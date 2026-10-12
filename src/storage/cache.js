// Optional IndexedDB cache for derived data. Every call is best effort: failures never break processing.
const DB = 'bad-apple-creator';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function cacheGet(key) {
  try { return (await tx('readonly', (s) => s.get(key))) ?? null; } catch { return null; }
}

export async function cacheSet(key, value) {
  try { await tx('readwrite', (s) => s.put(value, key)); return true; } catch { return false; }
}

export async function cacheClear() {
  try { await tx('readwrite', (s) => s.clear()); return true; } catch { return false; }
}
