// Puts the Latency Lens web UI on the director's virtual clock so every frame is deterministic:
// view animations, panel scrolling and CSS animations advance with the frame time, not the wall clock.
// Also answers "where is X on screen" questions so the pointer can move to real targets.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
(() => {
  if (window.__tick) return;
  const L = window.latencylens;
  const view = L.view;
  const meta = L.meta;
  const AXIS_H = 30;
  const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  window.__vt = 0;
  window.__animScale = 2.4;
  let anim = null;
  let scroll = null;

  view.animateTo = function (a, b, ms = 450) {
    anim = {
      c0: (this.t0 + this.t1) / 2,
      l0: Math.log(this.t1 - this.t0),
      c1: (a + b) / 2,
      l1: Math.log(Math.max(2000, b - a)),
      start: window.__vt,
      dur: Math.max(0.3, (ms / 1000) * window.__animScale),
    };
  };
  /** Zoom to [a, b] ns over `dur` seconds of video time. */
  window.__zoom = (a, b, dur) => {
    view.animateTo(a, b, 450);
    anim.dur = dur;
  };
  window.__scrollPanel = (to, dur) => {
    const el = document.getElementById('panel');
    scroll = { el, from: el.scrollTop, to: Math.max(0, Math.min(to, el.scrollHeight - el.clientHeight)), start: window.__vt, dur };
  };
  /** Scroll the findings panel so `sel` sits `margin` px below the panel's sticky header. */
  window.__scrollPanelTo = (sel, dur, margin = 12) => {
    const el = document.getElementById('panel');
    const t = document.querySelector(sel);
    if (!t) return false;
    const head = el.querySelector('.panel-head')?.offsetHeight ?? 0;
    const target = el.scrollTop + t.getBoundingClientRect().top - el.getBoundingClientRect().top - head - margin;
    window.__scrollPanel(target, dur);
    return true;
  };

  window.__tick = (vt) => {
    window.__vt = vt;
    let busy = false;
    if (anim) {
      const u = Math.min(1, (vt - anim.start) / anim.dur);
      const e = ease(Math.max(0, u));
      const span = Math.exp(anim.l0 + (anim.l1 - anim.l0) * e);
      const c = anim.c0 + (anim.c1 - anim.c0) * e;
      view.setView(c - span / 2, c + span / 2);
      if (u >= 1) anim = null;
      else busy = true;
    }
    if (scroll) {
      const u = Math.min(1, (vt - scroll.start) / scroll.dur);
      scroll.el.scrollTop = scroll.from + (scroll.to - scroll.from) * ease(Math.max(0, u));
      if (u >= 1) scroll = null;
      else busy = true;
    }
    for (const a of document.getAnimations()) {
      if (a.__t0 === undefined) a.__t0 = vt;
      a.pause();
      const ms = (vt - a.__t0) * 1000;
      a.currentTime = ms;
      const timing = a.effect ? a.effect.getComputedTiming() : null;
      if (timing && (timing.iterations === Infinity || ms < timing.endTime)) busy = true;
    }
    view.draw();
    return busy;
  };

  const threadIndex = (name) => {
    const pinned = view.lanes.find((l) => l.kind === 'thread' && meta.threads[l.index].name === name && l.pinned);
    if (pinned) return pinned.index;
    const T = meta.threads.find((x) => x.name === name && !x.isKernel);
    return T ? T.index : -1;
  };
  const laneOf = (th) => {
    const k = view.lanes.findIndex((l) => l.kind === 'thread' && l.index === th);
    return k;
  };
  /** Screen point of thread `name`'s lane at time t (ns); t = null gives the lane label. */
  window.__lanePoint = (name, t) => {
    const th = threadIndex(name);
    const k = laneOf(th);
    if (k < 0) return null;
    const r = view.canvas.getBoundingClientRect();
    const y = r.top + AXIS_H + view.laneY[k] - view.scrollY + view.lanes[k].height / 2;
    const x = t == null ? r.left + 70 : r.left + view.x(t);
    return { x, y };
  };
  /** Screen point in the middle of the widest visible run of `name` in `state` (a state code). */
  window.__runPoint = (name, state, prio) => {
    const th = threadIndex(name);
    const k = laneOf(th);
    if (k < 0) return null;
    const runs = view.data.threads[th];
    let best = null;
    for (let i = 0; i < runs.n; i++) {
      if (runs.state[i] !== state || (prio != null && runs.prio[i] !== prio)) continue;
      const a = Math.max(runs.start[i], view.t0);
      const b = Math.min(runs.end[i], view.t1);
      if (b <= a) continue;
      if (!best || b - a > best.b - best.a) best = { a, b, i };
    }
    if (!best) return null;
    const r = view.canvas.getBoundingClientRect();
    return {
      x: r.left + view.x((best.a + best.b) / 2),
      y: r.top + AXIS_H + view.laneY[k] - view.scrollY + view.lanes[k].height / 2,
      prio: runs.prio[best.i],
      ns: runs.end[best.i] - runs.start[best.i],
    };
  };
  /** Pin threads at the top of the timeline, as selecting a finding does. */
  window.__pin = (names) => {
    view.hl.threads = new Set(names.map(threadIndex).filter((i) => i >= 0));
    view.scrollY = 0;
    view.rebuildLanes();
  };
  window.__rect = (sel, nth = 0) => {
    const el = document.querySelectorAll(sel)[nth];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  };
})();
