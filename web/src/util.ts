// Formatting and colours for the timeline. Copyright (C) 2026 chinesepowered.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { S } from './data.js';

export function fmtDur(ns: number): string {
  if (!Number.isFinite(ns)) return 'n/a';
  const a = Math.abs(ns);
  if (a >= 1e9) return `${(ns / 1e9).toFixed(a >= 1e10 ? 1 : 2)} s`;
  if (a >= 1e6) return `${(ns / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)} ms`;
  if (a >= 1e3) return `${(ns / 1e3).toFixed(a >= 1e5 ? 0 : 1)} µs`;
  return `${ns.toFixed(0)} ns`;
}

/** Axis label for time t with a tick step: seconds with as many decimals as the step needs. */
export function fmtTick(t: number, step: number): string {
  const decimals = Math.max(0, Math.min(9, Math.ceil(-Math.log10(step / 1e9))));
  return `${(t / 1e9).toFixed(decimals)} s`;
}

export function fmtTime(t: number): string {
  return `${(t / 1e9).toFixed(6)} s`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** State colours, readable on the dark background. */
export const STATE_COLOR: Record<number, string> = {
  [S.RUNNING]: '#3fb950',
  [S.READY]: '#e3b341',
  [S.SEND]: '#58a6ff',
  [S.REPLY]: '#a371f7',
  [S.RECEIVE]: '#3d4a5c',
  [S.MUTEX]: '#f85149',
  [S.CONDVAR]: '#db61a2',
  [S.SEM]: '#db61a2',
  [S.JOIN]: '#8b949e',
  [S.INTR]: '#39c5cf',
  [S.NANOSLEEP]: '#2b3442',
};
export const OTHER_BLOCKED = '#4b5563';

/** How tall (fraction of the lane) each state draws: work is tall, waiting is thin. */
export function stateHeight(s: number): number {
  switch (s) {
    case S.RUNNING:
      return 1;
    case S.READY:
      return 0.62;
    case S.MUTEX:
    case S.SEND:
    case S.REPLY:
      return 0.42;
    case S.INTR:
    case S.CONDVAR:
    case S.SEM:
      return 0.28;
    default:
      return 0.16;
  }
}

/** Stable per-thread colour for CPU lanes: hue from the label, kernel threads grey. */
export function threadColor(label: string, isKernel: boolean): string {
  if (isKernel) return '#6e7681';
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 16777619);
  const hue = (h >>> 0) % 360;
  return `hsl(${hue} 62% 56%)`;
}

export const SEVERITY_COLOR = { critical: '#f85149', warning: '#e3b341', info: '#58a6ff' } as const;
