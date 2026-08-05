/**
 * LLM Response Cache
 *
 * A simple in-memory cache for LLM calls that are deterministic given the
 * same input (topic + params). This avoids re-calling the LLM for identical
 * curateReferences / generateWebSearchQueries / plan requests when the user
 * regenerates an article with the same topic.
 *
 * The cache is keyed by a hash of (prompt + system + temperature + maxTokens).
 * Entries expire after CACHE_TTL_MS (default 30 minutes) to avoid serving
 * stale results when the underlying data sources may have changed.
 *
 * This is a process-local cache (not shared across server instances). For a
 * single-server deployment like SciWrite that's sufficient — the cache hit
 * rate is high during iterative article regeneration within one session.
 */

interface CacheEntry {
  result: any;
  expiresAt: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const cache = new Map<string, CacheEntry>();

// Hit/miss counters for the cache stats UI. Reset by clearLLMCache().
let _hits = 0;
let _misses = 0;

/**
 * Simple string hash (djb2) — fast and good enough for cache keys.
 * Not cryptographic, but we don't need collision resistance here.
 */
function hashString(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Build a cache key from the prompt + options that affect the output.
 * Two calls with the same key will produce the same LLM response (assuming
 * the LLM is deterministic at temperature 0, which is approximately true
 * for low temperatures).
 */
function buildCacheKey(prompt: string, opts: Record<string, any>): string {
  const keyParts = [
    prompt,
    opts.system || "",
    String(opts.temperature ?? ""),
    String(opts.maxTokens ?? ""),
    String(opts.taskType || ""),
  ];
  return hashString(keyParts.join("|"));
}

/**
 * Get a cached LLM response if present and not expired.
 */
export function getCachedLLMResult(key: string): any | null {
  const entry = cache.get(key);
  if (!entry) {
    _misses++;
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    _misses++;
    return null;
  }
  _hits++;
  return entry.result;
}

/**
 * Store an LLM response in the cache with the standard TTL.
 */
export function setCachedLLMResult(key: string, result: any): void {
  cache.set(key, {
    result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Build a cache key for an LLM call. Exported so callers can log the key
 * for debugging ("cache hit" vs "cache miss").
 */
export function llmCacheKey(prompt: string, opts: Record<string, any>): string {
  return buildCacheKey(prompt, opts);
}

/**
 * Clear all cached entries. Called when a project is deleted or the user
 * explicitly requests a fresh generation (e.g. "force re-gather").
 */
export function clearLLMCache(): void {
  cache.clear();
  _hits = 0;
  _misses = 0;
}

/**
 * Get cache stats for debugging / UI display. Returns the current cache
 * size + cumulative hit/miss counts (since the last clearLLMCache call).
 */
export function getLLMCacheStats(): { size: number; hits: number; misses: number; hitRate: number } {
  const total = _hits + _misses;
  return {
    size: cache.size,
    hits: _hits,
    misses: _misses,
    hitRate: total > 0 ? Math.round((_hits / total) * 100) : 0,
  };
}
