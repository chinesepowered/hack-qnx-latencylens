// Check every thread name, priority, duration, CPU and count an explanation mentions against the
// finding's evidence. Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
//
// The model sees only the finding's facts and evidence events. Anything it says must be traceable to
// them: a priority must be one the named thread actually had, a duration must match a measured one
// (within the precision the text gives), a thread must be one in the evidence.

import { Cls, ThreadState } from '../kev/constants.js';
import type { Finding } from '../detect/types.js';
import { fmtDur } from '../detect/util.js';
import type { Model } from '../model/model.js';

export type ClaimKind = 'thread' | 'priority' | 'duration' | 'cpu' | 'count' | 'time' | 'protocol';
/** proposal: a value the FIX suggests ("raise it to 60"), not a statement about the trace. */
export type ClaimStatus = 'ok' | 'mismatch' | 'unknown' | 'proposal';

export interface Claim {
  start: number;
  end: number;
  text: string;
  kind: ClaimKind;
  status: ClaimStatus;
  /** What the evidence says, for the UI tooltip. */
  note: string;
}

export interface ClaimContext {
  threads: { names: string[]; label: string; priorities: Set<number> }[];
  /** Names of every thread in the trace (to spot threads that are not part of the evidence). */
  otherNames: Set<string>;
  durations: number[]; // ns
  times: number[]; // ns since the trace start
  /** Evidence event times relative to the window the model was shown (it quotes those). */
  relTimes: number[];
  counts: number[];
  cpus: Set<number>;
  allPriorities: Set<number>;
  /**
   * The longest mutex wait in the finding and whether the kernel raised the holder's priority while
   * the waiter waited. A mutex with PTHREAD_PRIO_INHERIT (or PTHREAD_PRIO_PROTECT with a ceiling at
   * or above the waiter) shows up as the holder running at the waiter's priority; null if no wait.
   */
  mutex: { waiter: string; waiterPrio: number; holder: string; holderMax: number; boosted: boolean } | null;
}

export function buildClaimContext(m: Model, f: Finding): ClaimContext {
  const involved = new Set<number>(f.threads);
  const e = m.trace.events;
  for (const i of f.evidence) {
    if (e.cls[i] === Cls.PR_TH && e.code[i] < 64) {
      const th = m.threadIndex.get(`${e.f0[i]}/${e.f1[i]}`);
      if (th !== undefined) involved.add(th);
    }
  }
  const prios = new Map<number, Set<number>>();
  const add = (th: number, p: number) => {
    if (p < 0) return;
    (prios.get(th) ?? prios.set(th, new Set()).get(th)!).add(p);
  };
  for (const th of involved) add(th, m.threads[th].basePrio);
  for (const i of f.evidence) {
    if (e.cls[i] === Cls.PR_TH && e.code[i] < 64) {
      const th = m.threadIndex.get(`${e.f0[i]}/${e.f1[i]}`);
      if (th !== undefined) add(th, e.f2[i]);
    }
  }
  for (const x of f.facts) if (x.kind === 'priority' && x.thread !== undefined) add(x.thread, Number(x.value));
  const threads = [...involved].map((th) => {
    const T = m.threads[th];
    const names = new Set<string>([T.label, `${T.process}/${T.name}`]);
    if (T.name) names.add(T.name);
    return { names: [...names].filter((n) => n && !n.endsWith('/')), label: T.label, priorities: prios.get(th) ?? new Set<number>() };
  });
  const otherNames = new Set<string>();
  for (const T of m.threads) if (!involved.has(T.index) && T.name && /[_\d]/.test(T.name)) otherNames.add(T.name);
  for (const t of threads) for (const n of t.names) otherNames.delete(n);
  const durations = f.facts.filter((x) => x.kind === 'duration').map((x) => Number(x.value));
  durations.push(...f.instances.slice(0, 200).map((x) => x.value));
  const times = f.facts.filter((x) => x.kind === 'time').map((x) => Number(x.value));
  times.push(...f.instances.slice(0, 200).flatMap((x) => [x.t0, x.t1]));
  const relTimes = f.evidence.map((i) => m.time[i] - f.window[0]);
  const counts = f.facts.filter((x) => x.kind === 'count').map((x) => Number(x.value));
  const cpus = new Set<number>(f.facts.filter((x) => x.kind === 'cpu').map((x) => Number(x.value)));
  for (const i of f.evidence) cpus.add(e.cpu[i]);
  const allPriorities = new Set<number>();
  for (const t of threads) for (const p of t.priorities) allPriorities.add(p);
  return { threads, otherNames, durations, times, relTimes, counts, cpus, allPriorities, mutex: mutexContext(m, f, involved) };
}

function mutexContext(m: Model, f: Finding, involved: Set<number>): ClaimContext['mutex'] {
  let best: ClaimContext['mutex'] = null;
  let bestNs = 0;
  for (const w of m.mutexWaits) {
    if (w.holder < 0 || !involved.has(w.waiter) || !involved.has(w.holder)) continue;
    const end = Number.isNaN(w.tWake) ? m.durationNs : w.tWake;
    if (end <= f.window[0] || w.tBlock >= f.window[1] || end - w.tBlock <= bestNs) continue;
    const prioIn = (th: number, states: number[]) => {
      const r = m.threads[th].runs;
      let p = -1;
      for (let k = 0; k < r.n; k++) {
        if (r.end[k] <= w.tBlock || r.start[k] >= end || !states.includes(r.state[k])) continue;
        p = Math.max(p, r.prio[k]);
      }
      return p;
    };
    const waiterPrio = Math.max(prioIn(w.waiter, [ThreadState.MUTEX]), m.threads[w.waiter].basePrio);
    const holderMax = Math.max(prioIn(w.holder, [ThreadState.RUNNING, ThreadState.READY]), m.threads[w.holder].basePrio);
    bestNs = end - w.tBlock;
    best = { waiter: m.threads[w.waiter].label, waiterPrio, holder: m.threads[w.holder].label, holderMax, boosted: holderMax >= waiterPrio };
  }
  return best;
}

const UNIT_NS: Record<string, number> = {
  ns: 1,
  nanosecond: 1,
  nanoseconds: 1,
  us: 1e3,
  µs: 1e3,
  μs: 1e3,
  microsecond: 1e3,
  microseconds: 1e3,
  ms: 1e6,
  millisecond: 1e6,
  milliseconds: 1e6,
  s: 1e9,
  sec: 1e9,
  secs: 1e9,
  second: 1e9,
  seconds: 1e9,
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Duration check with the precision the text used, and its qualifier ("about", "over", ...). */
function durationMatches(claim: number, decimals: number, unit: number, qualifier: string, facts: number[]): { ok: boolean; closest: number } {
  const round = 0.5 * Math.pow(10, -decimals) * unit;
  let closest = Number.NaN;
  let best = Infinity;
  let ok = false;
  for (const f of facts) {
    const d = Math.abs(f - claim);
    if (d < best) {
      best = d;
      closest = f;
    }
    const tol = Math.max(round, 0.03 * f);
    if (/over|more than|at least|exceed|above|longer than/.test(qualifier)) {
      if (f >= claim - tol && f <= claim * 2.5) ok = true;
    } else if (/under|less than|below|within|at most|up to|shorter than/.test(qualifier)) {
      if (f <= claim + tol && f >= claim * 0.4) ok = true;
    } else if (/about|approximately|roughly|around|nearly|almost|~|some/.test(qualifier)) {
      if (d <= Math.max(round, 0.12 * f)) ok = true;
    } else if (d <= tol) ok = true;
  }
  return { ok, closest };
}

/**
 * `fixStart` is where the FIX section begins: numbers there that match nothing are proposals
 * ("raise it to 60"), not errors. Everything in the CAUSE section is a claim about the trace.
 */
export function checkClaims(text: string, ctx: ClaimContext, fixStart = Infinity): Claim[] {
  const claims: Claim[] = [];
  const taken: [number, number][] = [];
  const free = (a: number, b: number) => taken.every(([x, y]) => b <= x || a >= y);
  const push = (c: Claim) => {
    if (c.status === 'mismatch' && c.start >= fixStart && c.kind !== 'thread') {
      c.status = 'proposal';
      c.note = `suggested value, not a claim about the trace (${c.note})`;
    }
    claims.push(c);
    taken.push([c.start, c.end]);
  };

  // 1. Thread mentions (longest names first so "brakesim/brake_ctl" wins over "brake_ctl").
  const mentions: { start: number; end: number; thread: number }[] = [];
  const names = ctx.threads.flatMap((t, k) => t.names.map((n) => ({ n, k }))).sort((a, b) => b.n.length - a.n.length);
  for (const { n, k } of names) {
    const re = new RegExp(`(?<![\\w/])${escapeRe(n)}(?![\\w/])`, 'g');
    for (let mm = re.exec(text); mm; mm = re.exec(text)) {
      const a = mm.index;
      const b = a + n.length;
      if (!free(a, b)) continue;
      mentions.push({ start: a, end: b, thread: k });
      push({ start: a, end: b, text: n, kind: 'thread', status: 'ok', note: `${ctx.threads[k].label} is in the evidence` });
    }
  }
  for (const n of ctx.otherNames) {
    const re = new RegExp(`(?<![\\w/])${escapeRe(n)}(?![\\w/])`, 'g');
    for (let mm = re.exec(text); mm; mm = re.exec(text)) {
      if (!free(mm.index, mm.index + n.length)) continue;
      push({ start: mm.index, end: mm.index + n.length, text: n, kind: 'thread', status: 'unknown', note: `${n} is in the trace but not part of this finding's evidence` });
    }
  }
  // Backticked snake_case names that are no thread at all.
  for (const mm of text.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)) {
    const a = (mm.index ?? 0) + 1;
    const b = a + mm[1].length;
    if (!free(a, b)) continue;
    push({ start: a, end: b, text: mm[1], kind: 'thread', status: 'unknown', note: `no thread called ${mm[1]} in the evidence` });
  }
  mentions.sort((x, y) => x.start - y.start);

  const threadNear = (pos: number, end: number): number => {
    // nearest mention before (same sentence, within 60 chars), else just after (within 30)
    let best = -1;
    for (const mt of mentions) {
      if (mt.end <= pos && pos - mt.end <= 60 && !/[.;!?]/.test(text.slice(mt.end, pos))) best = mt.thread;
    }
    if (best >= 0) return best;
    for (const mt of mentions) if (mt.start >= end && mt.start - end <= 30 && !/[.;!?]/.test(text.slice(end, mt.start))) return mt.thread;
    return -1;
  };

  // 2. Priorities: "priority 63", "priority of 63", "prio 63", "priority-63", "logger (10)".
  const prioRe = /\bprio(?:rity)?(?:\s+(?:of|level))?[\s:=-]*(\d{1,3})\b/gi;
  const parenRe = /\(\s*(\d{1,3})\s*\)/g;
  const prioClaims: { a: number; b: number; p: number }[] = [];
  for (const mm of text.matchAll(prioRe)) prioClaims.push({ a: mm.index ?? 0, b: (mm.index ?? 0) + mm[0].length, p: Number(mm[1]) });
  for (const mm of text.matchAll(parenRe)) {
    const a = mm.index ?? 0;
    // only right after a thread name: "logger (10)"
    if (mentions.some((mt) => a - mt.end >= 0 && a - mt.end <= 1)) prioClaims.push({ a, b: a + mm[0].length, p: Number(mm[1]) });
  }
  // "its priority was raised to 63", "boosted to priority 63", "inherited 63"
  const changeRe = /\b(?:raised|boosted|increased|elevated|lowered|dropped|bumped|inherit(?:s|ed)?|promoted)\s+(?:\w+\s+){0,3}?(?:to\s+)?(?:priority\s+)?(\d{1,3})\b/gi;
  for (const mm of text.matchAll(changeRe)) {
    const num = mm[1];
    const b = (mm.index ?? 0) + mm[0].length;
    const a = b - num.length;
    if (Number(num) <= 255) prioClaims.push({ a, b, p: Number(num) });
  }
  for (const pc of prioClaims) {
    if (!free(pc.a, pc.b)) continue;
    const th = threadNear(pc.a, pc.b);
    if (th >= 0) {
      const t = ctx.threads[th];
      const ok = t.priorities.has(pc.p);
      push({
        start: pc.a,
        end: pc.b,
        text: text.slice(pc.a, pc.b),
        kind: 'priority',
        status: ok ? 'ok' : 'mismatch',
        note: ok ? `${t.label} ran at priority ${pc.p}` : `${t.label} had priority ${[...t.priorities].join(' or ')} in the evidence, not ${pc.p}`,
      });
    } else {
      const ok = ctx.allPriorities.has(pc.p);
      push({
        start: pc.a,
        end: pc.b,
        text: text.slice(pc.a, pc.b),
        kind: 'priority',
        status: ok ? 'ok' : 'mismatch',
        note: ok ? `priority ${pc.p} appears in the evidence` : `no thread in the evidence has priority ${pc.p}`,
      });
    }
  }

  // 3. Durations and times.
  const durRe = /(about|approximately|roughly|around|nearly|almost|~|over|more than|at least|exceeding|exceeds|above|longer than|under|less than|below|within|at most|up to|shorter than|some|at)?\s*(?<![\w.])(\d+(?:\.\d+)?)\s*(nanoseconds?|ns|microseconds?|us|µs|μs|milliseconds?|ms|seconds?|secs?|s)\b/gi;
  for (const mm of text.matchAll(durRe)) {
    const full = mm[0];
    const qual = (mm[1] ?? '').toLowerCase();
    const numStr = mm[2];
    const unit = UNIT_NS[mm[3].toLowerCase()] ?? 1e6;
    const value = Number(numStr) * unit;
    const lead = full.length - full.trimStart().length;
    const a = (mm.index ?? 0) + lead + (mm[1] ? full.trimStart().indexOf(numStr) : 0);
    const b = (mm.index ?? 0) + full.length;
    if (!free(a, b)) continue;
    const decimals = numStr.includes('.') ? numStr.split('.')[1].length : 0;
    const after = text.slice(b, b + 24).toLowerCase();
    const before = text.slice(Math.max(0, (mm.index ?? 0) - 12), mm.index ?? 0).toLowerCase();
    // timestamps: "at 2.607 ms", "from 2.0 ms to 423.5 ms", "until 39.4 ms", "1.99 s into the trace"
    const isTime =
      qual === 'at' ||
      /(\bfrom|\buntil|\bbetween|\band|\bat)\s*$/.test(before) ||
      /^\s*(to|and)\s+\d/.test(after) ||
      (/\bto\s*$/.test(before) && /\d\s*(ns|us|µs|ms|s)\s+to\s*$/.test(text.slice(Math.max(0, (mm.index ?? 0) - 24), mm.index ?? 0))) ||
      /^\s*(into the trace|into the capture|after the trace|mark)/.test(after);
    if (isTime) {
      const round = 0.5 * Math.pow(10, -decimals) * unit;
      const okAbs = ctx.times.some((t) => Math.abs(t - value) <= Math.max(round, 1e6));
      const okRel = ctx.relTimes.some((t) => Math.abs(t - value) <= Math.max(round, 2e3));
      const ok = okAbs || okRel;
      push({
        start: a,
        end: b,
        text: text.slice(a, b),
        kind: 'time',
        status: ok ? 'ok' : 'mismatch',
        note: ok ? (okRel ? 'matches an evidence event (time after the window start)' : 'matches a time in the evidence') : 'no event in the evidence at that time',
      });
      continue;
    }
    const r = durationMatches(value, decimals, unit, qual, ctx.durations);
    push({
      start: a,
      end: b,
      text: text.slice(a, b),
      kind: 'duration',
      status: r.ok ? 'ok' : 'mismatch',
      note: r.ok ? `matches the measured ${fmtDur(r.closest)}` : Number.isNaN(r.closest) ? 'no duration in the evidence' : `closest measured duration is ${fmtDur(r.closest)}`,
    });
  }

  // 4. CPUs.
  for (const mm of text.matchAll(/\bCPU\s*#?(\d+)\b/g)) {
    const a = mm.index ?? 0;
    const b = a + mm[0].length;
    if (!free(a, b)) continue;
    const ok = ctx.cpus.has(Number(mm[1]));
    push({ start: a, end: b, text: mm[0], kind: 'cpu', status: ok ? 'ok' : 'mismatch', note: ok ? 'CPU in the evidence' : `the evidence is on CPU ${[...ctx.cpus].join(', ')}` });
  }

  // 5. Mutex protocol statements in the CAUSE ("the mutex uses PTHREAD_PRIO_INHERIT"): the trace shows
  // whether the holder ran at the waiter's priority. Negated statements ("lacks priority
  // inheritance", "rather than PTHREAD_PRIO_INHERIT") and hypotheticals ("would prevent") are read
  // as such; the FIX proposes a protocol and is not checked.
  const mx = ctx.mutex;
  if (mx) {
    const protoRe = /\bPTHREAD_PRIO_(INHERIT|PROTECT|NONE)\b|\bpriority[- ](inheritance|ceiling)\b/gi;
    for (const mm of text.matchAll(protoRe)) {
      const a = mm.index ?? 0;
      const b = a + mm[0].length;
      if (a >= fixStart || !free(a, b)) continue;
      const sentenceStart = Math.max(...['.', ';', '!', '?', '\n'].map((d) => text.lastIndexOf(d, a - 1))) + 1;
      const before = text.slice(Math.max(sentenceStart, a - 70), a).toLowerCase();
      const after = text.slice(b, b + 24).toLowerCase();
      if (/\b(if|would|could|should|unless|requires?|needs?|recommend\w*|consider)\b/.test(before) || /^\W*\w*\W*(would|could|should|might)\b/.test(after)) continue;
      const negated = /\b(no|not|lacks?|lacking|without|instead of|rather than|missing|never|neither|nor|absence of|disabled)\b|n't\b/.test(before);
      const none = (mm[1] ?? '').toUpperCase() === 'NONE';
      // what the statement says about the trace: did the holder get the waiter's priority?
      const saysBoosted = none ? negated : !negated;
      const ok = saysBoosted === mx.boosted;
      const seen = `${mx.holder} ran at priority ${mx.holderMax} at most while ${mx.waiter} (${mx.waiterPrio}) waited`;
      push({
        start: a,
        end: b,
        text: mm[0],
        kind: 'protocol',
        status: ok ? 'ok' : 'mismatch',
        note: ok
          ? `matches the trace: ${seen}`
          : mx.boosted
            ? `the trace shows the holder's priority raised: ${seen}`
            : `the trace shows no priority inheritance or ceiling: ${seen}`,
      });
    }
  }

  // 6. Counts: "35 of 150 jobs", "29 times".
  for (const mm of text.matchAll(/\b(\d+)\s+(?:out\s+)?(?:of\s+(?:the\s+)?(\d+)\s+)?(jobs?|deadlines?|times|occurrences|interrupts?|requests?|deliveries|misses|episodes)\b/gi)) {
    const a = mm.index ?? 0;
    const b = a + mm[0].length;
    if (!free(a, b)) continue;
    const nums = [Number(mm[1]), ...(mm[2] ? [Number(mm[2])] : [])];
    const ok = nums.every((x) => ctx.counts.includes(x));
    push({ start: a, end: b, text: mm[0], kind: 'count', status: ok ? 'ok' : 'mismatch', note: ok ? 'matches the counts in the evidence' : `counts in the evidence: ${ctx.counts.join(', ')}` });
  }
  return claims.sort((x, y) => x.start - y.start);
}

export function summarizeClaims(claims: Claim[]): { ok: number; mismatch: number; unknown: number; proposal: number } {
  return {
    ok: claims.filter((c) => c.status === 'ok').length,
    mismatch: claims.filter((c) => c.status === 'mismatch').length,
    unknown: claims.filter((c) => c.status === 'unknown').length,
    proposal: claims.filter((c) => c.status === 'proposal').length,
  };
}
