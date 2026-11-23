// CPU hog: one thread monopolised a core for a sustained window while other threads were ready to
// run there. Under SCHED_FIFO nothing time-slices between priorities, so a busy high-priority thread
// starves everything below it on its CPU. Copyright (C) 2026 chinesepowered.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ST, firstRunEndingAfter, type Model } from '../model/model.js';
import type { DetectorOptions, Fact, Finding, Instance } from './types.js';
import { collectEvidence, fmtDur, fmtTime, pct, plural, threadShort } from './util.js';

interface Episode {
  cpu: number;
  thread: number;
  a: number;
  b: number;
  busy: number;
  starved: { thread: number; ns: number; prio: number }[];
}

export function detectHogs(m: Model, opts: DetectorOptions): Finding[] {
  const W = opts.hogWindowNs;
  const step = W / 10;
  const episodes: Episode[] = [];
  for (let cpu = 0; cpu < m.cpus.length; cpu++) {
    const c = m.cpus[cpu];
    // running intervals per thread on this CPU
    const per = new Map<number, { s: number[]; e: number[] }>();
    for (let k = 0; k < c.n; k++) {
      const th = c.thread[k];
      if (th < 0 || m.threads[th].isIdle) continue;
      const x = per.get(th) ?? per.set(th, { s: [], e: [] }).get(th)!;
      x.s.push(c.start[k]);
      x.e.push(c.end[k]);
    }
    for (const [th, iv] of per) {
      let total = 0;
      for (let k = 0; k < iv.s.length; k++) total += iv.e[k] - iv.s[k];
      if (total < W * opts.hogShare) continue;
      // prefix sums of busy time for O(log n) window queries
      const pre = new Float64Array(iv.s.length + 1);
      for (let k = 0; k < iv.s.length; k++) pre[k + 1] = pre[k] + (iv.e[k] - iv.s[k]);
      const busyUntil = (t: number): number => {
        let lo = 0;
        let hi = iv.s.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (iv.s[mid] < t) lo = mid + 1;
          else hi = mid;
        }
        // intervals [0, lo) start before t
        let busy = pre[lo];
        if (lo > 0 && iv.e[lo - 1] > t) busy -= iv.e[lo - 1] - t;
        return busy;
      };
      let cur: Episode | null = null;
      for (let a = 0; a + W <= m.durationNs; a += step) {
        const busy = busyUntil(a + W) - busyUntil(a);
        const hot = busy >= opts.hogShare * W;
        if (hot) {
          if (cur && a <= cur.b) cur.b = a + W;
          else {
            if (cur) episodes.push(cur);
            cur = { cpu, thread: th, a, b: a + W, busy: 0, starved: [] };
          }
        }
      }
      if (cur) episodes.push(cur);
      for (const ep of episodes) if (ep.thread === th && ep.cpu === cpu && ep.busy === 0) ep.busy = busyUntil(ep.b) - busyUntil(ep.a);
    }
  }

  // Who was starved: threads READY on that CPU during the episode.
  for (const ep of episodes) {
    for (const T of m.threads) {
      if (T.index === ep.thread || T.isIdle) continue;
      const r = T.runs;
      let ready = 0;
      for (let k = firstRunEndingAfter(r, ep.a); k < r.n && r.start[k] < ep.b; k++) {
        if (r.state[k] !== ST.READY || r.cpu[k] !== ep.cpu) continue;
        ready += Math.min(ep.b, r.end[k]) - Math.max(ep.a, r.start[k]);
      }
      if (ready >= 1e6) ep.starved.push({ thread: T.index, ns: ready, prio: T.basePrio });
    }
    ep.starved.sort((x, y) => y.ns - x.ns);
  }

  const byThread = new Map<string, Episode[]>();
  for (const ep of episodes) {
    if (!ep.starved.length) continue; // a busy core nobody else wanted is not a hog
    const k = `${ep.thread}:${ep.cpu}`;
    (byThread.get(k) ?? byThread.set(k, []).get(k)!).push(ep);
  }
  const findings: Finding[] = [];
  for (const list of byThread.values()) {
    list.sort((x, y) => y.b - y.a - (x.b - x.a));
    const w = list[0];
    const th = w.thread;
    const name = threadShort(m, th);
    const prio = m.threads[th].basePrio;
    const len = w.b - w.a;
    const share = w.busy / len;
    const total = list.reduce((s, x) => s + (x.b - x.a), 0);
    const top = w.starved[0];
    const facts: Fact[] = [
      { key: 'hogPrio', label: `${name} priority`, kind: 'priority', value: prio, thread: th },
      { key: 'cpu', label: 'CPU', kind: 'cpu', value: w.cpu },
      { key: 'episode', label: 'longest episode', kind: 'duration', value: len },
      { key: 'busy', label: `${name} running time in it`, kind: 'duration', value: w.busy },
      { key: 'share', label: 'share of the CPU', kind: 'percent', value: share * 100 },
      { key: 'episodes', label: 'episodes', kind: 'count', value: list.length },
      { key: 'total', label: 'time monopolised in total', kind: 'duration', value: total },
      { key: 'window', label: 'hog window', kind: 'duration', value: opts.hogWindowNs },
    ];
    for (const s of w.starved.slice(0, 4)) {
      facts.push({ key: `starved:${s.thread}`, label: `${threadShort(m, s.thread)} ready but not running`, kind: 'duration', value: s.ns });
      facts.push({ key: `prio:${s.thread}`, label: `${threadShort(m, s.thread)} priority`, kind: 'priority', value: s.prio, thread: s.thread });
    }
    const summary =
      `${m.threads[th].label} (priority ${prio}) used ${pct(share)} of CPU ${w.cpu} for ${fmtDur(len)} starting at ${fmtTime(w.a)}. ` +
      `Meanwhile ${w.starved
        .slice(0, 3)
        .map((s) => `${threadShort(m, s.thread)} (priority ${s.prio}) was ready but not running for ${fmtDur(s.ns)}`)
        .join(', ')}. ` +
      `SCHED_FIFO does not share the CPU between priorities, so everything below priority ${prio} on CPU ${w.cpu} waited. ` +
      `It happened in ${plural(list.length, 'episode')}, ${fmtDur(total)} in total.`;
    const hint = `Run ${name} below the periodic threads on CPU ${w.cpu} (under priority ${Math.min(...w.starved.map((s) => s.prio))}), make it SCHED_SPORADIC with a CPU budget, move it to a CPU of its own with a runmask, or split its work into short slices with yields.`;
    const threads = [th, ...w.starved.slice(0, 3).map((s) => s.thread)];
    const t0 = Math.max(0, w.a - len * 0.05);
    const t1 = Math.min(m.durationNs, w.b + len * 0.05);
    const instances: Instance[] = list.map((x) => ({
      t0: x.a,
      t1: x.b,
      value: x.b - x.a,
      text: `${fmtTime(x.a)}: ${name} held CPU ${x.cpu} for ${fmtDur(x.b - x.a)} (${pct(x.busy / (x.b - x.a))})`,
      events: [],
    }));
    findings.push({
      id: '',
      kind: 'cpu-hog',
      severity: top && top.ns > len * 0.5 ? 'critical' : 'warning',
      title: `CPU hog: ${name} (${prio}) held CPU ${w.cpu} for ${fmtDur(len)} (${pct(share)})`,
      summary,
      hint,
      threads,
      window: [t0, t1],
      evidence: collectEvidence(m, threads, w.a, Math.min(w.b, w.a + 20e6), { max: opts.maxEvidence, cpus: [w.cpu] }),
      facts,
      instances,
      related: [],
    });
  }
  return findings;
}
