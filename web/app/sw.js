// Vocalgraph's service worker (browser version). Three jobs:
//
// 1. The pages are the desktop app's own; they talk to "/api/..." as if the
//    app's server were there. This worker catches those requests (fetches,
//    audio players, downloads, uploads alike) and hands them to the backend
//    running in one of the site's open pages (backend/main.js), which answers
//    from the recordings kept in this browser.
//
// 2. Versions: every file of one published version is served from that
//    version's cache, so a tab never mixes old and new files. A new version
//    waits until the page says to switch ("Update now"), so it never changes
//    under a recording. VERSION is filled in by web/tools/assemble.mjs.
//
// 3. Locks the pages and workers down (headers GitHub Pages can't send):
//    cross-origin isolation, which multi-threaded WebAssembly needs, and a
//    content security policy that lets them load only the site's own files
//    and talk only to the site and the Vocalgraph helper on this computer,
//    so nothing (even a bad script) can send a recording anywhere.
'use strict';

const VERSION = '__VERSION__';
const CACHE = `vocalgraph-${VERSION}`;
const TIMEOUT_MS = 10 * 60 * 1000;     // a long step (a trimmed file for an hour) can take minutes
const HELPER = 'http://127.0.0.1:8766 ws://127.0.0.1:8766';

self.addEventListener('install', () => {
  // The first install takes over at once; an update waits to be asked.
  if (!self.registration.active) self.skipWaiting();
});
self.addEventListener('activate', (ev) => ev.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('vocalgraph-') && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('message', (ev) => {
  if (ev.data?.type === 'vg-update') self.skipWaiting();
  if (ev.data?.type === 'vg-version') ev.source?.postMessage({ type: 'vg-version', version: VERSION });
});

const isApi = (url) => url.origin === location.origin && url.pathname.startsWith('/api/');
const scope = new URL(self.registration.scope);

self.addEventListener('fetch', (ev) => {
  const req = ev.request, url = new URL(req.url);
  if (isApi(url)) { ev.respondWith(forward(ev)); return; }
  if (url.origin !== location.origin || req.method !== 'GET' || !url.pathname.startsWith(scope.pathname)) return;
  if (url.pathname.startsWith(scope.pathname + 'test/')) return;   // the old test page: as published, not locked down
  const dest = req.destination;
  if (req.mode === 'navigate' || dest === 'worker' || dest === 'sharedworker') ev.respondWith(locked(req, dest));
  else ev.respondWith(cached(req));
});

// One version's files: from its cache, else fetched (fresh) and kept.
async function cached(req) {
  const cache = await caches.open(CACHE);
  const key = new URL(req.url); key.search = '';                 // ?v=… on the same file is the same file
  const hit = await cache.match(key.href);
  if (hit) return hit;
  const res = await fetch(req, { cache: 'no-cache' });
  if (res.ok && res.type === 'basic') await cache.put(key.href, res.clone());
  return res;
}

// Pages and workers, with the isolation and security headers.
async function locked(req, dest) {
  const res = await cached(req);
  if (!res.ok || res.type === 'opaqueredirect') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  let body = res.body;
  let scripts = "'self'";
  if (dest !== 'worker' && dest !== 'sharedworker') {
    // A page's own inline scripts are allowed by their hash, nothing else.
    const html = await res.text();
    body = html;
    // Hashed as the browser sees the script: its parser turns CRLF and CR into LF.
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g))
      scripts += ` '${await sha256(m[1].replace(/\r\n?/g, '\n'))}'`;
  }
  headers.set('Content-Security-Policy', [
    "default-src 'self'",
    `script-src ${scripts} 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self' ${HELPER}`,
    "worker-src 'self' blob:",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'",
  ].join('; '));
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return 'sha256-' + btoa(String.fromCharCode(...new Uint8Array(d)));
}

// An open page to answer: the one asking if it can, else any of the site's pages.
async function backendClient(ev) {
  const own = ev.clientId && await self.clients.get(ev.clientId);
  if (own) return own;
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
  return all.find(c => c.focused) || all[0] || null;
}

async function forward(ev) {
  const client = await backendClient(ev);
  if (!client) return json(503, { error: 'Open Vocalgraph in a tab first.' });
  const req = ev.request;
  const msg = { type: 'vg-api', method: req.method, url: req.url, headers: [...req.headers.entries()] };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const type = req.headers.get('content-type') || '';
    if (type.startsWith('multipart/form-data')) {
      const form = await req.formData();
      msg.form = [...form.entries()].map(([k, v]) => [k, v]);     // Files stay Files (structured clone)
    } else {
      msg.body = await req.arrayBuffer();
    }
  }
  const { port1, port2 } = new MessageChannel();
  const answer = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), TIMEOUT_MS);
    port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
  });
  client.postMessage(msg, [port2]);
  const r = await answer;
  if (!r) return json(504, { error: 'Vocalgraph took too long to answer.' });
  return new Response(r.body ?? null, { status: r.status, headers: r.headers });
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
