// Decoded trace: header plus a columnar event table shared by both decoders (our .kev reader and
// the traceprinter text reader). Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later

export interface TraceHeader {
  /** Every TRACE_<KEY>::<value> attribute from the file, keyed without the TRACE_ prefix. */
  attrs: Record<string, string>;
  cyclesPerSec: number;
  cpuCount: number;
  littleEndian: boolean;
  sysRelease: string;
  sysVersion: string;
  kernelVersion: string;
  machine: string;
  nodename: string;
  date: string;
  bootDate: string;
  traceloggerArgs: string;
}

/**
 * One row per kernel event, in time order. f0..f5 hold the decoded payload; their meaning depends on
 * the event (see decodeFields() in reader.ts):
 *
 *   THREAD state, THCREATE, THDESTROY   f0 pid, f1 tid, f2 priority (-1 in fast mode), f3 policy
 *   PROCCREATE, PROCDESTROY             f0 ppid, f1 pid            (+ str: name for *_NAME)
 *   PROCTHREAD_NAME                     f0 pid, f1 tid, str name
 *   INT_DELIVER                         f0 interrupt id
 *   COMM                                f0 rcvid | scoid | tid, f1 pid
 *   SYSTEM TIMER                        f0 pid, f1 tid, f2 timer id, f3 flags
 *   SYSTEM IST_ATTACH / IST_DETACH      f0 pid, f1 tid, f2 interrupt id, f3 cpu, f4 flags, f5 IST priority
 *   SYSTEM PATHMGR_OPEN                 f0 pid, f1 tid, str path
 *   USREVENT                            f0 d0, f1 d1 (simple) or str (string event)
 *   CONTROL                             TIME f0 msb f1 lsb, BUFFER f0 seq f1 count, DROPPED f0 count
 *   KER_CALL SYNC_MUTEX_LOCK/UNLOCK     f0 sync pointer, f1 count, f2 owner
 *   KER_CALL SYNC_CONDVAR_WAIT          f0 condvar pointer, f1 mutex pointer, f2 mutex owner
 *   KER_CALL MSG_SENDV(NC)              f0 coid, f1 send parts, f2 receive parts
 *   KER_CALL MSG_RECEIVEV/PULSEV        f0 chid
 *   KER_EXIT MSG_RECEIVEV/PULSEV        f0 rcvid, f1 client pid, f2 client tid, f3 client priority,
 *                                       f4 chid, f5 scoid  (pid/tid/priority -1 in fast mode)
 *   KER_CALL MSG_REPLYV                 f0 rcvid, f1 status
 *   KER_CALL MSG_ERROR                  f0 rcvid, f1 error
 *   KER_CALL INTERRUPT_ATTACH           f0 interrupt, f1 flags
 *   KER_CALL INTERRUPT_WAIT             f0 flags
 *   other KER_EXIT                      f0 return value, f1 second word
 */
export interface EventTable {
  n: number;
  /** Absolute 64-bit cycle counter (ClockCycles()) as a double; exact below 2^53. */
  cycles: Float64Array;
  cpu: Uint8Array;
  /** Internal class (bits 10..14 of the header), see Cls. */
  cls: Uint8Array;
  /** Event code (bits 0..9 of the header). */
  code: Uint16Array;
  f0: Float64Array;
  f1: Float64Array;
  f2: Float64Array;
  f3: Float64Array;
  f4: Float64Array;
  f5: Float64Array;
  /** Index into `strings`, or -1. */
  str: Int32Array;
  strings: string[];
  /** Number of 16-byte slots the event used in the file (binary decoder only). */
  slots?: Uint8Array;
}

export interface TraceStats {
  bytes: number;
  slots: number;
  buffers: number;
  /** Events the kernel reported as dropped (CONTROL DROPPED). */
  droppedEvents: number;
  droppedBuffers: number;
  /** Continuation slots whose first slot was missing, and combine events never completed. */
  orphanSlots: number;
  incompleteEvents: number;
  parseMs: number;
}

export interface Trace {
  header: TraceHeader;
  events: EventTable;
  decoder: 'kev' | 'traceprinter';
  stats: TraceStats;
  /** Cycle count of the first event; model times are nanoseconds from here. */
  originCycles: number;
}

export function emptyHeader(): TraceHeader {
  return {
    attrs: {},
    cyclesPerSec: 0,
    cpuCount: 1,
    littleEndian: true,
    sysRelease: '',
    sysVersion: '',
    kernelVersion: '',
    machine: '',
    nodename: '',
    date: '',
    bootDate: '',
    traceloggerArgs: '',
  };
}

export function headerFromAttrs(attrs: Record<string, string>): TraceHeader {
  const h = emptyHeader();
  h.attrs = attrs;
  h.cyclesPerSec = Number(attrs.CYCLES_PER_SEC ?? 0);
  h.cpuCount = Number(attrs.CPU_NUM ?? 1) || 1;
  h.littleEndian = (attrs.LITTLE_ENDIAN ?? 'TRUE').trim().toUpperCase() !== 'FALSE' && !('BIG_ENDIAN' in attrs);
  h.sysRelease = attrs.SYS_RELEASE ?? '';
  h.sysVersion = attrs.SYS_VERSION ?? '';
  h.kernelVersion = attrs.KERNEL_VERSION ?? '';
  h.machine = attrs.MACHINE ?? '';
  h.nodename = attrs.NODENAME ?? '';
  h.date = attrs.DATE ?? '';
  h.bootDate = attrs.BOOT_DATE ?? '';
  h.traceloggerArgs = attrs.TRACELOGGER_ARGS ?? '';
  return h;
}

/** Growable columnar builder used by both decoders. */
export class EventTableBuilder {
  n = 0;
  private cap: number;
  cycles: Float64Array;
  cpu: Uint8Array;
  cls: Uint8Array;
  code: Uint16Array;
  f0: Float64Array;
  f1: Float64Array;
  f2: Float64Array;
  f3: Float64Array;
  f4: Float64Array;
  f5: Float64Array;
  str: Int32Array;
  slots: Uint8Array;
  strings: string[] = [];
  private stringIds = new Map<string, number>();

  constructor(capacity = 1024) {
    this.cap = Math.max(16, capacity);
    this.cycles = new Float64Array(this.cap);
    this.cpu = new Uint8Array(this.cap);
    this.cls = new Uint8Array(this.cap);
    this.code = new Uint16Array(this.cap);
    this.f0 = new Float64Array(this.cap);
    this.f1 = new Float64Array(this.cap);
    this.f2 = new Float64Array(this.cap);
    this.f3 = new Float64Array(this.cap);
    this.f4 = new Float64Array(this.cap);
    this.f5 = new Float64Array(this.cap);
    this.str = new Int32Array(this.cap);
    this.slots = new Uint8Array(this.cap);
  }

  private grow(): void {
    const cap = this.cap * 2;
    const g = <T extends Float64Array | Uint8Array | Uint16Array | Int32Array>(a: T): T => {
      const b = new (a.constructor as { new (n: number): T })(cap);
      b.set(a);
      return b;
    };
    this.cycles = g(this.cycles);
    this.cpu = g(this.cpu);
    this.cls = g(this.cls);
    this.code = g(this.code);
    this.f0 = g(this.f0);
    this.f1 = g(this.f1);
    this.f2 = g(this.f2);
    this.f3 = g(this.f3);
    this.f4 = g(this.f4);
    this.f5 = g(this.f5);
    this.str = g(this.str);
    this.slots = g(this.slots);
    this.cap = cap;
  }

  /** Append an event and return its row; fields default to 0 and str to -1. */
  add(cycles: number, cpu: number, cls: number, code: number): number {
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    this.cycles[i] = cycles;
    this.cpu[i] = cpu;
    this.cls[i] = cls;
    this.code[i] = code;
    this.str[i] = -1;
    this.slots[i] = 1;
    return i;
  }

  intern(s: string): number {
    let id = this.stringIds.get(s);
    if (id === undefined) {
      id = this.strings.length;
      this.strings.push(s);
      this.stringIds.set(s, id);
    }
    return id;
  }

  /** Finish, reordering rows by `order` (row indices in final order) when given. */
  build(order?: Uint32Array): EventTable {
    const n = this.n;
    const pick = <T extends Float64Array | Uint8Array | Uint16Array | Int32Array>(a: T): T => {
      if (!order) return a.slice(0, n) as T;
      const b = new (a.constructor as { new (n: number): T })(n);
      for (let i = 0; i < n; i++) b[i] = a[order[i]];
      return b;
    };
    return {
      n,
      cycles: pick(this.cycles),
      cpu: pick(this.cpu),
      cls: pick(this.cls),
      code: pick(this.code),
      f0: pick(this.f0),
      f1: pick(this.f1),
      f2: pick(this.f2),
      f3: pick(this.f3),
      f4: pick(this.f4),
      f5: pick(this.f5),
      str: pick(this.str),
      strings: this.strings,
      slots: pick(this.slots),
    };
  }
}
