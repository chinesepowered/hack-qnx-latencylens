// The 1.27 million event stress trace: our reader must agree with traceprinter's per-type counts and
// stay fast. Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/deadlines.js';
import { analyse } from '../src/detect/index.js';
import { classLabel, eventLabel } from '../src/kev/constants.js';
import { readKev } from '../src/kev/reader.js';
import { buildModel } from '../src/model/model.js';
import { tracePath } from './helpers.js';

describe('stress trace (1.27M events)', () => {
  it('matches traceprinter event counts per type and parses quickly', () => {
    const summary = JSON.parse(readFileSync(tracePath('stress.traceprinter-summary.json'), 'utf8'));
    const raw = gunzipSync(readFileSync(tracePath('stress.kev.gz')));
    const t0 = performance.now();
    const trace = readKev(new Uint8Array(raw.buffer, raw.byteOffset, raw.length));
    const ms = performance.now() - t0;
    const e = trace.events;
    expect(e.n).toBe(summary.total);
    expect(e.n).toBeGreaterThan(1_000_000);
    const counts: Record<string, number> = {};
    for (let i = 0; i < e.n; i++) {
      const key = `${classLabel(e.cls[i], e.code[i])}:${eventLabel(e.cls[i], e.code[i])}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    expect(counts).toEqual(summary.byType);
    expect(String(e.cycles[0])).toBe(summary.firstCycles);
    expect(String(e.cycles[e.n - 1])).toBe(summary.lastCycles);
    expect(trace.stats.droppedEvents).toBe(0);
    console.log(`readKev: ${e.n} events from ${(raw.length / 1e6).toFixed(1)} MB in ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(5000);

    // The whole analysis of a million events stays in seconds, and procnto's own threads are never
    // blamed for an IST's latency (a user cannot reprioritise them): those delays become notes.
    const t1 = performance.now();
    const m = buildModel(trace);
    const a = analyse(m, loadConfig(tracePath('stress.deadlines.yaml')));
    expect(performance.now() - t1).toBeLessThan(15_000);
    const kinds = a.findings.map((f) => f.kind);
    expect(kinds).toContain('deadline-miss');
    expect(kinds).toContain('priority-inversion');
    for (const f of a.findings.filter((x) => x.kind === 'ist-latency')) {
      expect(f.threads.slice(1).every((th) => !m.threads[th].isKernel)).toBe(true);
    }
    expect(a.notes.some((n) => n.includes("procnto's own") && n.includes('kernel time'))).toBe(true);
  }, 60_000);
});
