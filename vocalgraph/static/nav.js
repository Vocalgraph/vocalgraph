// The top of every page: two modes (Recordings, Live) and a Card / Track layout
// switch. The layout is remembered, so both modes open the way it was last used.
'use strict';

const Nav = (() => {
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  const layout = () => store.get('st.layout') === 'track' ? 'track' : 'card';
  const setLayout = (l) => store.set('st.layout', l);
  // The recording last open in Recordings, so coming back from Live returns to it.
  const rememberJob = (id) => store.set('st.job', id || null);
  const recordingsHref = (id = store.get('st.job'), l = layout()) => (l === 'track' ? '/tracks' : '/') + (id ? `#${id}` : '');

  const css = `
    .nav { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
    .nav .modes, .nav .layout { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .nav .modes a, .nav .modes span { display: inline-flex; align-items: center; gap: 6px; padding: 6px 16px;
      font-size: 14px; font-weight: 600; text-decoration: none; color: var(--text-secondary); }
    .nav .modes a:hover { background: var(--row-hover); }
    .nav .modes [aria-current] { background: var(--accent); color: var(--accent-text); }
    .nav .rec-dot { width: 8px; height: 8px; border-radius: 50%; background: #d6342a; }
    .nav .layout { font-size: 13px; }
    .nav .layout button { font: inherit; background: none; border: none; padding: 5px 12px; color: var(--text-secondary); cursor: pointer; }
    .nav .layout button:hover { background: var(--row-hover); }
    .nav .layout button[aria-pressed="true"] { background: var(--accent-soft); color: var(--text-primary); font-weight: 600; }
    .nav .layout-label { color: var(--muted); font-size: 12px; margin-right: -8px; }`;

  // mode: 'recordings' | 'live'. onLayout(l) is called when the switch changes;
  // the page decides whether that means re-drawing or opening the other page.
  function mount(host, { mode, onLayout }) {
    if (!document.getElementById('nav-css')) {
      const st = document.createElement('style'); st.id = 'nav-css'; st.textContent = css; document.head.append(st);
    }
    host.className = 'nav'; host.replaceChildren();
    const modes = document.createElement('nav'); modes.className = 'modes'; modes.setAttribute('aria-label', 'Mode');
    const tab = (label, href, here) => {
      const t = document.createElement(here ? 'span' : 'a'); t.textContent = label;
      if (here) t.setAttribute('aria-current', 'page'); else t.href = href;
      modes.append(t); return t;
    };
    const rec = tab('Recordings', recordingsHref(), mode === 'recordings');
    const live = tab('Live', '/live', mode === 'live');
    // Worked out on click, so it follows the layout switch and the last recording opened.
    if (mode !== 'recordings') rec.addEventListener('click', () => { rec.href = recordingsHref(); });

    const lab = document.createElement('span'); lab.className = 'layout-label'; lab.textContent = 'Layout';
    const sw = document.createElement('div'); sw.className = 'layout'; sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', 'Layout');
    const btns = {};
    for (const [l, text] of [['card', 'Card'], ['track', 'Track']]) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
      b.addEventListener('click', () => {
        if (layout() === l) return;
        setLayout(l); for (const [k, x] of Object.entries(btns)) x.setAttribute('aria-pressed', String(k === l));
        onLayout(l);
      });
      btns[l] = b; sw.append(b);
    }
    for (const [k, x] of Object.entries(btns)) x.setAttribute('aria-pressed', String(k === layout()));
    host.append(modes, lab, sw);

    // A red dot on Live while a session is recording, so it isn't forgotten
    // from the other tab.
    if (mode !== 'live') {
      const check = async () => {
        let on = false;
        try { const s = await (await fetch('/api/live/state')).json(); on = ['starting', 'live', 'stopping', 'finishing'].includes(s.status); } catch {}
        const dot = live.querySelector('.rec-dot');
        if (on && !dot) { const d = document.createElement('i'); d.className = 'rec-dot'; d.title = 'Recording now'; live.prepend(d); }
        if (!on && dot) dot.remove();
        live.title = on ? 'A live session is recording' : '';
      };
      check(); setInterval(check, 5000);
    }
  }

  // --- pitch floor and ceiling ("hot lava") -------------------------------------
  // One setting for every page and both modes; a change in one tab reaches the
  // others. Either can be left empty.
  const guide = () => {
    const num = (k) => { const v = parseFloat(store.get(k)); return v >= 30 && v <= 1000 ? v : null; };
    return { floor: num('st.floor'), ceiling: num('st.ceiling') };
  };
  const guideFns = [];
  const onGuide = (fn) => guideFns.push(fn);
  addEventListener('storage', (e) => { if (e.key === 'st.floor' || e.key === 'st.ceiling') guideFns.forEach(f => f(guide())); });

  // Two number boxes, bound to the setting.
  function guideControl(host) {
    const wrap = document.createElement('span'); wrap.className = 'guide-ctl';
    wrap.title = 'Marks pitch below the floor or above the ceiling on every pitch chart, in both modes. Leave empty for none.';
    const box = (key, label) => {
      const lab = document.createElement('label'); lab.textContent = label + ' ';
      const inp = document.createElement('input'); inp.type = 'number'; inp.min = 30; inp.max = 1000; inp.step = 5;
      inp.placeholder = 'none'; inp.inputMode = 'numeric';
      inp.setAttribute('aria-label', `Pitch ${label} in hertz`);
      inp.value = guide()[key] ?? '';
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        store.set('st.' + key, v >= 30 && v <= 1000 ? String(v) : null);
        guideFns.forEach(f => f(guide()));
      });
      onGuide((g) => { if (document.activeElement !== inp) inp.value = g[key] ?? ''; });
      lab.append(inp, document.createTextNode(' Hz'));
      return lab;
    };
    const h = document.createElement('span'); h.className = 'guide-h'; h.textContent = 'Pitch';
    wrap.append(h, box('floor', 'floor'), box('ceiling', 'ceiling'));
    host.append(wrap);
    return wrap;
  }

  // Share of voiced pitch below the floor / above the ceiling, as stat rows.
  function guideStats(f0values) {
    const g = guide(), v = f0values.filter(x => x != null), out = [];
    if (!v.length) return out;
    const pct = (n) => `${Math.round(100 * n / v.length)}%`;
    if (g.floor != null) out.push([`Below ${Math.round(g.floor)} Hz`, pct(v.filter(x => x < g.floor).length)]);
    if (g.ceiling != null) out.push([`Above ${Math.round(g.ceiling)} Hz`, pct(v.filter(x => x > g.ceiling).length)]);
    return out;
  }

  // --- keep the scroll position across a reload ----------------------------------
  // Pages draw after fetching, so the browser's own restore finds a short page
  // and lands at the top. Call restoreScroll() once the page is drawn.
  const scrollKey = () => 'st.scroll:' + location.pathname;
  try { history.scrollRestoration = 'manual'; } catch {}
  let scrollT = null;
  addEventListener('scroll', () => {
    clearTimeout(scrollT);
    scrollT = setTimeout(() => { try { sessionStorage.setItem(scrollKey(), String(Math.round(scrollY))); } catch {} }, 150);
  }, { passive: true });
  let restored = false;
  function restoreScroll() {
    if (restored) return; restored = true;
    let y = 0; try { y = +sessionStorage.getItem(scrollKey()) || 0; } catch {}
    if (y) requestAnimationFrame(() => scrollTo(0, y));
  }

  const guideCss = `
    .guide-ctl { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--text-secondary); font-size: 13px; }
    .guide-ctl .guide-h { font-weight: 600; color: var(--text-primary); }
    .guide-ctl label { display: inline-flex; align-items: center; gap: 4px; }
    .guide-ctl input { width: 68px; font: inherit; font-size: 13px; color: var(--text-primary); background: var(--surface-1);
      border: 1px solid var(--border); border-radius: 7px; padding: 3px 6px; }`;
  if (!document.getElementById('guide-css')) {
    const st = document.createElement('style'); st.id = 'guide-css'; st.textContent = guideCss; document.head.append(st);
  }

  return { mount, layout, setLayout, rememberJob, recordingsHref, guide, onGuide, guideControl, guideStats, restoreScroll };
})();
