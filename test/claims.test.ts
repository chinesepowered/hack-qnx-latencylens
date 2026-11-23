// The AI claim checker: every thread name, priority and duration in an explanation must match the
// finding's evidence. Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/deadlines.js';
import { analyse } from '../src/detect/index.js';
import { buildClaimContext, checkClaims } from '../src/explain/claims.js';
import { explainFinding, parseAnswer } from '../src/explain/explain.js';
import { buildModel } from '../src/model/model.js';
import { sampleTrace, tracePath } from './helpers.js';

const m = buildModel(sampleTrace('inversion'));
const a = analyse(m, loadConfig(tracePath('inversion.deadlines.yaml')));
const inversion = a.findings.find((f) => f.kind === 'priority-inversion')!;
const ctx = buildClaimContext(m, inversion);
const waitMs = (Number(inversion.facts.find((f) => f.key === 'wait')!.value) / 1e6).toFixed(1);

const byText = (text: string) => {
  const claims = checkClaims(text, ctx);
  return (s: string) => claims.find((c) => c.text === s);
};

describe('claim checker', () => {
  it('accepts names, priorities and durations that match the evidence', () => {
    const text = `brake_ctl (priority 63) waited ${waitMs} ms for the mutex held by logger (10) while telemetry, at priority 30, ran on CPU 0.`;
    const claims = checkClaims(text, ctx);
    expect(claims.filter((c) => c.status !== 'ok')).toEqual([]);
    expect(claims.map((c) => c.kind)).toEqual(expect.arrayContaining(['thread', 'priority', 'duration', 'cpu']));
  });

  it('rejects a wrong priority for a named thread', () => {
    const c = byText('The logger thread (priority 12) held the lock.')('priority 12');
    expect(c?.status).toBe('mismatch');
    expect(c?.note).toMatch(/priority 10/);
  });

  it('rejects a wrong duration', () => {
    // the measured wait is ~37 ms; 4.1 ms appears nowhere in the evidence
    const c = byText('brake_ctl waited 4.1 ms for the lock.')('4.1 ms');
    expect(c?.status).toBe('mismatch');
    expect(c?.note).toMatch(/closest measured duration/);
  });

  it('accepts a rounded duration only within the precision written', () => {
    const exact = Number(inversion.facts.find((f) => f.key === 'wait')!.value) / 1e6;
    expect(byText(`waited ${Math.round(exact)} ms`)(`${Math.round(exact)} ms`)?.status).toBe('ok');
    expect(byText(`waited ${(exact + 3).toFixed(1)} ms`)(`${(exact + 3).toFixed(1)} ms`)?.status).toBe('mismatch');
    expect(byText(`waited about ${Math.round(exact * 1.08)} ms`)(`${Math.round(exact * 1.08)} ms`)?.status).toBe('ok');
  });

  it('flags a thread that is not in the evidence', () => {
    const c = byText('The `flash_writer` thread held the lock.')('flash_writer');
    expect(c?.status).toBe('unknown');
  });

  it('rejects a CPU the evidence never mentions', () => {
    expect(byText('telemetry ran on CPU 3.')('CPU 3')?.status).toBe('mismatch');
  });

  it('checks a recorded model answer end to end', async () => {
    const answer = {
      text: `CAUSE: brake_ctl (priority 63) blocked on the mutex while logger (priority 10) held it, and telemetry (priority 30) kept logger off CPU 0 for ${waitMs} ms.\nFIX: Use PTHREAD_PRIO_INHERIT.`,
      model: 'recorded',
      ms: 0,
      usedFallback: false,
    };
    const ex = await explainFinding(m, inversion, null, answer);
    expect(ex.claimSummary.mismatch).toBe(0);
    expect(ex.claimSummary.ok).toBeGreaterThanOrEqual(7);
    const bad = await explainFinding(m, inversion, null, { ...answer, text: answer.text.replace('(priority 10)', '(priority 15)') });
    expect(bad.claimSummary.mismatch).toBe(1);
  });

  it('catches a priority boost that never happened', () => {
    // The trace shows logger at 10 throughout: there was no inheritance to raise it.
    const c = checkClaims("logger held the lock; the logger's priority was temporarily raised to 63.", ctx).find((x) => x.text === '63');
    expect(c?.status).toBe('mismatch');
  });

  it('treats unmatched numbers in the FIX as proposals, not errors', () => {
    const text = 'CAUSE logger (priority 10) held the lock.\nFIX raise logger to priority 70.';
    const claims = checkClaims(text, ctx, text.indexOf('FIX'));
    expect(claims.find((x) => x.text === 'priority 70')?.status).toBe('proposal');
    expect(claims.find((x) => x.text === 'priority 10')?.status).toBe('ok');
  });

  it('accepts evidence times quoted relative to the evidence window', () => {
    const rel = (m.time[inversion.evidence[3]] - inversion.window[0]) / 1e6;
    const c = byText(`brake_ctl blocked at ${rel.toFixed(3)} ms.`)(`${rel.toFixed(3)} ms`);
    expect(c?.kind).toBe('time');
    expect(c?.status).toBe('ok');
  });

  it('parses CAUSE and FIX even with markdown emphasis', () => {
    expect(parseAnswer('**CAUSE:** a\n**FIX:** b')).toEqual({ cause: 'a', fix: 'b' });
  });
});
