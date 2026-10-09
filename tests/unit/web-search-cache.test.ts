/**
 * round-RT3 QA: unit tests for the hosted web-search TTL cache (R7).
 *
 * Covers the contract from IMPROVEMENT_PLAN-RT2 R7:
 *  - healthy non-empty results are replayed within the TTL (deep copy!)
 *  - empty / null / failure-shaped results are NEVER cached
 *  - expired entries read as a miss and are scavenged
 *  - (query, num) is the cache key — different num ⇒ different entry
 *  - query whitespace is normalized
 *  - bounded size with soonest-expiry eviction
 *  - clear resets everything
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  webSearchCacheGet,
  webSearchCacheSet,
  webSearchCacheKey,
  webSearchCacheSize,
  webSearchCacheStats,
  clearWebSearchCache,
  WEB_SEARCH_CACHE_MAX,
} from "@/lib/web-search-cache";

// webSearchCacheStats is a plain counters OBJECT (not a function).
const stats = () => webSearchCacheStats;

describe("web-search cache", () => {
  beforeEach(() => {
    clearWebSearchCache();
  });

  test("miss then hit within TTL, and the hit is a DEEP copy", () => {
    const items = [{ url: "u1", name: "n", snippet: "s" }];
    expect(webSearchCacheGet("q", 6)).toBeNull();
    expect(webSearchCacheSet("q", 6, items)).toBe(true);
    const hit1 = webSearchCacheGet("q", 6)!;
    expect(hit1).toEqual(items);
    hit1[0].url = "MUTATED";
    const hit2 = webSearchCacheGet("q", 6)!;
    expect((hit2[0] as any).url).toBe("u1"); // caller mutation cannot poison the cache
  });

  test("failures and empty results are never cached", () => {
    expect(webSearchCacheSet("q", 6, [])).toBe(false);
    expect(webSearchCacheSet("q", 6, null)).toBe(false);
    expect(webSearchCacheSet("q", 6, undefined)).toBe(false);
    expect(webSearchCacheSize()).toBe(0);
  });

  test("expiry scavenges the entry", () => {
    webSearchCacheSet("q", 6, [{ url: "u" }], { now: 1000, ttlMs: 500 });
    expect(webSearchCacheGet("q", 6, 1200)).not.toBeNull(); // 1200 < 1500
    expect(webSearchCacheGet("q", 6, 1600)).toBeNull(); // expired
    expect(webSearchCacheSize()).toBe(0); // scavenged, not just skipped
  });

  test("(query, num) is the key", () => {
    webSearchCacheSet("q", 6, [{ url: "six" }]);
    webSearchCacheSet("q", 8, [{ url: "eight" }]);
    expect((webSearchCacheGet("q", 6)![0] as any).url).toBe("six");
    expect((webSearchCacheGet("q", 8)![0] as any).url).toBe("eight");
  });

  test("query whitespace normalizes", () => {
    webSearchCacheSet("  query  ", 6, [{ url: "u" }]);
    expect(webSearchCacheGet("query", 6)).not.toBeNull();
  });

  test("key format is stable", () => {
    expect(webSearchCacheKey(" q ", 6)).toBe("q::6");
  });

  test("bounded: soonest-to-expire is evicted at the cap", () => {
    // Fill to the cap with distinct expiry times.
    for (let i = 0; i < WEB_SEARCH_CACHE_MAX; i++) {
      webSearchCacheSet(`q${i}`, 6, [{ url: `u${i}` }], { now: 1000, ttlMs: 10_000 + i * 100 });
    }
    expect(webSearchCacheSize()).toBe(WEB_SEARCH_CACHE_MAX);
    // One more entry forces eviction of the SOONEST expiry (q0, ttl 10000).
    webSearchCacheSet("q-new", 6, [{ url: "n" }], { now: 1000, ttlMs: 999_999 });
    expect(webSearchCacheSize()).toBe(WEB_SEARCH_CACHE_MAX);
    expect(webSearchCacheGet("q0", 6, 1000 + 100)).toBeNull(); // evicted
    expect(webSearchCacheGet("q1", 6, 1000 + 200)).not.toBeNull(); // survived
    expect(stats().evictions).toBe(1);
  });

  test("stats count hits/misses/stores", () => {
    webSearchCacheGet("nope", 6);
    webSearchCacheSet("q", 6, [{ url: "u" }]);
    webSearchCacheGet("q", 6);
    expect(stats().misses).toBe(1);
    expect(stats().stores).toBe(1);
    expect(stats().hits).toBe(1);
  });

  test("clear resets entries and counters", () => {
    webSearchCacheSet("q", 6, [{ url: "u" }]);
    clearWebSearchCache();
    expect(webSearchCacheSize()).toBe(0);
    expect(stats().hits).toBe(0);
    expect(webSearchCacheGet("q", 6)).toBeNull();
  });
});
