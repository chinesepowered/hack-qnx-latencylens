// Numbers and time windows the demo video shows, computed from the demo traces with Latency Lens's
// own reader, model and detectors (nothing here is typed in by hand).
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
//
// Run by demo/record/director.mjs: esbuild bundles this file and runs it with
//   node facts.mjs <repo root> <out.json>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/deadlines.js';
import { analyse } from '../../src/detect/index.js';
import { jobsForThread } from '../../src/detect/deadline.js';
import { loadTrace } from '../../src/kev/load.js';
import { ST, buildModel, threadByName, type Model } from '../../src/model/model.js';

const [root, out] = process.argv.slice(2);
const load = (rel: string) => buildModel(loadTrace(join(root, rel)));
const thread = (m: Model, name: string) => {
  const t = threadByName(m, name)[0];
  if (!t) throw new Error(`no thread ${name}`);
  return t.index;
};

/** The busiest `width` ns between `from` and `to` (state changes on distinct threads, interrupts, messages), avoiding `skip`. */
function busiestWindow(m: Model, width: number, from: number, to: number, skip: [number, number][] = []): [number, number] {
  const changes: { t: number; th: number }[] = [];
  for (const T of m.threads) {
    if (T.isIdle) continue;
    const r = T.runs;
    for (let k = 0; k < r.n; k++) if (r.start[k] >= from && r.start[k] < to) changes.push({ t: r.start[k], th: T.index });
  }
  changes.sort((a, b) => a.t - b.t);
  const irq = Array.from(m.interrupts.t).filter((t) => t >= from && t < to).sort((a, b) => a - b);
  const msg = m.messages.map((x) => x.tSend).filter((t) => t >= from && t < to).sort((a, b) => a - b);
  const lower = (arr: number[], t: number) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const ct = changes.map((c) => c.t);
  let best = -1;
  let bestT = from;
  for (let a = from; a + width <= to; a += width / 4) {
    const b = a + width;
    if (skip.some(([x, y]) => a < y && b > x)) continue;
    const i0 = lower(ct, a);
    const i1 = lower(ct, b);
    const active = new Set<number>();
    for (let i = i0; i < i1; i++) active.add(changes[i].th);
    const score = Math.min(i1 - i0, 400) + 2 * (lower(irq, b) - lower(irq, a)) + 25 * (lower(msg, b) - lower(msg, a)) + 15 * active.size;
    if (score > best) {
      best = score;
      bestT = a;
    }
  }
  return [bestT, bestT + width];
}

// 1. The broken capture: every brake_ctl job and its response time.
const demo = load('demo/traces/brakesim.kev');
const demoCfg = loadConfig(join(root, 'demo/traces/brakesim.deadlines.yaml'));
const spec = demoCfg.deadlines[0];
const brake = thread(demo, spec.name);
const jobs = jobsForThread(demo, brake, spec).map((j) => ({ seq: j.seq, release: j.release, response: j.response }));
const demoAnalysis = analyse(demo, demoCfg);
const inversion = demoAnalysis.findings.find((f) => f.kind === 'priority-inversion')!;
const worst = inversion.instances[0];

// 2. The fixed capture: brake_ctl's mutex waits and the logger's priority while it holds the lock.
const fixed = load('demo/traces/fixed.kev');
const fBrake = thread(fixed, 'brake_ctl');
const fLogger = thread(fixed, 'logger');
const waits = fixed.mutexWaits
  .filter((w) => w.waiter === fBrake && !Number.isNaN(w.tWake))
  .map((w) => {
    const r = fixed.threads[fLogger].runs;
    let prio = -1;
    let ran = 0;
    for (let k = 0; k < r.n; k++) {
      if (r.state[k] !== ST.RUNNING || r.end[k] <= w.tBlock || r.start[k] >= w.tWake) continue;
      prio = Math.max(prio, r.prio[k]);
      ran += Math.min(r.end[k], w.tWake) - Math.max(r.start[k], w.tBlock);
    }
    return { tBlock: w.tBlock, tWake: w.tWake, ns: w.tWake - w.tBlock, holder: w.holder, loggerPrio: prio, loggerRanNs: ran };
  });
const sorted = [...waits].sort((a, b) => a.ns - b.ns);
const median = sorted[Math.floor(sorted.length / 2)];
// a typical wait in the middle of the trace whose holder ran boosted, a little longer than the median so it is easy to see
const typical = [...waits]
  .filter((w) => w.holder === fLogger && w.loggerPrio === 63 && w.tBlock > fixed.durationNs * 0.3 && w.tBlock < fixed.durationNs * 0.8)
  .sort((a, b) => Math.abs(a.ns - median.ns * 1.1) - Math.abs(b.ns - median.ns * 1.1))[0];
const pad = Math.max(typical.ns * 0.9, 600_000);

// 3. Where the timeline scene zooms in: a busy 4 ms in the middle of the broken capture, away from the worst inversion.
const zoom = busiestWindow(demo, 4e6, demo.durationNs * 0.3, demo.durationNs * 0.8, [[worst.t0 - 20e6, worst.t1 + 20e6]]);

// 4. The 1.27M-event stress capture: its size, and a busy 3 ms to zoom into.
const stress = load('samples/traces/stress.kev.gz');
const stressZoom = busiestWindow(stress, 3e6, stress.durationNs * 0.3, stress.durationNs * 0.7);

const facts = {
  demo: {
    pid: demo.threads[brake].pid,
    events: demo.trace.events.n,
    durationNs: demo.durationNs,
    deadlineNs: spec.deadlineNs,
    periodNs: spec.periodNs,
    jobs,
    late: jobs.filter((j) => j.response > spec.deadlineNs).length,
    worstInversion: { t0: worst.t0, t1: worst.t1, text: worst.text },
    findings: demoAnalysis.findings.map((f) => f.id),
    zoom,
  },
  fixed: {
    events: fixed.trace.events.n,
    waits: waits.length,
    medianWaitNs: median.ns,
    boostedWaits: waits.filter((w) => w.loggerPrio === 63).length,
    typical,
    window: [typical.tBlock - pad, typical.tWake + pad],
  },
  stress: { events: stress.trace.events.n, durationNs: stress.durationNs, zoom: stressZoom },
};
writeFileSync(out, JSON.stringify(facts, null, 2) + '\n');
console.log(
  `facts: ${jobs.length} brake jobs, ${facts.demo.late} late; fixed: ${waits.length} waits, median ${(median.ns / 1e6).toFixed(2)} ms, ` +
    `${facts.fixed.boostedWaits} with logger at 63; typical ${(typical.ns / 1e6).toFixed(2)} ms at ${(typical.tBlock / 1e9).toFixed(3)} s; ` +
    `zoom ${(zoom[0] / 1e9).toFixed(3)} s; stress ${stress.trace.events.n} events`,
);
