// Reader for QNX OS 8.0 tracelogger files (.kev). Copyright (C) 2026 chinesepowered.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// File layout (verified against the SDP 8.0 traceprinter, see docs/build-log.md):
//   "TRACE_HEADER_BEGIN::" then "TRACE_<KEY>::<value>" attributes back to back, "TRACE_HEADER_END::",
//   then TRACE_SYSPAGE_LEN bytes of system page, then 16-byte traceevent_t slots:
//     u32 header  [31:30] structure (S, CB, CC, CE)  [29:24] CPU  [14:10] class  [9:0] event
//     u32 data[0] the 32 least significant bits of ClockCycles()
//     u32 data[1], data[2] payload
// Slots arrive in per-CPU 16 KB buffers written in completion order. Within a CPU the slots are in
// time order; a combine event's slots share one timestamp and may be interlaced with other events.
// CONTROL TIME events carry the upper 32 bits of the clock. We rebuild 64-bit time per CPU,
// reassemble combine events, decode the payload into the EventTable columns, and merge the CPUs.

import { Cls, Comm, Control, KC_64, KC_EXIT, KC_NUM_MASK, Ker, Proc, STRUCT_CB, STRUCT_CC, STRUCT_CE, STRUCT_S, Sys } from './constants.js';
import { EventTableBuilder, headerFromAttrs, type Trace, type TraceStats } from './types.js';

const HEADER_END = 'TRACE_HEADER_END::';
const TWO32 = 4294967296;

export class KevFormatError extends Error {}

/** Parse the TRACE_<KEY>::<value> attribute run. Values never contain "TRACE_" or "::". */
export function parseHeaderAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /TRACE_([A-Z0-9_]+)::/g;
  const marks: { key: string; start: number; end: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) marks.push({ key: m[1], start: m.index, end: re.lastIndex });
  for (let i = 0; i < marks.length; i++) {
    const v = text.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : text.length);
    attrs[marks[i].key] = v.replace(/\0+$/, '');
  }
  return attrs;
}

function findAscii(buf: Uint8Array, needle: string, limit: number): number {
  const n = needle.length;
  const first = needle.charCodeAt(0);
  const end = Math.min(buf.length - n, limit);
  outer: for (let i = 0; i <= end; i++) {
    if (buf[i] !== first) continue;
    for (let j = 1; j < n; j++) if (buf[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

export function isKev(buf: Uint8Array): boolean {
  return findAscii(buf, 'TRACE_HEADER_BEGIN::', 64) === 0 || findAscii(buf, 'TRACE_', 16) === 0;
}

/** Decode a NUL-terminated little-endian string packed into 32-bit words. */
export function wordsToString(words: ArrayLike<number>, from: number, to = words.length): string {
  const bytes: number[] = [];
  for (let i = from; i < to; i++) {
    const w = words[i] >>> 0;
    for (let b = 0; b < 4; b++) {
      const c = (w >>> (8 * b)) & 0xff;
      if (c === 0) return Buffer.from(bytes).toString('utf8');
      bytes.push(c);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

const i32 = (x: number) => x | 0;
const u32 = (x: number) => x >>> 0;
const u64 = (lo: number, hi: number) => (hi >>> 0) * TWO32 + (lo >>> 0);

/**
 * Fill f0..f5/str of row `r` from the event's payload words (data[1], data[2] of each slot).
 * The meaning of each column is documented on EventTable.
 */
export function decodeFields(b: EventTableBuilder, r: number, cls: number, code: number, w: ArrayLike<number>): void {
  const len = w.length;
  switch (cls) {
    case Cls.PR_TH: {
      if (code < 64) {
        b.f0[r] = u32(w[0]);
        b.f1[r] = u32(w[1]);
        b.f2[r] = len >= 4 ? i32(w[2]) : -1;
        b.f3[r] = len >= 4 ? i32(w[3]) : -1;
      } else {
        b.f0[r] = u32(w[0]);
        b.f1[r] = u32(w[1]);
        if (code === Proc.CREATE_NAME || code === Proc.DESTROY_NAME || code === Proc.THREAD_NAME) {
          b.str[r] = b.intern(wordsToString(w, 2));
        }
      }
      return;
    }
    case Cls.INT:
      b.f0[r] = u32(w[0]);
      b.f1[r] = len > 1 ? u32(w[1]) : 0;
      return;
    case Cls.COMM:
      b.f0[r] = u32(w[0]);
      b.f1[r] = len > 1 ? i32(w[1]) : 0;
      return;
    case Cls.CONTROL:
      b.f0[r] = u32(w[0]);
      b.f1[r] = len > 1 ? u32(w[1]) : 0;
      return;
    case Cls.USER:
      if (len <= 2) {
        b.f0[r] = u32(w[0]);
        b.f1[r] = u32(w[1]);
      } else {
        b.str[r] = b.intern(wordsToString(w, 0));
        b.f0[r] = u32(w[0]);
        b.f1[r] = u32(w[1]);
      }
      return;
    case Cls.SYSTEM: {
      const ev = code & 0x1ff;
      if (ev === Sys.TIMER || ev === Sys.IST_ATTACH || ev === Sys.IST_DETACH) {
        b.f0[r] = u32(w[0]);
        b.f1[r] = u32(w[1]);
        b.f2[r] = ev === Sys.TIMER ? i32(w[2] ?? 0) : u32(w[2] ?? 0);
        b.f3[r] = u32(w[3] ?? 0);
        b.f4[r] = u32(w[4] ?? 0);
        b.f5[r] = i32(w[5] ?? 0);
      } else if (ev === Sys.PATHMGR) {
        b.f0[r] = u32(w[0]);
        b.f1[r] = u32(w[1]);
        b.str[r] = b.intern(wordsToString(w, 2));
      } else {
        b.f0[r] = u32(w[0]);
        b.f1[r] = len > 1 ? u32(w[1]) : 0;
      }
      return;
    }
    case Cls.KERCALL:
      decodeKerCall(b, r, code, w);
      return;
    default:
      b.f0[r] = u32(w[0] ?? 0);
      b.f1[r] = u32(w[1] ?? 0);
  }
}

function decodeKerCall(b: EventTableBuilder, r: number, code: number, w: ArrayLike<number>): void {
  const num = code & KC_NUM_MASK;
  const exit = (code & KC_EXIT) !== 0;
  const k64 = (code & KC_64) !== 0;
  const len = w.length;
  const fast = len <= 2;
  if (!exit) {
    switch (num) {
      case Ker.SYNC_MUTEX_LOCK:
      case Ker.SYNC_MUTEX_UNLOCK:
        if (k64) {
          b.f0[r] = u64(w[0], w[1]);
          b.f1[r] = len >= 4 ? i32(w[2]) : 0;
          b.f2[r] = len >= 4 ? u32(w[3]) : u32(w[2] ?? 0);
        } else if (fast) {
          b.f0[r] = u32(w[0]);
          b.f2[r] = u32(w[1]);
        } else {
          b.f0[r] = u32(w[0]);
          b.f1[r] = i32(w[1]);
          b.f2[r] = u32(w[2]);
        }
        return;
      case Ker.SYNC_CONDVAR_WAIT:
        if (k64 && len >= 8) {
          b.f0[r] = u64(w[0], w[1]);
          b.f1[r] = u64(w[2], w[3]);
          b.f2[r] = u32(w[7]);
        } else {
          b.f0[r] = u32(w[0]);
          b.f1[r] = u32(w[1] ?? 0);
          b.f2[r] = len >= 6 ? u32(w[5]) : 0;
        }
        return;
      case Ker.SYNC_CONDVAR_SIGNAL:
      case Ker.SYNC_SEM_POST:
      case Ker.SYNC_SEM_WAIT:
        b.f0[r] = k64 ? u64(w[0], w[1]) : u32(w[0]);
        return;
      case Ker.MSG_SENDV:
      case Ker.MSG_SENDVNC:
        b.f0[r] = u32(w[0]);
        if (k64 && len >= 5) {
          b.f1[r] = u64(w[1], w[2]);
          b.f2[r] = u64(w[3], w[4]);
        } else if (!fast) {
          b.f1[r] = i32(w[1]);
          b.f2[r] = i32(w[2]);
        }
        return;
      case Ker.MSG_RECEIVEV:
      case Ker.MSG_RECEIVEPULSEV:
        b.f0[r] = u32(w[0]);
        return;
      case Ker.MSG_REPLYV:
        b.f0[r] = u32(w[0]);
        if (k64 && len >= 5) b.f1[r] = u64(w[3], w[4]);
        else b.f1[r] = fast ? i32(w[1]) : i32(w[2] ?? 0);
        return;
      case Ker.MSG_ERROR:
        b.f0[r] = u32(w[0]);
        b.f1[r] = i32(w[1] ?? 0);
        return;
      case Ker.INTERRUPT_ATTACH:
        // fast: intr, flags   wide: intr, handler, area, areasize, flags   (64: pointers are 2 words)
        b.f0[r] = i32(w[0]);
        b.f1[r] = u32((fast ? w[1] : k64 ? w[6] : w[4]) ?? 0);
        return;
      case Ker.INTERRUPT_WAIT:
        b.f0[r] = u32(w[0]);
        return;
      default:
        b.f0[r] = u32(w[0] ?? 0);
        b.f1[r] = u32(w[1] ?? 0);
        return;
    }
  }
  // exits
  if ((num === Ker.MSG_RECEIVEV || num === Ker.MSG_RECEIVEPULSEV) && !fast) {
    b.f0[r] = i32(w[0]);
    b.f1[r] = i32(w[6] ?? -1);
    b.f2[r] = i32(w[7] ?? -1);
    b.f4[r] = i32(w[8] ?? -1);
    b.f5[r] = i32(w[9] ?? -1);
    b.f3[r] = i32((k64 ? w[17] : w[14]) ?? -1);
    return;
  }
  if (num === Ker.MSG_RECEIVEV || num === Ker.MSG_RECEIVEPULSEV) {
    // fast mode, or a failed call: ret_val (-1) and errno
    b.f0[r] = i32(w[0]);
    b.f1[r] = -1;
    b.f2[r] = -1;
    b.f3[r] = -1;
    b.f4[r] = -1;
    b.f5[r] = -1;
    return;
  }
  b.f0[r] = i32(w[0] ?? 0);
  b.f1[r] = u32(w[1] ?? 0);
}

interface Pending {
  key: number; // header without the structure bits
  ts: number; // data[0]
  row: number;
  words: number[];
}

export interface ReadOptions {
  /** Stop after this many slots (for previews). */
  maxSlots?: number;
}

/** Decode a .kev file. */
export function readKev(buf: Uint8Array, opts: ReadOptions = {}): Trace {
  const t0 = performance.now();
  const endAt = findAscii(buf, HEADER_END, 1 << 20);
  if (endAt < 0 || !isKev(buf)) throw new KevFormatError('not a QNX kernel trace: no TRACE_HEADER_END:: in the first megabyte');
  const headerText = Buffer.from(buf.subarray(0, endAt + HEADER_END.length)).toString('latin1');
  const attrs = parseHeaderAttrs(headerText);
  const header = headerFromAttrs(attrs);
  const syspageLen = Number(attrs.SYSPAGE_LEN ?? 0) || 0;
  const off = endAt + HEADER_END.length + syspageLen;
  let nSlots = Math.max(0, Math.floor((buf.length - off) / 16));
  if (opts.maxSlots !== undefined) nSlots = Math.min(nSlots, opts.maxSlots);

  // Copy the slots into an aligned buffer (the header length is arbitrary).
  const raw = new Uint8Array(nSlots * 16);
  raw.set(buf.subarray(off, off + nSlots * 16));
  const s = new Uint32Array(raw.buffer);
  if (!header.littleEndian) {
    for (let i = 0; i < s.length; i++) {
      const x = s[i];
      s[i] = ((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24);
    }
  }

  const b = new EventTableBuilder(Math.ceil(nSlots * 0.6) + 64);
  const msb = new Float64Array(64);
  const lastLsb = new Float64Array(64).fill(-1);
  const pending: Pending[][] = Array.from({ length: 64 }, () => []);
  const valid: boolean[] = [];
  const stats: TraceStats = {
    bytes: buf.length,
    slots: nSlots,
    buffers: 0,
    droppedEvents: 0,
    droppedBuffers: 0,
    orphanSlots: 0,
    incompleteEvents: 0,
    parseMs: 0,
  };
  const pair = [0, 0];
  let maxCpu = 0;

  for (let i = 0; i < nSlots; i++) {
    const h = s[4 * i];
    const d0 = s[4 * i + 1];
    const d1 = s[4 * i + 2];
    const d2 = s[4 * i + 3];
    const st = h >>> 30;
    const cpu = (h >>> 24) & 0x3f;
    const cls = (h >>> 10) & 0x1f;
    const code = h & 0x3ff;
    if (cpu > maxCpu) maxCpu = cpu;

    // 64-bit time: CONTROL TIME sets the upper half; otherwise detect a wrap of the lower half.
    let hi = msb[cpu];
    if (cls === Cls.CONTROL && code === Control.TIME && st === STRUCT_S) {
      msb[cpu] = hi = d1;
      lastLsb[cpu] = d0;
    } else if (lastLsb[cpu] >= 0) {
      const last = lastLsb[cpu];
      if (d0 < last && last - d0 > 0x80000000) {
        msb[cpu] = hi = hi + 1;
        lastLsb[cpu] = d0;
      } else if (d0 > last && d0 - last > 0x80000000) {
        hi = hi - 1; // a slot from just before a wrap, written after it
      } else {
        lastLsb[cpu] = d0;
      }
    } else {
      lastLsb[cpu] = d0;
    }
    const cycles = hi * TWO32 + d0;

    if (st === STRUCT_S) {
      const r = b.add(cycles, cpu, cls, code);
      valid[r] = true;
      pair[0] = d1;
      pair[1] = d2;
      decodeFields(b, r, cls, code, pair);
      if (cls === Cls.CONTROL) {
        if (code === Control.BUFFER) stats.buffers++;
        else if (code === Control.DROPPED) {
          stats.droppedBuffers++;
          stats.droppedEvents += d1 >>> 0;
        }
      }
    } else {
      const key = h & 0x3fffffff;
      const list = pending[cpu];
      if (st === STRUCT_CB) {
        // A CB that reuses a pending key means the previous event never completed.
        for (let k = 0; k < list.length; k++) {
          if (list[k].key === key && list[k].ts === d0) {
            stats.incompleteEvents++;
            list.splice(k, 1);
            break;
          }
        }
        const r = b.add(cycles, cpu, cls, code);
        valid[r] = false;
        list.push({ key, ts: d0, row: r, words: [d1, d2] });
      } else {
        let k = -1;
        for (let j = list.length - 1; j >= 0; j--) {
          if (list[j].key === key && list[j].ts === d0) {
            k = j;
            break;
          }
        }
        if (k < 0) {
          stats.orphanSlots++;
          continue;
        }
        const p = list[k];
        p.words.push(d1, d2);
        if (st === STRUCT_CE) {
          list.splice(k, 1);
          valid[p.row] = true;
          b.slots[p.row] = Math.min(255, p.words.length / 2);
          decodeFields(b, p.row, cls, code, p.words);
        } else if (st !== STRUCT_CC) {
          stats.orphanSlots++;
        }
      }
    }
  }
  for (const list of pending) stats.incompleteEvents += list.length;

  // Merge the per-CPU streams (each already in time order) by time; ties keep file order.
  const nCpu = maxCpu + 1;
  const perCpu: number[][] = Array.from({ length: nCpu }, () => []);
  for (let r = 0; r < b.n; r++) if (valid[r]) perCpu[b.cpu[r]].push(r);
  let total = 0;
  for (const l of perCpu) total += l.length;
  const order = new Uint32Array(total);
  const head = new Int32Array(nCpu);
  for (let o = 0; o < total; o++) {
    let best = -1;
    let bestT = Infinity;
    let bestRow = Infinity;
    for (let c = 0; c < nCpu; c++) {
      const l = perCpu[c];
      if (head[c] >= l.length) continue;
      const r = l[head[c]];
      const t = b.cycles[r];
      if (t < bestT || (t === bestT && r < bestRow)) {
        bestT = t;
        bestRow = r;
        best = c;
      }
    }
    order[o] = perCpu[best][head[best]++];
  }
  const events = b.build(order);
  if (!header.cpuCount || header.cpuCount < nCpu) header.cpuCount = nCpu;
  stats.parseMs = performance.now() - t0;
  return { header, events, decoder: 'kev', stats, originCycles: events.n ? events.cycles[0] : 0 };
}
