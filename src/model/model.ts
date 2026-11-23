// The analysis model: what each thread and CPU was doing over time, built in one pass over the
// decoded events. Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
//
// QNX vocabulary used throughout:
//   thread states   RUNNING, READY, and the blocked states (SEND, REPLY, RECEIVE, MUTEX, NANOSLEEP,
//                   INTR, CONDVAR, SEM, ...), from the THREAD class events
//   messages        MsgSend() -> MsgReceive() -> MsgReply(), linked by the receive id (rcvid)
//   mutex waits     SyncMutexLock() that blocked; the owner word names the holder
//   ISTs            threads attached with InterruptAttachThread()/InterruptAttachEvent()

import { Cls, Comm, Control, KC_EXIT, Ker, Proc, ThreadState, Sys } from '../kev/constants.js';
import type { Trace } from '../kev/types.js';

export const ST = ThreadState;

/** One contiguous stretch of a thread in a single state. Columnar per thread. */
export interface StateRuns {
  n: number;
  start: Float64Array; // ns
  end: Float64Array; // ns
  state: Uint8Array;
  prio: Int16Array; // -1 if the trace was captured in fast mode
  cpu: Int8Array; // CPU of the event that started the run
  ev: Int32Array; // event index that started the run
}

export interface ThreadInfo {
  index: number;
  pid: number;
  tid: number;
  name: string; // thread name or "" if never named
  process: string; // process short name
  label: string; // "brakesim/brake_ctl"
  isIdle: boolean; // procnto's idle thread for a CPU
  isKernel: boolean; // a procnto (pid 1) thread
  runs: StateRuns;
  prioMin: number;
  prioMax: number;
  /** Most frequent priority while RUNNING: the thread's "own" priority, boosts excluded. */
  basePrio: number;
  policy: number;
  runningNs: number;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  path: string;
  name: string;
}

export interface CpuRuns {
  n: number;
  start: Float64Array;
  end: Float64Array;
  thread: Int32Array; // thread index, or -1 when unknown
  prio: Int16Array;
}

export interface Interrupts {
  n: number;
  t: Float64Array;
  cpu: Uint8Array;
  intr: Float64Array;
  ev: Int32Array;
}

export interface IstBinding {
  thread: number;
  intr: number;
  cpu: number;
  istPrio: number;
  flags: number;
  ev: number;
}

/** A Neutrino message transaction. Times are NaN when outside the trace. */
export interface MessageTxn {
  id: number;
  client: number; // thread index
  server: number; // server thread index, -1 until received
  serverPid: number;
  rcvid: number;
  tSend: number; // MsgSend() entered
  tReceive: number; // server's MsgReceive() returned with this message
  tReply: number; // server called MsgReply()/MsgError()
  error: boolean;
  evSend: number;
  evReceive: number;
  evReply: number;
  clientPrio: number; // priority the server received at (info->priority)
}

export interface Pulse {
  t: number;
  from: number; // thread index of the sender (running thread), -1 if unknown
  toPid: number;
  ev: number;
}

/** A SyncMutexLock() that blocked the caller. */
export interface MutexWait {
  waiter: number;
  holder: number; // thread index or -1 if unresolved
  sync: number; // mutex address
  owner: number; // raw owner word
  tLock: number; // SyncMutexLock() entered
  tBlock: number; // entered STATE_MUTEX
  tWake: number; // left STATE_MUTEX (NaN if still waiting at the end)
  evLock: number;
  evBlock: number;
  evWake: number;
  evUnlock: number; // the holder's SyncMutexUnlock() that released it, -1 if not seen
}

export interface JobMarker {
  thread: number;
  t: number;
  code: number;
  d0: number;
  d1: number;
  ev: number;
}

export interface Note {
  thread: number;
  t: number;
  code: number;
  text: string;
  ev: number;
}

export interface Model {
  trace: Trace;
  /** ns since the first event, per event. */
  time: Float64Array;
  durationNs: number;
  nsPerCycle: number;
  cpuCount: number;
  processes: Map<number, ProcessInfo>;
  threads: ThreadInfo[];
  threadIndex: Map<string, number>; // "pid/tid" -> index
  /** Thread running on each event's CPU when the event was logged (-1 if unknown). */
  eventThread: Int32Array;
  cpus: CpuRuns[];
  interrupts: Interrupts;
  ists: IstBinding[];
  messages: MessageTxn[];
  pulses: Pulse[];
  mutexWaits: MutexWait[];
  markers: JobMarker[];
  notes: Note[];
  timers: { t: number; thread: number; ev: number }[];
  warnings: string[];
  buildMs: number;
}

const key = (pid: number, tid: number) => `${pid}/${tid}`;

class RunBuilder {
  start: number[] = [];
  end: number[] = [];
  state: number[] = [];
  prio: number[] = [];
  cpu: number[] = [];
  ev: number[] = [];
  freeze(endNs: number): StateRuns {
    const n = this.start.length;
    const r: StateRuns = {
      n,
      start: Float64Array.from(this.start),
      end: Float64Array.from(this.end),
      state: Uint8Array.from(this.state),
      prio: Int16Array.from(this.prio),
      cpu: Int8Array.from(this.cpu),
      ev: Int32Array.from(this.ev),
    };
    if (n && Number.isNaN(r.end[n - 1])) r.end[n - 1] = endNs;
    return r;
  }
}

function shortName(path: string): string {
  const base = path.split('/').filter(Boolean).pop() ?? path;
  return base || path;
}

/** QNX packs a mutex owner as ((pid & 0x7fff) << 16) | tid, plus bit 31 when there are waiters. */
export function ownerKey(owner: number): number {
  return (owner & 0x7fffffff) >>> 0;
}
export function ownerKeyOf(pid: number, tid: number): number {
  return ((((pid & 0x7fff) << 16) | (tid & 0xffff)) & 0x7fffffff) >>> 0;
}

export function buildModel(trace: Trace): Model {
  const t0 = performance.now();
  const e = trace.events;
  const n = e.n;
  const cps = trace.header.cyclesPerSec || 1e9;
  const nsPerCycle = 1e9 / cps;
  const origin = trace.originCycles;
  const time = new Float64Array(n);
  for (let i = 0; i < n; i++) time[i] = (e.cycles[i] - origin) * nsPerCycle;
  const durationNs = n ? time[n - 1] : 0;
  const cpuCount = Math.max(trace.header.cpuCount, 1);
  const warnings: string[] = [];
  if (trace.stats.droppedEvents > 0) {
    warnings.push(`The kernel dropped ${trace.stats.droppedEvents} events in ${trace.stats.droppedBuffers} buffers: gaps are possible.`);
  }

  const processes = new Map<number, ProcessInfo>();
  const threads: ThreadInfo[] = [];
  const runBuilders: RunBuilder[] = [];
  const threadIndex = new Map<string, number>();
  const ownerToThread = new Map<number, number>();
  const threadName = new Map<number, string>();

  const getThread = (pid: number, tid: number): number => {
    const k = key(pid, tid);
    let idx = threadIndex.get(k);
    if (idx === undefined) {
      idx = threads.length;
      threadIndex.set(k, idx);
      threads.push({
        index: idx,
        pid,
        tid,
        name: '',
        process: '',
        label: '',
        isIdle: false,
        isKernel: pid === 1,
        runs: undefined as unknown as StateRuns,
        prioMin: 255,
        prioMax: -1,
        basePrio: -1,
        policy: -1,
        runningNs: 0,
      });
      runBuilders.push(new RunBuilder());
      ownerToThread.set(ownerKeyOf(pid, tid), idx);
    }
    return idx;
  };

  const eventThread = new Int32Array(n).fill(-1);
  const current = new Int32Array(64).fill(-1); // running thread per CPU
  const cpuStart: number[][] = Array.from({ length: 64 }, () => []);
  const cpuThread: number[][] = Array.from({ length: 64 }, () => []);
  const cpuPrio: number[][] = Array.from({ length: 64 }, () => []);
  const lastState = new Map<number, number>(); // thread -> current state

  const intT: number[] = [];
  const intCpu: number[] = [];
  const intId: number[] = [];
  const intEv: number[] = [];
  const ists: IstBinding[] = [];
  const messages: MessageTxn[] = [];
  const pulses: Pulse[] = [];
  // rcvids are local to the server process, so key by "server pid:rcvid"
  const awaitingReceive = new Map<string, MessageTxn[]>(); // sent, not yet received
  const awaitingReply = new Map<string, MessageTxn>(); // received, not yet replied
  const sendEnter = new Map<number, { t: number; ev: number }>(); // client thread -> MsgSend entry
  const openTxn = new Map<number, MessageTxn>(); // client thread -> its transaction in progress
  const lockEnter = new Map<number, { t: number; ev: number; sync: number; owner: number }>();
  // A condvar waiter re-acquires its mutex inside the kernel (no SyncMutexLock call), so remember it.
  const condvarMutex = new Map<number, { t: number; ev: number; sync: number; owner: number }>();
  const openWait = new Map<number, MutexWait>(); // waiter -> wait in progress
  const lastUnlock = new Map<number, { thread: number; ev: number; t: number }>(); // sync -> last unlock
  const mutexWaits: MutexWait[] = [];
  const markers: JobMarker[] = [];
  const notes: Note[] = [];
  const timers: { t: number; thread: number; ev: number }[] = [];
  const prioHist = new Map<number, Map<number, number>>(); // thread -> prio -> count while RUNNING

  for (let i = 0; i < n; i++) {
    const cls = e.cls[i];
    const code = e.code[i];
    const cpu = e.cpu[i];
    const t = time[i];
    eventThread[i] = current[cpu];

    if (cls === Cls.PR_TH) {
      if (code < 64) {
        const th = getThread(e.f0[i], e.f1[i]);
        const prio = e.f2[i];
        const T = threads[th];
        if (prio >= 0) {
          if (prio < T.prioMin) T.prioMin = prio;
          if (prio > T.prioMax) T.prioMax = prio;
        }
        if (e.f3[i] >= 0) T.policy = e.f3[i];
        if (code === ST.CREATE || code === ST.DESTROY) continue;
        const rb = runBuilders[th];
        const last = rb.start.length - 1;
        if (last >= 0 && Number.isNaN(rb.end[last])) rb.end[last] = t;
        rb.start.push(t);
        rb.end.push(Number.NaN);
        rb.state.push(code);
        rb.prio.push(prio);
        rb.cpu.push(cpu);
        rb.ev.push(i);
        const prev = lastState.get(th);
        lastState.set(th, code);

        // A client that leaves SEND/REPLY without being received or replied to was unblocked
        // (timeout, signal, unblock pulse): close its transaction so the rcvid can be reused.
        const ot = openTxn.get(th);
        if (ot && code !== ST.SEND && code !== ST.REPLY) {
          if (Number.isNaN(ot.tReply)) {
            const rk = `${ot.serverPid}:${ot.rcvid}`;
            if (Number.isNaN(ot.tReceive)) {
              const l = awaitingReceive.get(rk);
              const k = l ? l.indexOf(ot) : -1;
              if (l && k >= 0) l.splice(k, 1);
            } else if (awaitingReply.get(rk) === ot) awaitingReply.delete(rk);
            ot.tReply = t;
            ot.evReply = i;
            ot.error = true;
          }
          openTxn.delete(th);
        }

        if (code === ST.RUNNING) {
          // The CPU now runs this thread; if it was running elsewhere it migrated.
          for (let c = 0; c < 64; c++) if (c !== cpu && current[c] === th) current[c] = -1;
          current[cpu] = th;
          cpuStart[cpu].push(t);
          cpuThread[cpu].push(th);
          cpuPrio[cpu].push(prio);
          eventThread[i] = th;
          if (prio >= 0) {
            let h = prioHist.get(th);
            if (!h) prioHist.set(th, (h = new Map()));
            h.set(prio, (h.get(prio) ?? 0) + 1);
          }
        } else if (current[cpu] === th) {
          // It stopped running on this CPU; whoever runs next will log THRUNNING.
          current[cpu] = -1;
        }

        // Mutex waits: block and wake.
        if (code === ST.MUTEX) {
          const le = lockEnter.get(th) ?? condvarMutex.get(th);
          const holderByOwner = le ? (ownerToThread.get(ownerKey(le.owner)) ?? -1) : -1;
          const w: MutexWait = {
            waiter: th,
            holder: holderByOwner,
            sync: le ? le.sync : Number.NaN,
            owner: le ? le.owner : 0,
            tLock: le ? le.t : t,
            tBlock: t,
            tWake: Number.NaN,
            evLock: le ? le.ev : -1,
            evBlock: i,
            evWake: -1,
            evUnlock: -1,
          };
          openWait.set(th, w);
          mutexWaits.push(w);
        } else if (prev === ST.MUTEX) {
          condvarMutex.delete(th);
          const w = openWait.get(th);
          if (w) {
            w.tWake = t;
            w.evWake = i;
            openWait.delete(th);
            const u = lastUnlock.get(w.sync);
            if (u && u.t >= w.tBlock) {
              w.evUnlock = u.ev;
              if (w.holder < 0) w.holder = u.thread;
            }
          }
        }
        continue;
      }
      // process events
      if (code === Proc.CREATE_NAME || code === Proc.CREATE || code === Proc.DESTROY_NAME) {
        const pid = e.f1[i];
        const path = e.str[i] >= 0 ? e.strings[e.str[i]] : '';
        const p = processes.get(pid);
        if (!p) processes.set(pid, { pid, ppid: e.f0[i], path, name: shortName(path) });
        else if (path) {
          p.path = path;
          p.name = shortName(path);
        }
      } else if (code === Proc.THREAD_NAME) {
        const th = getThread(e.f0[i], e.f1[i]);
        const nm = e.str[i] >= 0 ? e.strings[e.str[i]] : '';
        if (nm) threadName.set(th, nm);
      }
      continue;
    }

    const self = current[cpu];
    switch (cls) {
      case Cls.INT:
        intT.push(t);
        intCpu.push(cpu);
        intId.push(e.f0[i]);
        intEv.push(i);
        break;
      case Cls.SYSTEM: {
        const ev = code & 0x1ff;
        if (ev === Sys.IST_ATTACH) {
          const th = getThread(e.f0[i], e.f1[i]);
          ists.push({ thread: th, intr: e.f2[i], cpu: e.f3[i], flags: e.f4[i], istPrio: e.f5[i], ev: i });
        } else if (ev === Sys.TIMER) {
          timers.push({ t, thread: getThread(e.f0[i], e.f1[i]), ev: i });
        }
        break;
      }
      case Cls.USER:
        if (e.str[i] >= 0) notes.push({ thread: self, t, code, text: e.strings[e.str[i]], ev: i });
        else markers.push({ thread: self, t, code, d0: e.f0[i], d1: e.f1[i], ev: i });
        break;
      case Cls.COMM: {
        if (code === Comm.SMSG) {
          const rcvid = e.f0[i];
          const se = self >= 0 ? sendEnter.get(self) : undefined;
          const txn: MessageTxn = {
            id: messages.length,
            client: self,
            server: -1,
            serverPid: e.f1[i],
            rcvid,
            tSend: se ? se.t : t,
            tReceive: Number.NaN,
            tReply: Number.NaN,
            error: false,
            evSend: se ? se.ev : i,
            evReceive: -1,
            evReply: -1,
            clientPrio: -1,
          };
          if (self >= 0) {
            sendEnter.delete(self);
            openTxn.set(self, txn);
          }
          messages.push(txn);
          const rk = `${txn.serverPid}:${rcvid}`;
          let l = awaitingReceive.get(rk);
          if (!l) awaitingReceive.set(rk, (l = []));
          l.push(txn);
        } else if (code >= Comm.SPULSE && code <= Comm.SPULSE_QUN && code !== Comm.RMSG && code !== Comm.RPULSE) {
          pulses.push({ t, from: self, toPid: e.f1[i], ev: i });
        }
        break;
      }
      case Cls.KERCALL: {
        const num = code & 0x7f;
        const exit = (code & KC_EXIT) !== 0;
        if (self < 0) break;
        if (!exit) {
          if (num === Ker.MSG_SENDV || num === Ker.MSG_SENDVNC) sendEnter.set(self, { t, ev: i });
          else if (num === Ker.SYNC_MUTEX_LOCK) lockEnter.set(self, { t, ev: i, sync: e.f0[i], owner: e.f2[i] });
          else if (num === Ker.SYNC_MUTEX_UNLOCK) lastUnlock.set(e.f0[i], { thread: self, ev: i, t });
          else if (num === Ker.SYNC_CONDVAR_WAIT) condvarMutex.set(self, { t, ev: i, sync: e.f1[i], owner: e.f2[i] });
          else if (num === Ker.MSG_REPLYV || num === Ker.MSG_ERROR) {
            const rk = `${threads[self].pid}:${e.f0[i]}`;
            const txn = awaitingReply.get(rk);
            if (txn) {
              txn.tReply = t;
              txn.evReply = i;
              txn.error = num === Ker.MSG_ERROR;
              awaitingReply.delete(rk);
            }
          }
        } else if ((num === Ker.MSG_RECEIVEV || num === Ker.MSG_RECEIVEPULSEV) && e.f0[i] > 0) {
          const rcvid = e.f0[i];
          const cpid = e.f1[i];
          const ctid = e.f2[i];
          const l = awaitingReceive.get(`${threads[self].pid}:${rcvid}`);
          let txn: MessageTxn | undefined;
          // info->pid/tid are only filled in when the server passed an info buffer to MsgReceive();
          // otherwise they are 0 and the rcvid (oldest first, same server process) decides.
          const myPid = threads[self].pid;
          if (l && l.length) {
            let k = -1;
            if (cpid > 0) k = l.findIndex((x) => x.client >= 0 && threads[x.client].pid === cpid && threads[x.client].tid === ctid);
            if (k < 0) k = l.findIndex((x) => x.serverPid === myPid);
            if (k < 0) k = 0;
            txn = l.splice(k, 1)[0];
          }
          if (!txn && cpid > 0) {
            // The send happened before the trace started.
            txn = {
              id: messages.length,
              client: getThread(cpid, ctid),
              server: -1,
              serverPid: threads[self].pid,
              rcvid,
              tSend: Number.NaN,
              tReceive: Number.NaN,
              tReply: Number.NaN,
              error: false,
              evSend: -1,
              evReceive: -1,
              evReply: -1,
              clientPrio: -1,
            };
            messages.push(txn);
          }
          if (txn) {
            if (txn.client < 0 && cpid > 0) txn.client = getThread(cpid, ctid);
            txn.server = self;
            txn.tReceive = t;
            txn.evReceive = i;
            txn.clientPrio = e.f3[i];
            awaitingReply.set(`${threads[self].pid}:${rcvid}`, txn);
          }
        } else if (num === Ker.SYNC_MUTEX_LOCK) {
          lockEnter.delete(self);
        }
        break;
      }
      case Cls.CONTROL:
        if (code === Control.DROPPED) {
          // already counted in stats
        }
        break;
    }
  }

  // Finish threads.
  for (const T of threads) {
    T.runs = runBuilders[T.index].freeze(durationNs);
    const p = processes.get(T.pid);
    T.process = p?.name || (T.pid === 1 ? 'procnto' : `pid ${T.pid}`);
    T.name = threadName.get(T.index) ?? '';
    T.isIdle = T.pid === 1 && /^idle/.test(T.name);
    T.label = `${T.process}/${T.name || `tid ${T.tid}`}`;
    const h = prioHist.get(T.index);
    if (h) {
      let best = -1;
      let bestN = -1;
      for (const [p2, c] of h) if (c > bestN || (c === bestN && p2 < best)) [best, bestN] = [p2, c];
      T.basePrio = best;
    } else T.basePrio = T.prioMin <= T.prioMax ? T.prioMin : -1;
    let run = 0;
    const r = T.runs;
    for (let k = 0; k < r.n; k++) if (r.state[k] === ST.RUNNING) run += r.end[k] - r.start[k];
    T.runningNs = run;
  }
  // Thread names may repeat across processes (send_chain forks); make labels unique.
  const seen = new Map<string, number>();
  for (const T of threads) seen.set(T.label, (seen.get(T.label) ?? 0) + 1);
  for (const T of threads) if ((seen.get(T.label) ?? 0) > 1) T.label = `${T.process}[${T.pid}]/${T.name || `tid ${T.tid}`}`;

  const cpus: CpuRuns[] = [];
  for (let c = 0; c < cpuCount; c++) {
    const s = cpuStart[c];
    const m = s.length;
    const runs: CpuRuns = {
      n: m,
      start: Float64Array.from(s),
      end: new Float64Array(m),
      thread: Int32Array.from(cpuThread[c]),
      prio: Int16Array.from(cpuPrio[c]),
    };
    for (let k = 0; k < m; k++) runs.end[k] = k + 1 < m ? s[k + 1] : durationNs;
    cpus.push(runs);
  }

  const interrupts: Interrupts = {
    n: intT.length,
    t: Float64Array.from(intT),
    cpu: Uint8Array.from(intCpu),
    intr: Float64Array.from(intId),
    ev: Int32Array.from(intEv),
  };

  return {
    trace,
    time,
    durationNs,
    nsPerCycle,
    cpuCount,
    processes,
    threads,
    threadIndex,
    eventThread,
    cpus,
    interrupts,
    ists,
    messages,
    pulses,
    mutexWaits,
    markers,
    notes,
    timers,
    warnings,
    buildMs: performance.now() - t0,
  };
}

/** Index of the run of `r` covering time t (or -1). Binary search on start. */
export function runAt(r: StateRuns | CpuRuns, t: number): number {
  let lo = 0;
  let hi = r.n - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (r.start[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (ans >= 0 && r.end[ans] < t) return -1;
  return ans;
}

/** First run index whose end is after t. */
export function firstRunEndingAfter(r: StateRuns | CpuRuns, t: number): number {
  let lo = 0;
  let hi = r.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r.end[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First event index with time >= t. */
export function eventAtOrAfter(m: Model, t: number): number {
  let lo = 0;
  let hi = m.time.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m.time[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function isBlockedState(s: number): boolean {
  return s !== ST.RUNNING && s !== ST.READY && s !== ST.DEAD && s !== ST.STOPPED;
}

export function stateName(s: number): string {
  for (const [k, v] of Object.entries(ST)) if (v === s) return k;
  return `STATE${s}`;
}

export function threadByName(m: Model, name: string): ThreadInfo[] {
  const n = name.trim();
  return m.threads.filter(
    (T) => T.name === n || T.label === n || `${T.process}/${T.name}` === n || `${T.pid}/${T.tid}` === n || `${T.process}:${T.name}` === n,
  );
}
