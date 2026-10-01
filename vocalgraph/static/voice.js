// Voice charts: pitch, resonance, loudness, breathiness. Ported from the
// voice_app.html page; drawing rules unchanged (one y-axis per chart, gaps
// where a measure is undefined, resonance summary by default, one shared
// crosshair + tooltip, a table view).
'use strict';

const VoiceCharts = (() => {
  const FORMANTS = [
    { id: 'f1', label: 'F1', plain: 'Mouth opening',  hint: 'rises as the jaw opens', color: 'var(--series-1)' },
    { id: 'f2', label: 'F2', plain: 'Tongue position', hint: 'rises as the tongue moves forward', color: 'var(--series-2)' },
    { id: 'f3', label: 'F3', plain: 'Tract length',    hint: 'rises as the vocal tract shortens', color: 'var(--series-3)' }];
  const CHARTS = [
    { key: 'pitch', title: 'Pitch', desc: 'Fundamental frequency (F0): how fast the vocal folds vibrate.',
      unit: 'Hz', series: [{ id: 'f0', label: 'F0', color: 'var(--series-1)' }] },
    { key: 'resonance', title: 'Resonance', summary: true,
      desc: 'Vocal tract resonances, set by throat and mouth shape rather than the folds. ' +
            'Where each one sits matters; the moment-to-moment movement is mostly which vowel was said.',
      unit: 'Hz', series: FORMANTS },
    { key: 'resonanceTime', title: 'Resonance over time',
      desc: 'The same three resonances on the recording\'s timeline. Most of this movement is vowel identity, not voice quality.',
      unit: 'Hz', series: FORMANTS },
    { key: 'loudness', title: 'Loudness', desc: 'Perceptual loudness. This is the volume measure.',
      unit: '', series: [{ id: 'loudness', label: 'Loudness', color: 'var(--series-1)' }] },
    { key: 'breathiness', title: 'Breathiness', desc: 'Harmonics-to-noise ratio. Lower is breathier, higher is a clearer tone.',
      unit: 'dB', series: [{ id: 'hnr', label: 'HNR', color: 'var(--series-1)' }] },
  ];
  // Same left/right margins as the speaker timeline (TL in index.html), so a
  // moment in the recording sits at the same x in both.
  const PAD = { l: 120, r: 24, t: 10, b: 22 };
  const NS = 'http://www.w3.org/2000/svg';
  let DATA = null, cursor = null, host = null, tip = null, playT = 0;
  // The page owns zooming: view() gives the [t0, t1] seconds to show, and
  // label() formats a tick for a given span. Defaults: everything, m:ss.
  let view = null, label = null, range = null, strips = null;
  const win = () => view ? view() : [0, DATA.duration];
  // Pitch floor / ceiling ("hot lava"): {floor, ceiling} in Hz, either null.
  // With the pitch chart's own range, axisLo / axisHi (both or neither).
  let guide = { floor: null, ceiling: null, axisLo: null, axisHi: null };
  const LAVA = 'var(--lava, #d6342a)';

  // Time ticks at round steps, about one per 110 px. Shared with the speaker
  // timeline so both axes carry the same marks.
  const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  function timeTicks(t0, t1, plotW) {
    const raw = (t1 - t0) / Math.max(2, Math.floor(plotW / 110));
    const step = STEPS.find(s => s >= raw) || 3600, out = [];
    for (let t = Math.ceil(t0 / step - 1e-9) * step; t <= t1 + 1e-9; t += step) out.push(+t.toFixed(3));
    return out;
  }

  // The visible slice of a uniformly spaced series, reduced to at most
  // `buckets` points by mean; an all-empty bucket stays a gap.
  function visible(values, t0, t1, buckets) {
    const n = values.length, dur = DATA.duration;
    const i0 = Math.max(0, Math.floor(t0 / dur * n)), i1 = Math.min(n, Math.ceil(t1 / dur * n));
    const k = Math.max(1, Math.ceil((i1 - i0) / buckets)), out = [];
    for (let i = i0; i < i1; i += k) {
      let sum = 0, c = 0; const j1 = Math.min(i + k, i1);
      for (let j = i; j < j1; j++) if (values[j] != null) { sum += values[j]; c++; }
      out.push([(i + (j1 - i) / 2) / n * dur, c ? sum / c : null]);
    }
    return out;
  }

  const fmtTime = (s) => { const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r.toFixed(1).padStart(4, '0')}`; };
  const fmtClock = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`; };
  const fmtVal = (v, unit) => v == null ? '—'
    : (unit === 'Hz' ? Math.round(v) + ' Hz' : unit === 'dB' ? v.toFixed(1) + ' dB' : v.toFixed(3));
  const ticks = (lo, hi, n) => { const step = (hi - lo) / n, out = []; for (let i = 0; i <= n; i++) out.push(lo + step * i); return out; };
  const svgEl = (W, H) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('width', W); s.setAttribute('height', H); return s; };
  const adder = (svg) => (tag, attrs, parent = svg) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    parent.append(el); return el;
  };

  function buildCard(spec) {
    const card = document.createElement('div'); card.className = 'vcard';
    const head = document.createElement('div'); head.className = 'card-head';
    const h = document.createElement('h3'); h.textContent = spec.title; head.append(h);
    if (spec.series.length > 1 && !spec.summary) {
      const leg = document.createElement('div'); leg.className = 'legend';
      for (const s of spec.series) {
        const sp = document.createElement('span');
        const i = document.createElement('i'); i.style.background = s.color;
        const t = document.createElement('span'); t.textContent = s.plain ? `${s.plain} (${s.label})` : s.label;
        sp.append(i, t); leg.append(sp);
      }
      head.append(leg);
    }
    const desc = document.createElement('p'); desc.className = 'desc';
    desc.textContent = spec.desc;
    const plot = document.createElement('div'); plot.className = 'plot'; plot.tabIndex = 0;
    plot.dataset.key = spec.key; plot.setAttribute('role', 'img');
    plot.setAttribute('aria-label', `${spec.title} over time. Values also listed in the table.`);
    card.append(head, desc, plot);
    // Under the pitch chart: the resonance trend's summary sentence (resonance.js).
    if (spec.key === 'pitch') { const n = document.createElement('p'); n.className = 'desc res-note'; card.append(n); }
    return card;
  }

  function drawChart(spec) {
    const plot = host.querySelector(`.plot[data-key="${spec.key}"]`);
    const W = plot.clientWidth || 700, H = spec.series.length > 1 ? 190 : 140, plotW = W - PAD.l - PAD.r;
    const [t0, t1] = win(), span = t1 - t0;
    const pts = Object.fromEntries(spec.series.map(s => [s.id, visible(DATA.series[s.id], t0, t1, plotW)]));
    // The value axis fits what's on screen, so zooming in past a spike shows
    // the detail around it.
    let lo = Infinity, hi = -Infinity;
    for (const s of spec.series) for (const [, v] of pts[s.id]) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const marks = spec.key === 'pitch' ? [['floor', guide.floor], ['ceiling', guide.ceiling]].filter(([, v]) => v != null) : [];
    // The page can hold the range steady instead (live): range(key, lo, hi) -> [lo, hi].
    let fitted = true;
    if (range) { const r = range(spec.key, lo, hi); [lo, hi] = r; fitted = !r[2]; }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (fitted) for (const [, v] of marks) { lo = Math.min(lo, v); hi = Math.max(hi, v); }   // always in view
    if (hi <= lo) hi = lo + 1;
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    // A pitch chart end the person set wins: exactly there, nothing added.
    const set = spec.key === 'pitch' && (guide.axisLo != null || guide.axisHi != null);
    if (set) {
      if (guide.axisLo != null) lo = guide.axisLo;
      if (guide.axisHi != null) hi = guide.axisHi;
      if (hi <= lo) { if (guide.axisHi == null) hi = lo + 50; else lo = hi - 50; }
    }
    const x = (v) => PAD.l + (v - t0) / span * plotW;
    const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    // Under the pitch chart's time axis, the resonance trend strip (resonance.js).
    // Before it, any strips the page adds there (live: who is speaking).
    const more = spec.key === 'pitch' && strips ? strips() : [];
    const tr = spec.key === 'pitch' ? resTrend() : null, extra = more.length * WHO + (tr ? STRIP : 0);
    const svg = svgEl(W, H + extra), add = adder(svg);
    more.forEach((st, i) => {
      const mid = H + i * WHO + WHO / 2 + 2;
      add('text', { x: PAD.l - 8, y: mid + 4, 'text-anchor': 'end', fill: 'var(--text-secondary)', 'font-size': 11, 'font-weight': 600 }).textContent = st.label;
      add('rect', { x: PAD.l, y: mid - 9, width: plotW, height: 18, fill: 'var(--grid)', opacity: 0.25, rx: 3 });
      st.draw(svg, { x, t0, t1, mid, h: 18 });
    });
    if (tr) {
      const mid = H + more.length * WHO + STRIP / 2 + 2;
      add('text', { x: PAD.l - 8, y: mid, 'text-anchor': 'end', fill: 'var(--text-secondary)', 'font-size': 11, 'font-weight': 600 }).textContent = 'Resonance';
      add('text', { x: PAD.l - 8, y: mid + 13, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 10 }).textContent = 'thicker = darker';
      add('rect', { x: PAD.l, y: mid - 12, width: plotW, height: 24, fill: 'var(--grid)', opacity: 0.25, rx: 3 });
      Resonance.drawStrip(svg, tr, { x, t0, t1, mid, h: 24 });
    }
    for (const gv of ticks(lo, hi, 4)) {
      add('line', { x1: PAD.l, x2: W - PAD.r, y1: y(gv), y2: y(gv), stroke: 'var(--grid)', 'stroke-width': 1 });
      add('text', { x: PAD.l - 8, y: y(gv) + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 })
        .textContent = spec.unit === 'Hz' ? Math.round(gv) : gv.toFixed(gv < 10 ? 2 : 0);
    }
    // Floor / ceiling: the side past each is shaded, and the line labelled.
    for (const [kind, v] of marks) {
      // Past the chart's range, the shading still covers what's lava on screen.
      const yv = y(Math.max(lo, Math.min(hi, v))), top = kind === 'floor' ? yv : PAD.t, h = kind === 'floor' ? H - PAD.b - yv : yv - PAD.t;
      add('rect', { x: PAD.l, y: top, width: plotW, height: Math.max(0, h), fill: LAVA, opacity: 0.07 });
      if (v < lo || v > hi) continue;
      add('line', { x1: PAD.l, x2: W - PAD.r, y1: yv, y2: yv, stroke: LAVA, 'stroke-width': 1.5, 'stroke-dasharray': '5 3' });
      add('text', { x: W - PAD.r - 4, y: kind === 'floor' ? yv + 13 : yv - 5, 'text-anchor': 'end', fill: LAVA,
        'font-size': 11, 'font-weight': 600 }).textContent = `${kind} ${Math.round(v)} Hz`;
    }
    // Where to drag one in from, while it isn't set (nav.js does the dragging).
    if (spec.key === 'pitch') for (const kind of ['ceiling', 'floor'].filter(k => guide[k] == null))
      add('text', { x: W - PAD.r - 4, y: kind === 'ceiling' ? PAD.t + 11 : H - PAD.b - 4, 'text-anchor': 'end',
        fill: 'var(--muted)', 'font-size': 10 }).textContent = `+ ${kind}`;
    add('line', { x1: PAD.l, x2: W - PAD.r, y1: H - PAD.b, y2: H - PAD.b, stroke: 'var(--axis)', 'stroke-width': 1 });
    // Same ticks and labels as the speaker timeline above.
    for (const tv of timeTicks(t0, t1, plotW))
      add('text', { x: x(tv), y: H - PAD.b + 15, 'text-anchor': 'middle',
        fill: 'var(--muted)', 'font-size': 11 }).textContent = label ? label(tv, span) : fmtClock(tv);
    for (const s of spec.series) {
      let d = '', pen = false, lastX = null, lastY = null;
      for (const [tv, v] of pts[s.id]) {
        if (v == null || (set && (v < lo || v > hi))) { pen = false; continue; }   // off a set range: a gap
        const px = x(tv), py = y(v);
        d += (pen ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1) + ' ';
        pen = true; lastX = px; lastY = py;
      }
      add('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      if (lastX != null && spec.series.length > 1)
        add('text', { x: Math.min(lastX + 6, W - 4), y: lastY + 4, fill: 'var(--text-secondary)', 'font-size': 11, 'font-weight': 600 }).textContent = s.label;
    }
    add('line', { class: 'playhead', x1: 0, x2: 0, y1: 0, y2: H - PAD.b + extra, stroke: 'var(--text-secondary)', 'stroke-width': 1.5, visibility: 'hidden' });
    add('line', { class: 'crosshair', x1: 0, x2: 0, y1: PAD.t, y2: H - PAD.b + extra, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
    for (const s of spec.series)
      add('circle', { class: 'dot', 'data-series': s.id, r: 4, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' });
    Object.assign(svg.dataset, { w: W, h: H, lo, hi });
    plot.replaceChildren(svg);
  }

  // Resonance summary: middle 80% and median per formant on one Hz axis. Time is
  // deliberately absent: formant movement over time is mostly vowel identity.
  function drawRanges(spec) {
    const plot = host.querySelector(`.plot[data-key="${spec.key}"]`);
    const W = plot.clientWidth || 700, ROW = 52, H = spec.series.length * ROW + 34, L = 168, R = 96;
    const rows = spec.series.map(s => {
      const v = DATA.series[s.id].filter(x => x != null).sort((a, b) => a - b);
      const at = (q) => v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : null;
      return { s, lo: at(0.10), mid: at(0.50), hi: at(0.90), n: v.length };
    }).filter(r => r.n > 0);
    const svg = svgEl(W, H), add = adder(svg);
    if (!rows.length) { plot.replaceChildren(svg); return; }
    const max = Math.max(...rows.map(r => r.hi)) * 1.05;
    const x = (v) => L + (v / max) * (W - L - R);
    for (const gv of ticks(0, max, 4)) {
      add('line', { x1: x(gv), x2: x(gv), y1: 6, y2: H - 22, stroke: 'var(--grid)', 'stroke-width': 1 });
      add('text', { x: x(gv), y: H - 7, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 11 }).textContent = Math.round(gv) + (gv === 0 ? '' : ' Hz');
    }
    rows.forEach((r, i) => {
      const y = 20 + i * ROW;
      add('text', { x: 0, y: y - 1, fill: 'var(--text-primary)', 'font-size': 12, 'font-weight': 600 }).textContent = r.s.plain || r.s.label;
      if (r.s.plain) add('text', { x: 0, y: y + 13, fill: 'var(--muted)', 'font-size': 11 }).textContent = `${r.s.label} · ${r.s.hint}`;
      add('line', { x1: x(r.lo), x2: x(r.hi), y1: y, y2: y, stroke: r.s.color, 'stroke-width': 8, 'stroke-linecap': 'round', opacity: 0.28 });
      add('circle', { cx: x(r.mid), cy: y, r: 5, fill: r.s.color, stroke: 'var(--surface-1)', 'stroke-width': 2 });
      add('text', { x: W - R + 8, y: y + 4, fill: 'var(--text-primary)', 'font-size': 12, 'font-weight': 600 }).textContent = Math.round(r.mid) + ' Hz';
      add('text', { x: W - R + 8, y: y + 18, fill: 'var(--muted)', 'font-size': 11 }).textContent = `${Math.round(r.lo)}–${Math.round(r.hi)}`;
    });
    plot.replaceChildren(svg);
  }

  // The resonance trend of the data shown, worked out again at most every
  // couple of seconds while it keeps changing (live), straight away for new
  // data. A page can say why there's none instead: data.resonance = 'why'.
  const STRIP = 44, WHO = 26;
  let res = { data: null, tr: null, at: 0 };
  function resTrend() {
    if (typeof Resonance === 'undefined' || typeof DATA.resonance === 'string') return null;
    if (res.data !== DATA && (res.data == null || Date.now() - res.at > 2000)) res = { data: DATA, tr: Resonance.trend(DATA), at: Date.now() };
    return res.tr;
  }
  function resNote() {
    const n = host.querySelector('.res-note'); if (!n) return;
    const tr = resTrend();
    n.textContent = typeof DATA.resonance === 'string' ? DATA.resonance
      : !tr ? 'Resonance trend: not enough measured speech yet.'
      : tr.summary ? tr.summary.text : 'Resonance trend: shown under the chart, darker where the strip is darker and thicker.';
  }

  function drawAll() {
    if (!DATA) return;
    resNote();
    for (const spec of CHARTS) spec.summary ? drawRanges(spec) : drawChart(spec);
    positionCursor();
    playhead(playT);
  }

  // Playback position (seconds on the trimmed recording), on every time chart.
  function playhead(t) {
    playT = t || 0;
    if (!host || !DATA) return;
    const [t0, t1] = win();
    for (const line of host.querySelectorAll('.playhead')) {
      const svg = line.ownerSVGElement, W = +svg.dataset.w;
      const px = PAD.l + (playT - t0) / (t1 - t0) * (W - PAD.l - PAD.r);
      line.setAttribute('x1', px); line.setAttribute('x2', px);
      line.setAttribute('visibility', playT > 0 && playT >= t0 && playT <= t1 ? 'visible' : 'hidden');
    }
  }

  // Samples are evenly spaced (time[i] = duration * (i + 0.5) / n), so the
  // nearest one is a division, not a search.
  const indexAt = (t) => Math.max(0, Math.min(DATA.time.length - 1, Math.floor(t / DATA.duration * DATA.time.length)));
  function indexFromEvent(ev, plot) {
    const svg = plot.querySelector('svg'), W = +svg.dataset.w, rect = svg.getBoundingClientRect();
    const scale = rect.width > 0 ? rect.width / W : 1;
    const frac = Math.max(0, Math.min(1, ((ev.clientX - rect.left) / scale - PAD.l) / (W - PAD.l - PAD.r)));
    const [t0, t1] = win();
    return indexAt(t0 + frac * (t1 - t0));
  }

  function positionCursor() {
    if (cursor == null) {
      host.querySelectorAll('.crosshair, .dot').forEach(e => e.setAttribute('visibility', 'hidden'));
      tip.hidden = true; return;
    }
    for (const spec of CHARTS) {
      if (spec.summary) continue;
      const svg = host.querySelector(`.plot[data-key="${spec.key}"] svg`);
      if (!svg) continue;
      const W = +svg.dataset.w, H = +svg.dataset.h, lo = +svg.dataset.lo, hi = +svg.dataset.hi, [t0, t1] = win();
      const px = PAD.l + (DATA.time[cursor] - t0) / (t1 - t0) * (W - PAD.l - PAD.r);
      const line = svg.querySelector('.crosshair');
      line.setAttribute('x1', px); line.setAttribute('x2', px); line.setAttribute('visibility', 'visible');
      for (const dot of svg.querySelectorAll('.dot')) {
        const v = DATA.series[dot.dataset.series][cursor];
        if (v == null) { dot.setAttribute('visibility', 'hidden'); continue; }
        dot.setAttribute('cx', px);
        dot.setAttribute('cy', PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b));
        dot.setAttribute('visibility', 'visible');
      }
    }
    tip.replaceChildren();
    const head = document.createElement('div'); head.className = 't'; head.textContent = fmtTime(DATA.time[cursor]);
    tip.append(head);
    for (const spec of CHARTS) for (const s of (spec.summary ? [] : spec.series)) {
      const row = document.createElement('div'); row.className = 'row';
      const i = document.createElement('i'); i.style.background = s.color;
      const b = document.createElement('b'); b.textContent = fmtVal(DATA.series[s.id][cursor], spec.unit);
      const n = document.createElement('span'); n.textContent = s.plain || s.label;
      row.append(i, b, n); tip.append(row);
    }
    const rp = resTrend() && Resonance.at(resTrend(), DATA.time[cursor]);
    if (rp) {
      const row = document.createElement('div'); row.className = 'row';
      const i = document.createElement('i'); i.style.background = Resonance.colour(Resonance.frac(rp.pct));
      const b = document.createElement('b'); b.textContent = `${rp.pct > 0 ? '+' : ''}${rp.pct.toFixed(1)}%`;
      const n = document.createElement('span'); n.textContent = `Resonance: ${Resonance.describe(rp.pct)}`;
      row.append(i, b, n); tip.append(row);
    }
    tip.hidden = false;
  }

  function placeTip(ev) {
    const w = tip.offsetWidth || 170, h = tip.offsetHeight || 120;
    let left = ev.clientX + 16; const top = ev.clientY - h / 2;
    if (left + w > innerWidth - 8) left = ev.clientX - w - 16;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, Math.min(innerHeight - h - 8, top)) + 'px';
  }

  function buildTable(table) {
    const cols = [['Time', null]];
    for (const spec of CHARTS.filter(c => !c.summary)) for (const s of spec.series) cols.push([s.plain ? `${s.plain} (${s.label})` : s.label, spec]);
    table.replaceChildren();
    const thead = document.createElement('thead'), hr = document.createElement('tr');
    for (const [label] of cols) { const th = document.createElement('th'); th.textContent = label; hr.append(th); }
    thead.append(hr); table.append(thead);
    const tb = document.createElement('tbody');
    const step = Math.max(1, Math.round(1 / (DATA.time[1] - DATA.time[0] || 1)));
    for (let i = 0; i < DATA.time.length; i += step) {
      const tr = document.createElement('tr');
      const td0 = document.createElement('td'); td0.textContent = fmtTime(DATA.time[i]); tr.append(td0);
      for (const spec of CHARTS.filter(c => !c.summary)) for (const s of spec.series) {
        const td = document.createElement('td'); td.textContent = fmtVal(DATA.series[s.id][i], spec.unit); tr.append(td);
      }
      tb.append(tr);
    }
    table.append(tb);
  }

  let meta = null, table = null;
  // Share of voiced pitch past the floor / ceiling.
  function guideStats() {
    const v = DATA.series.f0.filter(x => x != null), out = [];
    if (!v.length) return out;
    const pct = (n) => `${Math.round(100 * n / v.length)}%`;
    if (guide.floor != null) out.push([`Below ${Math.round(guide.floor)} Hz`, pct(v.filter(x => x < guide.floor).length)]);
    if (guide.ceiling != null) out.push([`Above ${Math.round(guide.ceiling)} Hz`, pct(v.filter(x => x > guide.ceiling).length)]);
    return out;
  }
  function renderMeta() {
    // A page that works out its own summary (live: over the whole session) says so.
    const tiles = [...DATA.stats, ...(DATA.guideStats === false ? [] : guideStats())].map(([k, v]) => {
      const d = document.createElement('div'); d.className = 'stat';
      const kk = document.createElement('div'); kk.className = 'k'; kk.textContent = k;
      const vv = document.createElement('div'); vv.className = 'v'; vv.textContent = v;
      d.append(kk, vv); return d;
    });
    meta.replaceChildren(...tiles);
  }
  // The cards are built once and then redrawn in place: rebuilding them left
  // the page briefly shorter, and the browser moved the scroll position up.
  function render() {
    renderMeta();
    if (host.dataset.built !== '1' || host.querySelectorAll('.vcard').length !== CHARTS.length) {
      host.replaceChildren(...CHARTS.map(buildCard));
      host.dataset.built = '1';
    }
    drawAll();
    if (table) buildTable(table);
  }

  function show(data, els) {
    ({ host, tip, meta, table } = els);
    view = els.view || null; label = els.label || null; range = els.range || null;
    // strips() -> [{ label, draw(svg, { x, t0, t1, mid, h }) }]: drawn under the pitch chart
    strips = els.strips || null;
    DATA = data; cursor = null; res = { data: null, tr: null, at: 0 };
    render();
  }

  // Clicking and dragging on a chart (play from there, zoom) is handled by the
  // page, together with the speaker timeline.

  document.addEventListener('pointermove', (ev) => {
    const plot = ev.target.closest?.('.plot');
    if (!plot || !DATA || !host?.contains(plot) || !plot.querySelector('svg .crosshair')) { if (cursor != null && host) { cursor = null; positionCursor(); } return; }
    cursor = indexFromEvent(ev, plot); positionCursor(); placeTip(ev);
  });
  document.addEventListener('keydown', (ev) => {
    const el = document.activeElement;
    if (!DATA || !el?.classList.contains('plot') || !host?.contains(el)) return;
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    cursor = Math.max(0, Math.min(DATA.time.length - 1, (cursor ?? 0) + (ev.key === 'ArrowRight' ? 1 : -1)));
    positionCursor();
    const r = el.getBoundingClientRect(); placeTip({ clientX: r.left + r.width / 2, clientY: r.top });
  });
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawAll, 150); });

  // New data for the same charts, e.g. live: redrawn in place, and the hover
  // readout stays where it is.
  function update(data) {
    if (!host || !DATA) return false;
    DATA = data;
    if (cursor != null) cursor = Math.min(cursor, DATA.time.length - 1);
    renderMeta(); drawAll();
    return true;
  }

  // The pitch plot under the pointer, for dragging the floor / ceiling (Nav.pitchArea).
  function pitchArea(ev) {
    const svg = ev.target.closest?.('.plot[data-key="pitch"]')?.querySelector('svg');
    if (!svg || !host?.contains(svg)) return null;
    const r = svg.getBoundingClientRect(), W = +svg.dataset.w, H = +svg.dataset.h, k = r.width / W || 1;
    return { top: r.top + PAD.t * k, bottom: r.top + (H - PAD.b) * k, left: r.left + PAD.l * k, right: r.left + (W - PAD.r) * k,
             lo: +svg.dataset.lo, hi: +svg.dataset.hi };
  }

  function setGuide(g) { guide = { floor: g?.floor ?? null, ceiling: g?.ceiling ?? null, axisLo: g?.axisLo ?? null, axisHi: g?.axisHi ?? null }; if (DATA && host) { renderMeta(); drawAll(); } }

  return { show, update, playhead, redraw: drawAll, ticks: timeTicks, setGuide, pitchArea,
           clear: () => { DATA = null; cursor = null; if (tip) tip.hidden = true; } };
})();
