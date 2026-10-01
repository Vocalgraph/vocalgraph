// Answers for the service worker: plain {status, headers, body} objects, the
// way the desktop app's Flask routes answer.

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const json = (obj, status = 200) =>
  ({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

export const error = (status, message) => json({ error: message }, status);

// A file, as send_file answers: whole, or the byte range an audio player asks
// for (so it can seek), and as a download when asked.
export function file(blob, { type, download = null, range = null } = {}) {
  const headers = { 'Content-Type': type || blob.type || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m && (m[1] || m[2])) {
    const size = blob.size;
    let start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
    let end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start >= size || start > end) return { status: 416, headers: { 'Content-Range': `bytes */${size}` }, body: null };
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(end - start + 1);
    return { status: 206, headers, body: blob.slice(start, end + 1) };
  }
  headers['Content-Length'] = String(blob.size);
  return { status: 200, headers, body: blob };
}

// The request the service worker passed on.
export function parse(msg) {
  const url = new URL(msg.url);
  const headers = new Map(msg.headers.map(([k, v]) => [k.toLowerCase(), v]));
  let jsonBody;
  return {
    method: msg.method, url, path: url.pathname, query: url.searchParams, headers,
    form: msg.form ? new Map(msg.form) : null,
    json() {
      if (jsonBody === undefined) {
        try { jsonBody = msg.body ? JSON.parse(new TextDecoder().decode(msg.body)) : {}; } catch { jsonBody = {}; }
      }
      return jsonBody || {};
    },
  };
}
