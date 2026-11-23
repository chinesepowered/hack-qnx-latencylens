// Load KEY=value pairs from a .env file without overriding variables that are already set.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Look for .env in the working directory and its parents (stops at the filesystem root). */
export function loadDotEnv(start = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    const p = join(dir, '.env');
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!m || line.trimStart().startsWith('#')) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
      }
      return p;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
