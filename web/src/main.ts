// Latency Lens web UI entry point. Copyright (C) 2026 chinesepowered.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { parsePack, type TraceMeta } from './data.js';
import { Overview } from './overview.js';
import { Panel } from './panel.js';
import { TimelineView } from './timeline.js';
import { esc, fmtDur } from './util.js';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

async function boot(): Promise<void> {
  const status = $('#status-left');
  status.textContent = 'Loading trace...';
  const t0 = performance.now();
  const [metaRes, packRes] = await Promise.all([fetch('/api/trace'), fetch('/api/timeline')]);
  const meta = (await metaRes.json()) as TraceMeta;
  const pack = await packRes.arrayBuffer();
  const data = parsePack(pack, meta);
  const loadMs = performance.now() - t0;

  document.title = `${meta.name} - Latency Lens`;
  $('#trace-name').textContent = meta.name;
  const h = meta.header;
  const chips = [
    `QNX ${h.sysRelease}`,
    h.kernelVersion ? `kernel ${h.kernelVersion}` : '',
    `${meta.cpuCount} CPU${meta.cpuCount === 1 ? '' : 's'}`,
    fmtDur(meta.durationNs),
    `${meta.events.toLocaleString('en-US')} events`,
    meta.deadlinesFile ? `deadlines: ${meta.deadlinesFile.split('/').pop()}` : 'no deadlines.yaml',
  ].filter(Boolean);
  $('#trace-meta').innerHTML = chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('');
  if (meta.stats.droppedEvents) $('#trace-meta').insertAdjacentHTML('beforeend', `<span class="chip warn">${meta.stats.droppedEvents} events dropped</span>`);

  const view = new TimelineView($('#timeline') as unknown as HTMLCanvasElement, meta, data);
  const overview = new Overview($('#overview') as unknown as HTMLCanvasElement, meta, data, view);
  const panel = new Panel($('#panel'), meta, view);

  const right = $('#status-right');
  const updateRight = () => {
    right.textContent = `draw ${view.drawMs.toFixed(1)} ms · decoded in ${meta.timings.parseMs.toFixed(0)} ms, analysed in ${(meta.timings.modelMs + meta.timings.detectMs).toFixed(0)} ms, loaded in ${loadMs.toFixed(0)} ms`;
  };
  view.onViewChange = () => {
    overview.draw();
    updateRight();
  };
  view.onHover = (hv) => {
    status.textContent = hv?.text || 'Scroll to zoom, drag to pan, Shift+drag to zoom to a range, F to fit. Click a finding to jump to it.';
    updateRight();
  };
  view.onHover(null);

  panel.onSelect = (f) => {
    view.hl.threads = new Set(f ? f.threads : []);
    view.hl.victim = f ? f.threads[0] : -1;
    view.hl.instances = f ? f.instances.map((x) => [x.t0, x.t1] as [number, number]) : [];
    if (!f) view.hl.window = null;
    view.scrollY = 0;
    view.rebuildLanes();
    view.request();
  };

  $('#btn-fit').addEventListener('click', () => view.fit());
  $('#btn-kernel').addEventListener('click', () => {
    view.showKernel = !view.showKernel;
    $('#btn-kernel').classList.toggle('on', view.showKernel);
    view.expanded.clear();
    view.collapsed.clear();
    view.rebuildLanes();
    view.request();
  });
  $('#btn-help').addEventListener('click', () => $('#help').classList.toggle('open'));
  $('#help').addEventListener('click', () => $('#help').classList.remove('open'));
  window.addEventListener('keydown', (ev) => {
    if ((ev.target as HTMLElement)?.closest?.('input, textarea')) return;
    if (ev.key === 'Escape') {
      $('#help').classList.remove('open');
      panel.select(null);
    } else if (ev.key === '?') $('#help').classList.toggle('open');
    else if (ev.key === 'n' || ev.key === 'N') panel.next(1);
    else if (ev.key === 'p' || ev.key === 'P') panel.next(-1);
    else if (ev.key === 'e' || ev.key === 'E') void panel.explain(false);
    else if (/^[1-9]$/.test(ev.key) && meta.findings[Number(ev.key) - 1]) panel.select(meta.findings[Number(ev.key) - 1].id);
  });

  const fromHash = () => {
    const m = /finding=([\w-]+)/.exec(location.hash);
    if (m && meta.findings.some((f) => f.id === m[1])) panel.select(m[1]);
  };
  window.addEventListener('hashchange', fromHash);
  fromHash();
  document.body.classList.add('ready');
  (window as unknown as { latencylens: unknown }).latencylens = { view, panel, meta };
}

boot().catch((err) => {
  $('#status-left').textContent = `Could not load the trace: ${(err as Error).message}`;
});
