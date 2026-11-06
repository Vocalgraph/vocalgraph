// Live's analysis, in workers of their own (analyser.js makes two): one for
// the voice (openSMILE), one for the speakers (the speaker models and the
// grouping). Each runs a session (session.js) with only its role, so the
// voice chart keeps up while the speaker models work, and neither holds up
// the backend worker, which takes in the sound and writes the recording.
import { Session } from './session.js';
import { loadModels } from './models.js';
import { loadSmile } from '../smile/smile.js';
import * as E from '../engine/index.js';

let role = null, tool = null, session = null;
const need = () => { if (!session) throw new Error('No live session.'); return session; };
const pause = () => new Promise(r => setTimeout(r, 50));

const ops = {
  // First message: which role, and so what to load (it starts at once; the
  // backend hears when it's ready, or why it failed).
  init({ as }) {
    role = as;
    tool = role === 'voice' ? loadSmile() : loadModels();
    tool.then(() => self.postMessage({ kind: 'loaded' }),
              (e) => self.postMessage({ kind: 'failed', error: e.message || String(e) }));
  },
  start({ tracks, names, numSpeakers }) {
    const s = session = new Session({ tracks, names, voice: role === 'voice', speakers: role === 'speakers' });
    s.numSpeakers = numSpeakers ?? null;
    tool.then((t) => (role === 'voice' ? s.useSmile(t) : s.useModels(t)), () => {});
  },
  close() { session = null; },
  // speakers: the whole state; voice: its part of it.
  state({ extra }) {
    const s = need();
    if (role === 'voice') {
      const out = s.state({ status: extra.status });
      return { voice_behind: out.voice_behind, level: out.level, preparing: s.preparing && extra.status === 'live', error: s.error || null };
    }
    return s.state({ ...extra, error: extra.error || s.error || null });
  },
  frames({ from }) { return need().frames(from); },
  spans({ spk }) { return need().speakerSpans(spk); },               // speakers
  voice({ spk, points, gate, spans }) { return need().voiceOver(spk, points, gate, spans); },   // voice
  speakers({ n }) { const s = need(); s.numSpeakers = n; s.askRegroup = true; s.kick(); },
  names({ names }) { const s = need(); for (const [k, v] of Object.entries(names)) s.speakerNames[k] = v; return s.anchors(); },
  end() { need().end(); },
  // Stopped: wait for what this role loads (if it stopped before that, it's
  // all analysed now), the last steps, and (speakers) a final grouping.
  async settle() {
    const s = need();
    await tool.catch(() => {});
    do await pause(); while (s.busy);
    if (role === 'speakers') { s.askRegroup = true; s.kick(); do await pause(); while (s.busy); }
    return { anchors: s.anchors(), numSpeakers: s.numSpeakers };
  },
  // To file with the saved recording, lined up with it. speakers: the offset
  // (from `saved`, its first seconds at 16 kHz) and the voiceprints; voice:
  // the voice frames moved by that offset.
  save({ saved }) {
    const s = need(), offset = E.offsetOf(saved, s.x.view());
    return { offset, prep: s.prepToSave() };
  },
  frames_to_save({ offset }) { return need().framesToSave(offset); },
};

self.addEventListener('message', async (ev) => {
  const m = ev.data;
  if (m?.kind === 'feed') { session?.feed(m.mix, m.inputs); return; }
  if (m?.kind !== 'call') return;
  try { self.postMessage({ kind: 'reply', call: m.call, result: await ops[m.op](m.args || {}) }); }
  catch (e) { self.postMessage({ kind: 'reply', call: m.call, error: e.message || String(e) }); }
});
