// Deadline miss: a periodic thread finished a job later than its deadline.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
//
// Jobs come from TraceEvent() job markers when the thread emits them (begin: d0 = sequence number,
// d1 = how many microseconds after its nominal release the job began; end: d0 = sequence number),
// otherwise from thread states: a job starts when the thread wakes from its wait state and ends
// when it returns to it.
//
// Release rule: a job's response time starts at the later of its nominal release and the moment
// the thread actually woke up. Timer lateness belongs to the platform, not the job; a job that
// begins late because the previous one overran keeps its nominal release (see docs/build-log.md).

import type { DeadlineSpec } from '../config/deadlines.js';
import { ST, firstRunEndingAfter, stateName, threadByName, type Model } from '../model/model.js';
import type { DetectorOptions, Fact, Finding, Instance } from './types.js';
import { collectEvidence, cpuOccupants, fmtDur, fmtTime, homeCpu, plural, threadShort, type Interferer } from './util.js';

export interface Job {
  seq: number;
  nominal: number; // NaN if unknown
  wakeup: number; // NaN if the thread did not block before the job
  release: number;
  start: number;
  finish: number;
  response: number;
  running: number;
  ready: number;
  blocked: Map<number, number>; // state -> ns
  preemptedBy: Interferer[];
  /** READY time while only lower-priority threads (or none) held the CPU: platform latency. */
  unexplained: number;
  /** The previous job was still running at this job's nominal release. */
  backlog: boolean;
  mutexHolders: { holder: number; sync: number; ns: number }[];
  servers: { server: number; ns: number }[];
  evBegin: number;
  evEnd: number;
}

const BETWEEN_JOB_STATES = new Set<number>([
  ST.NANOSLEEP,
  ST.RECEIVE,
  ST.SIGWAITINFO,
  ST.SIGSUSPEND,
  ST.INTR,
  ST.SEM,
  ST.CONDVAR,
  ST.JOIN,
  ST.MQ_RECEIVE,
]);

/** The state a thread waits in between jobs: the between-job state it spent the most time in. */
function guessWaitState(m: Model, th: number): number {
  const r = m.threads[th].runs;
  const per = new Map<number, number>();
  for (let k = 0; k < r.n; k++) if (BETWEEN_JOB_STATES.has(r.state[k])) per.set(r.state[k], (per.get(r.state[k]) ?? 0) + r.end[k] - r.start[k]);
  let best: number = ST.NANOSLEEP;
  let bestNs = -1;
  for (const [s, ns] of per) if (ns > bestNs) [best, bestNs] = [s, ns];
  return best;
}

/** Last time in (after, before] the thread went from a between-job wait to READY or RUNNING. */
function lastWakeup(m: Model, th: number, after: number, before: number): number {
  const r = m.threads[th].runs;
  let k = firstRunEndingAfter(r, before);
  if (k >= r.n) k = r.n - 1;
  for (; k > 0; k--) {
    if (r.start[k] > before) continue;
    if (r.start[k] <= after) break;
    if ((r.state[k] === ST.READY || r.state[k] === ST.RUNNING) && BETWEEN_JOB_STATES.has(r.state[k - 1])) return r.start[k];
  }
  return Number.NaN;
}

function analyseJob(m: Model, th: number, job: Job): void {
  const r = m.threads[th].runs;
  const cpu = homeCpu(m, th);
  const preempt = new Map<number, Interferer>();
  let firstRun = Number.NaN;
  for (let k = firstRunEndingAfter(r, job.release); k < r.n && r.start[k] < job.finish; k++) {
    const a = Math.max(job.release, r.start[k]);
    const b = Math.min(job.finish, r.end[k]);
    if (b <= a) continue;
    const s = r.state[k];
    if (s === ST.RUNNING) {
      job.running += b - a;
      if (Number.isNaN(firstRun)) firstRun = a;
    } else if (s === ST.READY) {
      job.ready += b - a;
      const myPrio = r.prio[k] >= 0 ? r.prio[k] : m.threads[th].basePrio;
      let explained = 0;
      for (const it of cpuOccupants(m, r.cpu[k] >= 0 ? r.cpu[k] : cpu, a, b, new Set([th]))) {
        if (it.prio < myPrio) continue; // cannot preempt under strict priority scheduling
        explained += it.ns;
        const p = preempt.get(it.thread) ?? { thread: it.thread, ns: 0, prio: it.prio };
        p.ns += it.ns;
        p.prio = Math.max(p.prio, it.prio);
        preempt.set(it.thread, p);
      }
      job.unexplained += Math.max(0, b - a - explained);
    } else job.blocked.set(s, (job.blocked.get(s) ?? 0) + (b - a));
  }
  if (!Number.isNaN(firstRun) && Number.isNaN(job.start)) job.start = firstRun;
  job.preemptedBy = [...preempt.values()].sort((x, y) => y.ns - x.ns);
  for (const w of m.mutexWaits) {
    if (w.waiter !== th) continue;
    const a = Math.max(job.release, w.tBlock);
    const b = Math.min(job.finish, Number.isNaN(w.tWake) ? m.durationNs : w.tWake);
    if (b > a) job.mutexHolders.push({ holder: w.holder, sync: w.sync, ns: b - a });
  }
  for (const x of m.messages) {
    if (x.client !== th || x.server < 0) continue;
    const a = Math.max(job.release, Number.isNaN(x.tSend) ? 0 : x.tSend);
    const b = Math.min(job.finish, Number.isNaN(x.tReply) ? m.durationNs : x.tReply);
    if (b > a) job.servers.push({ server: x.server, ns: b - a });
  }
}

function jobsFromMarkers(m: Model, th: number, spec: DeadlineSpec, begin: number, end: number): Job[] {
  const mine = m.markers.filter((x) => x.thread === th);
  const ends = new Map<number, (typeof mine)[number][]>();
  for (const x of mine) if (x.code === end) (ends.get(x.d0) ?? ends.set(x.d0, []).get(x.d0)!).push(x);
  const jobs: Job[] = [];
  let prevFinish = -Infinity;
  for (const b of mine) {
    if (b.code !== begin) continue;
    const candidates = ends.get(b.d0) ?? [];
    const e = candidates.find((x) => x.t >= b.t);
    if (!e) continue;
    const nominal = b.t - b.d1 * 1000;
    const wakeup = lastWakeup(m, th, Math.max(prevFinish, nominal - spec.periodNs), b.t);
    const release = Number.isNaN(wakeup) ? nominal : Math.max(nominal, wakeup);
    jobs.push({
      seq: b.d0,
      nominal,
      wakeup,
      release,
      start: b.t,
      finish: e.t,
      response: e.t - release,
      running: 0,
      ready: 0,
      blocked: new Map(),
      preemptedBy: [],
      unexplained: 0,
      backlog: Number.isNaN(wakeup) && prevFinish > nominal,
      mutexHolders: [],
      servers: [],
      evBegin: b.ev,
      evEnd: e.ev,
    });
    prevFinish = e.t;
  }
  return jobs;
}

function jobsFromStates(m: Model, th: number, waitState: number): Job[] {
  const r = m.threads[th].runs;
  const jobs: Job[] = [];
  let seq = 0;
  for (let k = 1; k < r.n; k++) {
    if (r.state[k - 1] !== waitState || (r.state[k] !== ST.READY && r.state[k] !== ST.RUNNING)) continue;
    const release = r.start[k];
    let j = k;
    while (j < r.n && r.state[j] !== waitState) j++;
    if (j >= r.n) break; // job still running when the trace ended
    jobs.push({
      seq: ++seq,
      nominal: Number.NaN,
      wakeup: release,
      release,
      start: Number.NaN,
      finish: r.start[j],
      response: r.start[j] - release,
      running: 0,
      ready: 0,
      blocked: new Map(),
      preemptedBy: [],
      unexplained: 0,
      backlog: false,
      mutexHolders: [],
      servers: [],
      evBegin: r.ev[k],
      evEnd: r.ev[j],
    });
    k = j;
  }
  return jobs;
}

export function detectDeadlineMisses(m: Model, specs: DeadlineSpec[], opts: DetectorOptions, notes: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const spec of specs) {
    const matches = threadByName(m, spec.name);
    if (!matches.length) {
      notes.push(`deadlines: no thread named "${spec.name}" in this trace`);
      continue;
    }
    for (const T of matches) {
      const th = T.index;
      const begin = spec.markers?.begin ?? 100;
      const end = spec.markers?.end ?? 101;
      const hasMarkers = m.markers.some((x) => x.thread === th && x.code === begin);
      const waitState = spec.waitState ?? guessWaitState(m, th);
      const jobs = hasMarkers ? jobsFromMarkers(m, th, spec, begin, end) : jobsFromStates(m, th, waitState);
      if (!jobs.length) {
        notes.push(`deadlines: ${T.label} has no complete job in this trace`);
        continue;
      }
      const late = jobs.filter((j) => j.response > spec.deadlineNs);
      if (!late.length) continue;
      for (const j of late) analyseJob(m, th, j);
      late.sort((x, y) => y.response - x.response);
      const w = late[0];
      const prio = T.basePrio;
      const mutexNs = w.blocked.get(ST.MUTEX) ?? 0;
      const sendNs = (w.blocked.get(ST.SEND) ?? 0) + (w.blocked.get(ST.REPLY) ?? 0);
      const holder = w.mutexHolders.sort((x, y) => y.ns - x.ns)[0];
      const server = w.servers.sort((x, y) => y.ns - x.ns)[0];
      const top = w.preemptedBy[0];

      const parts: string[] = [`it ran for ${fmtDur(w.running)}`];
      if (mutexNs > 0 && holder) parts.push(`waited ${fmtDur(mutexNs)} for a mutex held by ${threadShort(m, holder.holder)}${holder.holder >= 0 ? ` (priority ${m.threads[holder.holder].basePrio})` : ''}`);
      if (sendNs > 0 && server) parts.push(`waited ${fmtDur(sendNs)} on a message to ${threadShort(m, server.server)}`);
      if (w.ready > 0) parts.push(`was ready but not running for ${fmtDur(w.ready)}${top ? `, mostly while ${threadShort(m, top.thread)} (priority ${top.prio}) used its CPU` : ''}`);
      for (const [s, ns] of w.blocked) if (s !== ST.MUTEX && s !== ST.SEND && s !== ST.REPLY && ns > 0) parts.push(`was blocked in ${stateName(s)} for ${fmtDur(ns)}`);

      if (w.unexplained > 0) parts.push(`was ready for ${fmtDur(w.unexplained)} while no thread of equal or higher priority used its CPU (platform latency)`);
      // A late job that inherited a backlog: find the job that started it.
      let backlogNote = '';
      let rootCause = '';
      if (w.backlog) {
        const idx = jobs.indexOf(w);
        let k = idx;
        while (k > 0 && jobs[k].backlog) k--;
        const first = jobs[k];
        if (first !== w) {
          const timerLate = !Number.isNaN(first.wakeup) && !Number.isNaN(first.nominal) ? first.wakeup - first.nominal : 0;
          backlogNote = ` It could only start once job ${first.seq} and its successors had finished: a backlog that began at ${fmtTime(first.nominal)}`;
          if (timerLate > spec.deadlineNs) {
            backlogNote += `, when the timer that releases ${T.name || T.label} fired ${fmtDur(timerLate)} late with no other thread using the CPU (platform latency).`;
            rootCause = 'timer';
          } else backlogNote += '.';
        }
      }
      const dominant = Math.max(mutexNs, sendNs, w.ready - w.unexplained, w.running, w.unexplained);
      let hint: string;
      if (rootCause === 'timer')
        hint = `Nothing in the schedule delayed these jobs: the timer interrupt itself arrived late. On real hardware look for SMIs or firmware stalls; under QEMU's TCG this is emulation noise.`;
      else if (dominant === w.unexplained && w.unexplained > 0)
        hint = `The job was ready while no thread of equal or higher priority ran on its CPU: a stall outside the schedule (firmware, hypervisor, or emulation).`;
      else if (dominant === mutexNs && holder)
        hint = `The job spent most of its time blocked on a mutex held by ${threadShort(m, holder.holder)}. Check the priority inversion finding, use a PTHREAD_PRIO_INHERIT mutex, and keep work out of the critical section.`;
      else if (dominant === sendNs && server)
        hint = `The job waited on ${threadShort(m, server.server)}. Make the server faster, give it its own thread for this client, or stop calling it on the hot path.`;
      else if (dominant === w.ready && top)
        hint = `${threadShort(m, top.thread)} (priority ${top.prio}) held the CPU while the job was ready. Lower that thread's priority, move it to another CPU, or budget it with SCHED_SPORADIC.`;
      else hint = `The job's own work is longer than its deadline allows. Shorten or split the work, or relax the deadline.`;

      const t0 = Math.max(0, w.release - Math.min(2e6, spec.periodNs * 0.2));
      const t1 = Math.min(m.durationNs, w.finish + Math.min(2e6, spec.periodNs * 0.2));
      const involved = [th];
      if (holder && holder.holder >= 0) involved.push(holder.holder);
      if (server && server.server >= 0) involved.push(server.server);
      for (const p of w.preemptedBy.slice(0, 2)) involved.push(p.thread);
      const facts: Fact[] = [
        { key: 'priority', label: `${T.name || T.label} priority`, kind: 'priority', value: prio, thread: th },
        { key: 'period', label: 'period', kind: 'duration', value: spec.periodNs },
        { key: 'deadline', label: 'deadline', kind: 'duration', value: spec.deadlineNs },
        { key: 'jobs', label: 'jobs', kind: 'count', value: jobs.length },
        { key: 'misses', label: 'deadline misses', kind: 'count', value: late.length },
        { key: 'worstResponse', label: 'worst response time', kind: 'duration', value: w.response },
        { key: 'worstLateness', label: 'time past the deadline', kind: 'duration', value: w.response - spec.deadlineNs },
        { key: 'release', label: 'release (worst job)', kind: 'time', value: w.release },
        { key: 'start', label: 'start (worst job)', kind: 'time', value: w.start },
        { key: 'finish', label: 'finish (worst job)', kind: 'time', value: w.finish },
        { key: 'startDelay', label: 'release to start', kind: 'duration', value: w.start - w.release },
        { key: 'running', label: 'running time in the worst job', kind: 'duration', value: w.running },
        { key: 'ready', label: 'ready (preempted) time in the worst job', kind: 'duration', value: w.ready },
        { key: 'unexplained', label: 'ready time with no higher-priority thread running', kind: 'duration', value: w.unexplained },
      ];
      if (!Number.isNaN(w.nominal) && !Number.isNaN(w.wakeup) && w.wakeup > w.nominal)
        facts.push({ key: 'timerLateness', label: 'timer wakeup after nominal release', kind: 'duration', value: w.wakeup - w.nominal });
      if (mutexNs > 0) facts.push({ key: 'mutexWait', label: 'time blocked on the mutex', kind: 'duration', value: mutexNs });
      if (holder && holder.holder >= 0) facts.push({ key: 'holderPriority', label: `${threadShort(m, holder.holder)} priority`, kind: 'priority', value: m.threads[holder.holder].basePrio, thread: holder.holder });
      if (sendNs > 0) facts.push({ key: 'messageWait', label: 'time blocked sending to a server', kind: 'duration', value: sendNs });
      for (const p of w.preemptedBy.slice(0, 3)) {
        facts.push({ key: `preempt:${p.thread}`, label: `${threadShort(m, p.thread)} ran while the job was ready`, kind: 'duration', value: p.ns });
        facts.push({ key: `prio:${p.thread}`, label: `${threadShort(m, p.thread)} priority`, kind: 'priority', value: p.prio, thread: p.thread });
      }
      const instances: Instance[] = late.map((j) => ({
        t0: j.release,
        t1: j.finish,
        value: j.response,
        text: `job ${j.seq}: released ${fmtTime(j.release)}, finished after ${fmtDur(j.response)}`,
        events: [j.evBegin, j.evEnd].filter((x) => x >= 0),
      }));
      findings.push({
        id: '',
        kind: 'deadline-miss',
        severity: 'critical',
        title: `${T.name || T.label} missed ${late.length} of ${plural(jobs.length, 'deadline')} (${fmtDur(spec.deadlineNs)})`,
        summary:
          `${T.label} (priority ${prio}, period ${fmtDur(spec.periodNs)}, deadline ${fmtDur(spec.deadlineNs)}) finished late in ${late.length} of ${plural(jobs.length, 'job')}. ` +
          `The worst job was released at ${fmtTime(w.release)}, started ${fmtDur(w.start - w.release)} later and finished ${fmtDur(w.response)} after its release, ` +
          `${fmtDur(w.response - spec.deadlineNs)} past the deadline. In that job ${parts.join(', ')}.${backlogNote}`,
        hint,
        threads: [...new Set(involved)],
        window: [t0, t1],
        evidence: collectEvidence(m, [...new Set(involved)], t0, t1, {
          max: opts.maxEvidence,
          cpus: [homeCpu(m, th)],
          keyEvents: [w.evBegin, w.evEnd],
        }),
        facts,
        instances,
        related: [],
      });
    }
  }
  return findings;
}
