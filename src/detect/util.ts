// Helpers shared by the detectors. Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import { Cls, KC_EXIT, Ker } from '../kev/constants.js';
import { ST, eventAtOrAfter, firstRunEndingAfter, type CpuRuns, type Model, type StateRuns } from '../model/model.js';

/** "4.12 ms", "850 us", "1.25 s": three significant figures, units chosen for readability. */
export function fmtDur(ns: number): string {
  if (!Number.isFinite(ns)) return 'unknown';
  const a = Math.abs(ns);
  if (a >= 1e9) return `${(ns / 1e9).toFixed(a >= 1e10 ? 1 : 2)} s`;
  if (a >= 1e6) return `${(ns / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)} ms`;
  if (a >= 1e3) return `${(ns / 1e3).toFixed(0)} us`;
  return `${ns.toFixed(0)} ns`;
}

/** Trace-relative timestamp, "1.234567 s". */
export function fmtTime(ns: number): string {
  return `${(ns / 1e9).toFixed(6)} s`;
}

export function threadLabel(m: Model, th: number): string {
  return th >= 0 ? m.threads[th].label : 'an unknown thread';
}

/** Short name for prose: the thread name, or process/tid. */
export function threadShort(m: Model, th: number): string {
  if (th < 0) return 'an unknown thread';
  const T = m.threads[th];
  return T.name || `${T.process} tid ${T.tid}`;
}

/** Time a thread spent in each state during [a, b]. */
export function stateBreakdown(r: StateRuns, a: number, b: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let k = firstRunEndingAfter(r, a); k < r.n && r.start[k] < b; k++) {
    const d = Math.min(b, r.end[k]) - Math.max(a, r.start[k]);
    if (d > 0) out.set(r.state[k], (out.get(r.state[k]) ?? 0) + d);
  }
  return out;
}

export interface Interferer {
  thread: number;
  ns: number;
  prio: number;
}

/** Who ran on `cpu` during [a, b], excluding `exclude` and idle threads, sorted by time. */
export function cpuOccupants(m: Model, cpu: number, a: number, b: number, exclude: Set<number> = new Set()): Interferer[] {
  const c: CpuRuns | undefined = m.cpus[cpu];
  if (!c) return [];
  const acc = new Map<number, Interferer>();
  for (let k = firstRunEndingAfter(c, a); k < c.n && c.start[k] < b; k++) {
    const th = c.thread[k];
    if (th < 0 || exclude.has(th) || m.threads[th].isIdle) continue;
    const d = Math.min(b, c.end[k]) - Math.max(a, c.start[k]);
    if (d <= 0) continue;
    const it = acc.get(th) ?? { thread: th, ns: 0, prio: c.prio[k] };
    it.ns += d;
    it.prio = Math.max(it.prio, c.prio[k]);
    acc.set(th, it);
  }
  return [...acc.values()].sort((x, y) => y.ns - x.ns);
}

/** The CPU a thread mostly runs on (from its RUNNING runs), or 0. */
export function homeCpu(m: Model, th: number): number {
  const r = m.threads[th].runs;
  const per = new Map<number, number>();
  for (let k = 0; k < r.n; k++) if (r.state[k] === ST.RUNNING) per.set(r.cpu[k], (per.get(r.cpu[k]) ?? 0) + (r.end[k] - r.start[k]));
  let best = 0;
  let bestNs = -1;
  for (const [c, ns] of per) if (ns > bestNs) [best, bestNs] = [c, ns];
  return best;
}

/** Priority a thread had at time t (from the state run covering t), or its base priority. */
export function prioAt(m: Model, th: number, t: number): number {
  const r = m.threads[th].runs;
  let k = firstRunEndingAfter(r, t);
  if (k >= r.n) k = r.n - 1;
  if (k >= 0 && r.prio[k] >= 0) return r.prio[k];
  return m.threads[th].basePrio;
}

/**
 * Evidence for a time window: state changes of the involved threads, their mutex and message
 * kernel calls and job markers, interrupts they handle, and who ran on their CPUs. Capped, keeping
 * the events nearest the window's key moments.
 */
export function collectEvidence(
  m: Model,
  threads: number[],
  a: number,
  b: number,
  opts: { max: number; intr?: number; cpus?: number[]; keyEvents?: number[] },
): number[] {
  const e = m.trace.events;
  const want = new Set(threads);
  const cpus = new Set(opts.cpus ?? []);
  const out: number[] = [];
  const keySet = new Set(opts.keyEvents ?? []);
  const i0 = eventAtOrAfter(m, a);
  const i1 = eventAtOrAfter(m, b + 1);
  for (let i = i0; i < i1; i++) {
    const cls = e.cls[i];
    if (keySet.has(i)) {
      out.push(i);
      continue;
    }
    if (cls === Cls.PR_TH && e.code[i] < 64) {
      const th = m.threadIndex.get(`${e.f0[i]}/${e.f1[i]}`);
      if (th !== undefined && want.has(th)) out.push(i);
      else if (th !== undefined && e.code[i] === ST.RUNNING && cpus.has(e.cpu[i]) && !m.threads[th].isIdle) out.push(i);
      continue;
    }
    const self = m.eventThread[i];
    if (cls === Cls.KERCALL && self >= 0 && want.has(self)) {
      const num = e.code[i] & 0x7f;
      if (
        num === Ker.SYNC_MUTEX_LOCK ||
        num === Ker.SYNC_MUTEX_UNLOCK ||
        num === Ker.MSG_SENDV ||
        num === Ker.MSG_RECEIVEV ||
        num === Ker.MSG_REPLYV ||
        num === Ker.MSG_ERROR ||
        num === Ker.INTERRUPT_WAIT ||
        (num === Ker.TIMER_TIMEOUT && !(e.code[i] & KC_EXIT))
      )
        out.push(i);
      continue;
    }
    if (cls === Cls.USER && self >= 0 && want.has(self)) out.push(i);
    else if (cls === Cls.COMM && self >= 0 && want.has(self)) out.push(i);
    else if (cls === Cls.INT && opts.intr !== undefined && e.f0[i] === opts.intr) out.push(i);
  }
  if (out.length <= opts.max) return out;
  // Too many: keep the key events and an even spread of the rest.
  const keep = new Set<number>([...keySet].filter((x) => x >= i0 && x < i1));
  const rest = out.filter((x) => !keep.has(x));
  const room = Math.max(0, opts.max - keep.size);
  const step = rest.length / Math.max(1, room);
  for (let k = 0; k < room; k++) keep.add(rest[Math.floor(k * step)]);
  return [...keep].sort((x, y) => x - y);
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(x >= 0.995 ? 1 : 0)}%`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
