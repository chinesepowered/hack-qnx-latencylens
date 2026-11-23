#!/usr/bin/env node
// Renders demo/video.mp4. It films the real Latency Lens web UI (served by `latencylens open` on the
// demo traces) and replays the recorded terminal sessions, frame by frame at 30 fps and 1920x1080,
// then lays the ElevenLabs narration under the picture.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
//
//   node demo/record/tts.mjs        narration clips (cached, needs ELEVENLABS_API_KEY in .env)
//   node demo/record/director.mjs   video, thumbnail, stills and subtitles
//
// Every frame is deterministic: the UI's animations run on the frame clock (ui-harness.js), the
// pointer is drawn by overlay.js and moved to real on-screen targets, clicks are real clicks. The
// "Explain this" click asks the model live (W&B Inference); --recorded replays the saved answer.
// Options: --recorded, --only intro,capture,...  (preview some scenes, no audio), --no-stills
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = join(ROOT, 'demo', 'record');
const BUILD = join(ROOT, 'demo', 'build');
const WORK = join(BUILD, 'work');
const SHOTS = join(BUILD, 'stills'); // every still; the six in DOC_STILLS are copied to docs/screenshots
const DOC_STILLS = ['capture', 'timeline', 'finding', 'explanation', 'claim-check', 'fixed'];
const FPS = 30;
const LEAD = 0.45; // picture before each narration clip starts
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const value = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const ONLY = value('only')?.split(',') ?? null;
const RECORDED = flag('recorded');
const STILLS = !flag('no-stills') && !ONLY;

const log = (...a) => console.log(`[director ${new Date().toISOString().slice(11, 19)}]`, ...a);
const run = (cmd, args, o = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...o });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
};
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const r1 = (x) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------- inputs

const narration = JSON.parse(readFileSync(join(ROOT, 'demo', 'narration.json'), 'utf8'));
const clipPath = (id) => join(BUILD, 'audio', `${id}.mp3`);
for (const s of narration.scenes) if (!existsSync(clipPath(s.id))) throw new Error(`missing ${clipPath(s.id)}: run node demo/record/tts.mjs first`);
const DUR = Object.fromEntries(
  narration.scenes.map((s) => [s.id, Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clipPath(s.id)]).trim())]),
);

mkdirSync(BUILD, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
log('building the app');
run('node', [join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT });
log('computing facts from the demo traces');
run(join(ROOT, 'node_modules', '.bin', 'esbuild'), [
  join(HERE, 'facts.ts'),
  '--bundle',
  '--platform=node',
  '--format=esm',
  `--outfile=${join(BUILD, 'facts.mjs')}`,
  '--log-level=warning',
  "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
]);
log(run('node', [join(BUILD, 'facts.mjs'), ROOT, join(BUILD, 'facts.json')]).trim());
const FACTS = JSON.parse(readFileSync(join(BUILD, 'facts.json'), 'utf8'));

/** A screenful of the raw trace, as QNX's own traceprinter prints it (our dump if the SDP is absent). */
function traceWall() {
  const kev = join(ROOT, 'demo', 'traces', 'brakesim.kev');
  const host = process.env.QNX_HOST ?? join(process.env.HOME ?? '/root', 'qnx800', 'host', 'linux', 'x86_64');
  const target = process.env.QNX_TARGET ?? join(dirname(dirname(dirname(host))), 'target', 'qnx');
  const tp = join(host, 'usr', 'bin', 'traceprinter');
  let lines = [];
  let source = 'traceprinter';
  if (existsSync(tp)) {
    const r = spawnSync(tp, ['-f', kev], { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, QNX_HOST: host, QNX_TARGET: target } });
    if (r.status === 0) lines = r.stdout.split('\n').filter((l) => l.startsWith('t:0x'));
  }
  if (!lines.length) {
    source = 'latencylens dump';
    lines = run('node', [join(ROOT, 'bin', 'latencylens.mjs'), 'dump', kev, '--limit', '200000']).split('\n').filter((l) => l.trim());
  }
  const start = Math.floor(lines.length * 0.61);
  return { source, lines: lines.slice(start, start + 560).map((l) => l.slice(0, 150)) };
}

// ---------------------------------------------------------------- servers on copies of the traces

function workCopy(name, files) {
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [src, dst] of files) copyFileSync(join(ROOT, src), join(dir, dst));
  return dir;
}
const servers = [];
async function serve(trace, deadlines, port) {
  const args = [join(ROOT, 'bin', 'latencylens.mjs'), 'open', trace, '--port', String(port), '--no-open'];
  if (deadlines) args.push('--deadlines', deadlines);
  const p = spawn('node', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(p);
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server for ${trace} did not start:\n${out}`)), 90_000);
    p.stdout.on('data', (d) => {
      out += d;
      if (out.includes('http://')) {
        clearTimeout(timer);
        resolve();
      }
    });
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (c) => reject(new Error(`server for ${trace} exited with ${c}:\n${out}`)));
  });
  return `http://127.0.0.1:${port}/`;
}

// ---------------------------------------------------------------- film, cameras, shots

/** Fail loudly instead of hanging when a page stops answering. */
function deadline(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms)))]).finally(() => clearTimeout(timer));
}

class Film {
  constructor(out) {
    this.frames = 0;
    this.fresh = 0;
    this.marks = [];
    this.label = 'start';
    this.lastWrite = Date.now();
    this.watch = setInterval(() => {
      const idle = Date.now() - this.lastWrite;
      if (idle > 15_000) log(`no frame for ${(idle / 1000).toFixed(0)} s at frame ${this.frames}; last step: ${this.label}`);
    }, 5000);
    this.ff = spawn(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', String(FPS * 4), out],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
  }
  get T() {
    return this.frames / FPS;
  }
  async write(buf) {
    if (!this.ff.stdin.write(buf)) await once(this.ff.stdin, 'drain');
    this.frames++;
    this.lastWrite = Date.now();
  }
  async close() {
    clearInterval(this.watch);
    this.ff.stdin.end();
    const [code] = await once(this.ff, 'exit');
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
  }
}

let film;
let browser;
let uiCtx;
let flatCtx;
const OVERLAY = readFileSync(join(HERE, 'overlay.js'), 'utf8');
const HARNESS = readFileSync(join(HERE, 'ui-harness.js'), 'utf8');

class Cam {
  constructor(page, kind) {
    this.page = page;
    this.kind = kind;
    this.busy = false;
    this.buf = null;
    this.key = '';
    this.mouse = null;
  }
  static async ui(url) {
    const page = await uiCtx.newPage();
    page.on('pageerror', (e) => log('page error', url, e.message));
    await page.goto(url);
    await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 90_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.addScriptTag({ content: OVERLAY });
    await page.addScriptTag({ content: HARNESS });
    const cam = new Cam(page, 'ui');
    cam.cdp = await page.context().newCDPSession(page);
    await cam.prep(() => window.__tick(0));
    return cam;
  }
  static async file(name, ctx = flatCtx) {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log('page error', name, e.message));
    await page.goto(pathToFileURL(join(HERE, name)).href);
    await page.addScriptTag({ content: OVERLAY });
    const cam = new Cam(page, 'flat');
    cam.cdp = await page.context().newCDPSession(page);
    return cam;
  }
  /** Off-camera set-up. */
  async prep(fn, arg) {
    const r = await this.page.evaluate(fn, arg);
    this.buf = null;
    return r;
  }
  async shoot() {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
    return Buffer.from(data, 'base64');
  }
  async rect(sel, nth = 0) {
    const r = await this.page.evaluate(([s, n]) => window.__rect(s, n), [sel, nth]);
    if (!r) throw new Error(`no element ${sel}`);
    return r;
  }
}

/** A scene's clock: shots inside it share scene time. */
class Scene {
  constructor(id, tail = 0.6) {
    this.id = id;
    this.t0 = film.T;
    this.end = LEAD + DUR[id] + tail;
    film.marks.push({ id, frame: film.frames });
  }
  get t() {
    return film.T - this.t0;
  }
  /** Scene time of a moment `s` seconds into this scene's narration clip. */
  n(s) {
    return LEAD + s;
  }
}

class Shot {
  constructor(sc, cam) {
    this.sc = sc;
    this.cam = cam;
    this.dirty = true;
    this.cur = { x: 900, y: 520 };
    this.curO = { from: -1, to: 0, at: 0, dur: 0.01 }; // opacity animation
    this.curAnim = null;
    this.ripple = null;
    this.rings = [];
    this.caption = null;
    this.fades = [];
    this.before = null; // async (t) => changed?
  }
  get t() {
    return this.sc.t;
  }
  opacityAt(a, t) {
    const u = clamp((t - a.at) / a.dur);
    return a.from < 0 ? a.to * u : a.from + (a.to - a.from) * u;
  }
  cursorAt(t) {
    const A = this.curAnim;
    if (!A || t <= A.start) return { ...this.cur };
    const u = clamp((t - A.start) / A.dur);
    const e = easeInOut(u);
    const bend = Math.sin(Math.PI * e) * A.arc;
    return { x: A.x0 + (A.x1 - A.x0) * e + A.nx * bend, y: A.y0 + (A.y1 - A.y0) * e + A.ny * bend };
  }
  ovAt(t) {
    const c = this.cursorAt(t);
    const ov = { cursor: { x: r1(c.x), y: r1(c.y), o: r1(this.opacityAt(this.curO, t) * 100) / 100 } };
    if (this.ripple) {
      const p = (t - this.ripple.at) / 0.5;
      ov.ripple = p >= 0 && p < 1 ? { x: this.ripple.x, y: this.ripple.y, p: r1(p * 100) / 100, o: r1((1 - p) * 90) / 100 } : { o: 0, x: 0, y: 0, p: 0 };
    }
    const ring = this.rings.find((g) => t >= g.from - 0.01 && t < g.to + 0.3);
    if (ring) {
      const o = clamp((t - ring.from) / 0.25) * clamp((ring.to + 0.25 - t) / 0.25);
      ov.ring = { x: ring.x, y: ring.y, w: ring.w, h: ring.h, o: r1(o * 100) / 100 };
    }
    if (this.caption) {
      const k = this.caption;
      const o = clamp((t - k.from) / 0.3) * clamp((k.to - t) / 0.3);
      ov.caption = { ...k.pos, step: k.step, text: k.text, o: r1(o * 100) / 100 };
    }
    let fade = 0;
    for (const f of this.fades) {
      const u = clamp((t - f.at) / f.dur);
      if (t >= f.at) fade = f.from + (f.to - f.from) * u;
      else if (f.from === 1 && f.to === 0) fade = Math.max(fade, 1);
    }
    ov.fade = r1(fade * 100) / 100;
    return ov;
  }
  async frame() {
    const t = this.t;
    const cam = this.cam;
    if (Shot.active !== cam) {
      film.label = `bring ${cam.name} to front`;
      await deadline(cam.page.bringToFront(), 20_000, film.label);
      Shot.active = cam;
      this.dirty = true;
    }
    if (this.curAnim && t >= this.curAnim.start + this.curAnim.dur) {
      this.cur = { x: this.curAnim.x1, y: this.curAnim.y1 };
      this.curAnim = null;
    }
    film.label = `${this.sc.id} t=${t.toFixed(2)} before`;
    if (this.before && (await deadline(this.before(t), 20_000, film.label))) this.dirty = true;
    const ov = this.ovAt(t);
    const key = JSON.stringify(ov);
    if (this.dirty || cam.busy || key !== cam.key || !cam.buf) {
      if (cam.kind === 'ui' && ov.cursor.o > 0) {
        const mx = Math.round(ov.cursor.x);
        const my = Math.round(ov.cursor.y);
        if (!cam.mouse || cam.mouse.x !== mx || cam.mouse.y !== my) {
          film.label = `${this.sc.id} t=${t.toFixed(2)} mouse.move`;
          await deadline(cam.page.mouse.move(mx, my), 20_000, film.label);
          cam.mouse = { x: mx, y: my };
        }
      }
      film.label = `${this.sc.id} t=${t.toFixed(2)} tick ${cam.name}`;
      cam.busy = await deadline(
        cam.page.evaluate(
          async ([T, st, o]) => {
            const b = window.__tick ? await window.__tick(T, st) : false;
            window.__ov.set(o);
            return !!b;
          },
          [film.T, t, ov],
        ),
        20_000,
        film.label,
      );
      film.label = `${this.sc.id} t=${t.toFixed(2)} shoot ${cam.name}`;
      cam.buf = await deadline(cam.shoot(), 20_000, film.label);
      cam.key = key;
      this.dirty = false;
      film.fresh++;
    }
    await film.write(cam.buf);
  }
  async until(t) {
    while (this.t < t - 1e-6) await this.frame();
  }
  async wait(s) {
    await this.until(this.t + s);
  }
  /** Fade in from black now; fade out to black so that it is black at scene time `end`. */
  fadeIn(dur = 0.35) {
    this.fades.push({ at: this.t, dur, from: 1, to: 0 });
  }
  fadeOutAt(end, dur = 0.35) {
    this.fades.push({ at: end - dur, dur, from: 0, to: 1 });
  }
  showCursor(x, y, dur = 0.3) {
    this.cur = { x, y };
    this.curAnim = null;
    this.curO = { from: 0, to: 1, at: this.t, dur };
  }
  hideCursor(dur = 0.3) {
    this.curO = { from: 1, to: 0, at: this.t, dur };
  }
  async move(x, y, dur = 0.7, wait = true) {
    const c = this.cursorAt(this.t);
    const dx = x - c.x;
    const dy = y - c.y;
    const len = Math.hypot(dx, dy) || 1;
    this.cur = c;
    this.curAnim = { start: this.t, dur, x0: c.x, y0: c.y, x1: x, y1: y, nx: -dy / len, ny: dx / len, arc: Math.min(60, len * 0.08) };
    if (wait) await this.wait(dur);
  }
  async moveTo(cam, sel, dur = 0.7, dx = 0, dy = 0, nth = 0) {
    const r = await cam.rect(sel, nth);
    await this.move(r.cx + dx, r.cy + dy, dur);
    return r;
  }
  async click() {
    const c = this.cursorAt(this.t);
    this.ripple = { x: c.x, y: c.y, at: this.t };
    if (this.cam.kind === 'ui') {
      await this.cam.page.mouse.move(Math.round(c.x), Math.round(c.y));
      await this.cam.page.mouse.down();
      await this.cam.page.mouse.up();
    }
    this.dirty = true;
  }
  ring(r, from, to, pad = 6) {
    this.rings.push({ x: r1(r.x - pad), y: r1(r.y - pad), w: r1(r.w + 2 * pad), h: r1(r.h + 2 * pad), from, to });
  }
  captionOn(step, text, pos, from = this.t, to = 1e9) {
    this.caption = { step, text, pos, from, to };
  }
}

async function still(shot, name, { cursor = false } = {}) {
  if (!STILLS) return;
  const ov = shot.ovAt(shot.t);
  if (!cursor) ov.cursor.o = 0;
  ov.caption = { o: 0 };
  ov.ring = { o: 0, x: 0, y: 0, w: 0, h: 0 };
  ov.ripple = { o: 0, x: 0, y: 0, p: 0 };
  ov.fade = 0;
  await shot.cam.page.evaluate((o) => window.__ov.set(o), ov);
  const buf = await shot.cam.shoot();
  writeFileSync(join(SHOTS, `${name}.png`), buf);
  shot.dirty = true;
  log(`still ${name}.png`);
  return buf;
}

// ---------------------------------------------------------------- recorded terminal sessions

/**
 * Plan a replay of a recorded asciicast: commands are retyped at `plan[k].at` (scene time) and each
 * command's real output follows with its recorded timing (scaled by `plan[k].scale`, gaps capped).
 */
function planCast(castFile, sessionFile, plan, offset = 0) {
  const lines = readFileSync(castFile, 'utf8').trim().split('\n');
  const events = lines.slice(1).map((l) => JSON.parse(l));
  const cmds = JSON.parse(readFileSync(sessionFile, 'utf8')).filter((s) => s.cmd).map((s) => s.cmd);
  let raw = '';
  const at = []; // recorded time of each char
  for (const [t, , d] of events) {
    raw += d;
    for (let i = 0; i < d.length; i++) at.push(t);
  }
  const pos = [];
  let from = 0;
  for (const c of cmds) {
    const p = raw.indexOf(c, from);
    if (p < 0) throw new Error(`command not found in ${castFile}: ${c}`);
    pos.push(p);
    from = p + c.length;
  }
  const writes = [{ t: offset, d: raw.slice(0, pos[0]) }];
  const marks = [];
  let ready = offset; // when the previous command's output (and prompt) is complete
  for (let k = 0; k < cmds.length; k++) {
    const p = plan[k] ?? {};
    const cps = p.cps ?? 40;
    let start = offset + (p.at ?? ready + 0.3);
    if (start < ready + 0.12) {
      log(`  cast ${castFile.split('/').pop()}: command ${k + 1} moved from ${start.toFixed(2)} to ${(ready + 0.12).toFixed(2)}`);
      start = ready + 0.12;
    }
    const c = cmds[k];
    for (let i = 0; i < c.length; i++) writes.push({ t: start + i / cps + (c[i] === ' ' ? 0.01 : 0), d: c[i] });
    const enter = start + c.length / cps + 0.14;
    const outStart = pos[k] + c.length;
    const outEnd = k + 1 < cmds.length ? pos[k + 1] : raw.length;
    const t0 = at[outStart] ?? 0;
    const scale = p.scale ?? 0.85;
    let last = enter;
    let prevRec = t0;
    let tt = enter;
    for (let i = outStart; i < outEnd; i++) {
      const gap = Math.min((at[i] - prevRec) * scale, p.cap ?? 0.7);
      prevRec = at[i];
      tt += gap;
      writes.push({ t: tt, d: raw[i] });
      last = tt;
    }
    marks.push({ k, cmd: c, start, enter, done: last });
    ready = last;
  }
  // merge consecutive writes with the same time
  const merged = [];
  for (const w of writes.sort((a, b) => a.t - b.t)) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.t - w.t) < 1e-9) prev.d += w.d;
    else merged.push({ ...w });
  }
  return { writes: merged, marks, end: ready };
}

function castPlayer(cam, cast, titles = []) {
  let i = 0;
  let ti = 0;
  return async (t) => {
    let d = '';
    while (i < cast.writes.length && cast.writes[i].t <= t + 1e-6) d += cast.writes[i++].d;
    let changed = false;
    while (ti < titles.length && titles[ti].t <= t + 1e-6) {
      await cam.page.evaluate((h) => window.__setTitle(h), titles[ti++].html);
      changed = true;
    }
    if (d) {
      await cam.page.evaluate((x) => window.__write(x), d);
      changed = true;
    }
    return changed;
  };
}

// ---------------------------------------------------------------- scenes

const S = { RUNNING: 1, READY: 2, MUTEX: 13 };
const cams = {};
const capPos = { left: 24, bottom: 44 };
const HOST_TITLE = '<b>host</b>: ~/brakesim-demo (Linux, QNX SDP 8.0 tools)';
const QNX_TITLE = '<b>root@latencylens</b>: QNX OS 8.0 target in QEMU x86_64 (ssh)';
let liveAnswer = null;
let explainGate = null;

async function sceneIntro() {
  const sc = new Scene('intro', 0.75);
  const cam = cams.intro;
  const wall = traceWall();
  log(`intro wall from ${wall.source}`);
  await cam.prep(
    ([d]) => window.__init('intro', d),
    [
      {
        jobs: FACTS.demo.jobs,
        deadlineMs: FACTS.demo.deadlineNs / 1e6,
        wall: wall.lines,
        events: FACTS.demo.events,
        hotPids: [FACTS.demo.pid],
        marks: { barsFrom: 0.3, barsTo: sc.n(2.7), chartOut: sc.n(3.15), wallIn: sc.n(3.1), countIn: sc.n(3.45), countTo: sc.n(6.9), titleIn: sc.n(7.3) },
      },
    ],
  );
  const shot = new Shot(sc, cam);
  shot.fadeIn(0.5);
  await shot.until(sc.n(2.9));
  await still(shot, 'intro-chart');
  await shot.until(sc.end - 0.6);
  await still(shot, 'title');
  shot.fadeOutAt(sc.end, 0.35);
  await shot.until(sc.end);
}

async function sceneCapture() {
  const sc = new Scene('capture', 2.0);
  const cam = cams.capture;
  await cam.prep((o) => window.__setup(o), {
    cols: 110,
    rows: 30,
    fontSize: 18,
    title: HOST_TITLE,
    badges: [{ text: 'step 1: capture', cls: 'qnx' }],
    caption: '<b>qcc</b> from QNX SDP 8.0 builds the sample<span class="sep">|</span><b>tracelogger</b> records the kernel trace on QNX OS 8.0<span class="sep">|</span><b>latencylens</b> reads it on the host',
  });
  // When each command starts, in scene time, so the picture follows the narration.
  const plan = [
    { at: 0.25, cps: 30 }, // ls
    { at: 0.7, cps: 42 }, // qcc
    { at: 2.25, cps: 42, scale: 0.6 }, // qnx-vm put
    { at: 3.75, cps: 30, scale: 0.6 }, // qnx-vm ssh
    { at: 4.85, cps: 30 }, // uname -a
    { at: 5.6, cps: 34, scale: 0.8 }, // /tmp/brakesim -s 3
    { at: sc.n(9.6), cps: 62, scale: 0.45 }, // tracelogger ...
    { at: sc.n(11.85), cps: 60 }, // ls -l
    { at: sc.n(12.55), cps: 30 }, // exit
    { at: sc.n(12.85), cps: 55, scale: 0.6 }, // qnx-vm get
    { at: sc.n(14.0), cps: 62 }, // latencylens report
  ];
  const cast = planCast(join(HERE, 'sessions', 'capture.cast'), join(HERE, 'sessions', 'capture.json'), plan);
  for (const m of cast.marks) log(`  capture ${m.start.toFixed(2)}-${m.done.toFixed(2)}  ${m.cmd.slice(0, 60)}`);
  const titles = [
    { t: cast.marks[3].enter + 0.3, html: QNX_TITLE },
    { t: cast.marks[8].enter + 0.05, html: HOST_TITLE },
  ];
  const shot = new Shot(sc, cam);
  shot.before = castPlayer(cam, cast, titles);
  shot.fadeIn(0.35);
  await shot.until(Math.max(sc.end, cast.end + 2.6) - 0.6);
  await still(shot, 'capture');
  shot.fadeOutAt(Math.max(sc.end, cast.end + 2.6), 0.3);
  await shot.until(Math.max(sc.end, cast.end + 2.6));
}

async function sceneTimeline() {
  const sc = new Scene('timeline', 0.5);
  const A = cams.live;
  await A.prep(() => {
    window.latencylens.view.setView(0, window.latencylens.meta.durationNs);
    window.__tick(1);
  });
  const shot = new Shot(sc, A);
  shot.fadeIn(0.35);
  shot.captionOn('2', 'Open the trace: latencylens open brakesim.kev', capPos, 0.3);
  shot.showCursor(1150, 600, 0.4);
  await shot.wait(0.45);
  await shot.move(820, 92, 1.1); // the overview strip
  await shot.until(sc.n(2.3));
  const cpu0 = await A.page.evaluate(() => {
    const r = window.latencylens.view.canvas.getBoundingClientRect();
    return { x: r.left + 60, y: r.top + 30 + 13 };
  });
  await shot.move(cpu0.x, cpu0.y, 0.7);
  const brake = await A.page.evaluate(() => window.__lanePoint('brake_ctl', null));
  await shot.move(brake.x + 10, brake.y + 140, 1.3);
  await shot.until(sc.n(4.9));
  const [z0, z1] = FACTS.demo.zoom;
  await A.page.evaluate(([a, b]) => window.__zoom(a, b, 2.2), [z0, z1]);
  shot.dirty = true;
  await shot.move(1000, 420, 1.2);
  await shot.until(sc.n(7.3));
  const hover = await A.page.evaluate(() => window.__runPoint('io-sock', 1) ?? window.__runPoint('brake_ctl', 1));
  if (hover) await shot.move(hover.x, hover.y, 0.6);
  await still(shot, 'timeline', { cursor: true });
  await shot.until(sc.n(8.5));
  const st = await A.rect('#status-right');
  await shot.move(st.x + st.w * 0.55, st.cy - 2, 0.9);
  shot.ring(st, shot.t, sc.n(11.0), 5);
  await shot.until(sc.n(11.1));
  // the background of the picture in picture: this frame without the highlight ring
  const ovNow = shot.ovAt(shot.t);
  await A.page.evaluate((o) => window.__ov.set({ ...o, ring: { o: 0, x: 0, y: 0, w: 0, h: 0 } }), ovNow);
  const frame = await A.shoot();

  // picture in picture: the conformance tests against traceprinter
  const pip = cams.pip;
  await pip.prep((o) => window.__setup(o), {
    cols: 128,
    rows: 18,
    fontSize: 15,
    lineHeight: 1.1,
    title: '<b>host</b>: ~/hack-qnx-latencylens',
    pip: { right: 40, bottom: 70 },
    background: `data:image/png;base64,${frame.toString('base64')}`,
    badges: [{ text: 'decoder checked against the SDP traceprinter', cls: 'qnx' }],
  });
  const vcast = planCast(join(HERE, 'sessions', 'verify.cast'), join(HERE, 'sessions', 'verify.json'), [{ at: 0.15, cps: 40, scale: 1.0, cap: 0.5 }], sc.t);
  const pshot = new Shot(sc, pip);
  pshot.before = castPlayer(pip, vcast);
  pshot.fadeIn(0.12);
  await pshot.until(Math.max(sc.n(14.6), vcast.end + 0.6));
  await still(pshot, 'conformance');
  pshot.fadeOutAt(pshot.t + 0.18, 0.18);
  await pshot.wait(0.18);

  // the 1.27M-event capture stays smooth
  const B = cams.stress;
  await B.prep(() => {
    window.latencylens.view.setView(0, window.latencylens.meta.durationNs);
  });
  const bshot = new Shot(sc, B);
  bshot.fadeIn(0.18);
  bshot.captionOn('2', 'A 21 s stress capture: 1,268,250 events', capPos, sc.t);
  const chip = await B.page.evaluate(() => {
    const c = [...document.querySelectorAll('#trace-meta .chip')].find((x) => x.textContent.includes('events'));
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  bshot.ring(chip, sc.t + 0.1, sc.end, 4);
  const [s0, s1] = FACTS.stress.zoom;
  await B.page.evaluate(([a, b]) => window.__zoom(a, b, 2.6), [s0, s1]);
  bshot.showCursor(1000, 470, 0.3);
  await bshot.move(980, 430, 2.4);
  await bshot.until(sc.end - 0.35);
  await still(bshot, 'stress');
  bshot.fadeOutAt(sc.end, 0.3);
  await bshot.until(sc.end);
}

async function sceneFinding() {
  const sc = new Scene('finding', 0.55);
  const A = cams.live;
  await A.prep(() => {
    window.latencylens.view.setView(0, window.latencylens.meta.durationNs);
    document.getElementById('panel').scrollTop = 0;
  });
  const shot = new Shot(sc, A);
  shot.fadeIn(0.3);
  shot.captionOn('3', 'Pick a finding: it jumps to the worst occurrence', capPos, 0.25);
  shot.showCursor(1000, 560, 0.3);
  await shot.wait(0.3);
  const f = await shot.moveTo(A, '.finding[data-id="priority-inversion-1"]', 0.9, -60, 0);
  await shot.wait(0.1);
  await shot.click();
  await A.page.waitForSelector('.evidence table', { timeout: 10_000 });
  shot.dirty = true;
  await shot.wait(0.25);
  await shot.move(f.cx - 60, f.cy + 160, 0.9);
  await shot.until(sc.n(3.85));
  const mutex = await A.page.evaluate((s) => window.__runPoint('brake_ctl', s), S.MUTEX);
  await shot.move(mutex.x - 120, mutex.y, 0.8);
  await shot.until(sc.n(7.4));
  const loggerLabel = await A.page.evaluate(() => window.__lanePoint('logger', null));
  await shot.move(loggerLabel.x + 20, loggerLabel.y, 0.8);
  await shot.until(sc.n(8.75));
  const ready = await A.page.evaluate((s) => window.__runPoint('logger', s), S.READY);
  await shot.move(ready.x + 40, ready.y, 0.7);
  await shot.until(sc.n(13.1));
  const tele = await A.page.evaluate((s) => window.__runPoint('telemetry', s), S.RUNNING);
  await shot.move(tele.x + 90, tele.y, 0.7);
  await shot.wait(0.3);
  await still(shot, 'finding', { cursor: true });
  await shot.until(sc.n(17.0));
  await A.page.evaluate(() => window.__scrollPanelTo('#detail h3', 1.0, 8));
  shot.dirty = true;
  await shot.wait(1.05);
  const row0 = await A.rect('.evidence tr', 2);
  await shot.move(row0.x + 120, row0.cy, 0.6);
  for (let i = 3; i < 9; i++) {
    const r = await A.rect('.evidence tr', i);
    await shot.move(row0.x + 120, r.cy, 0.35);
  }
  await still(shot, 'evidence', { cursor: true });
  await shot.until(sc.end);
}

async function sceneExplain() {
  const sc = new Scene('explain', 0.6);
  const A = cams.live;
  const shot = new Shot(sc, A);
  shot.captionOn('4', 'Explain this: the model writes, the trace checks', capPos, 0);
  await A.page.evaluate(() => window.__scrollPanelTo('.explain', 0.8, 10));
  shot.dirty = true;
  await shot.move(1180, 300, 0.85);
  const btn = await shot.moveTo(A, '.ex-btn', 0.6, -30, 0);
  void btn;
  await shot.wait(0.1);
  const clickAt = shot.t;
  await shot.click();
  // the request is held until the frame clock has waited as long as the model really took
  for (;;) {
    if (liveAnswer && shot.t >= clickAt + liveAnswer.latency) break;
    if (!liveAnswer && shot.t > clickAt + 0.5) {
      film.label = 'waiting for the explanation';
      await deadline(explainGate.promise, 240_000, film.label);
    }
    await shot.frame();
  }
  await liveAnswer.release();
  await A.page.waitForSelector('.ex-answer', { timeout: 10_000 });
  shot.dirty = true;
  await shot.wait(0.3);
  const cause = await A.rect('.ex-answer .ex-sec p');
  await shot.move(cause.x + cause.w * 0.7, cause.y + cause.h * 0.45, 0.9);
  await shot.until(sc.n(8.3));
  const n = await A.page.evaluate(() => document.querySelectorAll('.ex-answer .claim-ok').length);
  for (let i = 0; i < Math.min(n, 4); i++) {
    const r = await A.rect('.ex-answer .claim-ok', i);
    await shot.move(r.cx, r.cy + 2, 0.55);
    shot.ring(r, shot.t, shot.t + 0.5, 3);
    await shot.wait(0.55);
  }
  const verdict = await A.rect('.ex-foot .v-ok, .ex-foot .v-bad, .ex-foot .v-warn');
  await shot.move(verdict.cx, verdict.cy + 2, 0.6);
  shot.ring(verdict, shot.t, sc.n(13.0), 5);
  await shot.until(sc.n(12.7));
  await still(shot, 'explanation', { cursor: false });
  shot.fadeOutAt(sc.n(13.15), 0.2);
  await shot.until(sc.n(13.15));

  // a recorded answer from an earlier capture where the model got a priority wrong
  const C = cams.inversion;
  const cshot = new Shot(sc, C);
  cshot.fadeIn(0.2);
  cshot.captionOn('4', 'A recorded answer with a wrong claim: struck out', capPos, sc.t);
  cshot.showCursor(1150, 520, 0.2);
  const bad = await C.rect('.ex-answer .claim-mismatch');
  await cshot.move(bad.cx, bad.cy + 3, 1.0);
  cshot.ring(bad, cshot.t, sc.end, 4);
  await cshot.until(sc.n(17.0));
  const v = await C.rect('.ex-foot .v-bad');
  await cshot.move(v.cx, v.cy + 3, 0.7);
  await cshot.until(sc.end - 0.25);
  await still(cshot, 'claim-check', { cursor: false });
  cshot.fadeOutAt(sc.end, 0.25);
  await cshot.until(sc.end);
}

async function sceneFix() {
  const sc = new Scene('fix', 1.6);
  const cam = cams.fix;
  await cam.prep((o) => window.__setup(o), {
    cols: 110,
    rows: 30,
    fontSize: 18,
    title: HOST_TITLE,
    badges: [{ text: 'step 5: fix and verify', cls: 'qnx' }],
    caption: 'One line: <b>PTHREAD_PRIO_INHERIT</b>, the QNX default<span class="sep">|</span>rebuild with <b>qcc</b><span class="sep">|</span>capture again<span class="sep">|</span>exit status 0 for CI',
  });
  const plan = [
    { at: 0.3, cps: 48 }, // sed
    { at: 1.95, cps: 48 }, // diff -u
    { at: sc.n(5.25), cps: 62, scale: 0.7 }, // qcc && put
    { at: sc.n(7.5), cps: 64, scale: 0.75 }, // ssh tracelogger
    { at: sc.n(10.75), cps: 50, scale: 0.6 }, // qnx-vm get
    { at: sc.n(11.85), cps: 66 }, // latencylens report
  ];
  const cast = planCast(join(HERE, 'sessions', 'fix.cast'), join(HERE, 'sessions', 'fix.json'), plan);
  for (const m of cast.marks) log(`  fix ${m.start.toFixed(2)}-${m.done.toFixed(2)}  ${m.cmd.slice(0, 60)}`);
  const shot = new Shot(sc, cam);
  shot.before = castPlayer(cam, cast);
  shot.fadeIn(0.3);
  const end = Math.max(sc.end, cast.end + 2.2);
  await shot.until(end - 0.5);
  await still(shot, 'fix');
  shot.fadeOutAt(end, 0.3);
  await shot.until(end);
}

async function sceneClean() {
  const sc = new Scene('clean', 0.7);
  const D = cams.fixed;
  const shot = new Shot(sc, D);
  shot.fadeIn(0.3);
  shot.captionOn('6', 'The fixed capture: no findings', capPos, 0.25);
  shot.showCursor(1000, 520, 0.3);
  const clean = await D.rect('.clean');
  await shot.move(clean.x + 60, clean.cy + 8, 0.9);
  shot.ring(clean, 0.9, sc.n(2.6), 5);
  await shot.until(sc.n(2.75));
  await D.page.evaluate(() => window.__pin(['brake_ctl', 'logger', 'telemetry']));
  const [w0, w1] = FACTS.fixed.window;
  await D.page.evaluate(([a, b]) => window.__zoom(a, b, 1.7), [w0, w1]);
  shot.dirty = true;
  shot.captionOn('6', 'Priority inheritance at work: logger runs at 63 while brake_ctl waits', capPos, sc.n(2.9));
  await shot.move(900, 300, 1.2);
  await shot.wait(0.55);
  const run = await D.page.evaluate((s) => window.__runPoint('logger', s, 63), S.RUNNING);
  if (!run) throw new Error('no logger run at priority 63 in view');
  await shot.move(run.x, run.y, 0.7);
  const status = await D.rect('#status-left');
  shot.ring({ x: status.x, y: status.y, w: Math.min(status.w, 760), h: status.h }, shot.t + 0.2, sc.end, 3);
  await shot.until(sc.end - 0.4);
  await still(shot, 'fixed', { cursor: true });
  shot.fadeOutAt(sc.end, 0.3);
  await shot.until(sc.end);
}

async function sceneMore() {
  const sc = new Scene('more', 0.7);
  const parts = [
    { cam: cams.ist, id: 'ist-latency-1', until: sc.n(4.45), text: 'IST latency: an interrupt thread held off by busier work' },
    { cam: cams.chain, id: 'send-chain-2', until: sc.n(6.55), text: 'Send-blocked chain: a request stuck behind three servers' },
    { cam: cams.hog, id: 'cpu-hog-1', until: sc.end, text: 'CPU hog: one thread holds a core' },
  ];
  for (const [i, p] of parts.entries()) {
    const shot = new Shot(sc, p.cam);
    shot.fadeIn(i === 0 ? 0.3 : 0.15);
    shot.captionOn('7', p.text, capPos, sc.t);
    const r = await p.cam.rect(`.finding[data-id="${p.id}"]`);
    shot.showCursor(r.cx - 40, r.cy + 120, 0.15);
    await shot.move(r.cx - 60, r.cy, 0.45);
    await shot.click();
    await p.cam.page.waitForSelector('.evidence table', { timeout: 10_000 });
    shot.dirty = true;
    await shot.move(r.cx - 60, r.cy + 220, 0.8);
    if (i === 1) await still(shot, 'send-chain');
    if (i < parts.length - 1) {
      shot.fadeOutAt(p.until, 0.15);
      await shot.until(p.until);
    } else {
      await shot.until(sc.end - 0.3);
      shot.fadeOutAt(sc.end, 0.3);
      await shot.until(sc.end);
    }
  }
}

async function sceneOutro() {
  const sc = new Scene('outro', 1.8);
  const cam = cams.outro;
  await cam.prep(([d]) => window.__init('outro', d), [{ marks: { r1: sc.n(0.35), r2: sc.n(3.3), r3: sc.n(5.2), credits: sc.n(6.4) } }]);
  const shot = new Shot(sc, cam);
  shot.fadeIn(0.4);
  await shot.until(sc.end - 0.9);
  await still(shot, 'outro');
  shot.fadeOutAt(sc.end, 0.8);
  await shot.until(sc.end);
}

// ---------------------------------------------------------------- audio, subtitles, thumbnail

function silences(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-38dB:d=0.18', '-f', 'null', '-'], { encoding: 'utf8' });
  const out = [];
  const re = /silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g;
  let m;
  while ((m = re.exec(r.stderr))) out.push([Number(m[1]), Number(m[2])]);
  return out;
}

function buildAudio(total) {
  const inputs = [];
  const filters = [];
  const placed = film.marks.filter((m) => DUR[m.id] != null);
  placed.forEach((m, i) => {
    inputs.push('-i', clipPath(m.id));
    const ms = Math.round((m.frame / FPS + LEAD) * 1000);
    filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${ms}:all=1[a${i}]`);
  });
  filters.push(`${placed.map((_, i) => `[a${i}]`).join('')}amix=inputs=${placed.length}:normalize=0:dropout_transition=0,apad=whole_dur=${total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]`);
  const wav = join(BUILD, 'narration.wav');
  run('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-t', total.toFixed(3), '-ac', '1', '-ar', '48000', wav]);
  return wav;
}

function srtTime(s) {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

/** Subtitles: one cue per sentence, its boundaries snapped to the pauses in the narration clip. */
function buildSrt() {
  const cues = [];
  for (const m of film.marks) {
    const scene = narration.scenes.find((s) => s.id === m.id);
    if (!scene) continue;
    const start = m.frame / FPS + LEAD;
    const sentences = scene.text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    const gaps = silences(clipPath(m.id)).filter(([a]) => a > 0.3 && a < DUR[m.id] - 0.3);
    const total = sentences.reduce((n, s) => n + s.length, 0);
    let acc = 0;
    let t = 0;
    sentences.forEach((s, i) => {
      acc += s.length;
      let end = DUR[m.id];
      if (i < sentences.length - 1) {
        const guess = (acc / total) * DUR[m.id];
        const best = gaps.reduce((b, g) => (Math.abs(g[0] - guess) < Math.abs(b[0] - guess) ? g : b), [guess, guess]);
        end = Math.abs(best[0] - guess) < 1.2 ? best[0] : guess;
      }
      cues.push({ a: start + t, b: start + end, text: s });
      const next = gaps.find((g) => Math.abs(g[0] - end) < 1e-6);
      t = next ? next[1] : end;
    });
  }
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.a)} --> ${srtTime(c.b)}\n${c.text}\n`).join('\n');
}

async function thumbnail(findingPng) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(join(HERE, 'cards.html')).href);
  await page.evaluate(
    ([d]) => window.__init('thumb', d),
    [{ shot: `data:image/png;base64,${findingPng.toString('base64')}`, shotW: 1280, shotH: 720, cropX: 330, cropY: 0 }],
  );
  await page.screenshot({ path: join(ROOT, 'demo', 'thumb.png') });
  await ctx.close();
}

// ---------------------------------------------------------------- main

async function main() {
  const wall0 = Date.now();
  const live = workCopy('live', [
    ['demo/traces/brakesim.kev', 'brakesim.kev'],
    ['demo/traces/brakesim.deadlines.yaml', 'brakesim.deadlines.yaml'],
    ...(RECORDED ? [['demo/traces/brakesim.explanations.json', 'brakesim.explanations.json']] : []),
  ]);
  const inv = workCopy('inversion', [
    ['samples/traces/inversion.kev', 'inversion.kev'],
    ['samples/traces/inversion.deadlines.yaml', 'inversion.deadlines.yaml'],
    ['samples/traces/inversion.explanations.json', 'inversion.explanations.json'],
  ]);
  const fixed = workCopy('fixed', [
    ['demo/traces/fixed.kev', 'fixed.kev'],
    ['demo/traces/fixed.deadlines.yaml', 'brakesim.deadlines.yaml'],
  ]);
  const ist = workCopy('ist', [['samples/traces/ist-latency.kev', 'ist-latency.kev']]);
  const chain = workCopy('chain', [['samples/traces/send-chain.kev', 'send-chain.kev']]);
  const hog = workCopy('hog', [
    ['samples/traces/cpu-hog.kev', 'cpu-hog.kev'],
    ['samples/traces/cpu-hog.deadlines.yaml', 'cpu-hog.deadlines.yaml'],
  ]);
  log('starting servers');
  const urls = {
    live: await serve(join(live, 'brakesim.kev'), join(live, 'brakesim.deadlines.yaml'), 7931),
    stress: await serve(join(ROOT, 'samples', 'traces', 'stress.kev.gz'), null, 7932),
    inversion: await serve(join(inv, 'inversion.kev'), join(inv, 'inversion.deadlines.yaml'), 7933),
    fixed: await serve(join(fixed, 'fixed.kev'), join(fixed, 'brakesim.deadlines.yaml'), 7934),
    ist: await serve(join(ist, 'ist-latency.kev'), null, 7935),
    chain: await serve(join(chain, 'send-chain.kev'), null, 7936),
    hog: await serve(join(hog, 'cpu-hog.kev'), join(hog, 'cpu-hog.deadlines.yaml'), 7937),
  };

  browser = await chromium.launch();
  uiCtx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3 });
  flatCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  log('opening pages');
  for (const k of Object.keys(urls)) cams[k] = await Cam.ui(urls[k]);
  cams.intro = await Cam.file('cards.html');
  cams.outro = await Cam.file('cards.html');
  cams.capture = await Cam.file('term.html');
  cams.fix = await Cam.file('term.html');
  cams.pip = await Cam.file('term.html');
  for (const [k, c] of Object.entries(cams)) c.name = k;

  // The live "Explain this" request: let it reach the model now, release the answer to the page
  // when the frame clock has waited as long as the model took.
  explainGate = {};
  explainGate.promise = new Promise((resolve, reject) => {
    explainGate.resolve = resolve;
    explainGate.reject = reject;
  });
  explainGate.promise.catch(() => {});
  await cams.live.page.route('**/api/explain', async (route) => {
    try {
      const req = route.request();
      log(`explain request: ${req.postData()}`);
      const t0 = Date.now();
      const res = await fetch(req.url(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.postData() });
      const text = await res.text();
      const wallMs = Date.now() - t0;
      if (res.status !== 200) throw new Error(`explanation failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      const body = JSON.parse(text);
      const s = body.claimSummary;
      log(`explanation: ${body.recorded ? 'recorded' : 'live'} ${body.model}, model ${Math.round(body.ms)} ms (wall ${wallMs} ms), claims ok ${s.ok}, mismatch ${s.mismatch}, unknown ${s.unknown}, proposals ${s.proposal}`);
      log(`  CAUSE: ${body.cause}`);
      log(`  FIX: ${body.fix}`);
      liveAnswer = {
        body,
        latency: clamp((body.recorded ? 2000 : body.ms) / 1000, 1.2, 3.5),
        release: () => route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: text }),
      };
      explainGate.resolve();
    } catch (err) {
      explainGate.reject(err);
    }
  });

  // page C shows the recorded wrong answer, ready before the cut
  const C = cams.inversion;
  await C.prep(() => window.latencylens.panel.select('deadline-miss-1'));
  await C.page.waitForSelector('.evidence table');
  await C.prep(() => window.latencylens.panel.explain(false));
  await C.page.waitForSelector('.ex-answer');
  await C.prep(() => {
    window.__tick(4);
    const panel = document.getElementById('panel');
    const ex = document.querySelector('.explain');
    const head = panel.querySelector('.panel-head').offsetHeight;
    panel.scrollTop += ex.getBoundingClientRect().top - panel.getBoundingClientRect().top - head - 10;
    window.__tick(5);
  });

  const picture = join(BUILD, `picture-${process.pid}.mp4`);
  film = new Film(picture);
  const scenes = { intro: sceneIntro, capture: sceneCapture, timeline: sceneTimeline, finding: sceneFinding, explain: sceneExplain, fix: sceneFix, clean: sceneClean, more: sceneMore, outro: sceneOutro };
  for (const [id, fn] of Object.entries(scenes)) {
    if (ONLY && !ONLY.includes(id)) continue;
    const f0 = film.frames;
    await fn();
    log(`scene ${id}: ${((film.frames - f0) / FPS).toFixed(2)} s (narration ${DUR[id].toFixed(2)} s)`);
  }
  await film.close();
  const total = film.frames / FPS;
  log(`picture: ${film.frames} frames, ${total.toFixed(2)} s, ${film.fresh} rendered`);

  if (!ONLY) {
    const wav = buildAudio(total);
    const out = join(ROOT, 'demo', 'video.mp4');
    run('ffmpeg', ['-y', '-loglevel', 'error', '-i', picture, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
    writeFileSync(join(ROOT, 'demo', 'video.srt'), buildSrt());
    const finding = readFileSync(join(SHOTS, 'finding.png'));
    await thumbnail(finding);
    mkdirSync(join(ROOT, 'docs', 'screenshots'), { recursive: true });
    for (const n of DOC_STILLS) copyFileSync(join(SHOTS, `${n}.png`), join(ROOT, 'docs', 'screenshots', `${n}.png`));
    if (liveAnswer && !liveAnswer.body.recorded) {
      // keep the answer the video shows next to the trace it explains
      const file = join(ROOT, 'demo', 'traces', 'brakesim.explanations.json');
      const rec = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
      const saved = JSON.parse(readFileSync(join(live, 'brakesim.explanations.json'), 'utf8'));
      Object.assign(rec, saved);
      writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
      log('saved the live answer to demo/traces/brakesim.explanations.json');
    }
    log(`wrote demo/video.mp4, demo/video.srt, demo/thumb.png, docs/screenshots in ${((Date.now() - wall0) / 1000).toFixed(0)} s`);
  } else {
    copyFileSync(picture, join(BUILD, 'preview.mp4'));
    log(`preview: ${join(BUILD, 'preview.mp4')}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const p of servers) p.kill();
    if (film && film.ff.exitCode === null) film.ff.kill('SIGKILL');
    if (film) clearInterval(film.watch);
    if (browser) await browser.close().catch(() => {});
    process.exit();
  });
