// Interrupt latency as QNX OS 8.0 sees it: there are no ISRs, so a driver's latency is the time from
// the kernel delivering the interrupt (INT_DELIVER) to its interrupt service thread (IST) running.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
//
// ISTs are known from SYSTEM IST_ATTACH events (emitted by InterruptAttachThread() and
// InterruptAttachEvent(), and for every attached IST when tracing starts). If a trace has none, we
// infer them: a thread that keeps leaving STATE_INTR right after deliveries of one interrupt.

import { ST, runAt, type Model } from '../model/model.js';
import type { DetectorOptions, Fact, Finding, Instance } from './types.js';
import { collectEvidence, cpuOccupants, fmtDur, fmtTime, homeCpu, plural, threadShort } from './util.js';

interface Binding {
  thread: number;
  intr: number;
  /** For _NTO_INTR_FLAGS_CPU_LOCAL attachments: only deliveries on this CPU wake the IST. */
  cpu: number;
}

const INTR_FLAGS_CPU_LOCAL = 0x80;
/** A delivery "wakes" an IST if the IST leaves its wait within this long. */
const WAKE_WINDOW_NS = 200_000;

function intrName(intr: number): string {
  return intr >= 0x80000000 ? `0x${intr.toString(16)}` : String(intr);
}

/** Threads that sleep in STATE_INTR and wake right after one interrupt are its ISTs. */
function inferBindings(m: Model, known: Set<string>): Binding[] {
  const out: Binding[] = [];
  const ints = m.interrupts;
  for (const T of m.threads) {
    if (T.isKernel) continue; // procnto's own ISTs are always reported by IST_ATTACH
    const r = T.runs;
    const votes = new Map<number, number>();
    let wakes = 0;
    for (let k = 1; k < r.n && wakes < 200; k++) {
      if (r.state[k - 1] !== ST.INTR || r.state[k] !== ST.READY) continue;
      wakes++;
      const t = r.start[k];
      // the latest delivery at or before the wakeup, within 1 ms
      let lo = 0;
      let hi = ints.n - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ints.t[mid] <= t) {
          best = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (best >= 0 && t - ints.t[best] < WAKE_WINDOW_NS) votes.set(ints.intr[best], (votes.get(ints.intr[best]) ?? 0) + 1);
    }
    let intr = -1;
    let n = 0;
    for (const [i, c] of votes) if (c > n) [intr, n] = [i, c];
    if (intr >= 0 && n >= Math.max(5, wakes * 0.8) && !known.has(`${T.index}:${intr}`)) out.push({ thread: T.index, intr, cpu: -1 });
  }
  return out;
}

export function detectIstLatency(m: Model, opts: DetectorOptions, notes: string[] = []): Finding[] {
  const seen = new Set<string>();
  const bindings: Binding[] = [];
  for (const b of m.ists) {
    const k = `${b.thread}:${b.intr}`;
    if (!seen.has(k)) {
      seen.add(k);
      bindings.push({ thread: b.thread, intr: b.intr, cpu: b.flags & INTR_FLAGS_CPU_LOCAL ? b.cpu : -1 });
    }
  }
  bindings.push(...inferBindings(m, seen));

  const findings: Finding[] = [];
  const ints = m.interrupts;
  for (const { thread: th, intr, cpu: onlyCpu } of bindings) {
    const T = m.threads[th];
    const r = T.runs;
    const lat: { t0: number; t2: number; ev: number; evRun: number; cpu: number }[] = [];
    let coalesced = 0;
    let deliveries = 0;
    for (let i = 0; i < ints.n; i++) {
      if (ints.intr[i] !== intr) continue;
      if (onlyCpu >= 0 && ints.cpu[i] !== onlyCpu) continue;
      deliveries++;
      const t0 = ints.t[i];
      const k = runAt(r, t0);
      if (k < 0) continue;
      const s = r.state[k];
      if (s === ST.RUNNING || s === ST.READY) {
        coalesced++; // still busy with (or preempted during) an earlier interrupt
        continue;
      }
      // The delivery must be what woke the IST: it leaves its wait right away.
      const j0 = k + 1;
      if (j0 >= r.n || r.start[j0] - t0 > WAKE_WINDOW_NS || (r.state[j0] !== ST.READY && r.state[j0] !== ST.RUNNING)) continue;
      let j = j0;
      while (j < r.n && r.state[j] !== ST.RUNNING && r.start[j] - t0 < 1e9) j++;
      if (j >= r.n || r.state[j] !== ST.RUNNING) continue;
      lat.push({ t0, t2: r.start[j], ev: ints.ev[i], evRun: r.ev[j], cpu: ints.cpu[i] });
    }
    if (!lat.length) continue;
    const vals = lat.map((x) => x.t2 - x.t0).sort((a, b) => a - b);
    const median = vals[Math.floor(vals.length / 2)];
    const p99 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))];
    const cpu = homeCpu(m, th);
    // A late IST is a scheduling problem when other threads used its CPU for most of the wait. If
    // nothing ran, the delay is outside the trace (emulation, firmware) and is only noted.
    // Under strict priority scheduling only threads at or above the IST's priority can hold it off
    // its CPU; time "taken" by lower-priority threads is a stall outside the schedule.
    const istPrio = T.basePrio;
    // Time the IST's CPU spent on threads at or above its priority, split into application threads
    // (a schedule you can change) and procnto's own threads (kernel time you cannot reprioritise).
    const occupied = (x: { t0: number; t2: number }, kernel: boolean) =>
      cpuOccupants(m, cpu, x.t0, x.t2, new Set([th]))
        .filter((o) => o.prio >= istPrio && m.threads[o.thread].isKernel === kernel)
        .reduce((s2, o) => s2 + o.ns, 0);
    const slow = lat.filter((x) => x.t2 - x.t0 >= opts.istLatencyNs);
    const over = slow.filter((x) => occupied(x, false) >= 0.5 * (x.t2 - x.t0)).sort((a, b) => b.t2 - b.t0 - (a.t2 - a.t0));
    const rest = slow.filter((x) => !over.includes(x));
    const inKernel = rest.filter((x) => occupied(x, true) >= 0.5 * (x.t2 - x.t0));
    const platform = rest.filter((x) => !inKernel.includes(x));
    if (inKernel.length) {
      const worst = inKernel.reduce((a, b) => (b.t2 - b.t0 > a.t2 - a.t0 ? b : a));
      const k = cpuOccupants(m, cpu, worst.t0, worst.t2, new Set([th])).filter((o) => o.prio >= istPrio && m.threads[o.thread].isKernel)[0];
      notes.push(
        `${T.label}: ${plural(inKernel.length, 'late wakeup')} of up to ${fmtDur(worst.t2 - worst.t0)} while procnto's own ${k ? `${threadShort(m, k.thread)} (priority ${k.prio})` : 'threads'} held CPU ${cpu} (kernel time, not your schedule; under QEMU's TCG usually emulation noise)`,
      );
    }
    if (platform.length) {
      const worstPlatform = Math.max(...platform.map((x) => x.t2 - x.t0));
      notes.push(`${T.label}: ${plural(platform.length, 'late wakeup')} of up to ${fmtDur(worstPlatform)} while no thread of equal or higher priority ran on CPU ${cpu} (platform latency, not scheduling)`);
    }
    if (!over.length) continue;
    const w = over[0];
    const worstNs = w.t2 - w.t0;
    const blockers = cpuOccupants(m, cpu, w.t0, w.t2, new Set([th])).filter((o) => o.prio >= istPrio && !m.threads[o.thread].isKernel);
    const crossCpu = w.cpu !== cpu;
    const top = blockers[0];
    const prio = T.basePrio;
    const name = threadShort(m, th);
    const facts: Fact[] = [
      { key: 'istPrio', label: `${name} priority`, kind: 'priority', value: prio, thread: th },
      { key: 'intr', label: 'interrupt', kind: 'text', value: intrName(intr) },
      { key: 'worst', label: 'worst latency (delivery to IST running)', kind: 'duration', value: worstNs },
      { key: 'median', label: 'median latency', kind: 'duration', value: median },
      { key: 'p99', label: '99th percentile latency', kind: 'duration', value: p99 },
      { key: 'threshold', label: 'latency threshold', kind: 'duration', value: opts.istLatencyNs },
      { key: 'over', label: 'deliveries over the threshold', kind: 'count', value: over.length },
      { key: 'deliveries', label: 'interrupt deliveries', kind: 'count', value: deliveries },
      { key: 'measured', label: 'deliveries measured', kind: 'count', value: lat.length },
      { key: 'coalesced', label: 'interrupts that arrived while the IST was busy or preempted', kind: 'count', value: coalesced },
      { key: 'cpu', label: 'CPU', kind: 'cpu', value: cpu },
      { key: 'deliveryCpu', label: 'CPU the interrupt was delivered on', kind: 'cpu', value: w.cpu },
    ];
    for (const b of blockers.slice(0, 3)) {
      facts.push({ key: `blocker:${b.thread}`, label: `${threadShort(m, b.thread)} ran during the worst case`, kind: 'duration', value: b.ns });
      facts.push({ key: `blockerPrio:${b.thread}`, label: `${threadShort(m, b.thread)} priority`, kind: 'priority', value: b.prio, thread: b.thread });
    }
    const summary =
      `${T.label} (priority ${prio}) is the interrupt service thread for interrupt ${intrName(intr)}. ` +
      `From interrupt delivery to running it waited up to ${fmtDur(worstNs)} (median ${fmtDur(median)}); ${over.length} of ${plural(lat.length, 'delivery', 'deliveries')} took longer than ${fmtDur(opts.istLatencyNs)}. ` +
      (top
        ? `In the worst case, at ${fmtTime(w.t0)}, ${threadShort(m, top.thread)} (priority ${top.prio}) held CPU ${cpu} for ${fmtDur(top.ns)} while the IST was ready. `
        : '') +
      (crossCpu
        ? `The interrupt was delivered on CPU ${w.cpu} but ${name} runs on CPU ${cpu}, so every wakeup also needs an inter-processor interrupt. `
        : '') +
      (coalesced ? `${plural(coalesced, 'interrupt')} arrived while ${name} was still busy or preempted, so the device was serviced late or samples were merged.` : '');
    const hint =
      (top
        ? `An IST has to outrank the work that shares its CPU. Raise ${name} above ${threadShort(m, top.thread)} (priority ${top.prio}), for example to ${Math.min(255, top.prio + 10)}, or move ${threadShort(m, top.thread)} to another CPU with a runmask.`
        : `Raise ${name}'s priority above the threads that share its CPU.`) +
      (crossCpu ? ` Run ${name} on CPU ${w.cpu}, where the interrupt arrives, to avoid the cross-CPU wakeup.` : '');
    const pad = Math.max(500_000, (w.t2 - w.t0) * 0.15);
    const t0 = Math.max(0, w.t0 - pad);
    const t1 = Math.min(m.durationNs, w.t2 + pad);
    const threads = [th, ...blockers.slice(0, 3).map((b) => b.thread)];
    const instances: Instance[] = over.map((x) => ({
      t0: x.t0,
      t1: x.t2,
      value: x.t2 - x.t0,
      text: `${fmtTime(x.t0)}: interrupt ${intrName(intr)} delivered, ${name} ran ${fmtDur(x.t2 - x.t0)} later`,
      events: [x.ev, x.evRun],
    }));
    findings.push({
      id: '',
      kind: 'ist-latency',
      severity: worstNs >= 5 * opts.istLatencyNs ? 'critical' : 'warning',
      title: `IST latency: ${name} (${prio}) ran up to ${fmtDur(worstNs)} after interrupt ${intrName(intr)}`,
      summary,
      hint,
      threads,
      window: [t0, t1],
      evidence: collectEvidence(m, threads, t0, t1, { max: opts.maxEvidence, intr, cpus: [cpu], keyEvents: [w.ev, w.evRun] }),
      facts,
      instances,
      related: [],
    });
  }
  return findings;
}
