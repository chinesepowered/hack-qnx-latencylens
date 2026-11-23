// Latency Lens codelab: step navigation (one step per URL hash), time remaining, copy buttons.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
(() => {
  const steps = [...document.querySelectorAll('section.step')];
  const toc = document.getElementById('toc');
  const prev = document.getElementById('prev');
  const next = document.getElementById('next');
  const bar = document.getElementById('bar');
  const remaining = document.getElementById('remaining');
  const clock = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"/></svg>';

  steps.forEach((s, i) => {
    const min = Number(s.dataset.duration || 0);
    const li = document.createElement('li');
    li.innerHTML = `<a href="#${i}"><span class="n">${i + 1}</span><span class="t"></span>${min ? `<span class="d">${min} min</span>` : ''}</a>`;
    li.querySelector('.t').textContent = s.dataset.label;
    toc.appendChild(li);
    const h = document.createElement('h2');
    h.className = 'step-title';
    h.textContent = `${i + 1}. ${s.dataset.label}`;
    const d = document.createElement('div');
    d.className = 'duration';
    d.innerHTML = min ? `${clock} Duration: ${min} min` : '';
    s.prepend(h, d);
  });

  // copy buttons on command blocks (the comment lines are skipped)
  document.querySelectorAll('pre.cmd').forEach((pre) => {
    const b = document.createElement('button');
    b.className = 'copy';
    b.type = 'button';
    b.textContent = 'Copy';
    b.addEventListener('click', async () => {
      const text = pre.innerText
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .join('\n')
        .trim();
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = 'Copied';
        b.classList.add('ok');
      } catch {
        b.textContent = 'Select and copy';
      }
      setTimeout(() => {
        b.textContent = 'Copy';
        b.classList.remove('ok');
      }, 1600);
    });
    pre.parentElement.appendChild(b);
  });

  let cur = -1;
  function show(i) {
    i = Math.max(0, Math.min(steps.length - 1, i));
    if (i === cur) return;
    cur = i;
    steps.forEach((s, k) => (s.hidden = k !== i));
    [...toc.children].forEach((li, k) => {
      li.classList.toggle('active', k === i);
      li.classList.toggle('done', k < i);
    });
    const left = steps.slice(i).reduce((n, s) => n + Number(s.dataset.duration || 0), 0);
    remaining.textContent = left ? `${left} min remaining` : 'Done';
    bar.style.width = `${(i / (steps.length - 1)) * 100}%`;
    prev.hidden = i === 0;
    next.textContent = i === steps.length - 1 ? 'Done' : 'Next';
    document.title = `${steps[i].dataset.label}: Find a priority inversion on QNX in 20 minutes`;
    if (location.hash !== `#${i}`) history.replaceState(null, '', `#${i}`);
    window.scrollTo(0, 0);
    document.body.classList.remove('nav-open');
  }
  prev.addEventListener('click', () => show(cur - 1));
  next.addEventListener('click', () => {
    if (cur === steps.length - 1) location.href = 'https://github.com/chinesepowered/hack-qnx-latencylens';
    else show(cur + 1);
  });
  window.addEventListener('hashchange', () => show(parseInt(location.hash.slice(1), 10) || 0));
  document.getElementById('menu').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea') || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight') show(cur + 1);
    if (e.key === 'ArrowLeft') show(cur - 1);
  });
  show(parseInt(location.hash.slice(1), 10) || 0);
})();
