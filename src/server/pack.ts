// Binary timeline pack for the web UI: every thread's state runs, every CPU's run queue, interrupts,
// message transactions and job markers, as typed arrays the browser maps without parsing.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layout: "LLT1", u32 JSON length, JSON index (padded to 8 bytes), then 8-byte aligned sections.
import type { Model } from '../model/model.js';

type Arr = Float64Array | Int32Array | Int16Array | Int8Array | Uint8Array;
interface Section {
  name: string;
  type: 'f64' | 'i32' | 'i16' | 'i8' | 'u8';
  offset: number;
  length: number;
}

function typeOf(a: Arr): Section['type'] {
  if (a instanceof Float64Array) return 'f64';
  if (a instanceof Int32Array) return 'i32';
  if (a instanceof Int16Array) return 'i16';
  if (a instanceof Int8Array) return 'i8';
  return 'u8';
}

export function packTimeline(m: Model): Buffer {
  const nRuns = m.threads.reduce((s, T) => s + T.runs.n, 0);
  const runStart = new Float64Array(nRuns);
  const runEnd = new Float64Array(nRuns);
  const runState = new Uint8Array(nRuns);
  const runPrio = new Int16Array(nRuns);
  const runCpu = new Int8Array(nRuns);
  const threads: { runOffset: number; runCount: number }[] = [];
  let o = 0;
  for (const T of m.threads) {
    const r = T.runs;
    runStart.set(r.start, o);
    runEnd.set(r.end, o);
    runState.set(r.state, o);
    runPrio.set(r.prio, o);
    runCpu.set(r.cpu, o);
    threads.push({ runOffset: o, runCount: r.n });
    o += r.n;
  }
  const nCpuRuns = m.cpus.reduce((s, c) => s + c.n, 0);
  const cpuStart = new Float64Array(nCpuRuns);
  const cpuEnd = new Float64Array(nCpuRuns);
  const cpuThread = new Int32Array(nCpuRuns);
  const cpuPrio = new Int16Array(nCpuRuns);
  const cpus: { offset: number; count: number }[] = [];
  o = 0;
  for (const c of m.cpus) {
    cpuStart.set(c.start, o);
    cpuEnd.set(c.end, o);
    cpuThread.set(c.thread, o);
    cpuPrio.set(c.prio, o);
    cpus.push({ offset: o, count: c.n });
    o += c.n;
  }
  const msgs = m.messages.filter((x) => x.client >= 0 && x.server >= 0 && !Number.isNaN(x.tReceive));
  const marks = m.markers;
  const sections: [string, Arr][] = [
    ['run_start', runStart],
    ['run_end', runEnd],
    ['run_state', runState],
    ['run_prio', runPrio],
    ['run_cpu', runCpu],
    ['cpu_start', cpuStart],
    ['cpu_end', cpuEnd],
    ['cpu_thread', cpuThread],
    ['cpu_prio', cpuPrio],
    ['int_t', m.interrupts.t],
    ['int_cpu', m.interrupts.cpu],
    ['int_id', m.interrupts.intr],
    ['msg_client', Int32Array.from(msgs, (x) => x.client)],
    ['msg_server', Int32Array.from(msgs, (x) => x.server)],
    ['msg_send', Float64Array.from(msgs, (x) => (Number.isNaN(x.tSend) ? x.tReceive : x.tSend))],
    ['msg_recv', Float64Array.from(msgs, (x) => x.tReceive)],
    ['msg_reply', Float64Array.from(msgs, (x) => (Number.isNaN(x.tReply) ? -1 : x.tReply))],
    ['mark_t', Float64Array.from(marks, (x) => x.t)],
    ['mark_thread', Int32Array.from(marks, (x) => x.thread)],
    ['mark_code', Int32Array.from(marks, (x) => x.code)],
    ['mark_d0', Float64Array.from(marks, (x) => x.d0)],
    ['mark_d1', Float64Array.from(marks, (x) => x.d1)],
  ];
  // Offsets are relative to the start of the buffer and 8-byte aligned.
  const index = { version: 1, threads, cpus, sections: [] as Section[] };
  let json = '';
  let headerLen = 64;
  for (;;) {
    let off = headerLen;
    index.sections = sections.map(([name, a]) => {
      off = Math.ceil(off / 8) * 8;
      const s: Section = { name, type: typeOf(a), offset: off, length: a.length };
      off += a.byteLength;
      return s;
    });
    json = JSON.stringify(index);
    const need = Math.ceil((8 + Buffer.byteLength(json)) / 8) * 8;
    if (need <= headerLen) break; // the index (with these offsets) fits in front of the data
    headerLen = need + 64;
  }
  const total = index.sections.length ? index.sections[index.sections.length - 1].offset + sections[sections.length - 1][1].byteLength : headerLen;
  const buf = Buffer.alloc(total + 8);
  buf.write('LLT1', 0, 'latin1');
  buf.writeUInt32LE(Buffer.byteLength(json), 4);
  buf.write(json, 8, 'utf8');
  sections.forEach(([, a], k) => {
    const s = index.sections[k];
    Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(buf, s.offset);
  });
  return buf;
}
