// Canvas timeline: one lane per CPU and per thread, states, interrupts, message arrows.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
//
// Level of detail: a lane with at most two runs per pixel draws every run exactly; a denser lane
// draws per-pixel columns whose RUNNING/READY shares come from prefix sums, found with a galloping
// cursor. Cost per frame is bounded by the canvas width, not by the trace size.
import { S, STATE_NAMES, lowerBound, type Runs, type Timeline, type TraceMeta } from './data.js';
import { OTHER_BLOCKED, STATE_COLOR, fmtDur, fmtTick, fmtTime, stateHeight, threadColor } from './util.js';

export interface Lane {
  kind: 'cpu' | 'thread' | 'group';
  index: number; // cpu or thread index, or -1 for groups
  key: string;
  label: string;
  sub: string;
  height: number;
  pinned: boolean;
  collapsed?: boolean;
  members?: number[];
}

export interface Highlight {
  threads: Set<number>;
  window: [number, number] | null;
  instances: [number, number][];
  victim: number;
  cursor: number | null; // ns: evidence row hovered in the panel
}

export interface HoverInfo {
  t: number;
  lane: Lane | null;
  text: string;
}

const LABEL_W = 230;
const AXIS_H = 30;
const MIN_SPAN = 2_000; // 2 us

/** Advance a run cursor to the first run whose end is after t (exponential then binary search). */
function gallop(end: Float64Array, n: number, k: number, t: number): number {
  if (k >= n || end[k] > t) return k;
  let step = 1;
  while (k + step < n && end[k + step] <= t) step *= 2;
  let lo = k + (step >> 1) + 1;
  let hi = Math.min(n, k + step);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (end[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class TimelineView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  t0 = 0;
  t1 = 1;
  scrollY = 0;
  lanes: Lane[] = [];
  private laneY: number[] = [];
  private contentH = 0;
  hl: Highlight = { threads: new Set(), window: null, instances: [], victim: -1, cursor: null };
  showKernel = false;
  showAll = false;
  drawMs = 0;
  private colors: string[];
  private pending = false;
  private anim: number | null = null;
  private hoverX = -1;
  private hoverY = -1;
  onHover: (h: HoverInfo | null) => void = () => {};
  onViewChange: () => void = () => {};

  constructor(
    canvas: HTMLCanvasElement,
    private meta: TraceMeta,
    private data: Timeline,
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.colors = meta.threads.map((t) => threadColor(t.label, t.isKernel));
    this.t0 = 0;
    this.t1 = Math.max(meta.durationNs, 1e6);
    this.rebuildLanes();
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
  }

  // ---------- lanes ----------

  rebuildLanes(): void {
    const meta = this.meta;
    const lanes: Lane[] = [];
    for (let c = 0; c < meta.cpuCount; c++) lanes.push({ kind: 'cpu', index: c, key: `cpu${c}`, label: `CPU ${c}`, sub: 'running thread', height: 26, pinned: false });
    const pinned = [...this.hl.threads];
    for (const th of pinned) {
      const T = meta.threads[th];
      lanes.push({ kind: 'thread', index: th, key: `pin${th}`, label: T.name || `tid ${T.tid}`, sub: T.process, height: 22, pinned: true });
    }
    const procs = new Map<number, number[]>();
    for (const T of meta.threads) {
      if (T.isIdle) continue;
      const r = this.data.threads[T.index];
      if (!this.showAll && (r.n === 0 || (T.runningNs === 0 && !this.hl.threads.has(T.index)))) continue;
      (procs.get(T.pid) ?? procs.set(T.pid, []).get(T.pid)!).push(T.index);
    }
    const order = [...procs.entries()].sort((a, b) => {
      const ka = meta.threads[a[1][0]].isKernel ? 1 : 0;
      const kb = meta.threads[b[1][0]].isKernel ? 1 : 0;
      const ra = a[1].reduce((s, t) => s + meta.threads[t].runningNs, 0);
      const rb = b[1].reduce((s, t) => s + meta.threads[t].runningNs, 0);
      const fa = a[1].some((t) => this.hl.threads.has(t)) ? 0 : 1;
      const fb = b[1].some((t) => this.hl.threads.has(t)) ? 0 : 1;
      return fa - fb || ka - kb || rb - ra;
    });
    for (const [pid, members] of order) {
      if (members.every((th) => this.hl.threads.has(th))) continue; // all pinned at the top
      const T0 = meta.threads[members[0]];
      const key = `p${pid}`;
      const collapsed = this.collapsed.has(key) || (T0.isKernel && !this.showKernel && !this.expanded.has(key));
      lanes.push({ kind: 'group', index: -1, key, label: `${T0.process}`, sub: `pid ${pid}, ${members.length} thread${members.length === 1 ? '' : 's'}`, height: 20, pinned: false, collapsed, members });
      if (collapsed) continue;
      members.sort((a, b) => meta.threads[b].basePrio - meta.threads[a].basePrio || meta.threads[a].tid - meta.threads[b].tid);
      for (const th of members) {
        if (this.hl.threads.has(th)) continue; // already pinned at the top
        const T = meta.threads[th];
        lanes.push({ kind: 'thread', index: th, key: `t${th}`, label: T.name || `tid ${T.tid}`, sub: '', height: 20, pinned: false });
      }
    }
    this.lanes = lanes;
    this.layout();
  }

  collapsed = new Set<string>();
  expanded = new Set<string>();

  private layout(): void {
    let y = 0;
    this.laneY = this.lanes.map((l) => {
      const v = y;
      y += l.height;
      return v;
    });
    this.contentH = y;
    this.clampScroll();
  }

  private clampScroll(): void {
    const viewH = this.h - AXIS_H;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, this.contentH - viewH)));
  }

  // ---------- view ----------

  private resize(): void {
    const parent = this.canvas.parentElement!;
    this.dpr = window.devicePixelRatio || 1;
    this.w = parent.clientWidth;
    this.h = parent.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.clampScroll();
    this.request();
  }

  get plotW(): number {
    return Math.max(10, this.w - LABEL_W);
  }

  x(t: number): number {
    return LABEL_W + ((t - this.t0) / (this.t1 - this.t0)) * this.plotW;
  }

  tAt(x: number): number {
    return this.t0 + ((x - LABEL_W) / this.plotW) * (this.t1 - this.t0);
  }

  setView(a: number, b: number): void {
    const dur = this.meta.durationNs;
    let span = Math.max(MIN_SPAN, b - a);
    span = Math.min(span, Math.max(dur * 1.05, 1e6));
    let s = (a + b) / 2 - span / 2;
    s = Math.max(-dur * 0.025, Math.min(s, dur * 1.025 - span));
    this.t0 = s;
    this.t1 = s + span;
    this.request();
    this.onViewChange();
  }

  /** Animate to [a, b], interpolating centre and log(span) so zooms feel even. */
  animateTo(a: number, b: number, ms = 450): void {
    if (this.anim !== null) cancelAnimationFrame(this.anim);
    const c0 = (this.t0 + this.t1) / 2;
    const l0 = Math.log(this.t1 - this.t0);
    const c1 = (a + b) / 2;
    const l1 = Math.log(Math.max(MIN_SPAN, b - a));
    const start = performance.now();
    const step = (now: number) => {
      const u = Math.min(1, (now - start) / ms);
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      const span = Math.exp(l0 + (l1 - l0) * e);
      const c = c0 + (c1 - c0) * e;
      this.setView(c - span / 2, c + span / 2);
      this.anim = u < 1 ? requestAnimationFrame(step) : null;
    };
    this.anim = requestAnimationFrame(step);
  }

  zoomAt(x: number, factor: number): void {
    const t = this.tAt(x);
    const a = t - (t - this.t0) * factor;
    const b = t + (this.t1 - t) * factor;
    this.setView(a, b);
  }

  fit(): void {
    this.animateTo(0, this.meta.durationNs);
  }

  scrollToLane(key: string): void {
    const k = this.lanes.findIndex((l) => l.key === key);
    if (k >= 0) {
      this.scrollY = this.laneY[k] - 40;
      this.clampScroll();
      this.request();
    }
  }

  request(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  // ---------- input ----------

  private bind(): void {
    const c = this.canvas;
    let drag: { x: number; y: number; t0: number; t1: number; scroll: number; box: boolean } | null = null;
    let box: [number, number] | null = null;
    c.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const rect = c.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        if (x < LABEL_W || ev.altKey) {
          this.scrollY += ev.deltaY;
          this.clampScroll();
          this.request();
          return;
        }
        if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) || ev.shiftKey) {
          const d = (ev.shiftKey ? ev.deltaY : ev.deltaX) / this.plotW;
          const span = this.t1 - this.t0;
          this.setView(this.t0 + d * span, this.t1 + d * span);
          return;
        }
        const factor = Math.exp(Math.max(-1, Math.min(1, ev.deltaY * (ev.deltaMode ? 0.05 : 0.0018))));
        this.zoomAt(x, factor);
      },
      { passive: false },
    );
    c.addEventListener('mousedown', (ev) => {
      const rect = c.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (x < LABEL_W) {
        const lane = this.laneAtY(y);
        if (lane && lane.kind === 'group') {
          if (lane.collapsed) {
            this.collapsed.delete(lane.key);
            this.expanded.add(lane.key);
          } else {
            this.collapsed.add(lane.key);
            this.expanded.delete(lane.key);
          }
          this.rebuildLanes();
          this.request();
        }
        return;
      }
      drag = { x, y, t0: this.t0, t1: this.t1, scroll: this.scrollY, box: ev.shiftKey };
      c.style.cursor = ev.shiftKey ? 'col-resize' : 'grabbing';
    });
    window.addEventListener('mousemove', (ev) => {
      const rect = c.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (drag) {
        if (drag.box) {
          box = [Math.min(drag.x, x), Math.max(drag.x, x)];
          this.boxSel = box;
          this.request();
        } else {
          const dt = ((x - drag.x) / this.plotW) * (drag.t1 - drag.t0);
          this.setView(drag.t0 - dt, drag.t1 - dt);
          this.scrollY = drag.scroll - (y - drag.y);
          this.clampScroll();
        }
      }
      if (x >= 0 && y >= 0 && x <= this.w && y <= this.h) {
        this.hoverX = x;
        this.hoverY = y;
        this.emitHover();
        this.request();
      } else if (this.hoverX >= 0) {
        this.hoverX = -1;
        this.onHover(null);
        this.request();
      }
    });
    window.addEventListener('mouseup', () => {
      if (drag?.box && box && box[1] - box[0] > 4) this.animateTo(this.tAt(box[0]), this.tAt(box[1]), 300);
      drag = null;
      box = null;
      this.boxSel = null;
      c.style.cursor = '';
      this.request();
    });
    c.addEventListener('dblclick', (ev) => {
      const rect = c.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      if (x < LABEL_W) return;
      const t = this.tAt(x);
      const span = (this.t1 - this.t0) / (ev.shiftKey ? 0.25 : 4);
      this.animateTo(t - span / 2, t + span / 2, 300);
    });
    c.addEventListener('mouseleave', () => {
      this.hoverX = -1;
      this.onHover(null);
      this.request();
    });
    window.addEventListener('keydown', (ev) => {
      if ((ev.target as HTMLElement)?.closest?.('input, textarea')) return;
      const span = this.t1 - this.t0;
      const cx = this.hoverX >= LABEL_W ? this.hoverX : LABEL_W + this.plotW / 2;
      switch (ev.key) {
        case 'w':
        case 'W':
        case '+':
        case '=':
          this.zoomAt(cx, 0.7);
          break;
        case 's':
        case 'S':
        case '-':
          this.zoomAt(cx, 1 / 0.7);
          break;
        case 'a':
        case 'A':
        case 'ArrowLeft':
          this.setView(this.t0 - span * 0.2, this.t1 - span * 0.2);
          break;
        case 'd':
        case 'D':
        case 'ArrowRight':
          this.setView(this.t0 + span * 0.2, this.t1 + span * 0.2);
          break;
        case 'f':
        case 'F':
        case '0':
          this.fit();
          break;
        default:
          return;
      }
      ev.preventDefault();
    });
  }

  private boxSel: [number, number] | null = null;

  private laneAtY(y: number): Lane | null {
    const yy = y - AXIS_H + this.scrollY;
    if (y < AXIS_H) return null;
    for (let k = 0; k < this.lanes.length; k++) if (yy >= this.laneY[k] && yy < this.laneY[k] + this.lanes[k].height) return this.lanes[k];
    return null;
  }

  private emitHover(): void {
    if (this.hoverX < LABEL_W) {
      this.onHover(null);
      return;
    }
    const t = this.tAt(this.hoverX);
    const lane = this.laneAtY(this.hoverY);
    let text = '';
    if (lane?.kind === 'thread') {
      const r = this.data.threads[lane.index];
      const k = gallop(r.end, r.n, 0, t);
      const T = this.meta.threads[lane.index];
      if (k < r.n && r.start[k] <= t) {
        text = `${T.label}  ${STATE_NAMES[r.state[k]] ?? r.state[k]}${r.prio[k] >= 0 ? ` at priority ${r.prio[k]}` : ''}${r.state[k] === S.RUNNING ? ` on CPU ${r.cpu[k]}` : ''}  for ${fmtDur(r.end[k] - r.start[k])}  (from ${fmtTime(r.start[k])})`;
      } else text = T.label;
    } else if (lane?.kind === 'cpu') {
      const c = this.data.cpus[lane.index];
      const k = gallop(c.end, c.n, 0, t);
      if (k < c.n && c.start[k] <= t) {
        const th = c.thread[k];
        const T = th >= 0 ? this.meta.threads[th] : null;
        text = `CPU ${lane.index}  ${T ? (T.isIdle ? 'idle' : `${T.label} at priority ${c.prio[k]}`) : 'unknown'}  for ${fmtDur(c.end[k] - c.start[k])}`;
      }
    } else if (lane?.kind === 'group') text = `${lane.label} (${lane.sub}): click the label to ${lane.collapsed ? 'expand' : 'collapse'}`;
    this.onHover({ t, lane, text });
  }

  // ---------- drawing ----------

  draw(): void {
    const t0 = performance.now();
    const ctx = this.ctx;
    const W = this.w;
    const H = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);
    const span = this.t1 - this.t0;
    const pxNs = span / this.plotW;

    // grid
    const step = this.tickStep(span);
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, AXIS_H, this.plotW, H - AXIS_H);
    ctx.clip();
    ctx.strokeStyle = '#1b2230';
    ctx.lineWidth = 1;
    for (let t = Math.ceil(this.t0 / step) * step; t <= this.t1; t += step) {
      const xx = Math.round(this.x(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(xx, AXIS_H);
      ctx.lineTo(xx, H);
      ctx.stroke();
    }
    // finding window band
    if (this.hl.window) {
      const [a, b] = this.hl.window;
      ctx.fillStyle = 'rgba(248, 81, 73, 0.07)';
      ctx.fillRect(this.x(a), AXIS_H, Math.max(2, this.x(b) - this.x(a)), H - AXIS_H);
    }
    ctx.restore();

    // lanes
    const viewTop = this.scrollY;
    const viewBot = this.scrollY + H - AXIS_H;
    const yOf = new Map<number, number>(); // thread -> lane centre y (first visible lane)
    for (let k = 0; k < this.lanes.length; k++) {
      const lane = this.lanes[k];
      const ly = this.laneY[k];
      if (ly + lane.height < viewTop || ly > viewBot) continue;
      const y = AXIS_H + ly - this.scrollY;
      this.drawLane(lane, y, pxNs);
      if (lane.kind === 'thread' && !yOf.has(lane.index)) yOf.set(lane.index, y + lane.height / 2);
    }
    this.drawMessages(yOf, pxNs);
    this.drawMarkers(yOf);

    // axis on top
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, AXIS_H);
    ctx.strokeStyle = '#30363d';
    ctx.beginPath();
    ctx.moveTo(0, AXIS_H - 0.5);
    ctx.lineTo(W, AXIS_H - 0.5);
    ctx.stroke();
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (let t = Math.ceil(this.t0 / step) * step; t <= this.t1; t += step) {
      const xx = this.x(t);
      if (xx < LABEL_W + 2) continue;
      ctx.fillRect(Math.round(xx), AXIS_H - 6, 1, 6);
      ctx.fillText(fmtTick(t, step), xx + 4, AXIS_H / 2);
    }
    ctx.fillStyle = '#c9d1d9';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillText(`view ${fmtDur(span)}  (${fmtDur(pxNs)}/px)`, 10, AXIS_H / 2);

    // evidence cursor and hover cursor
    if (this.hl.cursor !== null) this.vline(this.hl.cursor, '#f0883e');
    if (this.hoverX >= LABEL_W) {
      const t = this.tAt(this.hoverX);
      this.vline(t, 'rgba(201, 209, 217, 0.55)');
      ctx.fillStyle = '#161b22';
      const label = fmtTime(t);
      ctx.font = '11px ui-monospace, monospace';
      const tw = ctx.measureText(label).width + 10;
      const lx = Math.min(this.hoverX + 6, W - tw - 2);
      ctx.fillRect(lx, 2, tw, AXIS_H - 6);
      ctx.fillStyle = '#f0f6fc';
      ctx.fillText(label, lx + 5, AXIS_H / 2 - 1);
    }
    if (this.boxSel) {
      ctx.fillStyle = 'rgba(88, 166, 255, 0.15)';
      ctx.fillRect(this.boxSel[0], AXIS_H, this.boxSel[1] - this.boxSel[0], H - AXIS_H);
    }
    // label column separator
    ctx.fillStyle = '#30363d';
    ctx.fillRect(LABEL_W - 1, 0, 1, H);
    this.drawMs = performance.now() - t0;
  }

  private vline(t: number, color: string): void {
    const xx = Math.round(this.x(t)) + 0.5;
    if (xx < LABEL_W || xx > this.w) return;
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(xx, AXIS_H);
    ctx.lineTo(xx, this.h);
    ctx.stroke();
  }

  private tickStep(span: number): number {
    const target = span / Math.max(2, this.plotW / 110);
    const p = Math.pow(10, Math.floor(Math.log10(target)));
    for (const m of [1, 2, 5, 10]) if (p * m >= target) return p * m;
    return p * 10;
  }

  private drawLabel(lane: Lane, y: number): void {
    const ctx = this.ctx;
    const h = lane.height;
    const hi = lane.kind === 'thread' && this.hl.threads.has(lane.index);
    ctx.fillStyle = lane.kind === 'group' ? '#11161d' : hi ? '#1c2533' : '#0d1117';
    ctx.fillRect(0, y, LABEL_W - 1, h);
    if (lane.pinned) {
      ctx.fillStyle = lane.index === this.hl.victim ? '#f85149' : '#f0883e';
      ctx.fillRect(0, y + 2, 3, h - 4);
    }
    ctx.textBaseline = 'middle';
    if (lane.kind === 'group') {
      ctx.fillStyle = '#8b949e';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillText(`${lane.collapsed ? '▸' : '▾'} ${lane.label}`, 8, y + h / 2);
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#6e7681';
      ctx.fillText(lane.sub, 8 + ctx.measureText(`${lane.collapsed ? '▸' : '▾'} ${lane.label}`).width + 54, y + h / 2);
      return;
    }
    if (lane.kind === 'cpu') {
      ctx.fillStyle = '#f0f6fc';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(lane.label, 10, y + h / 2);
      return;
    }
    const T = this.meta.threads[lane.index];
    ctx.fillStyle = hi ? '#f0f6fc' : '#c9d1d9';
    ctx.font = `${hi ? '600 ' : ''}12px system-ui, sans-serif`;
    const name = lane.pinned ? `${lane.label}` : `  ${lane.label}`;
    const nameW = Math.min(ctx.measureText(name).width, LABEL_W - 80);
    ctx.fillText(name, 10, y + h / 2, LABEL_W - 80);
    if (lane.pinned && nameW < LABEL_W - 110) {
      ctx.fillStyle = '#6e7681';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(lane.sub, 10 + nameW + 8, y + h / 2 + 1, LABEL_W - 60 - (10 + nameW + 8));
    }
    if (T.basePrio >= 0) {
      const txt = T.prioMax > T.basePrio ? `${T.basePrio}↑` : String(T.basePrio);
      ctx.font = '600 10px ui-monospace, monospace';
      const tw = ctx.measureText(txt).width + 8;
      ctx.fillStyle = '#21262d';
      ctx.fillRect(LABEL_W - tw - 8, y + 3, tw, h - 6);
      ctx.fillStyle = T.basePrio >= 50 ? '#ffa198' : T.basePrio >= 21 ? '#e3b341' : '#8b949e';
      ctx.fillText(txt, LABEL_W - tw - 4, y + h / 2 + 0.5);
    }
  }

  private drawLane(lane: Lane, y: number, pxNs: number): void {
    const ctx = this.ctx;
    this.drawLabel(lane, y);
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, y, this.plotW, lane.height);
    ctx.clip();
    ctx.strokeStyle = '#161b22';
    ctx.beginPath();
    ctx.moveTo(LABEL_W, y + lane.height - 0.5);
    ctx.lineTo(this.w, y + lane.height - 0.5);
    ctx.stroke();
    if (lane.kind === 'thread') this.drawThread(lane.index, y + 2, lane.height - 4, pxNs);
    else if (lane.kind === 'cpu') this.drawCpu(lane.index, y + 2, lane.height - 4, pxNs);
    else if (lane.kind === 'group' && lane.collapsed && lane.members) this.drawGroupSummary(lane.members, y + 4, lane.height - 8, pxNs);
    if (lane.kind === 'thread' && lane.index === this.hl.victim) {
      ctx.fillStyle = '#f85149';
      for (const [a, b] of this.hl.instances) {
        if (b < this.t0 || a > this.t1) continue;
        ctx.fillRect(this.x(a), y, Math.max(2, this.x(b) - this.x(a)), 2);
      }
    }
    ctx.restore();
  }

  private drawThread(th: number, y: number, h: number, pxNs: number): void {
    const r: Runs = this.data.threads[th];
    if (!r.n) return;
    const ctx = this.ctx;
    let k = gallop(r.end, r.n, 0, this.t0);
    const kEnd = lowerBound(r.start, this.t1);
    const count = kEnd - k;
    if (count <= this.plotW * 2) {
      for (; k < kEnd; k++) {
        const s = r.state[k];
        if (s === S.DEAD) continue;
        const x0 = this.x(r.start[k]);
        const x1 = this.x(r.end[k]);
        const wpx = x1 - x0;
        if (wpx < 0.35 && s !== S.RUNNING) continue;
        const hh = Math.max(2, h * stateHeight(s));
        ctx.fillStyle = STATE_COLOR[s] ?? OTHER_BLOCKED;
        ctx.fillRect(x0, y + (h - hh), Math.max(1, wpx), hh);
        if (s === S.RUNNING && wpx > 60) {
          // name the CPU inside long runs
          ctx.fillStyle = '#04260f';
          ctx.font = '600 10px system-ui, sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText(`CPU ${r.cpu[k]}${r.prio[k] >= 0 ? `  prio ${r.prio[k]}` : ''}`, Math.max(x0, LABEL_W) + 4, y + h / 2, wpx - 8);
        }
      }
      return;
    }
    // dense: per-pixel running and ready share from the prefix sums, one galloping cursor
    let kc = gallop(r.end, r.n, 0, this.t0);
    let run = 0;
    let ready = 0;
    const at = (t: number) => {
      kc = gallop(r.end, r.n, kc, t);
      if (kc >= r.n) {
        run = r.cumRun[r.n];
        ready = r.cumReady[r.n];
        return;
      }
      run = r.cumRun[kc];
      ready = r.cumReady[kc];
      if (r.start[kc] < t) {
        if (r.state[kc] === S.RUNNING) run += t - r.start[kc];
        else if (r.state[kc] === S.READY) ready += t - r.start[kc];
      }
    };
    at(this.t0);
    let prevRun = run;
    let prevReady = ready;
    const W = this.plotW;
    for (let px = 0; px < W; px++) {
      at(this.t0 + (px + 1) * pxNs);
      const fr = Math.min(1, (run - prevRun) / pxNs);
      const fy = Math.min(1 - fr, (ready - prevReady) / pxNs);
      prevRun = run;
      prevReady = ready;
      const xx = LABEL_W + px;
      if (fr > 0.002) {
        const hh = Math.max(1, h * (0.25 + 0.75 * fr));
        ctx.fillStyle = STATE_COLOR[S.RUNNING];
        ctx.globalAlpha = 0.45 + 0.55 * fr;
        ctx.fillRect(xx, y + h - hh, 1, hh);
      }
      if (fy > 0.002) {
        ctx.fillStyle = STATE_COLOR[S.READY];
        ctx.globalAlpha = 0.4 + 0.6 * fy;
        const hh = Math.max(1, h * 0.62 * fy);
        ctx.fillRect(xx, y + h - hh - (fr > 0.002 ? h * (0.25 + 0.75 * fr) : 0), 1, hh);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawGroupSummary(members: number[], y: number, h: number, pxNs: number): void {
    // a thin activity strip: any member running in the pixel
    const ctx = this.ctx;
    ctx.fillStyle = '#2d6a3f';
    for (const th of members) {
      const r = this.data.threads[th];
      if (!r.n) continue;
      let k = gallop(r.end, r.n, 0, this.t0);
      const kEnd = lowerBound(r.start, this.t1);
      let lastPx = -1;
      for (; k < kEnd; k++) {
        if (r.state[k] !== S.RUNNING) continue;
        const x0 = Math.floor(this.x(r.start[k]));
        const x1 = Math.ceil(this.x(r.end[k]));
        if (x1 <= lastPx) continue;
        ctx.fillRect(Math.max(x0, lastPx), y, Math.max(1, x1 - Math.max(x0, lastPx)), h);
        lastPx = x1;
        if (kEnd - k > 4 * this.plotW) k = Math.max(k, gallop(r.end, r.n, k, this.t0 + (x1 - LABEL_W + 1) * pxNs) - 1);
      }
    }
  }

  private drawCpu(cpu: number, y: number, h: number, pxNs: number): void {
    const c = this.data.cpus[cpu];
    const ctx = this.ctx;
    const meta = this.meta;
    let k = gallop(c.end, c.n, 0, this.t0);
    const kEnd = lowerBound(c.start, this.t1);
    if (kEnd - k <= this.plotW * 2) {
      for (; k < kEnd; k++) {
        const th = c.thread[k];
        if (th < 0 || meta.threads[th].isIdle) continue;
        const x0 = this.x(c.start[k]);
        const x1 = this.x(c.end[k]);
        const wpx = Math.max(1, x1 - x0);
        const hi = this.hl.threads.has(th);
        ctx.fillStyle = this.colors[th];
        ctx.globalAlpha = this.hl.threads.size && !hi ? 0.45 : 1;
        ctx.fillRect(x0, y, wpx, h);
        if (wpx > 46) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#0d1117';
          ctx.font = `${hi ? '600 ' : ''}10px system-ui, sans-serif`;
          ctx.textBaseline = 'middle';
          ctx.fillText(meta.threads[th].name || meta.threads[th].label, Math.max(x0, LABEL_W) + 3, y + h / 2, wpx - 6);
        }
      }
      ctx.globalAlpha = 1;
    } else {
      // dense: busy share per pixel, coloured by the thread at the pixel centre
      let kc = k;
      const busyAt = (t: number) => {
        kc = gallop(c.end, c.n, kc, t);
        if (kc >= c.n) return c.cumBusy[c.n];
        let v = c.cumBusy[kc];
        const th = c.thread[kc];
        if (c.start[kc] < t && th >= 0 && !meta.threads[th].isIdle) v += t - c.start[kc];
        return v;
      };
      let prev = busyAt(this.t0);
      for (let px = 0; px < this.plotW; px++) {
        const ta = this.t0 + px * pxNs;
        const tb = ta + pxNs;
        const kMid = gallop(c.end, c.n, kc, ta + pxNs / 2);
        const b = busyAt(tb);
        const f = Math.min(1, (b - prev) / pxNs);
        prev = b;
        if (f < 0.003) continue;
        const th = kMid < c.n ? c.thread[kMid] : -1;
        ctx.fillStyle = th >= 0 && !meta.threads[th].isIdle ? this.colors[th] : '#3fb950';
        ctx.globalAlpha = 0.35 + 0.65 * f;
        const hh = Math.max(1, h * f);
        ctx.fillRect(LABEL_W + px, y + h - hh, 1, hh);
      }
      ctx.globalAlpha = 1;
    }
    // interrupts delivered on this CPU
    const it = this.data.ints;
    const i0 = lowerBound(it.t, this.t0);
    const i1 = lowerBound(it.t, this.t1);
    if (i1 - i0 < this.plotW * 3) {
      ctx.fillStyle = '#39c5cf';
      for (let i = i0; i < i1; i++) if (it.cpu[i] === cpu) ctx.fillRect(Math.round(this.x(it.t[i])), y - 2, 1, 5);
    }
  }

  private drawMessages(yOf: Map<number, number>, pxNs: number): void {
    const m = this.data.msgs;
    if (!m.recv.length || pxNs > 50_000) return; // only when zoomed in (< 50 us per pixel)
    const ctx = this.ctx;
    // find messages received inside the view
    let lo = 0;
    let hi = m.byRecv.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (m.recv[m.byRecv[mid]] < this.t0) lo = mid + 1;
      else hi = mid;
    }
    let drawn = 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, AXIS_H, this.plotW, this.h - AXIS_H);
    ctx.clip();
    for (let q = lo; q < m.byRecv.length && drawn < 600; q++) {
      const i = m.byRecv[q];
      if (m.recv[i] > this.t1) break;
      const yc = yOf.get(m.client[i]);
      const ys = yOf.get(m.server[i]);
      if (yc === undefined || ys === undefined || yc === ys) continue;
      drawn++;
      this.arrow(this.x(m.send[i]), yc, this.x(m.recv[i]), ys, '#58a6ff', false);
      if (m.reply[i] >= 0) this.arrow(this.x(m.reply[i]), ys, this.x(m.reply[i]), yc, '#a371f7', true);
    }
    ctx.restore();
  }

  private arrow(x0: number, y0: number, x1: number, y1: number, color: string, dashed: boolean): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.25;
    ctx.setLineDash(dashed ? [3, 3] : []);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - 6 * Math.cos(a - 0.4), y1 - 6 * Math.sin(a - 0.4));
    ctx.lineTo(x1 - 6 * Math.cos(a + 0.4), y1 - 6 * Math.sin(a + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 1;
  }

  private drawMarkers(yOf: Map<number, number>): void {
    const mk = this.data.marks;
    const i0 = lowerBound(mk.t, this.t0);
    const i1 = lowerBound(mk.t, this.t1);
    if (i1 - i0 > this.plotW) return;
    const ctx = this.ctx;
    for (let i = i0; i < i1; i++) {
      const y = yOf.get(mk.thread[i]);
      if (y === undefined) continue;
      const xx = Math.round(this.x(mk.t[i]));
      ctx.fillStyle = mk.code[i] === 100 ? '#e6edf3' : mk.code[i] === 101 ? '#7d8590' : '#d2a8ff';
      ctx.fillRect(xx, y - 10, 1, 4);
    }
  }
}
