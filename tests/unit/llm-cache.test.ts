import { test, expect, describe, beforeEach } from "bun:test";
import {
  getCachedLLMResult,
  setCachedLLMResult,
  llmCacheKey,
  clearLLMCache,
  getLLMCacheStats,
} from "@/lib/llm-cache";

beforeEach(() => {
  clearLLMCache();
});

describe("llmCacheKey", () => {
  // round-RT2: llmCacheKey is now async (the key includes the current
  // provider/model selection — see src/lib/llm-cache.ts).
  test("returns a non-empty string", async () => {
    const key = await llmCacheKey("hello", { temperature: 0.2 });
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });

  test("same inputs produce the same key", async () => {
    const k1 = await llmCacheKey("prompt", { system: "sys", temperature: 0.5, taskType: "write" });
    const k2 = await llmCacheKey("prompt", { system: "sys", temperature: 0.5, taskType: "write" });
    expect(k1).toBe(k2);
  });

  test("different prompts produce different keys", async () => {
    const k1 = await llmCacheKey("prompt-a", { temperature: 0 });
    const k2 = await llmCacheKey("prompt-b", { temperature: 0 });
    expect(k1).not.toBe(k2);
  });

  test("different temperatures produce different keys", async () => {
    const k1 = await llmCacheKey("prompt", { temperature: 0 });
    const k2 = await llmCacheKey("prompt", { temperature: 1 });
    expect(k1).not.toBe(k2);
  });

  test("different systems produce different keys", async () => {
    const k1 = await llmCacheKey("prompt", { system: "sys-a", temperature: 0 });
    const k2 = await llmCacheKey("prompt", { system: "sys-b", temperature: 0 });
    expect(k1).not.toBe(k2);
  });

  test("different taskTypes produce different keys", async () => {
    const k1 = await llmCacheKey("prompt", { taskType: "write", temperature: 0 });
    const k2 = await llmCacheKey("prompt", { taskType: "revise", temperature: 0 });
    expect(k1).not.toBe(k2);
  });
});

describe("cache get / set / clear", () => {
  test("missing key returns null", () => {
    expect(getCachedLLMResult("does-not-exist")).toBeNull();
  });

  test("set + get round-trip works", () => {
    setCachedLLMResult("k1", { hello: "world" });
    expect(getCachedLLMResult("k1")).toEqual({ hello: "world" });
  });

  test("clear empties the cache", () => {
    setCachedLLMResult("k1", "v1");
    setCachedLLMResult("k2", "v2");
    clearLLMCache();
    expect(getCachedLLMResult("k1")).toBeNull();
    expect(getCachedLLMResult("k2")).toBeNull();
  });

  test("re-set overwrites the previous value", () => {
    setCachedLLMResult("k1", "v1");
    setCachedLLMResult("k1", "v2");
    expect(getCachedLLMResult("k1")).toBe("v2");
  });
});

describe("getLLMCacheStats", () => {
  test("starts empty with zero hits and zero misses", () => {
    const stats = getLLMCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.hitRate).toBe(0);
  });

  test("counts a miss when key is absent", () => {
    getCachedLLMResult("absent");
    const stats = getLLMCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
  });

  test("counts a hit when key is present", () => {
    setCachedLLMResult("k1", "v1");
    getCachedLLMResult("k1");
    const stats = getLLMCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(0);
  });

  test("hitRate reflects a mix of hits and misses", () => {
    setCachedLLMResult("k1", "v1");
    getCachedLLMResult("k1"); // hit
    getCachedLLMResult("k1"); // hit
    getCachedLLMResult("missing"); // miss
    const stats = getLLMCacheStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    // 2/3 ≈ 67%
    expect(stats.hitRate).toBe(Math.round((2 / 3) * 100));
  });

  test("size reflects number of cached entries", () => {
    setCachedLLMResult("k1", "v1");
    setCachedLLMResult("k2", "v2");
    setCachedLLMResult("k3", "v3");
    const stats = getLLMCacheStats();
    expect(stats.size).toBe(3);
  });

  test("clear resets counters to zero", () => {
    setCachedLLMResult("k1", "v1");
    getCachedLLMResult("k1");
    getCachedLLMResult("missing");
    clearLLMCache();
    const stats = getLLMCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.hitRate).toBe(0);
  });
});

describe("integration: llmCacheKey + cache round-trip", () => {
  test("round-trip using llmCacheKey as the cache key", () => {
    const key = llmCacheKey("my-prompt", { temperature: 0, taskType: "write" });
    setCachedLLMResult(key, { result: "ok" });
    expect(getCachedLLMResult(key)).toEqual({ result: "ok" });
  });

  test("different prompts produce different cache slots", async () => {
    const k1 = await llmCacheKey("prompt-a", { temperature: 0 });
    const k2 = await llmCacheKey("prompt-b", { temperature: 0 });
    setCachedLLMResult(k1, "a");
    setCachedLLMResult(k2, "b");
    expect(getCachedLLMResult(k1)).toBe("a");
    expect(getCachedLLMResult(k2)).toBe("b");
  });
});

// RT8 (dev-mode memory ceiling): the Map had TTL-only expiry with no entry
// cap — bursty runs wrote 50-100 entries of up to ~32KB and held them all
// for 30 minutes (an RSS ratchet contributor behind the RT7 OOM).
describe("RT8: LRU entry cap", () => {
  const CAP = 500; // must mirror CACHE_MAX_ENTRIES in src/lib/llm-cache.ts

  test("cache never exceeds the entry cap", () => {
    for (let i = 0; i < CAP + 60; i++) {
      setCachedLLMResult(`lru-key-${i}`, { i });
    }
    const stats = getLLMCacheStats();
    expect(stats.size).toBeLessThanOrEqual(CAP);
    expect(stats.size).toBe(CAP); // exactly at cap, not under
  });

  test("oldest entries are evicted first (insertion order)", () => {
    for (let i = 0; i < CAP + 10; i++) {
      setCachedLLMResult(`lru-order-${i}`, { i });
    }
    // The first 10 written keys were evicted to make room for the last 10.
    for (let i = 0; i < 10; i++) {
      expect(getCachedLLMResult(`lru-order-${i}`)).toBeNull();
    }
    // The most recent 10 survive.
    for (let i = CAP; i < CAP + 10; i++) {
      expect(getCachedLLMResult(`lru-order-${i}`)).toEqual({ i });
    }
  });

  test("a get refreshes recency — the read entry survives the next eviction wave", () => {
    // Fill the cache exactly to cap.
    for (let i = 0; i < CAP; i++) {
      setCachedLLMResult(`lru-recency-${i}`, { i });
    }
    // Touch the OLDEST entry — its recency is refreshed to newest.
    expect(getCachedLLMResult("lru-recency-0")).toEqual({ i: 0 });
    // Write one more entry → the eviction wave must NOT take key 0.
    setCachedLLMResult("lru-recency-new", { i: -1 });
    expect(getCachedLLMResult("lru-recency-0")).toEqual({ i: 0 });
    // Instead, the second-oldest (never read) key was evicted.
    expect(getCachedLLMResult("lru-recency-1")).toBeNull();
    expect(getCachedLLMResult("lru-recency-new")).toEqual({ i: -1 });
  });

  test("overflow evicts exactly one entry per write (no over-eviction)", () => {
    for (let i = 0; i < CAP; i++) {
      setCachedLLMResult(`lru-exact-${i}`, { i });
    }
    // Exactly at cap: the next write evicts exactly ONE oldest entry.
    setCachedLLMResult("lru-exact-new", { i: -1 });
    expect(getLLMCacheStats().size).toBe(CAP);
    expect(getCachedLLMResult("lru-exact-0")).toBeNull(); // the one evicted
    expect(getCachedLLMResult("lru-exact-1")).toEqual({ i: 1 }); // untouched
    expect(getCachedLLMResult("lru-exact-new")).toEqual({ i: -1 });
  });
});
