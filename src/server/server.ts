// Local web server behind `latencylens open trace.kev`. Binds to 127.0.0.1 by default.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { extname, join } from 'node:path';
import type { Config } from '../config/deadlines.js';
import { KIND_LABEL, type Analysis } from '../detect/index.js';
import { explainFinding, type CompletionResult, type Explanation, type LlmConfig } from '../explain/explain.js';
import { describeEvent } from '../model/format.js';
import { eventAtOrAfter, type Model } from '../model/model.js';
import { traceSummary } from '../report/report.js';
import { packTimeline } from './pack.js';

export interface ServeOptions {
  host: string;
  port: number;
  webDir: string;
  traceName: string;
  llm: LlmConfig | null;
  /** JSON file with recorded explanations: loaded at start, updated after each new one. */
  explanationsFile: string | null;
}

interface Recorded {
  [findingId: string]: CompletionResult & { recordedAt: string };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createServer(m: Model, a: Analysis, cfg: Config, opts: ServeOptions): http.Server {
  const pack = packTimeline(m);
  const recorded: Recorded = opts.explanationsFile && existsSync(opts.explanationsFile) ? JSON.parse(readFileSync(opts.explanationsFile, 'utf8')) : {};
  const fresh = new Map<string, Explanation & { recorded: boolean; recordedAt?: string }>();

  const summary = {
    name: opts.traceName,
    description: traceSummary(m),
    header: m.trace.header,
    stats: m.trace.stats,
    decoder: m.trace.decoder,
    durationNs: m.durationNs,
    cpuCount: m.cpuCount,
    events: m.trace.events.n,
    timings: { parseMs: m.trace.stats.parseMs, modelMs: m.buildMs, detectMs: a.ms },
    deadlines: cfg.deadlines,
    deadlinesFile: cfg.source ?? null,
    llm: opts.llm ? { model: opts.llm.model, fallback: opts.llm.fallbackModel } : null,
    recordedExplanations: Object.keys(recorded),
    threads: m.threads.map((T) => ({
      index: T.index,
      pid: T.pid,
      tid: T.tid,
      name: T.name,
      process: T.process,
      label: T.label,
      basePrio: T.basePrio,
      prioMin: T.prioMin,
      prioMax: T.prioMax,
      policy: T.policy,
      isIdle: T.isIdle,
      isKernel: T.isKernel,
      runningNs: T.runningNs,
    })),
    findings: a.findings.map((f) => ({
      id: f.id,
      kind: f.kind,
      kindLabel: KIND_LABEL[f.kind],
      severity: f.severity,
      title: f.title,
      summary: f.summary,
      hint: f.hint,
      threads: f.threads,
      window: f.window,
      related: f.related,
      facts: f.facts,
      instances: f.instances.slice(0, 500).map((x) => ({ t0: x.t0, t1: x.t1, value: x.value, text: x.text })),
      instanceCount: f.instances.length,
      evidenceCount: f.evidence.length,
    })),
    notes: a.notes,
    notesExtra: m.notes.map((n) => ({ t: n.t, thread: n.thread, text: n.text })),
  };
  const summaryJson = JSON.stringify(summary);

  const send = (res: http.ServerResponse, status: number, body: string | Buffer, type: string) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  };
  const json = (res: http.ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v), 'application/json; charset=utf-8');

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;
      if (req.method === 'GET' && p === '/api/trace') return send(res, 200, summaryJson, 'application/json; charset=utf-8');
      if (req.method === 'GET' && p === '/api/timeline') return send(res, 200, pack, 'application/octet-stream');
      if (req.method === 'GET' && p.startsWith('/api/finding/')) {
        const f = a.findings.find((x) => x.id === decodeURIComponent(p.slice('/api/finding/'.length)));
        if (!f) return json(res, 404, { error: 'no such finding' });
        return json(res, 200, { id: f.id, evidence: f.evidence.map((i) => describeEvent(m, i)) });
      }
      if (req.method === 'GET' && p === '/api/events') {
        const from = Number(url.searchParams.get('from') ?? 0);
        const to = Number(url.searchParams.get('to') ?? from + 1e6);
        const want = (url.searchParams.get('threads') ?? '').split(',').filter(Boolean).map(Number);
        const set = new Set(want);
        const rows = [];
        for (let i = eventAtOrAfter(m, from); i < m.trace.events.n && m.time[i] <= to && rows.length < 2000; i++) {
          const r = describeEvent(m, i);
          if (set.size && !set.has(r.thread)) continue;
          rows.push(r);
        }
        return json(res, 200, { rows });
      }
      if (req.method === 'POST' && p === '/api/explain') {
        const body = await new Promise<string>((resolve) => {
          let s = '';
          req.on('data', (c) => (s += c));
          req.on('end', () => resolve(s));
        });
        const { id, refresh } = JSON.parse(body || '{}') as { id?: string; refresh?: boolean };
        const f = a.findings.find((x) => x.id === id);
        if (!f) return json(res, 404, { error: 'no such finding' });
        if (!refresh && fresh.has(f.id)) return json(res, 200, fresh.get(f.id));
        const rec = recorded[f.id];
        if (!refresh && rec) {
          const ex = await explainFinding(m, f, null, rec);
          const out = { ...ex, recorded: true, recordedAt: rec.recordedAt };
          fresh.set(f.id, out);
          return json(res, 200, out);
        }
        if (!opts.llm) return json(res, 503, { error: 'Explanations need an API key: put OPENAI_API_KEY (W&B Inference or any OpenAI-compatible endpoint) in .env and restart.' });
        const ex = await explainFinding(m, f, opts.llm);
        const out = { ...ex, recorded: false };
        fresh.set(f.id, out);
        if (opts.explanationsFile) {
          recorded[f.id] = { text: `CAUSE: ${ex.cause}\nFIX: ${ex.fix}`, model: ex.model, ms: ex.ms, usedFallback: ex.usedFallback, recordedAt: new Date().toISOString() };
          writeFileSync(opts.explanationsFile, JSON.stringify(recorded, null, 2) + '\n');
        }
        return json(res, 200, out);
      }
      if (req.method === 'GET') {
        const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
        if (file.includes('..')) return send(res, 400, 'bad path', 'text/plain');
        const full = join(opts.webDir, file);
        if (existsSync(full)) return send(res, 200, readFileSync(full), MIME[extname(full)] ?? 'application/octet-stream');
      }
      send(res, 404, 'not found', 'text/plain');
    } catch (err) {
      json(res, 500, { error: String((err as Error).message ?? err) });
    }
  });
}
