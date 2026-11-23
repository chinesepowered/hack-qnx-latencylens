// Run every detector and link findings that explain each other.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import type { Config } from '../config/deadlines.js';
import type { Model } from '../model/model.js';
import { detectChains } from './chain.js';
import { detectDeadlineMisses } from './deadline.js';
import { detectHogs } from './hog.js';
import { detectInversions } from './inversion.js';
import { detectIstLatency } from './ist.js';
import type { Finding, FindingKind } from './types.js';

export * from './types.js';

const KIND_ORDER: FindingKind[] = ['deadline-miss', 'priority-inversion', 'ist-latency', 'send-chain', 'cpu-hog'];
const SEV_ORDER = { critical: 0, warning: 1, info: 2 };

export const KIND_LABEL: Record<FindingKind, string> = {
  'deadline-miss': 'Deadline miss',
  'priority-inversion': 'Priority inversion',
  'ist-latency': 'IST latency',
  'send-chain': 'Send-blocked chain',
  'cpu-hog': 'CPU hog',
};

export interface Analysis {
  findings: Finding[];
  notes: string[];
  ms: number;
}

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

export function analyse(m: Model, cfg: Config): Analysis {
  const t0 = performance.now();
  const notes: string[] = [...m.warnings];
  const findings: Finding[] = [
    ...detectDeadlineMisses(m, cfg.deadlines, cfg.options, notes),
    ...detectInversions(m, cfg.options),
    ...detectIstLatency(m, cfg.options, notes),
    ...detectChains(m, cfg.options, notes),
    ...detectHogs(m, cfg.options),
  ];
  findings.sort(
    (a, b) =>
      SEV_ORDER[a.severity] - SEV_ORDER[b.severity] ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      b.instances.length - a.instances.length,
  );
  const counts = new Map<string, number>();
  for (const f of findings) {
    const n = (counts.get(f.kind) ?? 0) + 1;
    counts.set(f.kind, n);
    f.id = `${f.kind}-${n}`;
  }

  // A missed deadline is explained by an inversion, chain or hog that hit the same thread during a
  // late job.
  for (const d of findings) {
    if (d.kind !== 'deadline-miss') continue;
    const victim = d.threads[0];
    for (const f of findings) {
      if (f === d || f.kind === 'deadline-miss') continue;
      const involves =
        (f.kind === 'priority-inversion' && f.threads[0] === victim) ||
        (f.kind === 'send-chain' && f.threads[0] === victim) ||
        (f.kind === 'cpu-hog' && f.threads.slice(1).includes(victim)) ||
        (f.kind === 'ist-latency' && f.threads[0] === victim);
      if (!involves) continue;
      const hit = d.instances.some((di) => f.instances.some((fi) => overlaps(di.t0, di.t1, fi.t0, fi.t1)));
      if (!hit) continue;
      d.related.push(f.id);
      f.related.push(d.id);
    }
    if (d.related.length) {
      const names = d.related.map((id) => findings.find((x) => x.id === id)!).map((x) => `${KIND_LABEL[x.kind].toLowerCase()} (${x.id})`);
      d.summary += ` The late jobs overlap ${names.join(' and ')}.`;
    }
  }
  return { findings, notes, ms: performance.now() - t0 };
}
