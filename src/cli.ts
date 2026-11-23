// latencylens command line. Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, findConfigFor, loadConfig, type Config } from './config/deadlines.js';
import { analyse } from './detect/index.js';
import { loadDotEnv } from './env.js';
import { explainFinding, llmConfigFromEnv } from './explain/explain.js';
import { loadTrace, type Decoder } from './kev/load.js';
import { eventLine } from './model/format.js';
import { buildModel } from './model/model.js';
import { exitCode, render, traceSummary, type ReportFormat } from './report/report.js';
import { createServer } from './server/server.js';
import { packTimeline } from './server/pack.js';

const VERSION = '1.0.0';

const USAGE = `latencylens ${VERSION}: find why a QNX OS 8.0 real-time deadline was missed

Usage:
  latencylens open <trace.kev> [--deadlines file.yaml] [--port 7878] [--host 127.0.0.1] [--no-open]
  latencylens report <trace.kev> [--deadlines file.yaml] [--format md|json|text] [--fail-on deadline|any|none]
  latencylens explain <trace.kev> [--finding id] [--deadlines file.yaml] [--save | --recorded]
  latencylens info <trace.kev>
  latencylens dump <trace.kev> [--from s] [--to s] [--limit n]
  latencylens bench <trace.kev>

Traces: tracelogger .kev files (also .kev.gz), or text printed by the SDP's traceprinter.
  --decoder kev|traceprinter   kev (default) is the built-in reader; traceprinter runs the SDP's
                               traceprinter (needs qnxsdp-env.sh) and reads its output
Deadlines: --deadlines, else <trace>.deadlines.yaml or deadlines.yaml next to the trace.
Explanations: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_FALLBACK_MODEL (read from .env).
Exit status of report: 1 if a deadline was missed (--fail-on deadline, the default), 2 on errors.
`;

interface Args {
  cmd: string;
  file: string;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags.set(k, v);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && !['no-open', 'save', 'recorded', 'help', 'version'].includes(k)) flags.set(k, argv[++i]);
      else flags.set(k, true);
    } else if (a === '-h') flags.set('help', true);
    else pos.push(a);
  }
  return { cmd: pos[0] ?? '', file: pos[1] ?? '', flags };
}

function str(flags: Args['flags'], k: string, d: string): string {
  const v = flags.get(k);
  return typeof v === 'string' ? v : d;
}

function loadAll(file: string, flags: Args['flags']) {
  if (!file) throw new Error('missing trace file');
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  const decoder = str(flags, 'decoder', 'auto') as Decoder;
  const trace = loadTrace(file, decoder);
  const m = buildModel(trace);
  const cfgFile = typeof flags.get('deadlines') === 'string' ? (flags.get('deadlines') as string) : findConfigFor(file);
  const cfg: Config = cfgFile ? loadConfig(cfgFile) : defaultConfig();
  const a = analyse(m, cfg);
  return { trace, m, cfg, a };
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no browser available (headless machine): the URL is printed anyway
  }
}

function webDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, 'web'), join(here, '..', 'dist', 'web')]) if (existsSync(join(c, 'index.html'))) return c;
  throw new Error('web UI not built: run `pnpm build`');
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.has('version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!args.cmd || args.flags.has('help')) {
    process.stdout.write(USAGE);
    return args.cmd ? 0 : 2;
  }
  loadDotEnv();
  const name = basename(args.file || '');
  switch (args.cmd) {
    case 'report': {
      const { m, cfg, a } = loadAll(args.file, args.flags);
      const fmt = str(args.flags, 'format', 'md') as ReportFormat;
      process.stdout.write(render(fmt, m, a, cfg, name));
      return exitCode(a, str(args.flags, 'fail-on', 'deadline') as 'deadline' | 'any' | 'none');
    }
    case 'info': {
      const { trace, m, a } = loadAll(args.file, args.flags);
      const h = trace.header;
      const out = [
        traceSummary(m),
        `decoder: ${trace.decoder}; ${trace.stats.slots} slots in ${trace.stats.buffers} buffers; dropped ${trace.stats.droppedEvents} events`,
        `boot ${h.bootDate}; captured ${h.date}; ${m.threads.length} threads in ${m.processes.size} processes`,
        `messages ${m.messages.length}, mutex waits ${m.mutexWaits.length}, interrupts ${m.interrupts.n}, ISTs ${m.ists.length}, job markers ${m.markers.length}`,
        `findings: ${a.findings.length ? a.findings.map((f) => f.id).join(', ') : 'none'}`,
      ];
      process.stdout.write(out.join('\n') + '\n');
      return 0;
    }
    case 'dump': {
      const { m } = loadAll(args.file, args.flags);
      const from = Number(str(args.flags, 'from', '0')) * 1e9;
      const to = Number(str(args.flags, 'to', String(m.durationNs / 1e9))) * 1e9;
      const limit = Number(str(args.flags, 'limit', '200'));
      let n = 0;
      for (let i = 0; i < m.trace.events.n && n < limit; i++) {
        if (m.time[i] < from || m.time[i] > to) continue;
        process.stdout.write(eventLine(m, i, 0) + '\n');
        n++;
      }
      return 0;
    }
    case 'bench': {
      const t0 = performance.now();
      const { trace, m, a } = loadAll(args.file, args.flags);
      const t1 = performance.now();
      const pack = packTimeline(m);
      const t2 = performance.now();
      const mb = statSync(args.file).size / 1e6;
      process.stdout.write(
        `${trace.events.n.toLocaleString('en-US')} events (${mb.toFixed(1)} MB on disk): ` +
          `read+decode ${trace.stats.parseMs.toFixed(0)} ms, model ${m.buildMs.toFixed(0)} ms, detectors ${a.ms.toFixed(0)} ms, ` +
          `total ${(t1 - t0).toFixed(0)} ms; timeline pack ${(pack.length / 1e6).toFixed(1)} MB in ${(t2 - t1).toFixed(0)} ms; ${a.findings.length} findings\n`,
      );
      return 0;
    }
    case 'explain': {
      const { m, a } = loadAll(args.file, args.flags);
      const id = str(args.flags, 'finding', a.findings[0]?.id ?? '');
      const f = a.findings.find((x) => x.id === id);
      if (!f) throw new Error(a.findings.length ? `no finding ${id}; have ${a.findings.map((x) => x.id).join(', ')}` : 'no findings to explain');
      const cfg = llmConfigFromEnv();
      const recFile = resolve(dirname(args.file), basename(args.file).replace(/\.(kev|txt)(\.gz)?$/i, '') + '.explanations.json');
      let replay;
      if (args.flags.has('recorded')) {
        const rec = existsSync(recFile) ? JSON.parse(readFileSync(recFile, 'utf8')) : {};
        if (!rec[f.id]) throw new Error(`no recorded explanation for ${f.id} in ${recFile}`);
        replay = rec[f.id];
      }
      const ex = await explainFinding(m, f, cfg, replay);
      const mark = (s: string) => (s === 'ok' ? 'ok ' : s === 'mismatch' ? 'BAD' : s === 'proposal' ? 'fix' : '?  ');
      process.stdout.write(`${f.id}: ${f.title}\nmodel: ${ex.model}${ex.usedFallback ? ' (fallback)' : ''}, ${(ex.ms / 1000).toFixed(1)} s\n\n`);
      process.stdout.write(`CAUSE: ${ex.cause}\n\nFIX: ${ex.fix}\n\nClaims checked against the evidence: ${ex.claimSummary.ok} ok, ${ex.claimSummary.mismatch} wrong, ${ex.claimSummary.unknown} not in evidence, ${ex.claimSummary.proposal} suggested values\n`);
      for (const c of ex.claims) process.stdout.write(`  [${mark(c.status)}] ${c.kind.padEnd(8)} "${c.text}": ${c.note}\n`);
      if (args.flags.has('save') && !replay) {
        const file = recFile;
        const rec = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
        rec[f.id] = { text: `CAUSE: ${ex.cause}\nFIX: ${ex.fix}`, model: ex.model, ms: ex.ms, usedFallback: ex.usedFallback, recordedAt: new Date().toISOString() };
        (await import('node:fs')).writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
        process.stdout.write(`saved to ${file}\n`);
      }
      return ex.claimSummary.mismatch ? 3 : 0;
    }
    case 'open': {
      const { m, cfg, a } = loadAll(args.file, args.flags);
      const host = str(args.flags, 'host', '127.0.0.1');
      const port = Number(str(args.flags, 'port', '7878'));
      const recFile = resolve(dirname(args.file), basename(args.file).replace(/\.(kev|txt)(\.gz)?$/i, '') + '.explanations.json');
      const server = createServer(m, a, cfg, {
        host,
        port,
        webDir: webDir(),
        traceName: name,
        llm: llmConfigFromEnv(),
        explanationsFile: recFile,
      });
      await new Promise<void>((res, rej) => {
        server.once('error', rej);
        server.listen(port, host, () => res());
      });
      const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`;
      process.stdout.write(`Latency Lens: ${name}: ${a.findings.length} finding${a.findings.length === 1 ? '' : 's'}\n${url}\n(Ctrl+C to stop)\n`);
      if (!args.flags.has('no-open')) openBrowser(url);
      await new Promise<void>(() => {});
      return 0;
    }
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`latencylens: ${(err as Error).message ?? err}\n`);
    process.exit(2);
  },
);
