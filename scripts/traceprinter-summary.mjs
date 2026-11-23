#!/usr/bin/env node
// traceprinter-summary.mjs: count the events in traceprinter output (stdin) by class and event label.
// Used for traces too large to commit as text: the counts are what our own .kev reader must match.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const re = /^t:0x([0-9a-f]+) CPU:(\d+) (\S+)\s*:(\S+)/;
const byType = {};
const byCpu = {};
let total = 0;
let first = null;
let last = null;
for await (const line of rl) {
  const m = re.exec(line);
  if (!m) continue;
  total++;
  const key = `${m[3]}:${m[4]}`;
  byType[key] = (byType[key] ?? 0) + 1;
  byCpu[m[2]] = (byCpu[m[2]] ?? 0) + 1;
  const t = BigInt('0x' + m[1]);
  if (first === null) first = t;
  last = t;
}
const sorted = Object.fromEntries(Object.entries(byType).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
process.stdout.write(
  JSON.stringify({ total, byCpu, firstCycles: String(first), lastCycles: String(last), byType: sorted }, null, 2) + '\n',
);
