// Our .kev reader must decode every committed trace exactly as the QNX SDP's traceprinter does.
// The reference text was produced by `traceprinter -f <trace>.kev` (SDP 8.0 host tools) when the
// traces were captured, see scripts/capture-samples.sh. Copyright (C) 2026 chinesepowered.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Cls, KC_64, Ker, Proc, Sys, classLabel, eventLabel } from '../src/kev/constants.js';
import { readKev } from '../src/kev/reader.js';
import { readTraceprinter } from '../src/kev/traceprinter.js';
import type { EventTable } from '../src/kev/types.js';
import { TRACES, tracePath } from './helpers.js';

/** Which decoded columns are comparable with traceprinter's text for this event. */
function comparedFields(cls: number, code: number): string[] {
  switch (cls) {
    case Cls.PR_TH:
      if (code < 64) return ['f0', 'f1', 'f2', 'f3'];
      return code === Proc.CREATE || code === Proc.DESTROY ? ['f0', 'f1'] : ['f0', 'f1', 'str'];
    case Cls.INT:
      return ['f0'];
    case Cls.COMM:
      return ['f0', 'f1'];
    case Cls.CONTROL:
      return ['f0', 'f1'];
    case Cls.USER:
      return ['f0', 'f1', 'str'];
    case Cls.SYSTEM: {
      const ev = code & 0x1ff;
      if (ev === Sys.TIMER) return ['f0', 'f1', 'f2', 'f3'];
      if (ev === Sys.IST_ATTACH || ev === Sys.IST_DETACH) return ['f0', 'f1', 'f2', 'f4', 'f5'];
      if (ev === Sys.PATHMGR) return ['f0', 'f1', 'str'];
      return [];
    }
    case Cls.KERCALL: {
      const num = code & 0x7f;
      if (code & 0x80) {
        if (num === Ker.MSG_RECEIVEV || num === Ker.MSG_RECEIVEPULSEV) return ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'];
        return ['f0'];
      }
      switch (num) {
        case Ker.SYNC_MUTEX_LOCK:
        case Ker.SYNC_MUTEX_UNLOCK:
          return ['f0', 'f1', 'f2'];
        case Ker.SYNC_CONDVAR_WAIT:
          return ['f0', 'f1', 'f2'];
        case Ker.MSG_SENDV:
        case Ker.MSG_SENDVNC:
          return ['f0', 'f1', 'f2'];
        case Ker.MSG_RECEIVEV:
        case Ker.MSG_RECEIVEPULSEV:
        case Ker.INTERRUPT_WAIT:
          return ['f0'];
        case Ker.MSG_REPLYV:
        case Ker.MSG_ERROR:
        case Ker.INTERRUPT_ATTACH:
          return ['f0', 'f1'];
        default:
          return [];
      }
    }
    default:
      return [];
  }
}

function value(e: EventTable, i: number, f: string): number | string {
  if (f === 'str') return e.str[i] < 0 ? '' : e.strings[e.str[i]];
  return (e as unknown as Record<string, Float64Array>)[f][i];
}

/** Sort rows by (cycles, cpu, class, code) so ties between CPUs do not matter. */
function sortedRows(e: EventTable): number[] {
  const idx = Array.from({ length: e.n }, (_, i) => i);
  idx.sort((a, b) => e.cycles[a] - e.cycles[b] || e.cpu[a] - e.cpu[b] || e.cls[a] - e.cls[b] || (e.code[a] & ~KC_64) - (e.code[b] & ~KC_64) || a - b);
  return idx;
}

describe('binary .kev reader matches the SDP traceprinter', () => {
  for (const name of TRACES) {
    it(`${name}: same events, same decoded fields`, () => {
      const kev = readKev(new Uint8Array(readFileSync(tracePath(`${name}.kev`))));
      const tp = readTraceprinter(gunzipSync(readFileSync(tracePath(`${name}.traceprinter.txt.gz`))).toString('utf8'));
      expect(kev.header.cyclesPerSec).toBe(tp.header.cyclesPerSec);
      expect(kev.header.cpuCount).toBe(tp.header.cpuCount);
      expect(kev.header.sysRelease).toBe('8.0.0');
      expect(tp.stats.orphanSlots).toBe(0); // every label traceprinter printed is known to us
      expect(kev.stats.orphanSlots + kev.stats.incompleteEvents).toBe(0);
      expect(kev.events.n).toBe(tp.events.n);

      const a = kev.events;
      const b = tp.events;
      const ra = sortedRows(a);
      const rb = sortedRows(b);
      const mismatches: string[] = [];
      for (let k = 0; k < ra.length && mismatches.length < 10; k++) {
        const i = ra[k];
        const j = rb[k];
        const la = `${a.cycles[i].toString(16)} ${a.cpu[i]} ${classLabel(a.cls[i], a.code[i])}:${eventLabel(a.cls[i], a.code[i] & ~KC_64)}`;
        const lb = `${b.cycles[j].toString(16)} ${b.cpu[j]} ${classLabel(b.cls[j], b.code[j])}:${eventLabel(b.cls[j], b.code[j] & ~KC_64)}`;
        if (la !== lb) {
          mismatches.push(`#${k}: kev ${la} vs traceprinter ${lb}`);
          continue;
        }
        for (const f of comparedFields(a.cls[i], a.code[i])) {
          const va = value(a, i, f);
          const vb = value(b, j, f);
          if (va !== vb) mismatches.push(`#${k} ${la} ${f}: kev ${va} vs traceprinter ${vb}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }
});
