// What the backend asks of FFmpeg: the same commands as the desktop app's
// core.py (decode, audio_streams, render) and live.py (the recording of a
// session with several inputs), run by the WebAssembly build of FFmpeg 7.1.
import { loadFFmpeg } from '../ffmpeg/ffmpeg.js';

const RATE = 16000;
const BATCH = 100;                              // segments per filter graph, as core.py
const CODECS = { mp3: ['-c:a', 'libmp3lame'], m4a: ['-c:a', 'aac', '-movflags', '+faststart'] };
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac', mka: 'audio/x-matroska' };

let ffp = null;
const ff = () => (ffp ??= loadFFmpeg());
const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
const inName = (name) => 'in_' + String(name || 'input').split(/[\\/]/).pop().replace(/[^\w.-]/g, '_');
const fail = (what, r) => { throw new Error(`${what}: ${(r.stderr || '').trim().slice(-400)}`); };

// core.decode: audio stream `stream` as 16 kHz mono float32 (the first
// `duration` seconds, if given).
export async function decode(blob, name, stream = 0, duration = null) {
  return (await ff()).decode16k(await bytes(blob), name, stream, duration);
}

// core.audio_streams: each audio stream's title ('' where it has none).
export async function streams(blob, name) {
  const n = inName(name);
  const r = await (await ff()).run(['-hide_banner', '-i', n], { inputs: { [n]: await bytes(blob) } });
  const out = [];
  for (const block of r.stderr.split(/^\s*Stream #/m).slice(1)) {
    const [head, ...rest] = block.split('\n');
    if (!head.includes(': Audio:')) continue;
    const m = /^\s+(?:title|handler_name)\s*:\s*(.+)$/m.exec(rest.join('\n'));
    const t = m ? m[1].trim() : '';
    out.push(t === 'SoundHandler' || t === 'Core Media Audio' ? '' : t);
  }
  return out;
}

// core.render: cut `segs` (source seconds) from audio stream `stream` and join
// them into an mp3 or m4a. Returns {blob, duration}.
export async function render(blob, name, segs, { fmt = 'mp3', stream = 0, bitrate = '192k', progress = null } = {}) {
  const f = await ff(), n = inName(name), data = await bytes(blob), parts = {};
  const batches = [];
  for (let i = 0; i < segs.length; i += BATCH) batches.push(segs.slice(i, i + BATCH));
  for (const [bi, batch] of batches.entries()) {
    progress?.(bi / Math.max(1, batches.length));
    const chain = batch.map(([a, b], j) => `[0:a:${stream}]atrim=start=${a.toFixed(6)}:end=${b.toFixed(6)},asetpts=N/SR/TB[s${j}]`);
    chain.push(`${batch.map((_, j) => `[s${j}]`).join('')}concat=n=${batch.length}:v=0:a=1[out]`);
    const part = `part${bi}.flac`;
    const r = await f.run(['-v', 'error', '-y', '-i', n, '-filter_complex', chain.join(';'), '-map', '[out]', part],
                          { inputs: { [n]: data }, outputs: [part] });
    if (r.code !== 0 || !r.files[part]) fail('Cutting failed', r);
    parts[part] = r.files[part];
  }
  // Joined with the concat *filter* (the concat demuxer drops audio between FLAC parts).
  const names = Object.keys(parts), out = `out.${fmt}`;
  const r = await f.run(['-v', 'error', '-y', ...names.flatMap(p => ['-i', p]), '-filter_complex',
    `${names.map((_, i) => `[${i}:a]`).join('')}concat=n=${names.length}:v=0:a=1[out]`, '-map', '[out]',
    ...CODECS[fmt], '-b:a', bitrate, out], { inputs: parts, outputs: [out] });
  if (r.code !== 0 || !r.files[out]) fail('Encoding failed', r);
  progress?.(1);
  const result = new Blob([r.files[out]], { type: MIME[fmt] });
  return { blob: result, duration: (await decode(result, out)).length / RATE };
}

// The first `seconds` of a recording, every audio stream, as they are (a replay's recording).
export async function cut(blob, name, seconds) {
  const n = inName(name), ext = (n.match(/\.[^.]+$/) || ['.m4a'])[0], out = 'out' + ext;
  const r = await (await ff()).run(['-v', 'error', '-y', '-i', n, '-map', '0:a', '-t', seconds.toFixed(3), '-c', 'copy', out],
                                   { inputs: { [n]: await bytes(blob) }, outputs: [out] });
  if (r.code !== 0 || !r.files[out]) fail('Saving the replay failed', r);
  return new Blob([r.files[out]], { type: MIME[ext.slice(1)] || 'application/octet-stream' });
}

// A live session's recording from its inputs (16-bit PCM at `rate`, each
// [{data, channels, name}]): as live.py makes it, the inputs summed into a mix
// (amix normalize=0) as the first track and each input as a track of its own,
// named. M4A (AAC 192k) or FLAC; several tracks in FLAC go in Matroska.
export async function encodeLive(tracks, rate, fmt = 'm4a', comment = '') {
  const inputs = {}, args = ['-v', 'error', '-y'];
  tracks.forEach((t, i) => { inputs[`in${i}.raw`] = t.data; args.push('-f', 's16le', '-ar', String(rate), '-ac', String(t.channels), '-i', `in${i}.raw`); });
  const n = tracks.length, ext = fmt === 'flac' ? (n > 1 ? 'mka' : 'flac') : 'm4a', out = `out.${ext}`;
  const codec = [...(fmt === 'flac' ? ['-c:a', 'flac'] : ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']),
                 ...(comment ? ['-metadata', `comment=${comment}`] : [])];
  if (n === 1) args.push('-map', '0:a:0', ...codec, out);
  else {
    const mix = `${tracks.map((_, i) => `[${i}:a:0]`).join('')}amix=inputs=${n}:duration=longest:normalize=0[rec]`;
    const titles = [];
    ['Mix', ...tracks.map((t, i) => t.name || `Input ${i + 1}`)].forEach((name, i) =>
      titles.push(`-metadata:s:a:${i}`, `title=${name}`, `-metadata:s:a:${i}`, `handler_name=${name}`));
    args.push('-filter_complex', mix, '-map', '[rec]', ...tracks.flatMap((_, i) => ['-map', `${i}:a:0`]), ...codec, ...titles, out);
  }
  const r = await (await ff()).run(args, { inputs, outputs: [out] });
  if (r.code !== 0 || !r.files[out]) fail('Saving the recording failed', r);
  return { blob: new Blob([r.files[out]], { type: MIME[ext] }), ext: '.' + ext };
}
