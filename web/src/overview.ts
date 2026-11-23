// Overview strip: CPU load over the whole trace, finding markers, and the current view window.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import { firstEndingAfter, type Timeline, type TraceMeta } from './data.js';
import type { TimelineView } from './timeline.js';
import { SEVERITY_COLOR } from './util.js';

export class Overview {
  private ctx: CanvasRenderingContext2D;
  private load: Float32Array | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  markers: { t0: number; t1: number; color: string }[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private meta: TraceMeta,
    private data: Timeline,
    private view: TimelineView,
  ) {
    this.ctx = canvas.getContext('2d')!;
    for (const f of meta.findings) for (const x of f.instances) this.markers.push({ t0: x.t0, t1: x.t1, color: SEVERITY_COLOR[f.severity] });
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    let dragging = false;
    const move = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const t = ((ev.clientX - rect.left) / this.w) * meta.durationNs;
      const span = view.t1 - view.t0;
      view.setView(t - span / 2, t + span / 2);
    };
    canvas.addEventListener('mousedown', (ev) => {
      dragging = true;
      move(ev);
    });
    window.addEventListener('mousemove', (ev) => dragging && move(ev));
    window.addEventListener('mouseup', () => (dragging = false));
    this.resize();
  }

  private resize(): void {
    const p = this.canvas.parentElement!;
    this.dpr = window.devicePixelRatio || 1;
    this.w = p.clientWidth;
    this.h = p.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.computeLoad();
    this.draw();
  }

  private computeLoad(): void {
    const W = Math.max(1, Math.floor(this.w));
    const load = new Float32Array(W);
    const dur = this.meta.durationNs;
    const px = dur / W;
    for (const c of this.data.cpus) {
      let k = 0;
      for (let x = 0; x < W; x++) {
        const a = x * px;
        const b = a + px;
        // busy time in [a, b] from the cumulative array
        const at = (t: number) => {
          k = Math.max(k, 0);
          const q = firstEndingAfter(c.end, c.n, t);
          if (q >= c.n) return c.cumBusy[c.n];
          let v = c.cumBusy[q];
          const th = c.thread[q];
          if (c.start[q] < t && th >= 0 && !this.meta.threads[th].isIdle) v += t - c.start[q];
          return v;
        };
        load[x] += (at(b) - at(a)) / px / this.data.cpus.length;
      }
    }
    this.load = load;
  }

  draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, this.w, this.h);
    const load = this.load;
    if (load) {
      ctx.fillStyle = '#238636';
      for (let x = 0; x < load.length; x++) {
        const hh = Math.max(0, Math.min(1, load[x])) * (this.h - 8);
        if (hh > 0.2) ctx.fillRect(x, this.h - hh, 1, hh);
      }
    }
    const dur = this.meta.durationNs;
    for (const m of this.markers) {
      ctx.fillStyle = m.color;
      ctx.fillRect((m.t0 / dur) * this.w, 0, Math.max(2, ((m.t1 - m.t0) / dur) * this.w), 5);
    }
    const a = (Math.max(0, this.view.t0) / dur) * this.w;
    const b = (Math.min(dur, this.view.t1) / dur) * this.w;
    ctx.fillStyle = 'rgba(88, 166, 255, 0.18)';
    ctx.fillRect(a, 0, Math.max(2, b - a), this.h);
    ctx.strokeStyle = '#58a6ff';
    ctx.strokeRect(a + 0.5, 0.5, Math.max(2, b - a) - 1, this.h - 1);
  }
}
