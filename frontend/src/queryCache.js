const CACHE_TTL_MS = 30_000;
const entries = new Map();

export function cacheKeyFor(loader, dependencies) {
  try {
    return `${loader.toString()}::${JSON.stringify(dependencies)}`;
  } catch {
    return null;
  }
}

export function readCache(key) {
  if (!key) return null;
  return entries.get(key) ?? null;
}

export function isFresh(entry) {
  return Boolean(entry) && !entry.promise && Date.now() - entry.at < CACHE_TTL_MS;
}

export function writeCache(key, data, at = Date.now()) {
  if (!key) return;
  entries.set(key, { data, at, promise: null });
}

export function writeInflight(key, previous, at, promise) {
  if (!key) return;
  entries.set(key, { data: previous, at, promise });
}

export function invalidateRequests() {
  entries.clear();
}
