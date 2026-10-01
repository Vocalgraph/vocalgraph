// Resonance trend: is the voice darker or brighter here than elsewhere in the
// same recording, apart from which vowel was said and apart from pitch?
//
// A voice placed darker (or brighter) moves all its resonances down (or up)
// together, by about the same proportion, while a vowel mostly changes how
// they sit relative to each other. So for each moment with F1, F2 and F3:
//   level  the mean of log F1, log F2, log F3 (where they sit together)
//   shape  log F2 - log F1 and log F3 - log F2 (which vowel, roughly)
// The level a moment's shape and pitch would lead to is fitted over the
// whole recording (least squares; shape with its squares and product, and
// log pitch, since pitch nudges the measured resonances too). What's left
// over is the moment's brightness: above zero brighter than this recording
// usually is for that vowel at that pitch, below zero darker. It's then
// averaged over about WINDOW seconds of speech, so single words wash out
// and the trend across the recording shows.
//
// Relative to the recording itself on purpose: it says "darker from 1:10 on",
// not how dark the voice is in general.
'use strict';

const Resonance = (() => {
  const WINDOW = 10;            // seconds of the timeline averaged for each point of the trend
  const STEP = 0.5;             // the trend's spacing, seconds
  const ENOUGH = 3;             // seconds of measured speech in a window for full confidence
  const FULL = 6;               // the strip's scale: this many % brighter or darker is the end of the ramp
  const MIN_FRAMES = 200;       // fewer usable moments than this: no trend
  const FIT_STRETCH = 10;       // seconds: the stretches the vowel and pitch effects are learnt within
  // the summary: a change counts when it's this big (%) and this sure (z)
  const CHANGE_PCT = 2, CHANGE_Z = 3, MIN_SIDE = 20, BLOCK = 2;

  const ok = (v) => v != null && v === v;

  // Least squares: rows of features (with a leading 1), targets -> coefficients.
  function fit(X, y) {
    const k = X[0].length, A = Array.from({ length: k }, () => new Float64Array(k + 1));
    for (let r = 0; r < X.length; r++) {
      const x = X[r];
      for (let i = 0; i < k; i++) { A[i][k] += x[i] * y[r]; for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j]; }
    }
    for (let i = 0; i < k; i++) A[i][i] += 1e-9;                     // keep it solvable
    for (let c = 0; c < k; c++) {                                    // Gauss-Jordan with pivoting
      let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      const d = A[c][c]; if (!d) continue;
      for (let j = c; j <= k; j++) A[c][j] /= d;
      for (let r = 0; r < k; r++) if (r !== c && A[r][c]) { const f = A[r][c]; for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j]; }
    }
    return A.map(row => row[k]);
  }
  const features = (s1, s2, lp) => [1, s1, s2, s1 * s1, s2 * s2, s1 * s2, lp];

  // The moments to use: every formant measured, in order, in a plausible range.
  function usable(d) {
    const { f0, f1, f2, f3 } = d.series, n = d.time.length, out = [];
    for (let i = 0; i < n; i++) {
      const p = f0[i], a = f1[i], b = f2[i], c = f3[i];
      if (!ok(p) || !ok(a) || !ok(b) || !ok(c)) continue;
      if (!(a >= 150 && a <= 1200 && b >= 500 && b <= 3500 && c >= 1200 && c <= 5000 && a < b && b < c && p > 40)) continue;
      const la = Math.log(a), lb = Math.log(b), lc = Math.log(c);
      out.push({ t: d.time[i], level: (la + lb + lc) / 3, s1: lb - la, s2: lc - lb, lp: Math.log(p), f0: p });
    }
    return out;
  }

  /**
   * d: { duration, time: [s], series: { f0, f1, f2, f3 } } (nulls or NaN where
   * not measured), one speaker's voice on a timeline, as the voice charts get it.
   * Returns null when there's too little, or:
   *   points  [{ t, pct, conf }] every STEP s where there's speech near: pct is
   *           % brighter (+) or darker (-) than usual for this recording, conf
   *           0..1 how much speech is behind it
   *   summary { text, change } or null: a sentence when part of the recording
   *           clearly differs from the rest, or when it's clearly steady
   * dt: seconds each entry of d stands for, when d is frames picked out of a
   * longer timeline (live) rather than the whole timeline.
   */
  function trend(d, { window = WINDOW, dt: every = null } = {}) {
    if (!d?.time?.length) return null;
    const m = usable(d);
    if (m.length < MIN_FRAMES) return null;
    // Learnt from how level, vowel shape and pitch move together within each
    // stretch of the recording (each one's own average taken out), so a slow
    // drift (darker and lower-pitched later on, say) can't be mistaken for
    // what vowels or pitch do to the level, and is left in the result.
    const X = m.map(o => features(o.s1, o.s2, o.lp)), y = m.map(o => o.level);
    const groups = new Map();
    m.forEach((o, i) => { const g = Math.floor(o.t / FIT_STRETCH); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); });
    const Xw = X.map(x => x.slice()), yw = y.slice();
    for (const idx of groups.values()) {
      const k = X[0].length, mean = new Float64Array(k); let my = 0;
      for (const i of idx) { for (let j = 1; j < k; j++) mean[j] += X[i][j]; my += y[i]; }
      for (const i of idx) { for (let j = 1; j < k; j++) Xw[i][j] -= mean[j] / idx.length; yw[i] -= my / idx.length; Xw[i][0] = 0; }
    }
    const coef = fit(Xw, yw);
    for (let i = 0; i < m.length; i++) { let p = 0; for (let j = 1; j < X[i].length; j++) p += coef[j] * X[i][j]; m[i].r = y[i] - p; }
    const mr = m.reduce((s, o) => s + o.r, 0) / m.length;          // zero: this recording's usual
    for (const o of m) o.r -= mr;
    // seconds each moment stands for: given (frames picked out of a timeline), or the timeline's spacing
    const dt = every ?? (d.time.length > 1 ? d.duration / d.time.length : 0.05);
    // sliding window over the moments, in time order
    const pre = new Float64Array(m.length + 1);
    for (let i = 0; i < m.length; i++) pre[i + 1] = pre[i] + m[i].r;
    const lower = (t) => { let lo = 0, hi = m.length; while (lo < hi) { const k = (lo + hi) >> 1; if (m[k].t < t) lo = k + 1; else hi = k; } return lo; };
    const points = [];
    for (let t = STEP / 2; t < d.duration; t += STEP) {
      const near0 = lower(t - 0.75), near1 = lower(t + 0.75);
      if (near1 <= near0) continue;                                  // nobody (this speaker) talking here
      const i0 = lower(t - window / 2), i1 = lower(t + window / 2), n = i1 - i0;
      const r = (pre[i1] - pre[i0]) / n;
      points.push({ t, pct: 100 * (Math.exp(r) - 1), conf: Math.min(1, n * dt / ENOUGH) });
    }
    return { points, summary: summarise(m, dt), full: FULL };
  }

  // Is part of the recording clearly darker or brighter than the rest? The best
  // single split, judged against how much 2-second stretches wobble anyway.
  function summarise(m, dt) {
    const blocks = [];
    for (const o of m) {
      const b = Math.floor(o.t / BLOCK);
      if (!blocks.length || blocks[blocks.length - 1].b !== b) blocks.push({ b, t: b * BLOCK, sum: 0, n: 0, f0: [] });
      const k = blocks[blocks.length - 1]; k.sum += o.r; k.n++; k.f0.push(o.f0);
    }
    const voiced = m.length * dt;
    if (blocks.length < 8 || voiced < 2 * MIN_SIDE) return null;
    const stats = (bs) => {
      const means = bs.map(b => b.sum / b.n), n = means.length;
      const mean = bs.reduce((s, b) => s + b.sum, 0) / bs.reduce((s, b) => s + b.n, 0);
      const v = means.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1);
      return { mean, v, n, secs: bs.reduce((s, b) => s + b.n, 0) * dt };
    };
    let best = null;
    for (let k = 2; k < blocks.length - 2; k++) {
      const a = stats(blocks.slice(0, k)), b = stats(blocks.slice(k));
      if (a.secs < MIN_SIDE || b.secs < MIN_SIDE) continue;
      const z = (b.mean - a.mean) / Math.sqrt(a.v / a.n + b.v / b.n + 1e-12);
      if (!best || Math.abs(z) > Math.abs(best.z)) best = { k, z, a, b };
    }
    if (!best) return null;
    const pct = 100 * (Math.exp(best.b.mean - best.a.mean) - 1), at = blocks[best.k].t;
    const median = (bs) => { const v = bs.flatMap(b => b.f0).sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
    const p0 = median(blocks.slice(0, best.k)), p1 = median(blocks.slice(best.k));
    const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    if (Math.abs(pct) >= CHANGE_PCT && Math.abs(best.z) >= CHANGE_Z) {
      const pitch = Math.abs(p1 / p0 - 1) < 0.03 ? `pitch stayed about the same (${Math.round(p0)} → ${Math.round(p1)} Hz)`
                                                : `pitch went ${p1 > p0 ? 'up' : 'down'} too (${Math.round(p0)} → ${Math.round(p1)} Hz), which this already allows for`;
      return { change: { at, pct, z: best.z, pitch: [p0, p1] },
               text: `From ${clock(at)} on, resonance was ${pct < 0 ? 'darker' : 'brighter'} than before (about ${Math.abs(pct).toFixed(0)}%); ${pitch}.` };
    }
    return { change: null, text: 'Resonance stayed about the same through the recording.' };
  }

  // Colour and thickness for a point: one blue ramp, darker (and thicker) where
  // the resonance is darker. f in 0..1, 0 = darkest end.
  const frac = (pct) => Math.max(0, Math.min(1, 0.5 + pct / (2 * FULL)));
  // The ramp's ends, for a light or a dark page (read off the page's background).
  const RAMP = { light: [[12, 44, 100], [170, 205, 240]], dark: [[40, 80, 150], [190, 220, 250]] };
  function pageIsDark() {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
    return m ? (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) < 128 : false;
  }
  function colour(f) {
    const [a, b] = RAMP[pageIsDark() ? 'dark' : 'light'];
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(',')})`;
  }

  /**
   * The strip, into an SVG: each stretch of speech one smooth band, coloured
   * along the darker-to-brighter ramp and thicker where darker, fainter where
   * little speech is behind it. x(t) maps time to pixels; [t0, t1] is the
   * visible part; mid / h the band's centre and full height.
   */
  const SVGNS = 'http://www.w3.org/2000/svg';
  let gradId = 0;
  function drawStrip(svg, tr, { x, t0, t1, mid, h }) {
    if (!tr) return;
    const half = STEP / 2, el = (tag, a, parent = svg) => {
      const e = document.createElementNS(SVGNS, tag); for (const k in a) e.setAttribute(k, a[k]); parent.append(e); return e; };
    const pts = tr.points.filter(p => p.t + half >= t0 && p.t - half <= t1);
    const runs = [];
    for (const p of pts) {
      const last = runs[runs.length - 1];
      if (last && p.t - last[last.length - 1].t <= STEP * 1.01) last.push(p); else runs.push([p]);
    }
    const defs = el('defs', {});
    for (const run of runs) {
      const a = Math.max(t0, run[0].t - half), b = Math.min(t1, run[run.length - 1].t + half);
      const xa = x(a), xb = Math.max(x(b), xa + 1);
      const id = `res-grad-${++gradId}`;
      const g = el('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: xa, x2: xb, y1: 0, y2: 0 }, defs);
      for (const p of run) {
        const off = Math.max(0, Math.min(1, (x(p.t) - xa) / (xb - xa)));
        el('stop', { offset: off.toFixed(4), 'stop-color': colour(frac(p.pct)), 'stop-opacity': (0.4 + 0.6 * p.conf).toFixed(2) }, g);
      }
      // the outline: thickness at each point, along the top and back along the bottom
      const th = (p) => h * (0.3 + 0.7 * (1 - frac(p.pct))) / 2;
      const top = run.map(p => [Math.max(xa, Math.min(xb, x(p.t))), mid - th(p)]);
      const bot = run.map(p => [Math.max(xa, Math.min(xb, x(p.t))), mid + th(p)]).reverse();
      const pathPts = [[xa, top[0][1]], ...top, [xb, top[top.length - 1][1]], [xb, bot[0][1]], ...bot, [xa, bot[bot.length - 1][1]]];
      el('path', { d: 'M' + pathPts.map(([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`).join(' L') + ' Z', fill: `url(#${id})` });
    }
  }
  // The point at time t, if any, and how to say it.
  function at(tr, t) {
    if (!tr?.points.length) return null;
    let lo = 0, hi = tr.points.length - 1;
    while (lo < hi) { const k = (lo + hi) >> 1; if (tr.points[k].t < t) lo = k + 1; else hi = k; }
    const p = [tr.points[lo], tr.points[Math.max(0, lo - 1)]].reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    return Math.abs(p.t - t) <= STEP ? p : null;
  }
  const describe = (pct) => Math.abs(pct) < 1 ? 'about usual for this recording'
    : `${Math.abs(pct).toFixed(0)}% ${pct < 0 ? 'darker' : 'brighter'} than usual for this recording`;

  return { trend, frac, colour, drawStrip, at, describe, WINDOW, FULL };
})();

if (typeof module !== 'undefined') module.exports = Resonance;
