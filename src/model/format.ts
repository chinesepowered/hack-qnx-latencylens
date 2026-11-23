// One readable line per kernel event, for evidence tables, the CLI and the AI prompt.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import { Cls, Control, KC_EXIT, Ker, Proc, STATE_NAMES, Sys, classLabel, eventLabel, kerCallName } from '../kev/constants.js';
import type { Model } from './model.js';

export interface EventRow {
  i: number;
  t: number; // ns
  cpu: number;
  cls: string;
  ev: string;
  /** Thread the event is about (state changes) or that logged it (calls, markers). */
  thread: number;
  text: string;
}

function hex(x: number): string {
  return '0x' + Math.max(0, x).toString(16);
}

function who(m: Model, pid: number, tid: number): string {
  const th = m.threadIndex.get(`${pid}/${tid}`);
  return th === undefined ? `pid ${pid} tid ${tid}` : m.threads[th].label;
}

export function describeEvent(m: Model, i: number): EventRow {
  const e = m.trace.events;
  const cls = e.cls[i];
  const code = e.code[i];
  const self = m.eventThread[i];
  let thread = self;
  let text = '';
  const f0 = e.f0[i];
  const f1 = e.f1[i];
  const str = e.str[i] >= 0 ? e.strings[e.str[i]] : '';
  switch (cls) {
    case Cls.PR_TH:
      if (code < 64) {
        thread = m.threadIndex.get(`${f0}/${f1}`) ?? -1;
        const prio = e.f2[i];
        text = `${who(m, f0, f1)} -> ${STATE_NAMES[code]}${prio >= 0 ? ` (priority ${prio})` : ''}`;
      } else if (code === Proc.THREAD_NAME) {
        thread = m.threadIndex.get(`${f0}/${f1}`) ?? -1;
        text = `thread ${f0}/${f1} named "${str}"`;
      } else text = `${eventLabel(cls, code).toLowerCase()} pid ${f1} (parent ${f0})${str ? ` ${str}` : ''}`;
      break;
    case Cls.INT:
      text = `interrupt ${f0 >= 0x80000000 ? hex(f0) : f0} delivered`;
      break;
    case Cls.COMM: {
      const label = eventLabel(cls, code);
      if (code === 0 || code === 2) text = `${label} rcvid ${hex(f0)} (server pid ${f1})`;
      else if (code === 10 || code === 11) text = `${label} to ${who(m, f1, f0)}`;
      else text = `${label} scoid ${hex(f0)} pid ${f1}`;
      break;
    }
    case Cls.USER:
      if (str) text = `user event ${code}: "${str}"`;
      else if (code === 100) text = `job ${f0} begins, ${f1} us after its nominal release`;
      else if (code === 101) text = `job ${f0} ends, response ${(f1 / 1000).toFixed(2)} ms as measured by the program`;
      else text = `user event ${code} d0=${f0} d1=${f1}`;
      break;
    case Cls.SYSTEM: {
      const ev = code & 0x1ff;
      if (ev === Sys.TIMER) text = `timer ${e.f2[i]} fired for ${who(m, f0, f1)}`;
      else if (ev === Sys.IST_ATTACH || ev === Sys.IST_DETACH)
        text = `${ev === Sys.IST_ATTACH ? 'IST attach' : 'IST detach'}: ${who(m, f0, f1)} interrupt ${e.f2[i] >= 0x80000000 ? hex(e.f2[i]) : e.f2[i]} priority ${e.f5[i]}`;
      else if (ev === Sys.PATHMGR) text = `path ${str} (${who(m, f0, f1)})`;
      else text = eventLabel(cls, code).toLowerCase();
      break;
    }
    case Cls.KERCALL: {
      const num = code & 0x7f;
      const exit = (code & KC_EXIT) !== 0;
      const name = kerCallName(num);
      if (!exit) {
        switch (num) {
          case Ker.SYNC_MUTEX_LOCK:
          case Ker.SYNC_MUTEX_UNLOCK: {
            const owner = e.f2[i] >>> 0;
            const pidLow = (owner >>> 16) & 0x7fff;
            const tid = owner & 0xffff;
            const holder = m.threads.find((T) => (T.pid & 0x7fff) === pidLow && T.tid === tid);
            text = `${name}(${hex(f0)})${owner ? ` owner ${holder ? holder.label : hex(owner)}` : ''}`;
            break;
          }
          case Ker.MSG_SENDV:
          case Ker.MSG_SENDVNC:
            text = `${name}(coid ${hex(f0)})`;
            break;
          case Ker.MSG_RECEIVEV:
          case Ker.MSG_RECEIVEPULSEV:
            text = `${name}(chid ${f0})`;
            break;
          case Ker.MSG_REPLYV:
          case Ker.MSG_ERROR:
            text = `${name}(rcvid ${hex(f0)})`;
            break;
          case Ker.INTERRUPT_WAIT:
            text = `${name}()`;
            break;
          default:
            text = `${name}()`;
        }
      } else if (num === Ker.MSG_RECEIVEV || num === Ker.MSG_RECEIVEPULSEV) {
        text = f0 > 0 ? `${name} returned rcvid ${hex(f0)}${e.f1[i] > 0 ? ` from ${who(m, e.f1[i], e.f2[i])}` : ''}` : f0 === 0 ? `${name} returned a pulse` : `${name} failed`;
      } else text = `${name} returned ${f0}`;
      break;
    }
    case Cls.CONTROL:
      text =
        code === Control.TIME
          ? 'clock high word'
          : code === Control.BUFFER
            ? `trace buffer ${f0}`
            : code === Control.DROPPED
              ? `${f0} events dropped`
              : eventLabel(cls, code).toLowerCase();
      break;
    default:
      text = eventLabel(cls, code);
  }
  return { i, t: m.time[i], cpu: e.cpu[i], cls: classLabel(cls, code), ev: eventLabel(cls, code), thread, text };
}

/** "  +12.345 ms CPU0  KER_CALL  SYNC_MUTEX_LOCK(0x3f..) owner brakesim/logger  [brakesim/brake_ctl]" */
export function eventLine(m: Model, i: number, t0: number): string {
  const r = describeEvent(m, i);
  const rel = ((r.t - t0) / 1e6).toFixed(3).padStart(9);
  const actor = r.cls === 'THREAD' || r.thread < 0 ? '' : `  [${m.threads[r.thread].label}]`;
  return `${rel} ms CPU${r.cpu} ${r.cls.padEnd(9)} ${r.text}${actor}`;
}
