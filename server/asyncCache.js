export function createAsyncCache({
  ttlMs = 30_000,
  staleMs = 5 * 60_000,
  now = () => Date.now(),
  onBackgroundError = () => {}
} = {}) {
  const entries = new Map();

  function startLoad(key, loader, entry) {
    if (entry.inflight) return entry.inflight;
    entry.loader = loader;
    entry.inflight = Promise.resolve()
      .then(loader)
      .then((value) => {
        entry.value = value;
        entry.updatedAt = now();
        entry.hasValue = true;
        return value;
      })
      .finally(() => {
        entry.inflight = null;
      });
    entries.set(key, entry);
    return entry.inflight;
  }

  async function get(key, loader) {
    const entry = entries.get(key) ?? {
      value: undefined,
      updatedAt: 0,
      hasValue: false,
      inflight: null,
      loader
    };
    const age = entry.hasValue ? now() - entry.updatedAt : Number.POSITIVE_INFINITY;
    if (entry.hasValue && age <= ttlMs) return entry.value;

    if (entry.hasValue && age <= staleMs) {
      startLoad(key, loader, entry).catch(onBackgroundError);
      return entry.value;
    }

    return startLoad(key, loader, entry);
  }

  async function refresh(key) {
    const entry = entries.get(key);
    if (!entry?.loader) return undefined;
    return startLoad(key, entry.loader, entry);
  }

  async function refreshAll({ concurrency = 2 } = {}) {
    const keys = [...entries.keys()];
    const workerCount = Math.max(1, Math.min(keys.length || 1, Number(concurrency) || 1));
    let cursor = 0;
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < keys.length) {
        const key = keys[cursor];
        cursor += 1;
        try {
          await refresh(key);
        } catch (error) {
          onBackgroundError(error);
        }
      }
    });
    await Promise.all(workers);
  }

  function invalidate(key) {
    return entries.delete(key);
  }

  function clear() {
    entries.clear();
  }

  return {
    get,
    refresh,
    refreshAll,
    invalidate,
    clear,
    size: () => entries.size
  };
}
