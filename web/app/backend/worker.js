// The browser backend: answers the pages' "/api/..." requests (passed on by
// the service worker through main.js), with the same routes and answers as
// vocalgraph/server.py.
import { parse, json, error, HttpError } from './http.js';
import * as jobs from './jobs.js';
import * as live from './live.js';

const routes = [
  ['GET', /^\/api\/library$/, () => jobs.library()],
  ['POST', /^\/api\/jobs$/, (r) => jobs.create(r)],
  ['GET', /^\/api\/jobs\/(\w+)$/, (r, id) => jobs.status(id)],
  ['DELETE', /^\/api\/jobs\/(\w+)$/, (r, id) => jobs.remove(id)],
  ['POST', /^\/api\/jobs\/(\w+)\/settings$/, (r, id) => jobs.settings(id, r)],
  ['POST', /^\/api\/jobs\/(\w+)\/names$/, (r, id) => jobs.names(id, r)],
  ['GET', /^\/api\/jobs\/(\w+)\/audio$/, (r, id) => jobs.audio(id, r)],
  ['GET', /^\/api\/jobs\/(\w+)\/audio\.m4a$/, (r, id) => jobs.audioM4a(id, r)],
  ['GET', /^\/api\/jobs\/(\w+)\/original$/, (r, id) => jobs.original(id)],
  ['GET', /^\/api\/jobs\/(\w+)\/segments$/, (r, id) => jobs.segments(id)],
  ['GET', /^\/api\/jobs\/(\w+)\/speaker\/(\d+)\/audio$/, (r, id, spk) => jobs.speakerAudio(id, +spk, r)],
  ['GET', /^\/api\/jobs\/(\w+)\/speaker\/(\d+)\/voice$/, (r, id, spk) => jobs.speakerVoice(id, +spk, r)],
  ['GET', /^\/api\/live\/(state|devices|frames|voice)$/, (r, what) => live.get(what, r)],
  ['POST', /^\/api\/live\/(\w+)$/, (r, what) => live.post(what, r)],
];

async function answer(msg) {
  const req = parse(msg);
  for (const [method, re, fn] of routes) {
    const m = re.exec(req.path);
    if (m && (method === req.method || (method === 'GET' && req.method === 'HEAD'))) return fn(req, ...m.slice(1));
  }
  return error(404, 'Not found.');
}

self.addEventListener('message', async (ev) => {
  if (ev.data?.kind === 'request') {
    const port = ev.ports[0];
    let res;
    try { res = await answer(ev.data.msg); }
    catch (e) {
      res = e instanceof HttpError ? error(e.status, e.message) : error(500, e.message || String(e));
      if (!(e instanceof HttpError)) console.error(e);
    }
    port.postMessage(res);
    return;
  }
  live.message?.(ev);       // messages from the page's live-recording side
});

jobs.resumeInterrupted().catch((e) => console.error('resume', e));
