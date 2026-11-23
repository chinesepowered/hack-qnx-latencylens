// Reports for CI pipelines and terminals: Markdown, JSON, or plain text.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import type { Config } from '../config/deadlines.js';
import { KIND_LABEL, type Analysis, type Finding } from '../detect/index.js';
import { fmtDur } from '../detect/util.js';
import { describeEvent, eventLine } from '../model/format.js';
import type { Model } from '../model/model.js';

export type ReportFormat = 'md' | 'json' | 'text' | 'summary';

export function traceSummary(m: Model): string {
  const h = m.trace.header;
  const ghz = h.cyclesPerSec / 1e9;
  return (
    `QNX ${h.sysRelease || '?'}${h.kernelVersion ? ` (kernel ${h.kernelVersion})` : ''} on ${h.nodename || 'unknown'} (${h.machine || '?'}), ` +
    `${m.cpuCount} CPU${m.cpuCount === 1 ? '' : 's'}, ${ghz.toFixed(3)} GHz clock; ${fmtDur(m.durationNs)}, ${m.trace.events.n.toLocaleString('en-US')} events` +
    (h.traceloggerArgs ? `, captured with \`${h.traceloggerArgs.trim()}\`` : '')
  );
}

function evidenceBlock(m: Model, f: Finding, max: number): string[] {
  const ev = f.evidence.slice(0, max);
  const lines = ev.map((i) => eventLine(m, i, f.window[0]));
  if (f.evidence.length > max) lines.push(`   ... ${f.evidence.length - max} more events`);
  return lines;
}

export function renderMarkdown(m: Model, a: Analysis, cfg: Config, traceName: string): string {
  const out: string[] = [];
  out.push(`# Latency Lens report: ${traceName}`, '');
  out.push(`Trace: ${traceSummary(m)}.`);
  out.push(cfg.source ? `Deadlines: \`${cfg.source}\` (${cfg.deadlines.length} thread${cfg.deadlines.length === 1 ? '' : 's'}).` : 'Deadlines: none given (deadline checks skipped).');
  out.push('');
  if (!a.findings.length) out.push('**No findings.** Every detector ran and found nothing to report.', '');
  else {
    out.push('| Finding | Severity | Summary |', '| --- | --- | --- |');
    for (const f of a.findings) out.push(`| \`${f.id}\` | ${f.severity} | ${f.title.replace(/\|/g, '\\|')} |`);
    out.push('');
  }
  for (const f of a.findings) {
    out.push(`## ${f.id}: ${KIND_LABEL[f.kind]}`, '');
    out.push(`**${f.title}**`, '');
    out.push(f.summary, '');
    out.push(`**Fix:** ${f.hint}`, '');
    if (f.related.length) out.push(`**Related:** ${f.related.map((r) => `\`${r}\``).join(', ')}`, '');
    out.push(`Evidence (worst instance, ${f.evidence.length} events, ms after ${(f.window[0] / 1e9).toFixed(6)} s):`, '');
    out.push('```', ...evidenceBlock(m, f, 40), '```', '');
  }
  if (a.notes.length) {
    out.push('## Notes', '');
    for (const n of a.notes) out.push(`- ${n}`);
    out.push('');
  }
  out.push(`Analysis took ${(m.trace.stats.parseMs + m.buildMs + a.ms).toFixed(0)} ms (parse ${m.trace.stats.parseMs.toFixed(0)}, model ${m.buildMs.toFixed(0)}, detectors ${a.ms.toFixed(0)}).`);
  return out.join('\n') + '\n';
}

export function renderText(m: Model, a: Analysis, cfg: Config, traceName: string): string {
  const out: string[] = [`Latency Lens: ${traceName}`, traceSummary(m), cfg.source ? `deadlines: ${cfg.source}` : 'deadlines: none', ''];
  if (!a.findings.length) out.push('No findings.');
  for (const f of a.findings) {
    out.push(`[${f.severity.toUpperCase()}] ${f.id}  ${f.title}`);
    out.push(`  ${f.summary}`);
    out.push(`  Fix: ${f.hint}`);
    if (f.related.length) out.push(`  Related: ${f.related.join(', ')}`);
    out.push('');
  }
  for (const n of a.notes) out.push(`note: ${n}`);
  return out.join('\n') + '\n';
}

export function renderJson(m: Model, a: Analysis, cfg: Config, traceName: string): string {
  const h = m.trace.header;
  return (
    JSON.stringify(
      {
        trace: {
          name: traceName,
          sysRelease: h.sysRelease,
          kernelVersion: h.kernelVersion,
          nodename: h.nodename,
          machine: h.machine,
          cpus: m.cpuCount,
          cyclesPerSec: h.cyclesPerSec,
          durationNs: m.durationNs,
          events: m.trace.events.n,
          decoder: m.trace.decoder,
          stats: m.trace.stats,
        },
        deadlines: cfg.deadlines,
        findings: a.findings.map((f) => ({
          id: f.id,
          kind: f.kind,
          severity: f.severity,
          title: f.title,
          summary: f.summary,
          fix: f.hint,
          related: f.related,
          threads: f.threads.map((t) => m.threads[t].label),
          window: f.window,
          facts: f.facts.map((x) => ({ key: x.key, label: x.label, kind: x.kind, value: x.value })),
          instances: f.instances.length,
          evidence: f.evidence.map((i) => {
            const r = describeEvent(m, i);
            return { event: i, t: r.t, cpu: r.cpu, class: r.cls, event_label: r.ev, thread: r.thread >= 0 ? m.threads[r.thread].label : null, text: r.text };
          }),
        })),
        notes: a.notes,
      },
      null,
      2,
    ) + '\n'
  );
}

/** One line per finding: for terminals and CI logs. */
export function renderSummary(m: Model, a: Analysis, traceName: string): string {
  const h = m.trace.header;
  const out = [`${traceName}: ${a.findings.length ? `${a.findings.length} finding${a.findings.length === 1 ? '' : 's'}` : 'no findings'} (QNX ${h.sysRelease}, ${m.cpuCount} CPUs, ${fmtDur(m.durationNs)}, ${m.trace.events.n.toLocaleString('en-US')} events)`];
  const w = Math.max(0, ...a.findings.map((f) => f.id.length));
  for (const f of a.findings) out.push(`  ${f.severity.toUpperCase().padEnd(8)} ${f.id.padEnd(w)}  ${f.title}`);
  return out.join('\n') + '\n';
}

export function render(fmt: ReportFormat, m: Model, a: Analysis, cfg: Config, traceName: string): string {
  if (fmt === 'summary') return renderSummary(m, a, traceName);
  return fmt === 'json' ? renderJson(m, a, cfg, traceName) : fmt === 'text' ? renderText(m, a, cfg, traceName) : renderMarkdown(m, a, cfg, traceName);
}

/** Exit status for CI: 1 when the chosen class of finding is present. */
export function exitCode(a: Analysis, failOn: 'deadline' | 'any' | 'none'): number {
  if (failOn === 'none') return 0;
  if (failOn === 'any') return a.findings.length ? 1 : 0;
  return a.findings.some((f) => f.kind === 'deadline-miss') ? 1 : 0;
}
