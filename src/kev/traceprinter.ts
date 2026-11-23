// Reader for the text the QNX SDP's traceprinter utility prints. Copyright (C) 2026 chinesepowered.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// traceprinter is QNX's own decoder (built on libtraceparser), and the SAT guide documents its
// output format: "t:<cycles> CPU:<cpu> <class> :<event> <parameters>", with wide-mode parameters on
// indented continuation lines. Latency Lens accepts this text as input and uses it as the reference
// its binary reader is tested against (test/conformance.test.ts).

import { COMM_LABELS, Cls, Control, KC_EXIT, Ker, Proc, STATE_NAMES, Sys } from './constants.js';
import { EventTableBuilder, headerFromAttrs, type Trace, type TraceStats } from './types.js';

const STATE_BY_LABEL = new Map<string, number>(STATE_NAMES.map((n, i) => [`TH${n}`, i]));
const COMM_BY_LABEL = new Map<string, number>(Object.entries(COMM_LABELS).map(([k, v]) => [v, Number(k)]));
const SYS_BY_LABEL = new Map<string, number>([
  ['PATHMGR_OPEN', Sys.PATHMGR],
  ['MMAP', Sys.MMAP],
  ['MUNMAP', Sys.MUNMAP],
  ['MAPNAME', Sys.MAPNAME],
  ['MAPNAME_64', Sys.MAPNAME_64],
  ['ADDRESS', Sys.ADDRESS],
  ['FUNC_ENTER', Sys.FUNC_ENTER],
  ['FUNC_EXIT', Sys.FUNC_EXIT],
  ['SLOG2', Sys.SLOG],
  ['RUNSTATE', Sys.RUNSTATE],
  ['POWER', Sys.POWER],
  ['IPI', Sys.IPI],
  ['IPI_64', Sys.IPI | 0x200],
  ['PAGEWAIT', Sys.PAGEWAIT],
  ['TIMER', Sys.TIMER],
  ['PROFILE', Sys.PROFILE],
  ['IST_ATTACH', Sys.IST_ATTACH],
  ['IST_DETACH', Sys.IST_DETACH],
  ['SEND_IPI', Sys.SEND_IPI],
  ['SEND_IPI_64', Sys.SEND_IPI | 0x200],
]);
const PROC_BY_LABEL = new Map<string, number>([
  ['PROCCREATE', Proc.CREATE],
  ['PROCDESTROY', Proc.DESTROY],
  ['PROCCREATE_NAME', Proc.CREATE_NAME],
  ['PROCDESTROY_NAME', Proc.DESTROY_NAME],
  ['PROCTHREAD_NAME', Proc.THREAD_NAME],
]);
const CONTROL_BY_LABEL = new Map<string, number>([
  ['TIME', Control.TIME],
  ['BUFFER', Control.BUFFER],
  ['BUFFER_END', Control.BUFFER_END],
  ['DROPPED', Control.DROPPED],
]);

const EVENT_RE = /^t:0x([0-9a-fA-F]+) CPU:(\d+) (\S+)\s*:(\S+)(.*)$/;
const FIELD_RE = /([A-Za-z_][\w\->[\].()]*)\s*(?::|=)\s*("(?:[^"\\]|\\.)*"|-?0x[0-9a-fA-F]+(?:\(-?\d+\))?|-?\d+|[^\s,]+)/g;

export function isTraceprinterText(head: string): boolean {
  return /TRACEPRINTER version|-- KERNEL EVENTS --|^t:0x[0-9a-f]+ CPU:\d+ /m.test(head);
}

/** Parse a printed number: hex (possibly 64-bit, possibly with "(decimal)"), or signed decimal. */
export function num(v: string | undefined): number {
  if (v === undefined) return 0;
  const m = /^(-?)0x([0-9a-fA-F]+)/.exec(v);
  if (m) {
    const x = Number(BigInt('0x' + m[2]));
    return m[1] ? -x : x;
  }
  const d = Number.parseInt(v, 10);
  return Number.isFinite(d) ? d : 0;
}

function unquote(v: string | undefined): string {
  if (!v) return '';
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return v;
}

function wordsText(words: number[]): string {
  const bytes: number[] = [];
  for (const w of words) for (let k = 0; k < 4; k++) {
    const c = (w >>> (8 * k)) & 0xff;
    if (c === 0) return Buffer.from(bytes).toString('utf8');
    bytes.push(c);
  }
  return Buffer.from(bytes).toString('utf8');
}

function fieldsOf(text: string): Map<string, string> {
  const f = new Map<string, string>();
  FIELD_RE.lastIndex = 0;
  for (let m = FIELD_RE.exec(text); m; m = FIELD_RE.exec(text)) if (!f.has(m[1])) f.set(m[1], m[2]);
  return f;
}

function classAndCode(clsLabel: string, evLabel: string): [number, number] | null {
  switch (clsLabel) {
    case 'CONTROL': {
      const c = CONTROL_BY_LABEL.get(evLabel);
      return c === undefined ? null : [Cls.CONTROL, c];
    }
    case 'KER_CALL':
    case 'KER_EXIT': {
      const m = /\/(\d+)$/.exec(evLabel);
      if (!m) return null;
      return [Cls.KERCALL, Number(m[1]) | (clsLabel === 'KER_EXIT' ? KC_EXIT : 0)];
    }
    case 'INTERRUPT':
      return evLabel === 'INT_DELIVER' ? [Cls.INT, 7] : null;
    case 'THREAD': {
      const s = STATE_BY_LABEL.get(evLabel);
      return s === undefined ? null : [Cls.PR_TH, s];
    }
    case 'PROCESS': {
      const p = PROC_BY_LABEL.get(evLabel);
      return p === undefined ? null : [Cls.PR_TH, p];
    }
    case 'SYSTEM': {
      const s = SYS_BY_LABEL.get(evLabel);
      return s === undefined ? null : [Cls.SYSTEM, s];
    }
    case 'USREVENT': {
      const m = /^EVENT:(\d+)$/.exec(evLabel);
      return m ? [Cls.USER, Number(m[1])] : null;
    }
    case 'COMM': {
      const c = COMM_BY_LABEL.get(evLabel);
      return c === undefined ? null : [Cls.COMM, c];
    }
    default:
      return null;
  }
}

function fill(b: EventTableBuilder, r: number, cls: number, code: number, f: Map<string, string>): void {
  const g = (k: string) => num(f.get(k));
  switch (cls) {
    case Cls.PR_TH:
      if (code < 64) {
        b.f0[r] = g('pid');
        b.f1[r] = g('tid');
        b.f2[r] = f.has('priority') ? g('priority') : -1;
        b.f3[r] = f.has('policy') ? g('policy') : -1;
      } else if (code === Proc.THREAD_NAME) {
        b.f0[r] = g('pid');
        b.f1[r] = g('tid');
        b.str[r] = b.intern(f.get('name') ?? '');
      } else {
        b.f0[r] = g('ppid');
        b.f1[r] = g('pid');
        if (f.has('name')) b.str[r] = b.intern(f.get('name') ?? '');
      }
      return;
    case Cls.INT:
      b.f0[r] = g('intr_id') >>> 0;
      return;
    case Cls.COMM: {
      if (code === 9) {
        b.f0[r] = g('si_signo');
        b.f1[r] = g('si_code');
        return;
      }
      const first = f.get('rcvid') ?? f.get('scoid') ?? f.get('tid');
      b.f0[r] = num(first) >>> 0;
      b.f1[r] = g('pid');
      return;
    }
    case Cls.CONTROL:
      if (code === Control.TIME) {
        b.f0[r] = g('msb');
        b.f1[r] = num(f.get('lsb(offset)') ?? f.get('lsb'));
      } else if (code === Control.BUFFER) {
        b.f0[r] = g('sequence');
        b.f1[r] = g('num_events');
      } else if (code === Control.BUFFER_END) {
        b.f0[r] = num('0x' + (f.get('cookie1') ?? '0'));
        b.f1[r] = num('0x' + (f.get('cookie2') ?? '0'));
      } else {
        const v = [...f.values()][0];
        b.f0[r] = num(v);
      }
      return;
    case Cls.USER: {
      b.f0[r] = g('d0') >>> 0;
      b.f1[r] = g('d1') >>> 0;
      if (f.has('d2')) {
        // A string event prints STR:"..."; when the string fills its words exactly there is no NUL
        // and traceprinter prints only the words, so rebuild the text from them.
        if (f.has('STR')) b.str[r] = b.intern(unquote(f.get('STR')));
        else {
          const words: number[] = [];
          for (let k = 0; f.has(`d${k}`); k++) words.push(num(f.get(`d${k}`)) >>> 0);
          b.str[r] = b.intern(wordsText(words));
        }
      }
      return;
    }
    case Cls.SYSTEM: {
      const ev = code & 0x1ff;
      if (ev === Sys.TIMER) {
        b.f0[r] = g('pid');
        b.f1[r] = g('tid');
        b.f2[r] = g('timer_id');
        b.f3[r] = g('flags') >>> 0;
      } else if (ev === Sys.IST_ATTACH || ev === Sys.IST_DETACH) {
        b.f0[r] = g('pid');
        b.f1[r] = g('tid');
        b.f2[r] = g('intr_id') >>> 0;
        b.f3[r] = g('intr_cpu');
        b.f4[r] = g('flags') >>> 0;
        b.f5[r] = g('ist_prio');
      } else if (ev === Sys.PATHMGR) {
        b.f0[r] = g('pid');
        b.f1[r] = g('tid');
        b.str[r] = b.intern(f.get('path') ?? '');
      }
      return;
    }
    case Cls.KERCALL: {
      const callNum = code & 0x7f;
      if (code & KC_EXIT) {
        if (callNum === Ker.MSG_RECEIVEV || callNum === Ker.MSG_RECEIVEPULSEV) {
          b.f0[r] = num(f.get('rcvid') ?? f.get('ret_val')) | 0;
          b.f1[r] = f.has('info->pid') ? g('info->pid') : -1;
          b.f2[r] = f.has('info->tid') ? g('info->tid') : -1;
          b.f3[r] = f.has('info->priority') ? g('info->priority') : -1;
          b.f4[r] = f.has('info->chid') ? g('info->chid') : -1;
          b.f5[r] = f.has('info->scoid') ? g('info->scoid') : -1;
        } else {
          const vals = [...f.values()];
          b.f0[r] = num(vals[0]) | 0;
          b.f1[r] = num(vals[1]) >>> 0;
        }
        return;
      }
      switch (callNum) {
        case Ker.SYNC_MUTEX_LOCK:
        case Ker.SYNC_MUTEX_UNLOCK:
          b.f0[r] = g('sync_p');
          b.f1[r] = g('count') | 0;
          b.f2[r] = g('owner') >>> 0;
          return;
        case Ker.SYNC_CONDVAR_WAIT:
          b.f0[r] = g('sync_p');
          b.f1[r] = g('mutex_p');
          b.f2[r] = g('mutex->owner') >>> 0;
          return;
        case Ker.SYNC_CONDVAR_SIGNAL:
        case Ker.SYNC_SEM_POST:
        case Ker.SYNC_SEM_WAIT:
          b.f0[r] = g('sync_p');
          return;
        case Ker.MSG_SENDV:
        case Ker.MSG_SENDVNC:
          b.f0[r] = g('coid') >>> 0;
          b.f1[r] = g('sparts');
          b.f2[r] = g('rparts');
          return;
        case Ker.MSG_RECEIVEV:
        case Ker.MSG_RECEIVEPULSEV:
          b.f0[r] = g('chid') >>> 0;
          return;
        case Ker.MSG_REPLYV:
          b.f0[r] = g('rcvid') >>> 0;
          b.f1[r] = g('status');
          return;
        case Ker.MSG_ERROR:
          b.f0[r] = g('rcvid') >>> 0;
          b.f1[r] = g('err');
          return;
        case Ker.INTERRUPT_ATTACH:
          b.f0[r] = g('intr');
          b.f1[r] = g('flags') >>> 0;
          return;
        case Ker.INTERRUPT_WAIT:
          b.f0[r] = g('flags') >>> 0;
          return;
        default: {
          const vals = [...f.values()];
          b.f0[r] = num(vals[0]) >>> 0;
          b.f1[r] = num(vals[1]) >>> 0;
        }
      }
    }
  }
}

/** Parse traceprinter output. Unknown event labels are skipped (counted in stats.orphanSlots). */
export function readTraceprinter(text: string): Trace {
  const t0 = performance.now();
  const lines = text.split(/\r?\n/);
  const attrs: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (EVENT_RE.test(line) || line.includes('-- KERNEL EVENTS --')) break;
    const m = /^\s*TRACE_([A-Z0-9_]+)::\s?(.*)$/.exec(line);
    if (m) attrs[m[1]] = m[2].trim();
  }
  const header = headerFromAttrs(attrs);
  const b = new EventTableBuilder(Math.ceil(lines.length / 2) + 16);
  const stats: TraceStats = {
    bytes: text.length,
    slots: 0,
    buffers: 0,
    droppedEvents: 0,
    droppedBuffers: 0,
    orphanSlots: 0,
    incompleteEvents: 0,
    parseMs: 0,
  };
  let maxCpu = 0;
  for (; i < lines.length; i++) {
    const m = EVENT_RE.exec(lines[i]);
    if (!m) continue;
    let rest = m[5];
    const whole = new Map<string, string>();
    while (i + 1 < lines.length && lines[i + 1].length > 0 && !lines[i + 1].startsWith('t:0x') && /^\s/.test(lines[i + 1])) {
      const cont = lines[++i];
      // Names and paths sit alone on their line and may contain spaces or commas.
      const nm = /^\s*(name|path):(.*)$/.exec(cont);
      if (nm) whole.set(nm[1], nm[2]);
      else rest += ' ' + cont.trim();
    }
    const cc = classAndCode(m[3], m[4]);
    if (!cc) {
      stats.orphanSlots++;
      continue;
    }
    const cpu = Number(m[2]);
    if (cpu > maxCpu) maxCpu = cpu;
    const r = b.add(Number(BigInt('0x' + m[1])), cpu, cc[0], cc[1]);
    const fields = fieldsOf(rest);
    for (const [k, v] of whole) fields.set(k, v);
    fill(b, r, cc[0], cc[1], fields);
    if (cc[0] === Cls.CONTROL && cc[1] === Control.BUFFER) stats.buffers++;
    if (cc[0] === Cls.CONTROL && cc[1] === Control.DROPPED) {
      stats.droppedBuffers++;
      stats.droppedEvents += b.f0[r];
    }
  }
  // traceprinter already prints in time order; keep it stable.
  const events = b.build();
  if (header.cpuCount < maxCpu + 1) header.cpuCount = maxCpu + 1;
  stats.parseMs = performance.now() - t0;
  return { header, events, decoder: 'traceprinter', stats, originCycles: events.n ? events.cycles[0] : 0 };
}
