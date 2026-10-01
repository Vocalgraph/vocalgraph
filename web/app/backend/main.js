// The page's side of the backend: it only passes each request from the
// service worker on to the backend worker (worker.js), which answers straight
// back to the service worker. Everything else — the library, the analysis,
// the models — runs in that worker, so the page stays responsive.
import { serve } from './page.js';

const worker = new Worker(new URL('worker.js', import.meta.url), { type: 'module', name: 'vocalgraph-backend' });
let failed = null;

// If the worker can't start (or dies), answer with the reason instead of
// leaving the page waiting.
worker.addEventListener('error', (e) => {
  failed = e.message || 'the backend failed to start';
  console.error('Vocalgraph backend:', failed);
});

export function handle(ev) {
  const port = ev.ports[0];
  if (failed) {
    port.postMessage({ status: 500, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Vocalgraph's backend stopped: ${failed}. Reload the page to try again.` }) });
    return;
  }
  worker.postMessage({ kind: 'request', msg: ev.data }, [port]);
}

// Live recording needs the page for microphones (page.js).
serve(worker);
export { worker };
