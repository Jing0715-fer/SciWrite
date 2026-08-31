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

import { createHash } from "node:crypto";

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
 * Cache keys use SHA-256 — collision-free even for very long-lived caches.
 * (The previous djb2 32-bit hash could collide at ~65k entries via the
 * birthday paradox and silently return the wrong cached LLM result.)
 */
function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
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
  // r37 fix: expired entries were only deleted when their exact key was
  // re-requested — distinct prompts (results up to ~32KB) accumulated for
  // the process lifetime, a slow memory leak on a long-lived server. Sweep
  // expired entries on every set (O(n) over keys, cheap: string-keyed Map).
  const now = Date.now();
  for (const [k, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(k);
  }
  cache.set(key, {
    result,
    expiresAt: now + CACHE_TTL_MS,
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
