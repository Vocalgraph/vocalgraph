// Live's analysis in a worker of its own: the session (session.js), with
// openSMILE and the speaker models. The backend worker, which takes in the
// sound and writes it to the recording, only hands blocks on to this one, so
// a long step here (a voiceprint, a grouping of a long session) never holds
// the sound up. analyser.js is the backend's side.
import { Session } from './session.js';
import { loadModels } from './models.js';
import { loadSmile } from '../smile/smile.js';
import * as E from '../engine/index.js';

// Loaded as soon as the worker starts (when the Live page lists the inputs);
// each tells the backend when it's ready or why it failed.
const smile = loadSmile(), models = loadModels();
for (const [what, p] of [['smile', smile], ['models', models]]) {
  p.then(() => self.postMessage({ kind: 'loaded', what }),
         (e) => self.postMessage({ kind: 'failed', what, error: e.message || String(e) }));
}
const both = Promise.allSettled([smile, models]);

let session = null;
const need = () => { if (!session) throw new Error('No live session.'); return session; };
const pause = () => new Promise(r => setTimeout(r, 50));

const ops = {
  start({ tracks, names, numSpeakers }) {
    const s = session = new Session({ tracks, names });
    s.numSpeakers = numSpeakers ?? null;
    smile.then((m) => s.useSmile(m), () => {});
    models.then((m) => s.useModels(m), () => {});
  },
  close() { session = null; },
  state({ extra }) {
    const s = need(), out = s.state({ ...extra, error: extra.error || s.error || null });
    out.preparing = s.preparing && extra.status === 'live';
    return out;
  },
  frames({ from }) { return need().frames(from); },
  voice({ spk, points, gate }) { return need().voiceFor(spk, points, gate); },
  speakers({ n }) { const s = need(); s.numSpeakers = n; s.askRegroup = true; s.kick(); },
  names({ names }) { const s = need(); for (const [k, v] of Object.entries(names)) s.speakerNames[k] = v; return s.anchors(); },
  end() { need().end(); },
  // Stopped: wait for the models (if it stopped before they loaded, it's all
  // analysed now), the last windows and voice blocks, and a final grouping.
  async settle() {
    const s = need();
    await both;
    do await pause(); while (s.busy);
    s.askRegroup = true; s.kick();
    do await pause(); while (s.busy);
    return { anchors: s.anchors(), numSpeakers: s.numSpeakers };
  },
  // The analysis to file with the saved recording, lined up with it (`saved`:
  // its first seconds, 16 kHz).
  save({ saved }) {
    const s = need(), offset = E.offsetOf(saved, s.x.view());
    return { offset, analysis: s.analysisToSave(offset) };
  },
};

self.addEventListener('message', async (ev) => {
  const m = ev.data;
  if (m?.kind === 'feed') { session?.feed(m.mix, m.inputs); return; }
  if (m?.kind !== 'call') return;
  try { self.postMessage({ kind: 'reply', call: m.call, result: await ops[m.op](m.args || {}) }); }
  catch (e) { self.postMessage({ kind: 'reply', call: m.call, error: e.message || String(e) }); }
});
