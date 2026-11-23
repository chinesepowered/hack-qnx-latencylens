// Priority inversion: a high-priority thread waits for a resource (a mutex, or a reply from a
// server) held by a lower-priority thread, and a medium-priority thread keeps the holder off the
// CPU. Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
//
// For every wait we look at the holder's READY time during the wait. If the holder's effective
// priority then (as logged in its THREADY/THRUNNING events, so a priority-inheritance boost counts)
// was below the waiter's, every thread that ran on the holder's CPU with a priority strictly between
// the two is an inverting thread. A boosted holder (PTHREAD_PRIO_INHERIT, or a server that received
// at the client's priority) produces no inversion.

import { ST, firstRunEndingAfter, type Model } from '../model/model.js';
import type { DetectorOptions, Fact, Finding, Instance } from './types.js';
import { collectEvidence, cpuOccupants, fmtDur, fmtTime, homeCpu, plural, prioAt, threadShort } from './util.js';

interface Inv {
  via: 'mutex' | 'reply';
  waiter: number;
  holder: number;
  resource: string; // "mutex 0x..." or "a reply"
  sync: number;
  waiterPrio: number;
  holderPrio: number; // effective priority while it was kept off the CPU
  t0: number;
  t1: number;
  wait: number;
  holderReady: number;
  holderRunning: number;
  inverted: number; // time medium threads ran while the holder was ready
  mediums: Map<number, { ns: number; prio: number }>;
  keyEvents: number[];
}

function analyse(m: Model, inv: Inv): void {
  const r = m.threads[inv.holder].runs;
  for (let k = firstRunEndingAfter(r, inv.t0); k < r.n && r.start[k] < inv.t1; k++) {
    const a = Math.max(inv.t0, r.start[k]);
    const b = Math.min(inv.t1, r.end[k]);
    if (b <= a) continue;
    if (r.state[k] === ST.RUNNING) {
      inv.holderRunning += b - a;
      continue;
    }
    if (r.state[k] !== ST.READY) continue;
    inv.holderReady += b - a;
    const hp = r.prio[k] >= 0 ? r.prio[k] : m.threads[inv.holder].basePrio;
    if (hp >= inv.waiterPrio) continue; // boosted to the waiter's level: no inversion
    inv.holderPrio = Math.min(inv.holderPrio, hp);
    const cpu = r.cpu[k] >= 0 ? r.cpu[k] : homeCpu(m, inv.holder);
    for (const it of cpuOccupants(m, cpu, a, b, new Set([inv.holder, inv.waiter]))) {
      if (it.prio <= hp || it.prio >= inv.waiterPrio) continue;
      inv.inverted += it.ns;
      const x = inv.mediums.get(it.thread) ?? { ns: 0, prio: it.prio };
      x.ns += it.ns;
      x.prio = Math.max(x.prio, it.prio);
      inv.mediums.set(it.thread, x);
    }
  }
}

export function detectInversions(m: Model, opts: DetectorOptions): Finding[] {
  const found: Inv[] = [];
  for (const w of m.mutexWaits) {
    if (w.holder < 0 || w.holder === w.waiter || Number.isNaN(w.tWake)) continue;
    const inv: Inv = {
      via: 'mutex',
      waiter: w.waiter,
      holder: w.holder,
      resource: `mutex 0x${w.sync.toString(16)}`,
      sync: w.sync,
      waiterPrio: prioAt(m, w.waiter, w.tBlock + 1),
      holderPrio: 1e9,
      t0: w.tBlock,
      t1: w.tWake,
      wait: w.tWake - w.tBlock,
      holderReady: 0,
      holderRunning: 0,
      inverted: 0,
      mediums: new Map(),
      keyEvents: [w.evLock, w.evBlock, w.evUnlock, w.evWake].filter((x) => x >= 0),
    };
    analyse(m, inv);
    if (inv.inverted >= opts.inversionMinNs) found.push(inv);
  }
  for (const x of m.messages) {
    if (x.server < 0 || x.client < 0 || Number.isNaN(x.tReceive) || Number.isNaN(x.tReply)) continue;
    if (x.tReply - x.tReceive < opts.inversionMinNs) continue;
    const inv: Inv = {
      via: 'reply',
      waiter: x.client,
      holder: x.server,
      resource: 'a reply',
      sync: Number.NaN,
      waiterPrio: prioAt(m, x.client, x.tReceive + 1),
      holderPrio: 1e9,
      t0: x.tReceive,
      t1: x.tReply,
      wait: x.tReply - x.tReceive,
      holderReady: 0,
      holderRunning: 0,
      inverted: 0,
      mediums: new Map(),
      keyEvents: [x.evSend, x.evReceive, x.evReply].filter((e) => e >= 0),
    };
    analyse(m, inv);
    if (inv.inverted >= opts.inversionMinNs) found.push(inv);
  }

  // One finding per waiter, holder and resource.
  const groups = new Map<string, Inv[]>();
  for (const inv of found) {
    const k = `${inv.via}:${inv.waiter}:${inv.holder}:${inv.sync}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(inv);
  }
  const findings: Finding[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.inverted - a.inverted);
    const w = list[0];
    const W = threadShort(m, w.waiter);
    const H = threadShort(m, w.holder);
    const mediums = [...w.mediums.entries()].sort((a, b) => b[1].ns - a[1].ns);
    const [mTh, mInfo] = mediums[0];
    const M = threadShort(m, mTh);
    const hBase = m.threads[w.holder].basePrio;
    const cpu = homeCpu(m, w.holder);
    const totalInverted = list.reduce((s, x) => s + x.inverted, 0);
    const what = w.via === 'mutex' ? `the mutex at 0x${w.sync.toString(16)}` : `a reply from ${H}`;
    const summary =
      `${W} (priority ${w.waiterPrio}) waited ${fmtDur(w.wait)} for ${what}, which ${H} (priority ${w.holderPrio}) had to ${w.via === 'mutex' ? 'release' : 'send'}. ` +
      `${H} was ready to run for ${fmtDur(w.holderReady)} of that time but ${M} (priority ${mInfo.prio}) ran instead for ${fmtDur(mInfo.ns)} on CPU ${cpu}, ` +
      `so the priority ${w.waiterPrio} thread waited on a priority ${mInfo.prio} thread: a priority inversion. ` +
      `It happened ${plural(list.length, 'time')} in this trace (${fmtDur(totalInverted)} of inverted time in total); the worst wait began at ${fmtTime(w.t0)}.`;
    const hint =
      w.via === 'mutex'
        ? `Create the mutex with PTHREAD_PRIO_INHERIT (the QNX default) or PTHREAD_PRIO_PROTECT with a ceiling of at least ${w.waiterPrio}, so ${H} runs at ${W}'s priority while it holds the lock. Also keep slow work such as formatting or I/O out of the critical section.`
        : `Let ${H} inherit its clients' priorities (do not create the channel with _NTO_CHF_FIXED_PRIORITY), or raise ${H} above ${M}.`;
    const facts: Fact[] = [
      { key: 'waiterPrio', label: `${W} priority`, kind: 'priority', value: w.waiterPrio, thread: w.waiter },
      { key: 'holderPrio', label: `${H} priority`, kind: 'priority', value: w.holderPrio, thread: w.holder },
      { key: 'mediumPrio', label: `${M} priority`, kind: 'priority', value: mInfo.prio, thread: mTh },
      { key: 'wait', label: `${W} wait`, kind: 'duration', value: w.wait },
      { key: 'holderReady', label: `${H} ready but not running`, kind: 'duration', value: w.holderReady },
      { key: 'holderRunning', label: `${H} running during the wait`, kind: 'duration', value: w.holderRunning },
      { key: 'mediumRan', label: `${M} ran while ${H} was ready`, kind: 'duration', value: mInfo.ns },
      { key: 'inverted', label: 'inverted time (worst)', kind: 'duration', value: w.inverted },
      { key: 'occurrences', label: 'occurrences', kind: 'count', value: list.length },
      { key: 'totalInverted', label: 'inverted time (all occurrences)', kind: 'duration', value: totalInverted },
      { key: 'cpu', label: 'CPU', kind: 'cpu', value: cpu },
    ];
    if (hBase !== w.holderPrio) facts.push({ key: 'holderBase', label: `${H} base priority`, kind: 'priority', value: hBase, thread: w.holder });
    for (const [th, info] of mediums.slice(1, 3)) {
      facts.push({ key: `medium:${th}`, label: `${threadShort(m, th)} ran while ${H} was ready`, kind: 'duration', value: info.ns });
      facts.push({ key: `mediumPrio:${th}`, label: `${threadShort(m, th)} priority`, kind: 'priority', value: info.prio, thread: th });
    }
    if (w.via === 'mutex') {
      facts.push({ key: 'mutex', label: 'mutex address', kind: 'text', value: `0x${w.sync.toString(16)}` });
      // What the trace says about the mutex protocol: with PTHREAD_PRIO_INHERIT (or a high enough
      // PTHREAD_PRIO_PROTECT ceiling) the kernel would have run the holder at the waiter's priority.
      const r = m.threads[w.holder].runs;
      let top = -1;
      for (let k = firstRunEndingAfter(r, w.t0); k < r.n && r.start[k] < w.t1; k++) {
        if (r.state[k] === ST.RUNNING || r.state[k] === ST.READY) top = Math.max(top, r.prio[k]);
      }
      if (top >= 0 && top < w.waiterPrio) {
        facts.push({
          key: 'holderBoost',
          label: `${H} priority during the wait`,
          kind: 'text',
          value: top === hBase ? `${top}, never raised (no priority inheritance or ceiling took effect)` : `${top}, below ${W}'s ${w.waiterPrio}`,
        });
      }
    }
    const pad = Math.min(2e6, w.wait * 0.1);
    const t0 = Math.max(0, w.t0 - pad);
    const t1 = Math.min(m.durationNs, w.t1 + pad);
    const threads = [w.waiter, w.holder, ...mediums.slice(0, 3).map(([th]) => th)];
    const instances: Instance[] = list.map((x) => ({
      t0: x.t0,
      t1: x.t1,
      value: x.wait,
      text: `${fmtTime(x.t0)}: waited ${fmtDur(x.wait)}, inverted ${fmtDur(x.inverted)}`,
      events: x.keyEvents,
    }));
    findings.push({
      id: '',
      kind: 'priority-inversion',
      severity: 'critical',
      title: `Priority inversion: ${W} (${w.waiterPrio}) waited on ${H} (${w.holderPrio}) while ${M} (${mInfo.prio}) ran`,
      summary,
      hint,
      threads,
      window: [t0, t1],
      evidence: collectEvidence(m, threads, t0, t1, { max: opts.maxEvidence, cpus: [cpu], keyEvents: w.keyEvents }),
      facts,
      instances,
      related: [],
    });
  }
  return findings;
}
