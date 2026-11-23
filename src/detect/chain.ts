// Send-blocked chains: thread A waits on B, which waits on C, and so on. Built from Neutrino
// message transactions (SEND-blocked: the server has not received yet, usually because it is busy;
// REPLY-blocked: the server has the message) and mutex waits.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later

import { ST, firstRunEndingAfter, type Model } from '../model/model.js';
import type { DetectorOptions, Fact, Finding, Instance } from './types.js';
import { collectEvidence, fmtDur, fmtTime, plural, threadShort } from './util.js';

type Kind = 'SEND' | 'REPLY' | 'MUTEX';

interface Edge {
  a: number;
  b: number;
  kind: Kind;
  target: number; // thread, or -1 for SEND (resolved through the server process)
  targetPid: number;
  ref: number; // message id or mutex wait index
}

interface Hop {
  from: number;
  kind: Kind;
  to: number; // -1 when no server thread could be identified
  toPid: number;
  busyWith: number; // for SEND hops: the client the server was busy with, or -1
}

interface Seg {
  a: number;
  b: number;
  hops: Hop[];
  cycle: boolean;
}

const MAX_DEPTH = 8;

/** When the server thread next entered RECEIVE after t (it stopped working on the request). */
function nextReceive(m: Model, th: number, t: number): number {
  const r = m.threads[th].runs;
  for (let k = firstRunEndingAfter(r, t); k < r.n; k++) if (r.start[k] > t && r.state[k] === ST.RECEIVE) return r.start[k];
  return m.durationNs;
}

export class Graph {
  edges = new Map<number, Edge[]>();
  serving = new Map<number, { a: number; b: number; server: number; client: number }[]>(); // pid -> intervals

  constructor(private m: Model) {
    const add = (th: number, e: Edge) => (this.edges.get(th) ?? this.edges.set(th, []).get(th)!).push(e);
    for (const x of m.messages) {
      if (x.client < 0) continue;
      const end = Number.isNaN(x.tReply) ? m.durationNs : x.tReply;
      if (!Number.isNaN(x.tSend) && !Number.isNaN(x.tReceive) && x.tReceive > x.tSend) {
        add(x.client, { a: x.tSend, b: x.tReceive, kind: 'SEND', target: -1, targetPid: x.serverPid, ref: x.id });
      }
      if (x.server >= 0 && !Number.isNaN(x.tReceive)) {
        // A server works on a request only until it calls MsgReceive() again. Servers often keep
        // the rcvid and reply later (a deferred reply, as procnto does for waitpid()); after that
        // point the client waits on an event, not on the server thread.
        const busyEnd = Math.min(end, nextReceive(m, x.server, x.tReceive));
        add(x.client, { a: x.tReceive, b: busyEnd, kind: 'REPLY', target: x.server, targetPid: m.threads[x.server].pid, ref: x.id });
        if (busyEnd < end) add(x.client, { a: busyEnd, b: end, kind: 'REPLY', target: -1, targetPid: m.threads[x.server].pid, ref: x.id });
        const pid = m.threads[x.server].pid;
        (this.serving.get(pid) ?? this.serving.set(pid, []).get(pid)!).push({ a: x.tReceive, b: busyEnd, server: x.server, client: x.client });
      }
    }
    m.mutexWaits.forEach((w, i) => {
      if (w.holder < 0 || w.holder === w.waiter) return;
      add(w.waiter, { a: w.tBlock, b: Number.isNaN(w.tWake) ? m.durationNs : w.tWake, kind: 'MUTEX', target: w.holder, targetPid: m.threads[w.holder].pid, ref: i });
    });
    for (const l of this.edges.values()) l.sort((p, q) => p.a - q.a);
    for (const l of this.serving.values()) l.sort((p, q) => p.a - q.a);
  }

  edgesOf(th: number, a: number, b: number): Edge[] {
    const l = this.edges.get(th);
    if (!l) return [];
    // edges are short and sorted by start; scan from the first that can overlap
    let lo = 0;
    let hi = l.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (l[mid].a < a - 5e9) lo = mid + 1;
      else hi = mid;
    }
    const out: Edge[] = [];
    for (let k = lo; k < l.length && l[k].a < b; k++) if (l[k].b > a) out.push(l[k]);
    return out;
  }

  servingIn(pid: number, a: number, b: number): { a: number; b: number; server: number; client: number }[] {
    const l = this.serving.get(pid) ?? [];
    const out: { a: number; b: number; server: number; client: number }[] = [];
    let cur = a;
    for (const s of l) {
      if (s.b <= cur || s.a >= b) continue;
      const x = Math.max(cur, s.a);
      const y = Math.min(b, s.b);
      if (y > x) {
        out.push({ a: x, b: y, server: s.server, client: s.client });
        cur = y;
      }
    }
    return out;
  }

  segments(th: number, a: number, b: number, path: number[], depth: number): Seg[] {
    const out: Seg[] = [];
    let cur = a;
    for (const E of this.edgesOf(th, a, b)) {
      const s = Math.max(cur, E.a);
      const e = Math.min(b, E.b);
      if (e <= s) continue;
      if (s > cur) out.push({ a: cur, b: s, hops: [], cycle: false });
      if (E.kind === 'SEND') {
        let c2 = s;
        for (const sv of this.servingIn(E.targetPid, s, e)) {
          if (sv.a > c2) out.push({ a: c2, b: sv.a, hops: [{ from: th, kind: 'SEND', to: -1, toPid: E.targetPid, busyWith: -1 }], cycle: false });
          const hop: Hop = { from: th, kind: 'SEND', to: sv.server, toPid: E.targetPid, busyWith: sv.client };
          out.push(...this.descend(hop, sv.server, sv.a, sv.b, path, depth));
          c2 = sv.b;
        }
        if (c2 < e) out.push({ a: c2, b: e, hops: [{ from: th, kind: 'SEND', to: -1, toPid: E.targetPid, busyWith: -1 }], cycle: false });
      } else if (E.target < 0) {
        // deferred reply: the server is not working on it, the chain ends here
        out.push({ a: s, b: e, hops: [{ from: th, kind: E.kind, to: -1, toPid: E.targetPid, busyWith: -1 }], cycle: false });
      } else {
        out.push(...this.descend({ from: th, kind: E.kind, to: E.target, toPid: E.targetPid, busyWith: -1 }, E.target, s, e, path, depth));
      }
      cur = e;
    }
    if (cur < b) out.push({ a: cur, b, hops: [], cycle: false });
    return out;
  }

  private descend(hop: Hop, next: number, a: number, b: number, path: number[], depth: number): Seg[] {
    if (path.includes(next)) return [{ a, b, hops: [hop], cycle: true }];
    if (depth >= MAX_DEPTH) return [{ a, b, hops: [hop], cycle: false }];
    return this.segments(next, a, b, [...path, next], depth + 1).map((sg) => ({ a: sg.a, b: sg.b, hops: [hop, ...sg.hops], cycle: sg.cycle }));
  }

  /** Is `th` serving some client at time t (then its waits belong to that client's chain)? */
  isServing(th: number, t: number): boolean {
    const pid = this.m.threads[th].pid;
    for (const s of this.serving.get(pid) ?? []) if (s.server === th && s.a <= t && t < s.b) return true;
    return false;
  }
}

interface Wait {
  root: number;
  a: number;
  b: number;
  segs: Seg[];
  maxDepth: number;
  deepNs: number;
  cycle: boolean;
  events: number[];
}

function hopText(m: Model, h: Hop): string {
  const from = threadShort(m, h.from);
  if (h.kind === 'MUTEX') return `${from} blocked on a mutex held by ${threadShort(m, h.to)}`;
  if (h.kind === 'REPLY') return `${from} REPLY-blocked on ${threadShort(m, h.to)}`;
  const server = h.to >= 0 ? threadShort(m, h.to) : `process ${m.processes.get(h.toPid)?.name ?? h.toPid}`;
  return `${from} SEND-blocked on ${server}${h.busyWith >= 0 ? ` (busy with ${threadShort(m, h.busyWith)})` : ''}`;
}

export function detectChains(m: Model, opts: DetectorOptions, notes: string[] = []): Finding[] {
  const g = new Graph(m);
  const waits: Wait[] = [];
  for (const x of m.messages) {
    if (x.client < 0 || Number.isNaN(x.tReply)) continue;
    const a = Number.isNaN(x.tSend) ? x.tReceive : x.tSend;
    const b = x.tReply;
    if (!(b - a >= opts.chainWaitNs)) continue;
    if (g.isServing(x.client, a)) continue; // nested inside someone else's chain
    const segs = g.segments(x.client, a, b, [x.client], 0);
    let maxDepth = 0;
    let deepNs = 0;
    let cycle = false;
    for (const s of segs) {
      maxDepth = Math.max(maxDepth, s.hops.length);
      if (s.hops.length >= 2) deepNs += s.b - s.a;
      cycle ||= s.cycle;
    }
    if (maxDepth < 2) continue;
    waits.push({ root: x.client, a, b, segs, maxDepth, deepNs, cycle, events: [x.evSend, x.evReceive, x.evReply].filter((e) => e >= 0) });
  }

  const byRoot = new Map<number, Wait[]>();
  for (const w of waits) (byRoot.get(w.root) ?? byRoot.set(w.root, []).get(w.root)!).push(w);
  const findings: Finding[] = [];
  for (const [root, list] of byRoot) {
    list.sort((p, q) => q.b - q.a - (p.b - p.a));
    const w = list[0];
    const dur = w.b - w.a;
    if (list.length < opts.chainMinCount) {
      // One-off chains (typically a program starting up: procnto loading it from the disk driver)
      // are listed, not flagged.
      notes.push(
        `${m.threads[root].label} waited ${fmtDur(dur)} through a chain of ${w.maxDepth} servers at ${fmtTime(w.a)} ` +
          `(${plural(list.length, 'time')}; chains are reported from ${opts.chainMinCount} occurrences)`,
      );
      continue;
    }
    // The dominant chain: deepest, then longest lasting.
    const segsByChain = new Map<string, { hops: Hop[]; ns: number }>();
    for (const s of w.segs) {
      const k = s.hops.map((h) => `${h.from}${h.kind}${h.to}`).join('>');
      const c = segsByChain.get(k) ?? { hops: s.hops, ns: 0 };
      c.ns += s.b - s.a;
      segsByChain.set(k, c);
    }
    const dominant = [...segsByChain.values()].sort((p, q) => q.hops.length - p.hops.length || q.ns - p.ns)[0];
    const perHop = new Map<string, { hop: Hop; ns: number }>();
    for (const s of w.segs)
      for (const h of s.hops) {
        const k = `${h.from}${h.kind}${h.to}`;
        const c = perHop.get(k) ?? { hop: h, ns: 0 };
        c.ns += s.b - s.a;
        perHop.set(k, c);
      }
    const hops = [...perHop.values()].sort((p, q) => q.ns - p.ns);
    const sortedDur = list.map((x) => x.b - x.a).sort((p, q) => p - q);
    const median = sortedDur[Math.floor(sortedDur.length / 2)];
    const involved = [root];
    for (const h of dominant.hops) {
      if (h.to >= 0) involved.push(h.to);
      if (h.busyWith >= 0) involved.push(h.busyWith);
    }
    const threads = [...new Set(involved)];
    const name = threadShort(m, root);
    const rootPrio = m.threads[root].basePrio;
    const chainText = dominant.hops.map((h) => hopText(m, h)).join(', then ');
    const end = dominant.hops[dominant.hops.length - 1];
    const summary =
      `${m.threads[root].label} (priority ${rootPrio}) waited ${fmtDur(dur)} for one request, starting at ${fmtTime(w.a)}. ` +
      `For ${fmtDur(w.deepNs)} of that it was at the head of a chain ${w.maxDepth} servers deep: ${chainText}. ` +
      `Time on each hop: ${hops.slice(0, 5).map((h) => `${hopText(m, h.hop)} ${fmtDur(h.ns)}`).join('; ')}. ` +
      (w.cycle ? 'The chain loops back on itself: this is a deadlock. ' : '') +
      `${plural(list.length, 'request')} waited longer than ${fmtDur(opts.chainWaitNs)} through a chain like this (median ${fmtDur(median)}).`;
    const busy = dominant.hops.find((h) => h.kind === 'SEND' && h.busyWith >= 0);
    const hint = busy
      ? `${threadShort(m, busy.to)} serves one request at a time, so ${threadShort(m, busy.from)} queues behind ${threadShort(m, busy.busyWith)}. Give the server a pool of threads (or a dedicated channel for latency-critical clients), shorten its work per request, or cache ${threadShort(m, end.to >= 0 ? end.to : end.from)}'s results.`
      : `Shorten the chain: make ${threadShort(m, end.to >= 0 ? end.to : end.from)} answer faster, or let ${name} use cached data instead of a synchronous request on its critical path.`;
    const facts: Fact[] = [
      { key: 'rootPrio', label: `${name} priority`, kind: 'priority', value: rootPrio, thread: root },
      { key: 'wait', label: `${name} total wait (worst request)`, kind: 'duration', value: dur },
      { key: 'deep', label: 'time at chain depth 2 or more', kind: 'duration', value: w.deepNs },
      { key: 'depth', label: 'chain depth', kind: 'count', value: w.maxDepth },
      { key: 'requests', label: 'requests over the threshold', kind: 'count', value: list.length },
      { key: 'median', label: 'median wait of those requests', kind: 'duration', value: median },
      { key: 'threshold', label: 'chain wait threshold', kind: 'duration', value: opts.chainWaitNs },
    ];
    for (const h of hops.slice(0, 6)) facts.push({ key: `hop:${h.hop.from}:${h.hop.kind}:${h.hop.to}`, label: hopText(m, h.hop), kind: 'duration', value: h.ns });
    for (const th of threads) facts.push({ key: `prio:${th}`, label: `${threadShort(m, th)} priority`, kind: 'priority', value: m.threads[th].basePrio, thread: th });
    const pad = Math.min(2e6, dur * 0.1);
    const t0 = Math.max(0, w.a - pad);
    const t1 = Math.min(m.durationNs, w.b + pad);
    const instances: Instance[] = list.map((x) => ({
      t0: x.a,
      t1: x.b,
      value: x.b - x.a,
      text: `${fmtTime(x.a)}: ${name} waited ${fmtDur(x.b - x.a)}, chain depth ${x.maxDepth}`,
      events: x.events,
    }));
    findings.push({
      id: '',
      kind: 'send-chain',
      severity: w.cycle ? 'critical' : 'warning',
      title: `Send-blocked chain: ${[name, ...dominant.hops.map((h) => (h.to >= 0 ? threadShort(m, h.to) : `pid ${h.toPid}`))].join(' -> ')} (${fmtDur(dur)})`,
      summary,
      hint,
      threads,
      window: [t0, t1],
      evidence: collectEvidence(m, threads, t0, t1, { max: opts.maxEvidence, keyEvents: w.events }),
      facts,
      instances,
      related: [],
    });
  }
  return findings;
}
