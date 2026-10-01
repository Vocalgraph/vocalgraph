// What only the page can do for the backend worker: list and open
// microphones (and, in Chromium browsers, the computer's own sound), and tell
// which helper download fits this computer. A
// microphone's sound goes from an AudioWorklet straight to the worker
// (capture-worklet.js); the page only wires it up.
const mics = new Map();          // id -> { ctx, stream, node }

async function listMics() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  // Names are only given once the site may use a microphone: ask once.
  if (devices.some(d => d.kind === 'audioinput' && !d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch { /* refused: list them without names */ }
  }
  const list = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: 'mic:' + d.deviceId, name: d.label || `Microphone ${i + 1}`, kind: 'mic' }));
  // Listed with the programs: all of the computer's sound, without the helper.
  if (systemAudio()) list.push({ id: SYSTEM, name: "All of this computer's sound (no helper needed)", kind: 'app' });
  return list;
}

// The computer's own sound, through the browser's screen sharing with "share
// system audio". Only Chromium browsers (Chrome, Edge...) give sound that
// way, and only they have userAgentData, so that tells; Firefox and Safari
// share no sound from a screen.
const SYSTEM = 'system:';
const systemAudio = () => !!(navigator.mediaDevices?.getDisplayMedia &&
  navigator.userAgentData?.brands?.some(b => /Chromium/.test(b.brand)));

async function systemStream() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,                      // a screen or tab is shared with its sound, never sound alone
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
    systemAudio: 'include', monitorTypeSurfaces: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude',
  });
  stream.getVideoTracks().forEach(t => t.stop());      // only the sound is kept
  if (!stream.getAudioTracks().length) {
    throw new Error('No sound was shared. Start again, choose "Entire screen" and tick "Also share system audio" ' +
      '(or choose a tab and keep "Also share tab audio" ticked).');
  }
  return stream;
}

// Opens a microphone (or the computer's sound) and connects it to the worker through `port`.
async function openMic({ id, deviceId }, port) {
  const stream = id === SYSTEM ? await systemStream() : await navigator.mediaDevices.getUserMedia({ audio: {
    deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
    // The voice as it is: no cleaning up, which would change what's measured.
    echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } } });
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(new URL('capture-worklet.js', import.meta.url));
  const src = ctx.createMediaStreamSource(stream);
  const channels = Math.min(2, stream.getAudioTracks()[0]?.getSettings().channelCount || 1);
  const node = new AudioWorkletNode(ctx, 'vocalgraph-capture', { processorOptions: { id, channels }, numberOfOutputs: 0 });
  src.connect(node);
  if (ctx.state === 'suspended') await ctx.resume();
  node.port.postMessage({ port }, [port]);
  mics.set(id, { ctx, stream, node });
  // The audio clock against the computer's: the worker places samples by it.
  const ts = ctx.getOutputTimestamp();
  const clock = ts.performanceTime
    ? { contextTime: ts.contextTime, epoch: performance.timeOrigin + ts.performanceTime }
    : { contextTime: ctx.currentTime, epoch: performance.timeOrigin + performance.now() };
  return { channels, clock, name: stream.getAudioTracks()[0]?.label };
}

function closeMic(id) {
  const m = mics.get(id); if (!m) return;
  m.node.port.postMessage({ stop: true });
  m.stream.getTracks().forEach(t => t.stop());
  m.ctx.close();
  mics.delete(id);
}

// Which helper download fits this computer: {os: 'windows' | 'mac' | null,
// chip: 'apple-silicon' | 'intel' | null}. Chromium browsers say outright
// (client hints). Safari and Firefox call every Mac Intel, so there the
// graphics card's name decides when it's given (Apple's own only come with
// Apple Silicon), and otherwise Apple Silicon, which every Mac since 2020 has.
// The page also offers the other Mac download, in case this is wrong.
async function system() {
  const ua = navigator.userAgent, hints = navigator.userAgentData;
  const platform = hints?.platform || '';
  let os = null, chip = null;
  if (platform === 'Windows' || (!platform && /Windows NT/.test(ua))) os = 'windows';
  // An iPad asks for the Mac site too, but has a touch screen.
  else if (platform === 'macOS' || (!platform && /Macintosh/.test(ua) && navigator.maxTouchPoints < 2)) os = 'mac';
  if (os !== 'mac') return { os, chip };
  try {
    const h = await hints?.getHighEntropyValues(['architecture']);
    if (h?.architecture) chip = h.architecture === 'arm' ? 'apple-silicon' : 'intel';
  } catch { /* not given */ }
  if (!chip) {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const name = String(gl?.getParameter(gl.RENDERER) || '');
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      if (/Apple M\d/.test(name)) chip = 'apple-silicon';
      else if (/Intel|AMD|Radeon|NVIDIA/i.test(name)) chip = 'intel';
    } catch { /* no WebGL */ }
  }
  return { os, chip: chip || 'apple-silicon' };
}

// Requests from the worker: {kind: 'page', op, args, call} -> {kind: 'page-reply', call, result | error}.
export function serve(worker) {
  worker.addEventListener('message', async (ev) => {
    const m = ev.data;
    if (m?.kind !== 'page') return;
    try {
      let result;
      if (m.op === 'mics') result = await listMics();
      else if (m.op === 'openMic') result = await openMic(m.args, ev.ports[0]);
      else if (m.op === 'closeMic') result = closeMic(m.args.id);
      else if (m.op === 'system') result = await system();
      worker.postMessage({ kind: 'page-reply', call: m.call, result });
    } catch (e) {
      worker.postMessage({ kind: 'page-reply', call: m.call, error: e.message || String(e) });
    }
  });
  addEventListener('pagehide', () => { for (const id of [...mics.keys()]) closeMic(id); });
}
