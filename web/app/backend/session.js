// A live session's analysis: the browser port of vocalgraph/live.py's Session
// (everything but the capture, which is inputs.js, and the saving, live.js).
// Same rules, same steps:
//   speakers  for each new second, segmentation of the newest 10 s window and
//             a voiceprint per local speaker (speakers.prepare on that window);
//             the newest second labelled by nearest voiceprint;
//   grouper   the full grouping (speakers.assign) on everything so far, every
//             few seconds; ids kept stable by shared speaking time; a new
//             voice only becomes a speaker once confirmed (CONFIRM_TALK, twice
//             running); anyone on an input of their own read off its track;
//   voice     openSMILE on each new 0.1 s with 0.5 s before and 0.1 s after;
//             with several inputs, on each input on its own.
import * as E from '../engine/index.js';

const S = E.speakers, src = E.sources, V = E.voice;
const RATE = S.RATE;
const VOICE_BLOCK = 0.1, VOICE_BEFORE = 0.5, VOICE_AFTER = 0.1;
const REGROUP_EVERY = 4.0;
const CONFIRM_TALK = 2.0;
const LEVEL = Math.trunc(src.HOP * RATE);

// A growable typed array.
class Grow {
  constructor(T, cap = RATE * 60) { this.T = T; this.a = new T(cap); this.n = 0; }
  push(v) {
    if (this.n + v.length > this.a.length) { const b = new this.T(Math.max(this.a.length * 2, this.n + v.length)); b.set(this.a.subarray(0, this.n)); this.a = b; }
    this.a.set(v, this.n); this.n += v.length;
  }
  view(a = 0, b = this.n) { return this.a.subarray(a, Math.min(b, this.n)); }
}

const nan256 = () => new Float32Array(S.LOCAL * S.DIM).fill(NaN);
const norm = (v) => { let s = 0; for (const x of v) s += x * x; return Math.sqrt(s); };

// scipy.optimize.linear_sum_assignment for maximising: Hungarian method on a
// rectangular matrix, pairs (row, col) for min(rows, cols) of them.
function bestPairs(score) {
  const n = score.length, m = score[0]?.length || 0;
  if (!n || !m) return [];
  const size = Math.max(n, m), big = Math.max(1, ...score.flat()) + 1;
  const cost = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => (i < n && j < m ? big - score[i][j] : big)));
  const u = new Float64Array(size + 1), v = new Float64Array(size + 1), p = new Int32Array(size + 1), way = new Int32Array(size + 1);
  for (let i = 1; i <= size; i++) {
    p[0] = i; let j0 = 0; const minv = new Float64Array(size + 1).fill(Infinity), used = new Uint8Array(size + 1);
    do {
      used[j0] = 1; const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= size; j++) if (!used[j]) {
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= size; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const out = [];
  for (let j = 1; j <= size; j++) if (p[j] && p[j] - 1 < n && j - 1 < m) out.push([p[j] - 1, j - 1]);
  return out.sort((a, b) => a[0] - b[0]);
}

export class Session {
  constructor({ tracks = 0, names = [], models, smile }) {
    Object.assign(this, { tracks, names, models, smile });
    this.numSpeakers = null; this.speakerNames = {};
    this.x = new Grow(Float32Array);                               // the mix, 16 kHz, rounded to 16-bit
    this.tx = Array.from({ length: tracks }, () => new Grow(Int16Array));
    this.lev = Array.from({ length: tracks }, () => new Grow(Float64Array, 3000));
    this.thr = null; this.homes = new Map(); this.own = new Map();
    this.binary = []; this.emb = [];                               // per window: Uint8Array(589*3), Float32Array(3*256)
    this.cent = new Map(); this.nextPid = 0; this.online = [];
    this.grouped = []; this.groupedUntil = 0; this.regroup = { at: null, took: null };
    this.confirmed = new Map(); this.seen = new Map();
    this.vt = new Grow(Float64Array, 6000);
    this.vraw = Object.fromEntries(V.KEYS.map(k => [k, new Grow(Float64Array, 6000)]));
    this.vsrc = new Grow(Int8Array, 6000); this.vprim = new Grow(Uint8Array, 6000);
    this.voiceUntil = 0; this.ended = false;
    this.window = 0; this.voiceAt = 0; this.lastRegroup = 0; this.busy = false;
  }

  get n() { return this.x.n; }

  // 16 kHz mono blocks from inputs.js: the mix, and each input when several.
  feed(mix, inputs) {
    this.x.push(V.to16bit(mix));
    if (this.tracks && inputs) inputs.forEach((t, i) => this.tx[i].push(V.toPcm16(t)));
    this.kick();
  }
  end() { this.ended = true; this.kick(); }

  // Work through what has arrived; one step at a time, so a long grouping
  // never runs twice at once.
  kick() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    (async () => {
      try {
        do { this.again = false; await this.step(); } while (this.again);
      } catch (e) { this.error = e.message || String(e); console.error(e); }
      finally { this.busy = false; }
    })();
  }

  async step() {
    // speakers: every complete 10 s window
    while (this.n >= this.window * S.STEP + S.WINDOW) await this.speakerWindow(this.window++);
    // voice: every complete 0.1 s block (the last part once the input ends)
    const block = Math.round(VOICE_BLOCK * RATE), after = Math.round(VOICE_AFTER * RATE);
    while (this.n >= this.voiceAt + block + after || (this.ended && this.n - this.voiceAt >= Math.round(0.03 * RATE))) {
      await this.voiceBlock(this.voiceAt, block);
      this.voiceAt += block;
    }
    const now = performance.now() / 1000;
    if (this.binary.length && (now - this.lastRegroup >= REGROUP_EVERY || this.ended || this.askRegroup)) {
      this.askRegroup = false;
      this.lastRegroup = now;
      this.regroupOnce();
    }
    if (this.ended && !this.done) this.done = true;
  }

  async speakerWindow(c) {
    const crop = this.x.view(c * S.STEP, c * S.STEP + S.WINDOW).slice();
    const p = await S.prepare(crop, this.models, null);
    const binary = p ? p.binary : new Uint8Array(S.NUM_FRAMES * S.LOCAL);
    const emb = p ? p.embeddings : nan256();
    this.placeWindow(c, binary, emb);
  }

  // Store one window and label its newest second by nearest speaker.
  placeWindow(c, binary, emb) {
    this.binary.push(binary); this.emb.push(emb);
    const first = S.closestFrame(c * S.STEP / RATE + 0.5 * S.FRAME_DUR);
    const stamp = (f) => S.FRAME_START + (first + f) * S.FRAME_STEP + S.FRAME_DUR / 2;
    const lo = c === 0 ? 0 : (c * S.STEP + S.WINDOW - S.STEP) / RATE, hi = (c * S.STEP + S.WINDOW) / RATE;
    for (let k = 0; k < S.LOCAL; k++) {
      const e = emb.subarray(k * S.DIM, (k + 1) * S.DIM);
      let any = false;
      for (let f = 0; f < S.NUM_FRAMES; f++) if (binary[f * S.LOCAL + k]) { any = true; break; }
      if (!any || e.some(Number.isNaN)) continue;
      const pid = this.nearest(e);
      let run = -1;
      for (let f = 0; f <= S.NUM_FRAMES; f++) {
        const on = f < S.NUM_FRAMES && binary[f * S.LOCAL + k] && stamp(f) >= lo && stamp(f) < hi;
        if (on && run < 0) run = f;
        if (!on && run >= 0) { this.online.push([stamp(run), Math.min(stamp(f - 1) + S.FRAME_STEP, hi), pid]); run = -1; }
      }
    }
  }

  nearest(e0) {
    const len = norm(e0) + 1e-12, e = Float64Array.from(e0, v => v / len);
    let pid = null, dist = Infinity;
    for (const [id, [sum, n]] of this.cent) {
      let d = 0; for (let i = 0; i < e.length; i++) { const x = sum[i] / n - e[i]; d += x * x; }
      d = Math.sqrt(d);
      if (d < dist) { dist = d; pid = id; }
    }
    const full = this.numSpeakers !== null && this.cent.size >= this.numSpeakers;
    if (pid === null || (dist > S.THRESHOLD && !full)) { pid = this.nextPid++; this.cent.set(pid, [new Float64Array(e.length), 0]); }
    const slot = this.cent.get(pid);
    for (let i = 0; i < e.length; i++) slot[0][i] += e[i];
    slot[1] += 1;
    return pid;
  }

  levels() {
    const full = Math.floor(this.n / LEVEL);
    this.tx.forEach((t, i) => {
      const have = this.lev[i].n;
      if (full > have) {
        const x = Float32Array.from(t.view(have * LEVEL, full * LEVEL), v => v / 32768);
        this.lev[i].push(src.levels(x, RATE));
      }
    });
    return this.lev.map(l => l.view());
  }

  // The full grouping on everything so far.
  regroupOnce() {
    const chunks = this.binary.length;
    const binary = new Uint8Array(chunks * S.NUM_FRAMES * S.LOCAL), emb = new Float32Array(chunks * S.LOCAL * S.DIM);
    this.binary.forEach((b, c) => binary.set(b, c * b.length));
    this.emb.forEach((e, c) => emb.set(e, c * e.length));
    const shown = this.labelled(), until = ((chunks - 1) * S.STEP + S.WINDOW) / RATE;
    const t0 = performance.now();
    const sums = new Float32Array(chunks * S.NUM_FRAMES);
    for (let i = 0; i < sums.length; i++) sums[i] = binary[i * 3] + binary[i * 3 + 1] + binary[i * 3 + 2];
    const count = Int16Array.from(S.aggregate(sums, chunks, 1, false), v => S.rint(v));
    let turns = count.some(v => v > 0) ? E.assign({ binary, count, embeddings: emb, chunks }, this.numSpeakers) : [];
    const labelCent = turns.length ? this.centroids(binary, emb, chunks, turns) : new Map();
    let homes = new Map(), own = new Map(), thr = null;
    if (this.tracks && turns.length) {
      const lev = this.levels();
      thr = lev.map(v => src.threshold(v));
      const act = src.activity(lev, thr);
      [turns, homes] = src.refine(turns, act, until);
      const n = Math.min(act.frames, Math.trunc(until / src.HOP));
      [, own] = src.homes(turns, { frames: n, inputs: act.inputs, data: act.data.subarray(0, n * act.inputs) });
    }
    const took = (performance.now() - t0) / 1000;

    // Keep ids stable: match new groups to those on screen by shared speaking time.
    const newIds = [...new Set(turns.map(t => t[2]))].sort((a, b) => a - b);
    const oldIds = [...new Set(shown.map(t => t[2]))].sort((a, b) => a - b);
    const mapping = new Map();
    if (newIds.length && oldIds.length) {
      const joined = E.join(turns);
      const spansNew = newIds.map(k => joined.filter(t => t[2] === k).map(([a, b]) => [a, b]));
      const spansOld = oldIds.map(k => shown.filter(t => t[2] === k && t[0] < until).map(([a, b]) => [a, Math.min(b, until)]));
      const score = spansNew.map(sn => spansOld.map(so => overlapOf(sn, so)));
      for (const [i, j] of bestPairs(score)) if (score[i][j] > 0) mapping.set(newIds[i], oldIds[j]);
    }
    for (const k of newIds) if (!mapping.has(k)) mapping.set(k, this.nextPid++);
    this.grouped = turns.map(([a, b, k]) => [a, b, mapping.get(k)]);
    this.groupedUntil = until;
    this.cent = new Map([...labelCent].filter(([k]) => mapping.has(k)).map(([k, v]) => [mapping.get(k), v]));
    this.homes = new Map([...homes].filter(([k]) => mapping.has(k)).map(([k, h]) => [mapping.get(k), h]));
    this.own = new Map([...own].filter(([, k]) => mapping.has(k)).map(([i, k]) => [i, mapping.get(k)]));
    this.thr = thr;
    this.online = this.online.filter(t => t[1] > until);
    this.regroup = { at: Date.now() / 1000, took: Math.round(took * 1000) / 1000, until };
    this.confirm();
  }

  centroids(binary, emb, chunks, grouped) {
    const firsts = Array.from({ length: chunks }, (_, c) => S.closestFrame(c * S.STEP / RATE + 0.5 * S.FRAME_DUR));
    const label = new Int32Array(firsts[chunks - 1] + S.NUM_FRAMES).fill(-1), offset = S.FRAME_START + S.FRAME_DUR / 2;
    for (const [a, b, k] of grouped) {
      const lo = Math.max(0, Math.ceil((a - offset) / S.FRAME_STEP)), hi = Math.min(label.length, Math.ceil((b - offset) / S.FRAME_STEP));
      label.fill(k, lo, Math.max(lo, hi));
    }
    const cent = new Map();
    for (let c = 0; c < chunks; c++) for (let k = 0; k < S.LOCAL; k++) {
      const e = emb.subarray((c * S.LOCAL + k) * S.DIM, (c * S.LOCAL + k + 1) * S.DIM);
      if (e.some(Number.isNaN)) continue;
      const hits = new Map();
      for (let f = 0; f < S.NUM_FRAMES; f++) {
        if (!binary[(c * S.NUM_FRAMES + f) * S.LOCAL + k]) continue;
        const who = label[firsts[c] + f]; if (who >= 0) hits.set(who, (hits.get(who) || 0) + 1);
      }
      if (!hits.size) continue;
      let best = null, most = -1;
      for (const [id, h] of [...hits].sort((a, b) => a[0] - b[0])) if (h > most) { most = h; best = id; }
      const len = norm(e) + 1e-12;
      if (!cent.has(best)) cent.set(best, [new Float64Array(S.DIM), 0]);
      const slot = cent.get(best);
      for (let i = 0; i < S.DIM; i++) slot[0][i] += e[i] / len;
      slot[1] += 1;
    }
    return cent;
  }

  // A voice becomes a speaker once the grouping has kept it apart twice
  // running, with CONFIRM_TALK of speech and one turn of MIN_TURN; the first
  // speaker, and anyone on an input of their own, need it once.
  confirm() {
    const talk = new Map(), longest = new Map();
    for (const [a, b, k] of E.join(this.grouped)) { talk.set(k, (talk.get(k) || 0) + b - a); longest.set(k, Math.max(longest.get(k) || 0, b - a)); }
    const present = [...talk.keys()];
    this.seen = new Map(present.map(k => [k, (this.seen.get(k) || 0) + 1]));
    let anyone = present.some(k => this.confirmed.has(k));
    const own = new Set(this.own.values());
    const firstAt = (k) => Math.min(...this.grouped.filter(t => t[2] === k).map(t => t[0]));
    for (const k of present.sort((a, b) => firstAt(a) - firstAt(b))) {
      if (this.confirmed.has(k) || talk.get(k) < CONFIRM_TALK || longest.get(k) < S.MIN_TURN) continue;
      if (this.seen.get(k) >= 2 || !anyone || own.has(k)) { this.confirmed.set(k, this.confirmed.size); anyone = true; }
    }
  }

  async voiceBlock(at, block) {
    const before = Math.round(VOICE_BEFORE * RATE), after = Math.round(VOICE_AFTER * RATE);
    const a = Math.max(0, at - before), b = Math.min(this.n, at + block + after);
    const pieces = this.tracks ? this.tx.map(t => t.view(a, b).slice()) : [V.toPcm16(this.x.view(a, b))];
    const got = pieces.map((pcm) => {
      const frame = this.smile.process(pcm, RATE);
      const { starts, ends } = V.frameTimes(frame, pcm.length);
      const raw = V.rawSeries(frame), keep = [], centre = [];
      for (let i = 0; i < frame.frames; i++) {
        const c = a / RATE + (starts[i] + ends[i]) / 2;
        if (c >= at / RATE && c < (at + block) / RATE) { keep.push(i); centre.push(c); }
      }
      return { centre, vals: Object.fromEntries(V.KEYS.map(k => [k, keep.map(i => raw[k][i] ?? NaN)])) };
    });
    const m = Math.min(...got.map(g => g.centre.length)), G = got.length;
    const t = new Float64Array(m * G), s = new Int8Array(m * G), prim = new Uint8Array(m * G);
    const vals = Object.fromEntries(V.KEYS.map(k => [k, new Float64Array(m * G)]));
    for (let i = 0; i < m; i++) {
      let loudest = 0, lv = -Infinity;
      for (let g = 0; g < G; g++) { const l = Number.isNaN(got[g].vals.loudness[i]) ? -1 : got[g].vals.loudness[i]; if (l > lv) { lv = l; loudest = g; } }
      for (let g = 0; g < G; g++) {
        const j = i * G + g;
        t[j] = got[0].centre[i]; s[j] = g; prim[j] = g === loudest ? 1 : 0;
        for (const k of V.KEYS) vals[k][j] = got[g].vals[k][i];
      }
    }
    this.vt.push(t); this.vsrc.push(s); this.vprim.push(prim);
    for (const k of V.KEYS) this.vraw[k].push(vals[k]);
    this.voiceUntil = Math.min(this.n, at + block) / RATE;
  }

  // --- views ----------------------------------------------------------------------

  // Every turn with its id, confirmed or not: the latest grouping, then the
  // newest speech, straight from their own input for anyone on one.
  labelled() {
    const since = this.groupedUntil, own = new Set(this.own.values());
    const tail = this.online.filter(t => t[1] > since && !own.has(t[2])).map(([a, b, k]) => [Math.max(a, since), b, k]);
    if (this.own.size && this.thr) {
      const lev = this.levels(), lo = Math.trunc(since / src.HOP);
      for (const [i, k] of this.own) {
        const act = Uint8Array.from(lev[i].subarray(lo), v => (v > this.thr[i] ? 1 : 0));
        for (const [a, b] of runs(act, lo * src.HOP)) tail.push([a, b, k]);
      }
    }
    return E.join([...this.grouped, ...tail]);
  }

  // (turns of confirmed speakers, spans of speech not yet put to anyone)
  display() {
    const turns = [], unsureT = [];
    for (const t of this.labelled()) (this.confirmed.has(t[2]) ? turns : unsureT).push(t);
    let unsure = E.join(unsureT.map(([a, b]) => [a, b, 0]), 0.0).map(([a, b]) => [a, b]);
    const own = new Set(this.own.values());
    const sure = turns.filter(t => own.has(t[2])).map(([a, b]) => [a, b]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    if (sure.length && unsure.length) {
      const left = [];
      for (let [a, b] of unsure) {
        for (const [c2, d] of sure) {
          if (d <= a || c2 >= b) continue;
          if (c2 > a) left.push([a, c2]);
          a = Math.max(a, d);
          if (a >= b) break;
        }
        if (b > a) left.push([a, b]);
      }
      unsure = left.filter(([a, b]) => b - a > 0.05);
    }
    return { turns, unsure };
  }

  state(extra = {}) {
    const { turns, unsure } = this.display(), duration = this.n / RATE;
    let level = null;
    if (this.n) { const tail = this.x.view(Math.max(0, this.n - RATE / 10)); let s = 0; for (const v of tail) s += v * v; level = Math.round(10 * Math.log10(s / tail.length + 1e-12) * 10) / 10; }
    const doneTo = this.binary.length ? ((this.binary.length - 1) * S.STEP + S.WINDOW) / RATE : 0;
    const talk = new Map(); for (const [a, b, k] of turns) talk.set(k, (talk.get(k) || 0) + b - a);
    const order = [...talk.keys()].sort((a, b) => this.confirmed.get(a) - this.confirmed.get(b));
    const number = new Map(order.map((k, i) => [k, i + 1]));
    const live = extra.status === 'live';
    return {
      ...extra, duration, level,
      speakers_behind: live ? Math.max(0, duration - doneTo) : 0,
      voice_behind: live ? Math.max(0, duration - this.voiceUntil) : 0,
      regroup: this.regroup, grouped_until: this.groupedUntil, num_speakers: this.numSpeakers,
      names: Object.fromEntries(Object.entries(this.speakerNames).map(([k, v]) => [String(k), v])),
      speakers: order.map(k => ({ id: k, talk: talk.get(k), n: number.get(k), input: this.homes.get(k) ?? null,
        track: this.homes.has(k) && this.homes.get(k) < this.names.length ? this.names[this.homes.get(k)] : null })),
      turns: turns.map(([a, b, k]) => [r3(a), r3(b), k]),
      unsure: unsure.map(([a, b]) => [r3(a), r3(b)]),
      inputs: this.tracks ? this.names : [],
    };
  }

  // Voice frames from index `start`, for the page to keep and draw.
  frames(start, limit = 60000) {
    const total = this.vt.n; start = Math.max(0, Math.min(start | 0, total));
    const end = Math.min(total, start + limit), f0 = this.vraw.f0.view(start, end);
    const out = { from: start, next: end, total, t: Array.from(this.vt.view(start, end), v => r3(v)) };
    if (this.tracks) { out.src = Array.from(this.vsrc.view(start, end)); out.prim = Array.from(this.vprim.view(start, end)); }
    for (const k of V.KEYS) {
      const v = this.vraw[k].view(start, end), digits = k === 'loudness' ? 4 : 1;
      out[k] = Array.from(v, (x, i) => (Number.isNaN(x) || (V.FORMANTS.includes(k) && Number.isNaN(f0[i])) ? null : round(x, digits)));
    }
    return out;
  }

  voiceFrames() {
    const n = this.vt.n;
    return { t: this.vt.view().slice(), raw: Object.fromEntries(V.KEYS.map(k => [k, this.vraw[k].view().slice()])),
      src: this.tracks ? { input: this.vsrc.view().slice(), prim: this.vprim.view().slice() } : null, n };
  }

  voiceFor(spk, points, gate) {
    const duration = Math.max(this.n / RATE, 1e-3), { turns } = this.display();
    const spans = spk === 'all' ? E.join(turns.map(([a, b]) => [a, b, 0]), 0).map(([a, b]) => [a, b])
                                : turns.filter(t => t[2] === spk).map(([a, b]) => [a, b]);
    const { t, raw } = E.framesOf(this.voiceFrames(), spk === 'all' ? null : this.homes.get(spk) ?? null);
    return E.measure(t, raw, spans, gate, (v) => v, duration, points);
  }

  anchors() {
    const { turns } = this.display(), out = {};
    for (const [pid, name] of Object.entries(this.speakerNames)) if (name) out[name] = turns.filter(t => t[2] === +pid).map(([a, b]) => [a, b]);
    return out;
  }

  // The voiceprints in prepare()'s layout, and the voice frames moved onto
  // the saved file's timeline by `offset` (the encoder's lead-in).
  analysisToSave(offset) {
    if (!this.binary.length) return null;
    const chunks = this.binary.length;
    const binary = new Uint8Array(chunks * S.NUM_FRAMES * S.LOCAL), embeddings = new Float32Array(chunks * S.LOCAL * S.DIM);
    this.binary.forEach((b, c) => binary.set(b, c * b.length));
    this.emb.forEach((e, c) => embeddings.set(e, c * e.length));
    const sums = new Float32Array(chunks * S.NUM_FRAMES);
    for (let i = 0; i < sums.length; i++) sums[i] = binary[i * 3] + binary[i * 3 + 1] + binary[i * 3 + 2];
    const count = Int16Array.from(S.aggregate(sums, chunks, 1, false), v => S.rint(v));
    const vf = this.voiceFrames();
    vf.t = vf.t.map(v => v + offset);
    // level: the mix's loudness, so the library can tell background voices apart
    return { prep: { binary, count, embeddings, chunks, level: S.levels(this.x.view()) }, frames: vf };
  }
}

function overlapOf(a, b) {
  let i = 0, j = 0, total = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) total += hi - lo;
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return total;
}
// sources._runs: runs of 1s as [start, end] s, joined across JOIN, without bursts under MIN_RUN.
function runs(mask, t0) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i];
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      const s = t0 + start * src.HOP, e = t0 + i * src.HOP;
      if (out.length && s - out[out.length - 1][1] <= src.JOIN) out[out.length - 1][1] = e; else out.push([s, e]);
      start = -1;
    }
  }
  return out.filter(([s, e]) => e - s >= src.MIN_RUN);
}
const r3 = (v) => Math.round(v * 1000) / 1000;
const round = (v, d) => { const f = 10 ** d; return Math.round(v * f) / f; };
