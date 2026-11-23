// Shared test helpers. Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKev } from '../src/kev/reader.js';
import type { Trace } from '../src/kev/types.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TRACES = ['inversion', 'inversion-fixed', 'ist-latency', 'send-chain', 'cpu-hog', 'baseline'];

export function tracePath(file: string): string {
  return join(ROOT, 'samples', 'traces', file);
}

const cache = new Map<string, Trace>();
export function sampleTrace(name: string): Trace {
  let t = cache.get(name);
  if (!t) {
    t = readKev(new Uint8Array(readFileSync(tracePath(`${name}.kev`))));
    cache.set(name, t);
  }
  return t;
}
