// Findings panel: list, details, evidence, and "Explain this" with checked claims.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import type { FindingMeta, TraceMeta } from './data.js';
import type { TimelineView } from './timeline.js';
import { esc, fmtDur, fmtTime } from './util.js';

interface Claim {
  start: number;
  end: number;
  text: string;
  kind: string;
  status: 'ok' | 'mismatch' | 'unknown' | 'proposal';
  note: string;
}
interface Explanation {
  cause: string;
  fix: string;
  text: string;
  model: string;
  ms: number;
  usedFallback: boolean;
  claims: Claim[];
  claimSummary: { ok: number; mismatch: number; unknown: number; proposal: number };
  recorded: boolean;
  recordedAt?: string;
}
interface EvidenceRow {
  i: number;
  t: number;
  cpu: number;
  cls: string;
  ev: string;
  thread: number;
  text: string;
}

const KIND_ICON: Record<string, string> = {
  'deadline-miss': '⏱',
  'priority-inversion': '⇅',
  'ist-latency': '⚡',
  'send-chain': '⇢',
  'cpu-hog': '▣',
};

export class Panel {
  selected: FindingMeta | null = null;
  private instance = 0;
  private explanations = new Map<string, Explanation>();
  onSelect: (f: FindingMeta | null) => void = () => {};

  constructor(
    private root: HTMLElement,
    private meta: TraceMeta,
    private view: TimelineView,
  ) {
    this.renderList();
  }

  private renderList(): void {
    const m = this.meta;
    const list = this.root.querySelector<HTMLElement>('#findings')!;
    const head = this.root.querySelector<HTMLElement>('#findings-count')!;
    head.textContent = String(m.findings.length);
    if (!m.findings.length) {
      list.innerHTML = `<div class="clean"><div class="clean-mark">✓</div><div><b>No findings.</b> Every detector ran on ${m.events.toLocaleString('en-US')} events and found no deadline miss, priority inversion, IST latency, send-blocked chain or CPU hog.</div></div>`;
    } else {
      list.innerHTML = m.findings
        .map(
          (f) => `<button class="finding sev-${f.severity}" data-id="${esc(f.id)}">
            <span class="f-icon" aria-hidden="true">${KIND_ICON[f.kind] ?? '●'}</span>
            <span class="f-body"><span class="f-kind">${esc(f.kindLabel)}<span class="f-id">${esc(f.id)}</span></span>
            <span class="f-title">${esc(f.title)}</span>
            <span class="f-meta">${f.instanceCount} occurrence${f.instanceCount === 1 ? '' : 's'}${f.related.length ? ` · linked to ${f.related.map(esc).join(', ')}` : ''}</span></span>
          </button>`,
        )
        .join('');
      list.querySelectorAll<HTMLButtonElement>('.finding').forEach((b) => b.addEventListener('click', () => this.select(b.dataset.id!)));
    }
    const notes = this.root.querySelector<HTMLElement>('#notes')!;
    notes.innerHTML = m.notes.length ? `<details><summary>${m.notes.length} note${m.notes.length === 1 ? '' : 's'} from the detectors</summary><ul>${m.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : '';
  }

  select(id: string | null, instance = 0): void {
    const f = id ? (this.meta.findings.find((x) => x.id === id) ?? null) : null;
    this.selected = f;
    this.instance = instance;
    this.root.querySelectorAll<HTMLElement>('.finding').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    this.root.classList.toggle('has-detail', !!f);
    if (location.hash !== (f ? `#finding=${f.id}` : '')) history.replaceState(null, '', f ? `#finding=${f.id}` : ' ');
    this.onSelect(f);
    if (!f) {
      this.root.querySelector<HTMLElement>('#detail')!.innerHTML = '';
      return;
    }
    this.renderDetail();
    this.goToInstance(instance, true);
  }

  goToInstance(k: number, first = false): void {
    const f = this.selected;
    if (!f) return;
    const n = f.instances.length;
    this.instance = ((k % Math.max(1, n)) + n) % Math.max(1, n);
    let a = f.window[0];
    let b = f.window[1];
    if (!first && n) {
      const x = f.instances[this.instance];
      const pad = Math.max((x.t1 - x.t0) * 0.25, 300_000);
      a = x.t0 - pad;
      b = x.t1 + pad;
    }
    this.view.hl.window = n ? [f.instances[this.instance].t0, f.instances[this.instance].t1] : f.window;
    this.view.animateTo(a, b);
    const nav = this.root.querySelector<HTMLElement>('#inst-text');
    if (nav && n) nav.textContent = `${this.instance + 1} of ${f.instanceCount}: ${f.instances[this.instance].text}`;
  }

  next(d: number): void {
    if (this.selected) this.goToInstance(this.instance + d);
  }

  private factValue(x: FindingMeta['facts'][number]): string {
    switch (x.kind) {
      case 'duration':
        return fmtDur(Number(x.value));
      case 'time':
        return fmtTime(Number(x.value));
      case 'percent':
        return `${Number(x.value).toFixed(1)}%`;
      case 'cpu':
        return `CPU ${x.value}`;
      default:
        return esc(String(x.value));
    }
  }

  private renderDetail(): void {
    const f = this.selected!;
    const d = this.root.querySelector<HTMLElement>('#detail')!;
    const llm = this.meta.llm;
    const recorded = this.meta.recordedExplanations.includes(f.id);
    d.innerHTML = `
      <div class="d-head sev-${f.severity}"><span class="d-kind">${KIND_ICON[f.kind] ?? ''} ${esc(f.kindLabel)}</span><span class="d-sev">${f.severity}</span>
        <button class="close" title="Close (Esc)">✕</button></div>
      <h2>${esc(f.title)}</h2>
      <p class="summary">${esc(f.summary)}</p>
      <div class="fix"><span class="fix-label">Suggested fix</span>${esc(f.hint)}</div>
      ${f.related.length ? `<div class="related">Linked: ${f.related.map((r) => `<a href="#finding=${esc(r)}" data-rel="${esc(r)}">${esc(r)}</a>`).join(' ')}</div>` : ''}
      ${f.instances.length > 1 ? `<div class="inst"><button class="prev" title="Previous (P)">‹</button><span id="inst-text"></span><button class="next" title="Next (N)">›</button></div>` : ''}
      <section class="explain">
        <div class="ex-head"><button class="ex-btn">${recorded ? 'Show the AI explanation' : 'Explain this'}</button>
          <span class="ex-model">${llm ? esc(llm.model) : recorded ? 'recorded answer' : 'no API key: deterministic summary only'}</span></div>
        <div class="ex-body"></div>
      </section>
      <details class="facts" open><summary>Measured facts (${f.facts.length})</summary>
        <dl>${f.facts.map((x) => `<dt>${esc(x.label)}</dt><dd>${this.factValue(x)}</dd>`).join('')}</dl></details>
      <h3>Evidence <span class="muted">${f.evidenceCount} events, worst occurrence</span></h3>
      <div class="evidence"><div class="muted pad">loading...</div></div>`;
    d.querySelector('.close')!.addEventListener('click', () => this.select(null));
    d.querySelector('.prev')?.addEventListener('click', () => this.next(-1));
    d.querySelector('.next')?.addEventListener('click', () => this.next(1));
    d.querySelectorAll<HTMLAnchorElement>('[data-rel]').forEach((a) =>
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        this.select(a.dataset.rel!);
      }),
    );
    d.querySelector('.ex-btn')!.addEventListener('click', () => this.explain(false));
    const cached = this.explanations.get(f.id);
    if (cached) this.showExplanation(cached);
    void this.loadEvidence(f);
  }

  private async loadEvidence(f: FindingMeta): Promise<void> {
    const res = await fetch(`/api/finding/${encodeURIComponent(f.id)}`);
    const { evidence } = (await res.json()) as { evidence: EvidenceRow[] };
    if (this.selected !== f) return;
    const box = this.root.querySelector<HTMLElement>('.evidence')!;
    const t0 = f.window[0];
    box.innerHTML = `<table><tbody>${evidence
      .map(
        (r) => `<tr data-t="${r.t}" class="cls-${esc(r.cls.toLowerCase())}"><td class="t">${((r.t - t0) / 1e6).toFixed(3)}</td><td class="c">${r.cpu}</td><td class="e">${esc(r.text)}${r.cls !== 'THREAD' && r.thread >= 0 ? ` <span class="actor">${esc(this.meta.threads[r.thread].label)}</span>` : ''}</td></tr>`,
      )
      .join('')}</tbody></table>`;
    box.querySelectorAll<HTMLTableRowElement>('tr').forEach((tr) => {
      const t = Number(tr.dataset.t);
      tr.addEventListener('mouseenter', () => {
        this.view.hl.cursor = t;
        this.view.request();
      });
      tr.addEventListener('mouseleave', () => {
        this.view.hl.cursor = null;
        this.view.request();
      });
      tr.addEventListener('click', () => {
        const span = Math.max(200_000, (this.view.t1 - this.view.t0) / 6);
        this.view.animateTo(t - span / 2, t + span / 2, 350);
      });
    });
  }

  async explain(refresh: boolean): Promise<void> {
    const f = this.selected;
    if (!f) return;
    const body = this.root.querySelector<HTMLElement>('.ex-body')!;
    const model = this.meta.llm?.model ?? 'the model';
    body.innerHTML = `<div class="ex-wait"><span class="spinner"></span>Sending this finding and its ${f.evidenceCount} evidence events to ${esc(model)}...</div>`;
    try {
      const res = await fetch('/api/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: f.id, refresh }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      this.explanations.set(f.id, data);
      if (this.selected === f) this.showExplanation(data);
    } catch (err) {
      body.innerHTML = `<div class="ex-error">${esc(String((err as Error).message ?? err))}</div>`;
    }
  }

  private showExplanation(ex: Explanation): void {
    const body = this.root.querySelector<HTMLElement>('.ex-body')!;
    const claims = [...ex.claims].sort((a, b) => a.start - b.start);
    const mark = (text: string, offset: number) => {
      let out = '';
      let pos = 0;
      for (const c of claims) {
        const a = c.start - offset;
        const b = c.end - offset;
        if (a < pos || a < 0 || b > text.length) continue;
        out += esc(text.slice(pos, a));
        out += `<span class="claim claim-${c.status}" title="${esc(`${c.kind}: ${c.note}`)}">${esc(text.slice(a, b))}</span>`;
        pos = b;
      }
      return out + esc(text.slice(pos));
    };
    const s = ex.claimSummary;
    const total = s.ok + s.mismatch + s.unknown;
    const proposals = s.proposal ? ` <span class="muted">· ${s.proposal} suggested value${s.proposal === 1 ? '' : 's'} in the fix</span>` : '';
    const verdict =
      s.mismatch === 0 && s.unknown === 0
        ? `<span class="v-ok">✓ all ${total} claims match the evidence</span>`
        : `<span class="${s.mismatch ? 'v-bad' : 'v-warn'}">${s.mismatch ? `✗ ${s.mismatch} claim${s.mismatch === 1 ? '' : 's'} contradict${s.mismatch === 1 ? 's' : ''} the evidence` : ''}${s.mismatch && s.unknown ? ', ' : ''}${s.unknown ? `${s.unknown} not in the evidence` : ''}</span> <span class="muted">(${s.ok} of ${total} match)</span>`;
    body.innerHTML = `
      <div class="ex-answer">
        <div class="ex-sec"><span class="ex-label">Cause</span><p>${mark(ex.cause, 0)}</p></div>
        <div class="ex-sec"><span class="ex-label">Fix</span><p>${mark(ex.fix, ex.cause.length + 1)}</p></div>
      </div>
      <div class="ex-foot">${verdict}${proposals}<span class="muted ex-src">${esc(ex.model)}${ex.usedFallback ? ' (fallback)' : ''}${ex.recorded ? `, recorded ${esc((ex.recordedAt ?? '').slice(0, 10))}` : `, ${(ex.ms / 1000).toFixed(1)} s`}</span>
      ${this.meta.llm ? '<button class="ex-again">Ask again</button>' : ''}</div>`;
    body.querySelector('.ex-again')?.addEventListener('click', () => this.explain(true));
    const btn = this.root.querySelector<HTMLButtonElement>('.ex-btn');
    if (btn) btn.style.display = 'none';
  }
}
