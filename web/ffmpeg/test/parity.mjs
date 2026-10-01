// Parity test: the wasm FFmpeg against the desktop app's FFmpeg 7.1.
//
//   .venv\Scripts\python.exe web\ffmpeg\test\make_refs.py         (references)
//   node web/ffmpeg/test/parity.mjs
//   .venv\Scripts\python.exe web\ffmpeg\test\make_refs.py --check (playability)
//
// Reads the recordings named in REFS/meta.json (read only) and writes its own
// outputs and parity.json to REFS, which is outside the repository.

import { readFile, writeFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadFFmpeg } from '../ffmpeg.js';

// Outside the repository: they're made from personal recordings (make_refs.py).
const REFS = process.env.VG_FFMPEG_REFS ?? path.join(tmpdir(), 'vocalgraph-ffmpeg-refs');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RATE = 16000;

function compare(a, b) {
  const n = Math.min(a.length, b.length);
  const ua = new Uint32Array(a.buffer, a.byteOffset, n);
  const ub = new Uint32Array(b.buffer, b.byteOffset, n);
  let same = 0, maxAbs = 0, sumSq = 0, refSq = 0, maxAt = -1;
  for (let i = 0; i < n; i++) {
    if (ua[i] === ub[i]) { same++; refSq += b[i] * b[i]; continue; }
    const d = Math.abs(a[i] - b[i]);
    if (d > maxAbs) { maxAbs = d; maxAt = i; }
    sumSq += d * d;
    refSq += b[i] * b[i];
  }
  const rmsDiff = Math.sqrt(sumSq / Math.max(1, n));
  const rmsRef = Math.sqrt(refSq / Math.max(1, n));
  return {
    lenWasm: a.length, lenDesktop: b.length, sameLength: a.length === b.length,
    bitIdentical: n ? same / n : 0, maxAbsDiff: maxAbs, maxAt,
    rmsDiff, diffDbRelSignal: rmsDiff > 0 ? 20 * Math.log10(rmsDiff / rmsRef) : -Infinity,
  };
}

const f32 = (u8) => new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
const fmt = (r) => `len ${r.lenWasm}/${r.lenDesktop} ${r.sameLength ? 'same' : 'DIFFERENT'}, `
  + `bit-identical ${(100 * r.bitIdentical).toFixed(3)}%, max |diff| ${r.maxAbsDiff.toExponential(3)}, `
  + `rms diff ${r.rmsDiff.toExponential(3)} (${r.diffDbRelSignal.toFixed(1)} dB re signal)`;

const meta = JSON.parse(await readFile(path.join(REFS, 'meta.json'), 'utf8'));
const t0 = performance.now();
const ff = await loadFFmpeg();
const results = { loadMs: performance.now() - t0, decodes: [], cut: {}, encode: {} };
console.log(`loaded in ${results.loadMs.toFixed(0)} ms`);

// 1. decode parity
for (const d of meta.decodes) {
  const bytes = await readFile(d.path);
  const t = performance.now();
  const x = await ff.decode16k(bytes, path.basename(d.path), d.stream);
  const secs = (performance.now() - t) / 1000;
  const ref = f32(await readFile(path.join(REFS, `dec_${d.id}.f32`)));
  await writeFile(path.join(REFS, `wasm_dec_${d.id}.f32`), new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
  const r = { id: d.id, stream: d.stream, wasmSeconds: secs, desktopSeconds: d.desktop_seconds,
              speed: x.length / RATE / secs, ...compare(x, ref) };
  results.decodes.push(r);
  console.log(`decode ${d.id}: ${fmt(r)}; ${secs.toFixed(2)} s (${r.speed.toFixed(0)}x realtime)`);
}

// 2. cutting parity (core.render's two ffmpeg calls)
const src = await readFile(meta.cut.path);
const inName = 'input' + path.extname(meta.cut.path);
const partArgs = meta.cut.part_args.map((a) => (a === 'IN' ? inName : a));
let t = performance.now();
const part = await ff.run(partArgs, { inputs: { [inName]: src }, outputs: ['part0.flac'] });
const partSecs = (performance.now() - t) / 1000;
if (part.code !== 0) throw new Error('cut failed: ' + part.stderr);
const partFlac = part.files['part0.flac'];
await writeFile(path.join(REFS, 'wasm_cut_part.flac'), partFlac);

// FLAC is lossless: compare the parts at their own rate, sample for sample.
const native = async (bytes, name) => {
  const r = await ff.run(['-v', 'error', '-i', name, '-f', 'f32le', 'o.f32'],
                         { inputs: { [name]: bytes }, outputs: ['o.f32'] });
  if (r.code) throw new Error(r.stderr);
  return f32(r.files['o.f32']);
};
const deskPart = await readFile(path.join(REFS, 'cut_part_desktop.flac'));
results.cut.partNative = compare(await native(partFlac, 'p.flac'), await native(deskPart, 'p.flac'));
results.cut.part16k = compare(await ff.decode16k(partFlac, 'p.flac'),
                              f32(await readFile(path.join(REFS, 'cut_part_desktop.f32'))));
results.cut.partSeconds = partSecs;
console.log(`cut part (FLAC, native rate): ${fmt(results.cut.partNative)}`);
console.log(`cut part (16k decode):        ${fmt(results.cut.part16k)}`);

// The part's duration: its samples (all channels) / rate / channels.
const probe = (await ff.run(['-hide_banner', '-i', 'p.flac'], { inputs: { 'p.flac': partFlac } })).stderr;
const partRate = Number(probe.match(/(\d+) Hz/)[1]);
const partCh = /stereo/.test(probe) ? 2 : 1;
const partAudio = results.cut.partNative.lenWasm / partRate / partCh;
for (const kind of ['mp3', 'm4a']) {
  const args = ['-v', 'error', '-y', '-i', 'part0.flac', '-filter_complex',
                '[0:a]concat=n=1:v=0:a=1[out]', '-map', '[out]',
                ...meta.cut.codecs[kind], '-b:a', '192k', `out.${kind}`];
  t = performance.now();
  const r = await ff.run(args, { inputs: { 'part0.flac': partFlac }, outputs: [`out.${kind}`] });
  const secs = (performance.now() - t) / 1000;
  if (r.code !== 0) throw new Error(`${kind} encode failed: ${r.stderr}`);
  const out = r.files[`out.${kind}`];
  await writeFile(path.join(REFS, `wasm_cut.${kind}`), out);
  const desk = await readFile(path.join(REFS, `cut_desktop.${kind}`));
  // Same decoder (this one) for both files, so only the cut + encode differ.
  const cmp = compare(await ff.decode16k(out, `o.${kind}`), await ff.decode16k(desk, `d.${kind}`));
  results.cut[kind] = cmp;
  results.encode[kind] = { seconds: secs, audioSeconds: partAudio, speed: partAudio / secs,
                           bytes: out.length, desktopBytes: desk.length };
  console.log(`cut ${kind}: ${fmt(cmp)}`);
  console.log(`encode ${kind}: ${partAudio.toFixed(1)} s of audio in ${secs.toFixed(2)} s `
    + `= ${(partAudio / secs).toFixed(1)} s/s; ${out.length} bytes (desktop ${desk.length})`);
}

// 4. size
const wasm = await readFile(path.join(HERE, '..', 'ffmpeg.wasm'));
const mjs = await stat(path.join(HERE, '..', 'ffmpeg.mjs'));
results.size = { wasm: wasm.length, wasmGzip: gzipSync(wasm, { level: 9 }).length, mjs: mjs.size };
console.log(`ffmpeg.wasm ${wasm.length} bytes, gzip -9 ${results.size.wasmGzip}; ffmpeg.mjs ${mjs.size}`);

// 5. 20 commands in a row on the same instance: different kinds interleaved,
// each must give exactly what its first run gave (no state leaking between
// runs). Options that change global state (-y, -v, -t, -nostats, -threads)
// are mixed in on purpose.
const wavBytes = await readFile(meta.decodes[0].path);
const m4aBytes = await readFile(meta.decodes[3].path);
const bytesOf = (x) => new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
const hashOf = (u8) => { let h = 2166136261; for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 16777619); return (h >>> 0).toString(16) + ':' + u8.length; };
const kinds = [
  async () => hashOf(bytesOf(await ff.decode16k(wavBytes, 'a.wav', 0))),
  async () => hashOf(bytesOf(await ff.decode16k(m4aBytes, 'b.m4a', meta.decodes[3].stream, 20))),
  async () => {
    const r = await ff.run(['-y', '-nostats', '-v', 'warning', '-i', 'p.flac', '-ss', '2', '-t', '5', '-c:a', 'libmp3lame', '-b:a', '128k', 'o.mp3'],
                           { inputs: { 'p.flac': partFlac }, outputs: ['o.mp3'] });
    return r.code + ' ' + hashOf(r.files['o.mp3'] ?? new Uint8Array());
  },
  async () => {
    const r = await ff.run(['-hide_banner', '-threads', '1', '-i', 'p.flac', '-af', 'volume=0.5', '-c:a', 'aac', '-b:a', '96k', 'o.m4a'],
                           { inputs: { 'p.flac': partFlac }, outputs: ['o.m4a'] });
    return r.code + ' ' + hashOf(r.files['o.m4a'] ?? new Uint8Array());
  },
];
const first = [], runMs = [];
let repeatOk = true;
for (let i = 0; i < 20; i++) {
  const k = i % kinds.length;
  const t1 = performance.now();
  const h = await kinds[k]();
  runMs.push(performance.now() - t1);
  if (i < kinds.length) first[k] = h; else if (h !== first[k]) { repeatOk = false; console.log(`run ${i} (kind ${k}) differs: ${h} vs ${first[k]}`); }
}
results.repeat = { runs: 20, identical: repeatOk, kinds: first, ms: runMs };
console.log(`20 interleaved runs on one instance identical: ${repeatOk}; pool now ${JSON.stringify(ff.pool())}`);

// 6. Per-command overhead: a command with next to no work, many times.
const tiny = [];
for (let i = 0; i < 30; i++) {
  const t1 = performance.now();
  const r = await ff.run(['-v', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'x.raw', '-f', 'f32le', 'o.f32'],
                         { inputs: { 'x.raw': new Uint8Array(320) }, outputs: ['o.f32'] });
  if (r.code !== 0) throw new Error(r.stderr);
  tiny.push(performance.now() - t1);
}
tiny.sort((a, b) => a - b);
results.overheadMs = { median: tiny[15], min: tiny[0], max: tiny[29] };
console.log(`per-command overhead (10 ms of audio): median ${tiny[15].toFixed(1)} ms, min ${tiny[0].toFixed(1)}, max ${tiny[29].toFixed(1)}`);

await writeFile(path.join(REFS, 'parity.json'), JSON.stringify(results, null, 2));
process.exit(0);   // pool workers keep Node alive otherwise
