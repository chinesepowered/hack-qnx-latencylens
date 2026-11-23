// Open a trace in any form Latency Lens understands. Copyright (C) 2026 chinesepowered.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
//   .kev / .kev.gz                        tracelogger output, read by our own decoder (default)
//   traceprinter text (.txt / .txt.gz)    output of the SDP's traceprinter
//   .kev with decoder 'traceprinter'      we run the SDP's traceprinter and read its text

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { isKev, readKev } from './reader.js';
import { isTraceprinterText, readTraceprinter } from './traceprinter.js';
import type { Trace } from './types.js';

export type Decoder = 'auto' | 'kev' | 'traceprinter';

export function decompressIfNeeded(buf: Uint8Array): Uint8Array {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return new Uint8Array(gunzipSync(buf));
  return buf;
}

/** Find the SDP's host traceprinter: $QNX_HOST/usr/bin, then PATH. */
export function findTraceprinter(): string | null {
  const host = process.env.QNX_HOST;
  if (host) {
    const p = join(host, 'usr', 'bin', 'traceprinter');
    if (existsSync(p)) return p;
  }
  const r = spawnSync('sh', ['-c', 'command -v traceprinter'], { encoding: 'utf8' });
  const p = r.stdout.trim();
  return r.status === 0 && p ? p : null;
}

export function parseTraceBuffer(buf: Uint8Array, decoder: Decoder = 'auto'): Trace {
  const data = decompressIfNeeded(buf);
  if (isKev(data) && decoder !== 'traceprinter') return readKev(data);
  const head = Buffer.from(data.subarray(0, 4096)).toString('latin1');
  if (isTraceprinterText(head)) return readTraceprinter(Buffer.from(data).toString('utf8'));
  if (isKev(data)) throw new Error('decoder "traceprinter" needs a file path (it runs the SDP traceprinter)');
  throw new Error('unrecognised input: expected a .kev trace or traceprinter output');
}

export function loadTrace(path: string, decoder: Decoder = 'auto'): Trace {
  const buf = new Uint8Array(readFileSync(path));
  if (decoder === 'traceprinter') {
    const data = decompressIfNeeded(buf);
    if (isKev(data)) {
      const tp = findTraceprinter();
      if (!tp) throw new Error('traceprinter not found: source the QNX SDP environment (qnxsdp-env.sh) or use the built-in decoder');
      let file = path;
      let tmp: string | null = null;
      if (data !== buf) {
        // traceprinter needs a real file, so decompress into the temp directory first.
        tmp = join(process.env.TMPDIR ?? '/tmp', `latencylens-${process.pid}.kev`);
        writeFileSync(tmp, data);
        file = tmp;
      }
      try {
        const r = spawnSync(tp, ['-f', file], { encoding: 'utf8', maxBuffer: 1 << 30 });
        if (r.status !== 0) throw new Error(`traceprinter failed: ${r.stderr || r.status}`);
        return readTraceprinter(r.stdout);
      } finally {
        if (tmp) unlinkSync(tmp);
      }
    }
  }
  return parseTraceBuffer(buf, decoder);
}
