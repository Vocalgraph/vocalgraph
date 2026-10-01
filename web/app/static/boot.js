// Loaded first by every page: the browser version's copy (the desktop app
// ships its own, which only says "desktop"). It makes sure the service worker
// (sw.js) is in charge of this page, then starts the in-browser backend, which
// answers the page's "/api/..." requests from the recordings kept in this browser.
'use strict';
window.VG = { web: true };

(() => {
  const sw = navigator.serviceWorker;
  if (!sw) {
    document.addEventListener('DOMContentLoaded', () => {
      document.body.prepend(Object.assign(document.createElement('p'), {
        className: 'error',
        textContent: "This browser can't run Vocalgraph: it doesn't support service workers (a private window can turn them off).",
      }));
    });
    return;
  }
  // The first visit (and a forced reload) isn't under the service worker yet:
  // register it, then reload once so it is. The page is hidden meanwhile.
  const base = new URL('../', document.currentScript.src);
  if (!sw.controller) {
    document.documentElement.style.visibility = 'hidden';
    let tries = 0; try { tries = +sessionStorage.getItem('vg.reloads') || 0; } catch {}
    const show = (msg) => {
      document.documentElement.style.visibility = '';
      if (!msg) return;
      const p = Object.assign(document.createElement('p'), { className: 'error', textContent: msg });
      if (document.body) document.body.prepend(p); else addEventListener('DOMContentLoaded', () => document.body.prepend(p));
    };
    sw.register(new URL('sw.js', base), { scope: base.pathname }).then(() => sw.ready).then(() => {
      if (tries < 2) { try { sessionStorage.setItem('vg.reloads', String(tries + 1)); } catch {} location.reload(); }
      else show('Vocalgraph could not start in this tab. Reload the page to try again.');
    }, (err) => show(`Vocalgraph could not start: this browser wouldn't run its service worker (${err.message}).`));
    return;
  }
  try { sessionStorage.removeItem('vg.reloads'); } catch {}
  // A newer published version: the browser fetches it, then it waits. Offer
  // it; switching reloads the page (asking first if a session is recording).
  sw.register(new URL('sw.js', base), { scope: base.pathname }).then((reg) => {
    const offer = () => { if (reg.waiting && sw.controller) updateBar(reg); };
    offer();
    reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', offer));
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  });
  let switching = false;
  sw.addEventListener('controllerchange', () => { if (switching) location.reload(); });
  function updateBar(reg) {
    if (document.getElementById('vg-update')) return;
    const bar = document.createElement('div');
    bar.id = 'vg-update';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:50;display:flex;gap:12px;' +
      'align-items:center;padding:10px 14px;border-radius:10px;background:var(--surface-1,#fff);color:var(--text-primary,#000);' +
      'border:1px solid var(--border,rgba(0,0,0,.15));box-shadow:0 6px 24px rgba(0,0,0,.18);font:14px system-ui,sans-serif;max-width:calc(100vw - 32px)';
    const text = document.createElement('span'); text.textContent = 'A new version of Vocalgraph is ready.';
    const go = document.createElement('button'); go.type = 'button'; go.textContent = 'Update now';
    go.style.cssText = 'font:inherit;font-weight:600;border-radius:8px;padding:6px 12px;border:1px solid var(--accent,#2a78d6);' +
      'background:var(--accent,#2a78d6);color:var(--accent-text,#fff);cursor:pointer';
    go.addEventListener('click', async () => {
      try {
        const s = await (await fetch('api/live/state', { signal: AbortSignal.timeout(3000) })).json();
        if (['starting', 'live', 'stopping', 'finishing'].includes(s.status) &&
            !confirm('A live session is recording. Updating reloads the page and stops it. Update anyway?')) return;
      } catch {}
      switching = true;
      go.disabled = true; go.textContent = 'Updating…';
      // The version offered may have been replaced by an even newer one since
      // the bar appeared, still installing: wait for that one instead.
      let w = reg.waiting;
      if (!w && reg.installing) {
        const next = reg.installing;
        await new Promise((done) => {
          const check = () => { if (next.state !== 'installing') done(); };
          next.addEventListener('statechange', check); check();
        });
        w = reg.waiting;
      }
      if (w) w.postMessage({ type: 'vg-update' });     // it takes over, and controllerchange reloads
      setTimeout(() => {                                // didn't happen: say how to finish it by hand
        text.textContent = 'Close every Vocalgraph tab, then open it again to finish updating.';
        go.remove();
      }, 8000);
    });
    bar.append(text, go);
    document.body.append(bar);
  }

  // Requests can arrive before the backend has loaded: hold them until it has.
  const waiting = [];
  let handle = null;
  sw.addEventListener('message', (ev) => {
    if (!ev.data || ev.data.type !== 'vg-api') return;
    if (handle) handle(ev); else waiting.push(ev);
  });
  sw.startMessages && sw.startMessages();
  import(new URL('backend/main.js', base).href).then((m) => {
    handle = m.handle;
    for (const ev of waiting.splice(0)) handle(ev);
  }, (err) => {
    for (const ev of waiting.splice(0)) ev.ports[0].postMessage({ status: 500, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Vocalgraph failed to start: ' + err.message }) });
    handle = (ev) => ev.ports[0].postMessage({ status: 500, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Vocalgraph failed to start: ' + err.message }) });
  });
})();
