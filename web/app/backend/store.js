// The library, kept in this browser (IndexedDB): what the desktop app keeps in
// its library folder. "jobs" holds each recording's job.json equivalent;
// "files" holds its files (the original, the trimmed file, the analysis...),
// keyed [job id, file name], as Blobs or ArrayBuffers.
const DB = 'vocalgraph', VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // Ask the browser not to clear the library under storage pressure.
  navigator.storage?.persist?.().catch(() => {});
  return dbp;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then(v => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('The library could not be saved (storage full?).'));
  });
}
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const jobs = {
  get: (id) => tx(['jobs'], 'readonly', t => req(t.objectStore('jobs').get(id))),
  all: () => tx(['jobs'], 'readonly', t => req(t.objectStore('jobs').getAll())),
  put: (job) => tx(['jobs'], 'readwrite', t => req(t.objectStore('jobs').put(job))),
  // A job and all its files.
  delete: (id) => tx(['jobs', 'files'], 'readwrite', t => {
    t.objectStore('jobs').delete(id);
    t.objectStore('files').delete(IDBKeyRange.bound([id, ''], [id, '￿']));
  }),
};

export const files = {
  get: (id, name) => tx(['files'], 'readonly', t => req(t.objectStore('files').get([id, name]))),
  put: (id, name, data) => tx(['files'], 'readwrite', t => req(t.objectStore('files').put(data, [id, name]))),
  delete: (id, name) => tx(['files'], 'readwrite', t => req(t.objectStore('files').delete([id, name]))),
  names: (id) => tx(['files'], 'readonly', t => req(t.objectStore('files').getAllKeys(IDBKeyRange.bound([id, ''], [id, '￿']))))
    .then(keys => keys.map(k => k[1])),
};

// How much the library takes and how much the browser allows.
export async function usage() {
  const e = await navigator.storage?.estimate?.().catch(() => null);
  return e ? { used: e.usage, quota: e.quota } : null;
}
