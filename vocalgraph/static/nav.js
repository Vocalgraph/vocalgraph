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
  // Page addresses: the desktop app serves /, /tracks and /live; the browser
  // version (boot.js sets VG.web) is plain files next to each other.
  const web = !!(window.VG && window.VG.web);
  const href = (page) => web ? { recordings: 'index.html', tracks: 'tracks.html', live: 'live.html' }[page]
                             : { recordings: '/', tracks: '/tracks', live: '/live' }[page];
  // Wording that differs: where recordings are kept, and what to try when the
  // backend stops answering (the desktop app's window closed; the browser tab's
  // worker stopped).
  const where = web ? 'Saved in this browser, on this computer. Clearing this site’s data in the browser deletes them.'
                    : null;
  const lost = web ? 'Try reloading the page.' : 'Is its window still open?';
  if (where) addEventListener('DOMContentLoaded', () => { for (const n of document.querySelectorAll('.side-note[data-where]')) n.textContent = where; });
  const recordingsHref = (id = store.get('st.job'), l = layout()) => href(l === 'track' ? 'tracks' : 'recordings') + (id ? `#${id}` : '');

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
    const live = tab('Live', href('live'), mode === 'live');
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
        try { const s = await (await fetch('api/live/state')).json(); on = ['starting', 'live', 'stopping', 'finishing'].includes(s.status); } catch {}
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
  // With it, the pitch chart's own range (axisLo / axisHi, a separate setting):
  // each end set on its own, every pitch chart starts or stops exactly there,
  // so it can reach past the floor and ceiling into the lava; an empty end
  // fits the voice.
  const AXIS_MIN = 20, AXIS_MAX = 2000;
  const guide = () => {
    const num = (k, lo = 30, hi = 1000) => { const v = parseFloat(store.get(k)); return v >= lo && v <= hi ? v : null; };
    const g = { floor: num('st.floor'), ceiling: num('st.ceiling'),
                axisLo: num('st.axisLo', AXIS_MIN, AXIS_MAX), axisHi: num('st.axisHi', AXIS_MIN, AXIS_MAX) };
    if (g.axisLo != null && g.axisHi != null && g.axisHi <= g.axisLo) g.axisLo = g.axisHi = null;
    return g;
  };
  // The pitch chart's set ends as [lo, hi] (either null: fit that end), or null when neither is set.
  const axis = () => { const g = guide(); return g.axisLo == null && g.axisHi == null ? null : [g.axisLo, g.axisHi]; };
  // A fitted [lo, hi] with the set ends put in.
  const withAxis = (lo, hi) => {
    const a = axis(); if (!a) return [lo, hi];
    if (a[0] != null) lo = a[0];
    if (a[1] != null) hi = a[1];
    if (hi <= lo) { if (a[1] == null) hi = lo + 50; else lo = hi - 50; }
    return [lo, hi];
  };
  const guideFns = [];
  const onGuide = (fn) => guideFns.push(fn);
  const GUIDE_KEYS = ['st.floor', 'st.ceiling', 'st.axisLo', 'st.axisHi'];
  addEventListener('storage', (e) => { if (GUIDE_KEYS.includes(e.key)) guideFns.forEach(f => f(guide())); });

  // Number boxes, bound to the settings: the lava floor and ceiling, then the
  // chart's range.
  function guideControl(host) {
    const wrap = document.createElement('span'); wrap.className = 'guide-ctl';
    const box = (key, label, aria, lo, hi, step) => {
      const lab = document.createElement('label'); lab.textContent = label + ' ';
      const inp = document.createElement('input'); inp.type = 'number'; inp.min = lo; inp.max = hi; inp.step = step;
      inp.placeholder = key.startsWith('axis') ? 'auto' : 'none'; inp.inputMode = 'numeric';
      inp.setAttribute('aria-label', aria);
      // the raw stored value, so a half-entered range stays in its box
      const stored = () => { const v = parseFloat(store.get('st.' + key)); return v >= lo && v <= hi ? v : ''; };
      inp.value = stored();
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        store.set('st.' + key, v >= lo && v <= hi ? String(v) : null);
        guideFns.forEach(f => f(guide()));
      });
      onGuide(() => { if (document.activeElement !== inp) inp.value = stored(); });
      lab.append(inp);
      return lab;
    };
    const group = (title, tip, ...kids) => {
      const g = document.createElement('span'); g.className = 'guide-grp'; g.title = tip;
      const h = document.createElement('span'); h.className = 'guide-h'; h.textContent = title;
      g.append(h, ...kids, document.createTextNode('Hz'));
      return g;
    };
    wrap.append(
      group('Pitch', 'Marks pitch below the floor or above the ceiling ("hot lava") on every pitch chart, in both modes. Leave empty for none.',
        box('floor', 'floor', 'Pitch floor in hertz', 30, 1000, 5), box('ceiling', 'ceiling', 'Pitch ceiling in hertz', 30, 1000, 5)),
      group('Pitch chart', 'Where every pitch chart starts and stops, e.g. past the floor and ceiling to see some of the lava. Set either end on its own; an empty one fits the voice.',
        box('axisLo', 'from', 'Pitch chart bottom in hertz', AXIS_MIN, AXIS_MAX, 10), box('axisHi', 'to', 'Pitch chart top in hertz', AXIS_MIN, AXIS_MAX, 10)));
    host.append(wrap);
    return wrap;
  }

  const setGuide = (kind, v) => {
    store.set('st.' + kind, v == null ? null : String(v));
    guideFns.forEach(f => f(guide()));
  };

  // On the pitch charts themselves: drag a floor or ceiling line to move it
  // (off the chart to remove it), or drag one in from the "+ floor" /
  // "+ ceiling" marks at the chart's right edge. Each page says where its
  // pitch charts are: area(ev) -> { top, bottom, left, right, lo, hi } in
  // client pixels for the pitch plot under the pointer (lo / hi: the values
  // at its bottom and top), or null.
  const areaFns = [];
  const pitchArea = (fn) => areaFns.push(fn);
  const NEAR = 6, MARK_W = 72, MARK_H = 16, OFF = 24;
  let gDrag = null, cursorSet = false, hint = null;
  const areaAt = (ev) => { for (const f of areaFns) { const a = f(ev); if (a && a.hi > a.lo) return a; } return null; };
  const yOf = (a, v) => a.bottom - (v - a.lo) / (a.hi - a.lo) * (a.bottom - a.top);
  const vOf = (a, y) => a.lo + (a.bottom - y) / (a.bottom - a.top) * (a.hi - a.lo);
  function hitOf(ev) {
    const a = areaAt(ev);
    if (!a || ev.clientX < a.left || ev.clientX > a.right + 40) return null;
    const g = guide();
    for (const kind of ['ceiling', 'floor']) {
      const v = g[kind];
      if (v != null && v >= a.lo && v <= a.hi && Math.abs(ev.clientY - yOf(a, v)) <= NEAR) return { kind, a };
    }
    if (ev.clientX >= a.right - MARK_W && ev.clientX <= a.right) {
      if (g.ceiling == null && ev.clientY >= a.top && ev.clientY <= a.top + MARK_H) return { kind: 'ceiling', a };
      if (g.floor == null && ev.clientY <= a.bottom && ev.clientY >= a.bottom - MARK_H) return { kind: 'floor', a };
    }
    return null;
  }
  function showHint(ev, text) {
    if (!text) { if (hint) hint.hidden = true; return; }
    if (!hint) {
      hint = document.createElement('div'); hint.className = 'guide-hint'; hint.setAttribute('role', 'status');
      document.body.append(hint);
    }
    hint.textContent = text; hint.hidden = false;
    const w = hint.offsetWidth;
    hint.style.left = Math.max(8, Math.min(innerWidth - w - 8, ev.clientX - w - 14)) + 'px';
    hint.style.top = Math.max(8, ev.clientY - 30) + 'px';
  }
  const setCursor = (on) => {
    if (on === cursorSet) return;
    cursorSet = on; document.documentElement.style.cursor = on ? 'ns-resize' : '';
  };
  // Stop the page's own click-to-play and drag-to-zoom for this gesture.
  const swallow = (ev) => { ev.stopImmediatePropagation(); ev.preventDefault(); };
  addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const hit = hitOf(ev); if (!hit) return;
    swallow(ev);
    gDrag = { kind: hit.kind, a: hit.a, id: ev.pointerId };
    try { ev.target.setPointerCapture?.(ev.pointerId); } catch {}
    move(ev);
  }, true);
  function move(ev) {
    const { kind, a } = gDrag, g = guide();
    if (ev.clientY < a.top - OFF || ev.clientY > a.bottom + OFF) {
      if (g[kind] != null) setGuide(kind, null);
      showHint(ev, `Let go to remove the ${kind}`); return;
    }
    let v = Math.round(Math.max(a.lo, Math.min(a.hi, vOf(a, ev.clientY))) / 5) * 5;
    v = Math.max(30, Math.min(1000, v));
    // the floor stays below the ceiling
    if (kind === 'floor' && g.ceiling != null) v = Math.min(v, g.ceiling - 5);
    if (kind === 'ceiling' && g.floor != null) v = Math.max(v, g.floor + 5);
    if (v !== g[kind]) setGuide(kind, v);
    showHint(ev, `Pitch ${kind} ${v} Hz`);
  }
  addEventListener('pointermove', (ev) => {
    if (gDrag) { swallow(ev); move(ev); return; }
    if (ev.buttons) return;
    const hit = hitOf(ev);
    setCursor(!!hit);
    const v = hit && guide()[hit.kind];
    showHint(ev, !hit ? null : v == null ? `Drag ${hit.kind === 'floor' ? 'up' : 'down'} to set a pitch ${hit.kind}`
      : `Pitch ${hit.kind} ${Math.round(v)} Hz · drag to move, off the chart to remove`);
  }, true);
  const end = (ev) => {
    if (!gDrag) return;
    swallow(ev); gDrag = null; setCursor(false); showHint(ev, null);
    // ...and the click (or double-click) that follows it
    const eat = (e) => swallow(e);
    addEventListener('click', eat, true); addEventListener('dblclick', eat, true);
    setTimeout(() => { removeEventListener('click', eat, true); removeEventListener('dblclick', eat, true); }, 400);
  };
  addEventListener('pointerup', end, true);
  addEventListener('pointercancel', end, true);

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
    .guide-ctl .guide-grp { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .guide-ctl .guide-grp + .guide-grp { margin-left: 8px; }
    .guide-ctl label { display: inline-flex; align-items: center; gap: 4px; }
    .guide-ctl input { width: 68px; font: inherit; font-size: 13px; color: var(--text-primary); background: var(--surface-1);
      border: 1px solid var(--border); border-radius: 7px; padding: 3px 6px; }
    .guide-hint { position: fixed; z-index: 30; pointer-events: none; background: var(--surface-1); color: var(--text-primary);
      border: 1px solid var(--border); border-radius: 7px; padding: 3px 8px; font-size: 12px; white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0,0,0,.12); }`;
  if (!document.getElementById('guide-css')) {
    const st = document.createElement('style'); st.id = 'guide-css'; st.textContent = guideCss; document.head.append(st);
  }

  return { mount, layout, setLayout, rememberJob, recordingsHref, href, web, lost, guide, axis, withAxis, onGuide, guideControl, guideStats, pitchArea, restoreScroll };
})();
