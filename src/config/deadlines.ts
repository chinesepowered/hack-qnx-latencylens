// deadlines.yaml: which threads are periodic, with what period and deadline.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
//
//   threads:
//     - name: brake_ctl        # thread name, "process/thread", or "pid/tid"
//       period: 20ms
//       deadline: 15ms         # relative to each release; defaults to the period
//       markers:               # optional: TraceEvent() user events that delimit one job
//         begin: 100           # data: job sequence number, start lateness in us
//         end: 101
//       wait_state: NANOSLEEP  # optional: state the thread waits in between jobs (no markers)
//   thresholds:                # optional detector thresholds
//     ist_latency: 1ms
//     chain_wait: 5ms
//     chain_min_count: 3
//     hog_window: 100ms
//     hog_share: 90%
//     inversion_min: 200us

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import YAML from 'yaml';
import { ThreadState } from '../kev/constants.js';
import { DEFAULT_OPTIONS, type DetectorOptions } from '../detect/types.js';

export interface DeadlineSpec {
  name: string;
  periodNs: number;
  deadlineNs: number;
  markers?: { begin: number; end: number };
  waitState?: number;
}

export interface Config {
  deadlines: DeadlineSpec[];
  options: DetectorOptions;
  source?: string;
}

/** "20ms", "1.5 ms", "500us", "2s", "100ns"; a bare number means milliseconds. */
export function parseDuration(v: unknown, field: string): number {
  if (typeof v === 'number') return v * 1e6;
  if (typeof v !== 'string') throw new Error(`${field}: expected a duration like "20ms", got ${JSON.stringify(v)}`);
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(ns|us|µs|μs|ms|s)?\s*$/i.exec(v);
  if (!m) throw new Error(`${field}: cannot read duration "${v}"`);
  const x = Number(m[1]);
  switch ((m[2] ?? 'ms').toLowerCase()) {
    case 'ns':
      return x;
    case 'us':
    case 'µs':
    case 'μs':
      return x * 1e3;
    case 's':
      return x * 1e9;
    default:
      return x * 1e6;
  }
}

function parseShare(v: unknown): number {
  if (typeof v === 'number') return v > 1 ? v / 100 : v;
  const m = /^\s*([0-9.]+)\s*%?\s*$/.exec(String(v));
  if (!m) throw new Error(`hog_share: cannot read "${v}"`);
  const x = Number(m[1]);
  return String(v).includes('%') || x > 1 ? x / 100 : x;
}

export function parseConfig(text: string, source?: string): Config {
  const doc = (YAML.parse(text) ?? {}) as Record<string, unknown>;
  const deadlines: DeadlineSpec[] = [];
  const list = (doc.threads ?? doc.deadlines ?? []) as unknown[];
  if (!Array.isArray(list)) throw new Error('deadlines.yaml: "threads" must be a list');
  for (const [k, raw] of list.entries()) {
    const t = raw as Record<string, unknown>;
    const name = String(t.name ?? t.thread ?? '');
    if (!name) throw new Error(`threads[${k}]: missing name`);
    const periodNs = parseDuration(t.period, `${name}.period`);
    const deadlineNs = t.deadline === undefined ? periodNs : parseDuration(t.deadline, `${name}.deadline`);
    const spec: DeadlineSpec = { name, periodNs, deadlineNs };
    if (t.markers) {
      const mk = t.markers as Record<string, unknown>;
      spec.markers = { begin: Number(mk.begin ?? 100), end: Number(mk.end ?? 101) };
    }
    if (t.wait_state) {
      const s = String(t.wait_state).toUpperCase().replace(/^STATE_/, '');
      const v = (ThreadState as Record<string, number>)[s];
      if (v === undefined) throw new Error(`${name}.wait_state: unknown thread state ${t.wait_state}`);
      spec.waitState = v;
    }
    deadlines.push(spec);
  }
  const options: DetectorOptions = { ...DEFAULT_OPTIONS };
  const th = (doc.thresholds ?? {}) as Record<string, unknown>;
  if (th.ist_latency !== undefined) options.istLatencyNs = parseDuration(th.ist_latency, 'ist_latency');
  if (th.chain_wait !== undefined) options.chainWaitNs = parseDuration(th.chain_wait, 'chain_wait');
  if (th.chain_min_count !== undefined) options.chainMinCount = Math.max(1, Number(th.chain_min_count));
  if (th.hog_window !== undefined) options.hogWindowNs = parseDuration(th.hog_window, 'hog_window');
  if (th.hog_share !== undefined) options.hogShare = parseShare(th.hog_share);
  if (th.inversion_min !== undefined) options.inversionMinNs = parseDuration(th.inversion_min, 'inversion_min');
  return { deadlines, options, source };
}

export function loadConfig(path: string): Config {
  return parseConfig(readFileSync(path, 'utf8'), path);
}

/** Next to trace.kev: trace.deadlines.yaml, then deadlines.yaml. */
export function findConfigFor(tracePath: string): string | null {
  const dir = dirname(tracePath);
  const stem = basename(tracePath).replace(/\.(kev|txt)(\.gz)?$/i, '');
  for (const c of [join(dir, `${stem}.deadlines.yaml`), join(dir, 'deadlines.yaml')]) if (existsSync(c)) return c;
  return null;
}

export function defaultConfig(): Config {
  return { deadlines: [], options: { ...DEFAULT_OPTIONS } };
}
