// Runs a one shot task in a worker. Aborting terminates the worker, which frees everything it held.
export function runWorker(createWorker, payload, { transfer = [], onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const worker = createWorker();
    const finish = () => { signal?.removeEventListener('abort', onAbort); worker.terminate(); };
    const onAbort = () => { finish(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal?.addEventListener('abort', onAbort);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.value, m.detail);
      else if (m.type === 'done') { finish(); resolve(m); }
      else if (m.type === 'error') { finish(); reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { finish(); reject(new Error(e.message || 'A background task failed.')); };
    worker.postMessage(payload, transfer);
  });
}
