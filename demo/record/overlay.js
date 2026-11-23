// Overlay for the demo video: pointer, click ripple, highlight ring, step caption and fade to black.
// The director injects this into every page it films and sets the state once per frame.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
(() => {
  if (window.__ov) return;
  const root = document.createElement('div');
  root.id = '__ov';
  root.innerHTML = `
    <div id="__ring"></div>
    <div id="__cap"><span id="__cap-step"></span><span id="__cap-text"></span></div>
    <div id="__ripple"></div>
    <svg id="__cur" viewBox="0 0 24 24" width="24" height="24"><path d="M3 2 L3 19.5 L7.6 15.2 L10.6 22 L13.6 20.7 L10.7 14.1 L17 14.1 Z" fill="#ffffff" stroke="#0d1117" stroke-width="1.5" stroke-linejoin="round"/></svg>
    <div id="__fade"></div>`;
  const style = document.createElement('style');
  style.textContent = `
    #__ov { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font-family: Inter, system-ui, sans-serif; }
    #__fade { position: absolute; inset: 0; background: #000; opacity: 0; }
    #__cur { position: absolute; left: 0; top: 0; opacity: 0; filter: drop-shadow(0 2px 3px rgba(0,0,0,.65)); }
    #__ripple { position: absolute; left: 0; top: 0; width: 40px; height: 40px; border-radius: 50%; border: 3px solid #58a6ff; background: rgba(88,166,255,.18); opacity: 0; }
    #__ring { position: absolute; left: 0; top: 0; border: 2px solid #58a6ff; border-radius: 8px; box-shadow: 0 0 0 4px rgba(88,166,255,.22), 0 0 28px rgba(88,166,255,.35); opacity: 0; }
    #__cap { position: absolute; display: flex; align-items: center; gap: 10px; padding: 6px 16px 6px 7px; border-radius: 999px; background: rgba(13,17,23,.92);
      border: 1px solid #30363d; color: #e6edf3; font-size: 15px; font-weight: 500; box-shadow: 0 8px 28px rgba(0,0,0,.5); opacity: 0; white-space: nowrap; }
    #__cap-step { display: inline-grid; place-items: center; min-width: 24px; height: 24px; border-radius: 12px; background: #1f6feb; color: #fff; font-size: 13px; font-weight: 700; padding: 0 7px; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(root);
  const q = (s) => root.querySelector(s);
  const cur = q('#__cur');
  const rip = q('#__ripple');
  const ring = q('#__ring');
  const cap = q('#__cap');
  const fade = q('#__fade');
  window.__ov = {
    set(s) {
      const c = s.cursor ?? { o: 0, x: 0, y: 0 };
      cur.style.opacity = String(c.o);
      cur.style.transform = `translate(${c.x - 3}px, ${c.y - 2}px)`;
      const r = s.ripple ?? { o: 0, x: 0, y: 0, p: 0 };
      rip.style.opacity = String(r.o);
      rip.style.transform = `translate(${r.x - 20}px, ${r.y - 20}px) scale(${0.35 + r.p * 1.15})`;
      const g = s.ring ?? { o: 0, x: 0, y: 0, w: 0, h: 0 };
      ring.style.opacity = String(g.o);
      ring.style.transform = `translate(${g.x}px, ${g.y}px)`;
      ring.style.width = `${g.w}px`;
      ring.style.height = `${g.h}px`;
      const k = s.caption ?? { o: 0 };
      cap.style.opacity = String(k.o);
      if (k.o > 0) {
        q('#__cap-step').textContent = k.step ?? '';
        q('#__cap-step').style.display = k.step ? '' : 'none';
        q('#__cap-text').textContent = k.text ?? '';
        cap.style.left = k.left != null ? `${k.left}px` : '';
        cap.style.right = k.right != null ? `${k.right}px` : '';
        cap.style.top = k.top != null ? `${k.top}px` : '';
        cap.style.bottom = k.bottom != null ? `${k.bottom}px` : '';
      }
      fade.style.opacity = String(s.fade ?? 0);
    },
  };
})();
