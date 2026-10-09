/**
 * round-RT3 (R7): TTL result cache for hosted web searches.
 *
 * WHY: 2/6 web searches in the RT2 production run were degraded by hosted-
 * search rate limits, and re-runs / canary retries re-burned the same quota
 * for queries whose results are stable for minutes. The LLM text layer
 * already has llm-cache (30 min TTL); the search layer had nothing — every
 * fact-check retry, coverage re-probe and gap-agent re-run paid full search
 * cost again.
 *
 * DESIGN:
 *  - Cache ONLY healthy, non-empty outcomes. Failures (rate-limit / timeout /
 *    provider-unavailable) must NOT be replayed — a transient 429 cached for
 *    10 minutes would masquerade as "no results exist".
 *  - Key: `${query}::${num}` — the two inputs of webSearchDetailed.
 *  - Returns a DEEP COPY of the items: callers historically mutate their
 *    evidence arrays (truncation, normalization) and a shared reference
 *    would corrupt later replays.
 *  - Bounded: max WEB_SEARCH_CACHE_MAX entries, evicting the
 *    soonest-to-expire first (a full map of expired-but-unscavenged entries
 *    is memory noise, not a cache).
 *  - Pure and dependency-free so it is unit-testable (bun test) without the
 *    z-ai SDK — ai.ts owns the wiring, this file owns the policy.
 */

export interface CachedWebSearchOutcome {
  items: unknown[];
  storedAt: number;
  expiresAt: number;
}

export const WEB_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
export const WEB_SEARCH_CACHE_MAX = 200;

const store = new Map<string, CachedWebSearchOutcome>();

/** Telemetry counters (exposed for tests and /api/llm-cache-style probes). */
export const webSearchCacheStats = {
  hits: 0,
  misses: 0,
  stores: 0,
  evictions: 0,
};

export function webSearchCacheKey(query: string, num: number): string {
  return `${String(query).trim()}::${num}`;
}

/** Deep copy via structured clone when available, JSON round-trip otherwise. */
function deepCopy<T>(value: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      /* fall through to JSON */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

/** Look up a cached healthy outcome. Returns a deep copy, or null on miss/expiry. */
export function webSearchCacheGet(
  query: string,
  num: number,
  now: number = Date.now(),
): unknown[] | null {
  const key = webSearchCacheKey(query, num);
  const hit = store.get(key);
  if (!hit) {
    webSearchCacheStats.misses++;
    return null;
  }
  if (hit.expiresAt <= now) {
    store.delete(key);
    webSearchCacheStats.misses++;
    return null;
  }
  webSearchCacheStats.hits++;
  return deepCopy(hit.items);
}

/**
 * Store a successful outcome. No-op for outcomes that should not be replayed
 * (empty items, or an outcome carrying a failure reason).
 */
export function webSearchCacheSet(
  query: string,
  num: number,
  items: unknown[] | null | undefined,
  opts: { ttlMs?: number; now?: number } = {},
): boolean {
  if (!items || !Array.isArray(items) || items.length === 0) return false;
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? WEB_SEARCH_CACHE_TTL_MS;
  const key = webSearchCacheKey(query, num);
  if (store.size >= WEB_SEARCH_CACHE_MAX && !store.has(key)) {
    // Evict the entry expiring soonest — it is the least useful one.
    let soonestKey: string | null = null;
    let soonestExp = Infinity;
    for (const [k, v] of store) {
      if (v.expiresAt < soonestExp) {
        soonestExp = v.expiresAt;
        soonestKey = k;
      }
    }
    if (soonestKey) {
      store.delete(soonestKey);
      webSearchCacheStats.evictions++;
    }
  }
  store.set(key, {
    items: deepCopy(items),
    storedAt: now,
    expiresAt: now + ttl,
  });
  webSearchCacheStats.stores++;
  return true;
}

/** Test/maintenance hook: wipe the cache and reset counters. */
export function clearWebSearchCache(): void {
  store.clear();
  webSearchCacheStats.hits = 0;
  webSearchCacheStats.misses = 0;
  webSearchCacheStats.stores = 0;
  webSearchCacheStats.evictions = 0;
}

/** Number of live entries (any TTL state) — for tests/probes. */
export function webSearchCacheSize(): number {
  return store.size;
}
