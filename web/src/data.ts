// Timeline data in the browser: the server's binary pack mapped onto typed arrays, plus per-lane
// prefix sums so any pixel column's running/ready time is two binary searches away.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later

export const S = {
  DEAD: 0,
  RUNNING: 1,
  READY: 2,
  STOPPED: 3,
  SEND: 4,
  RECEIVE: 5,
  REPLY: 6,
  NANOSLEEP: 12,
  MUTEX: 13,
  CONDVAR: 14,
  JOIN: 15,
  INTR: 16,
  SEM: 17,
} as const;

export const STATE_NAMES: Record<number, string> = {
  0: 'DEAD',
  1: 'RUNNING',
  2: 'READY',
  3: 'STOPPED',
  4: 'SEND',
  5: 'RECEIVE',
  6: 'REPLY',
  7: 'MQ_SEND',
  8: 'MQ_RECEIVE',
  9: 'WAITPAGE',
  10: 'SIGSUSPEND',
  11: 'SIGWAITINFO',
  12: 'NANOSLEEP',
  13: 'MUTEX',
  14: 'CONDVAR',
  15: 'JOIN',
  16: 'INTR',
  17: 'SEM',
  18: 'WAITCTX',
  19: 'RWLOCK_READ',
  20: 'RWLOCK_WRITE',
  21: 'BARRIER',
  22: 'PIPE',
  26: 'MUON_MUTEX',
  27: 'TRACEBUFFER',
  28: 'INTR_ATTACH_EV',
  29: 'TIMER_DELEGATE',
  30: 'SEND_NOTIFY',
};

export interface ThreadMeta {
  index: number;
  pid: number;
  tid: number;
  name: string;
  process: string;
  label: string;
  basePrio: number;
  prioMin: number;
  prioMax: number;
  policy: number;
  isIdle: boolean;
  isKernel: boolean;
  runningNs: number;
}

export interface Fact {
  key: string;
  label: string;
  kind: string;
  value: number | string;
  thread?: number;
}

export interface FindingMeta {
  id: string;
  kind: string;
  kindLabel: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  summary: string;
  hint: string;
  threads: number[];
  window: [number, number];
  related: string[];
  facts: Fact[];
  instances: { t0: number; t1: number; value: number; text: string }[];
  instanceCount: number;
  evidenceCount: number;
}

export interface TraceMeta {
  name: string;
  description: string;
  header: Record<string, unknown> & { sysRelease: string; nodename: string; machine: string; kernelVersion: string };
  stats: { droppedEvents: number; parseMs: number };
  decoder: string;
  durationNs: number;
  cpuCount: number;
  events: number;
  timings: { parseMs: number; modelMs: number; detectMs: number };
  deadlinesFile: string | null;
  deadlines: { name: string; periodNs: number; deadlineNs: number }[];
  llm: { model: string; fallback: string } | null;
  recordedExplanations: string[];
  threads: ThreadMeta[];
  findings: FindingMeta[];
  notes: string[];
  notesExtra: { t: number; thread: number; text: string }[];
}

export interface Runs {
  n: number;
  start: Float64Array;
  end: Float64Array;
  state: Uint8Array;
  prio: Int16Array;
  cpu: Int8Array;
  /** cumulative RUNNING / READY time at the start of each run (n + 1 entries) */
  cumRun: Float64Array;
  cumReady: Float64Array;
}

export interface CpuLane {
  n: number;
  start: Float64Array;
  end: Float64Array;
  thread: Int32Array;
  prio: Int16Array;
  /** cumulative non-idle time at the start of each run */
  cumBusy: Float64Array;
}

export interface Timeline {
  threads: Runs[];
  cpus: CpuLane[];
  ints: { t: Float64Array; cpu: Uint8Array; id: Float64Array };
  msgs: { client: Int32Array; server: Int32Array; send: Float64Array; recv: Float64Array; reply: Float64Array; byRecv: Uint32Array };
  marks: { t: Float64Array; thread: Int32Array; code: Int32Array; d0: Float64Array; d1: Float64Array };
}

type Ctor = Float64ArrayConstructor | Int32ArrayConstructor | Int16ArrayConstructor | Int8ArrayConstructor | Uint8ArrayConstructor;
const CTORS: Record<string, Ctor> = { f64: Float64Array, i32: Int32Array, i16: Int16Array, i8: Int8Array, u8: Uint8Array };

export function parsePack(buf: ArrayBuffer, meta: TraceMeta): Timeline {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'LLT1') throw new Error('bad timeline pack');
  const jsonLen = dv.getUint32(4, true);
  const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jsonLen))) as {
    threads: { runOffset: number; runCount: number }[];
    cpus: { offset: number; count: number }[];
    sections: { name: string; type: string; offset: number; length: number }[];
  };
  const sec: Record<string, ArrayLike<number> & { subarray(a: number, b: number): never }> = {};
  for (const s of index.sections) sec[s.name] = new CTORS[s.type](buf, s.offset, s.length) as never;
  const f64 = (k: string) => sec[k] as unknown as Float64Array;
  const threads: Runs[] = index.threads.map(({ runOffset: o, runCount: n }) => {
    const start = f64('run_start').subarray(o, o + n);
    const end = f64('run_end').subarray(o, o + n);
    const state = (sec.run_state as unknown as Uint8Array).subarray(o, o + n);
    const cumRun = new Float64Array(n + 1);
    const cumReady = new Float64Array(n + 1);
    for (let k = 0; k < n; k++) {
      const d = end[k] - start[k];
      cumRun[k + 1] = cumRun[k] + (state[k] === S.RUNNING ? d : 0);
      cumReady[k + 1] = cumReady[k] + (state[k] === S.READY ? d : 0);
    }
    return {
      n,
      start,
      end,
      state,
      prio: (sec.run_prio as unknown as Int16Array).subarray(o, o + n),
      cpu: (sec.run_cpu as unknown as Int8Array).subarray(o, o + n),
      cumRun,
      cumReady,
    };
  });
  const idle = new Set(meta.threads.filter((t) => t.isIdle).map((t) => t.index));
  const cpus: CpuLane[] = index.cpus.map(({ offset: o, count: n }) => {
    const start = f64('cpu_start').subarray(o, o + n);
    const end = f64('cpu_end').subarray(o, o + n);
    const thread = (sec.cpu_thread as unknown as Int32Array).subarray(o, o + n);
    const cumBusy = new Float64Array(n + 1);
    for (let k = 0; k < n; k++) cumBusy[k + 1] = cumBusy[k] + (thread[k] >= 0 && !idle.has(thread[k]) ? end[k] - start[k] : 0);
    return { n, start, end, thread, prio: (sec.cpu_prio as unknown as Int16Array).subarray(o, o + n), cumBusy };
  });
  const recv = f64('msg_recv');
  const byRecv = Uint32Array.from({ length: recv.length }, (_, i) => i).sort((a, b) => recv[a] - recv[b]);
  return {
    threads,
    cpus,
    ints: { t: f64('int_t'), cpu: sec.int_cpu as unknown as Uint8Array, id: f64('int_id') },
    msgs: {
      client: sec.msg_client as unknown as Int32Array,
      server: sec.msg_server as unknown as Int32Array,
      send: f64('msg_send'),
      recv,
      reply: f64('msg_reply'),
      byRecv,
    },
    marks: {
      t: f64('mark_t'),
      thread: sec.mark_thread as unknown as Int32Array,
      code: sec.mark_code as unknown as Int32Array,
      d0: f64('mark_d0'),
      d1: f64('mark_d1'),
    },
  };
}

/** First index k with end[k] > t (runs sorted by start, non-overlapping). */
export function firstEndingAfter(end: Float64Array, n: number, t: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (end[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Cumulative time in a state up to t, from a cumulative array over runs. */
export function cumAt(start: Float64Array, end: Float64Array, cum: Float64Array, n: number, mask: (k: number) => boolean, t: number): number {
  const k = firstEndingAfter(end, n, t);
  if (k >= n) return cum[n];
  let v = cum[k];
  if (start[k] < t && mask(k)) v += t - start[k];
  return v;
}

/** First index with value >= t in a sorted Float64Array. */
export function lowerBound(a: Float64Array, t: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
