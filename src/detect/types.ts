// Finding format shared by all detectors. Copyright (C) 2026 chinesepowered.
// SPDX-License-Identifier: AGPL-3.0-or-later

export type Severity = 'critical' | 'warning' | 'info';
export type FindingKind = 'deadline-miss' | 'priority-inversion' | 'ist-latency' | 'send-chain' | 'cpu-hog';

/**
 * A number the explanation may quote. Durations are in ns, priorities are QNX priorities.
 * The claim checker accepts a model's number only if it matches one of these.
 */
export interface Fact {
  key: string;
  label: string;
  kind: 'duration' | 'priority' | 'count' | 'percent' | 'cpu' | 'time' | 'text';
  value: number | string;
  /** Thread the fact belongs to (index), for priorities. */
  thread?: number;
}

/** One occurrence of the problem, e.g. one missed job or one inversion. */
export interface Instance {
  t0: number; // ns
  t1: number; // ns
  /** Headline number of this instance in ns (response time, wait, latency, ...). */
  value: number;
  text: string;
  events: number[];
}

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  /** Deterministic plain-language explanation built from the facts. */
  summary: string;
  /** Suggested fix in plain words (deterministic). */
  hint: string;
  /** Involved threads, the affected one first. */
  threads: number[];
  /** Time window to show (ns), around the worst instance. */
  window: [number, number];
  /** Evidence: event indices of the worst instance, in time order. */
  evidence: number[];
  facts: Fact[];
  instances: Instance[];
  /** Other findings that explain this one (for example the inversion behind a deadline miss). */
  related: string[];
}

export interface DetectorOptions {
  istLatencyNs: number;
  chainWaitNs: number;
  /** A chain is reported when the same client waits through one at least this many times. */
  chainMinCount: number;
  hogWindowNs: number;
  hogShare: number;
  inversionMinNs: number;
  maxEvidence: number;
}

export const DEFAULT_OPTIONS: DetectorOptions = {
  istLatencyNs: 1_000_000,
  chainWaitNs: 5_000_000,
  chainMinCount: 3,
  hogWindowNs: 100_000_000,
  hogShare: 0.9,
  inversionMinNs: 200_000,
  maxEvidence: 160,
};
