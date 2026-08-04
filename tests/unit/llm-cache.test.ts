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
  test("returns a non-empty string", () => {
    const key = llmCacheKey("hello", { temperature: 0.2 });
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });

  test("same inputs produce the same key", () => {
    const k1 = llmCacheKey("prompt", { system: "sys", temperature: 0.5, taskType: "write" });
    const k2 = llmCacheKey("prompt", { system: "sys", temperature: 0.5, taskType: "write" });
    expect(k1).toBe(k2);
  });

  test("different prompts produce different keys", () => {
    const k1 = llmCacheKey("prompt-a", { temperature: 0 });
    const k2 = llmCacheKey("prompt-b", { temperature: 0 });
    expect(k1).not.toBe(k2);
  });

  test("different temperatures produce different keys", () => {
    const k1 = llmCacheKey("prompt", { temperature: 0 });
    const k2 = llmCacheKey("prompt", { temperature: 1 });
    expect(k1).not.toBe(k2);
  });

  test("different systems produce different keys", () => {
    const k1 = llmCacheKey("prompt", { system: "sys-a", temperature: 0 });
    const k2 = llmCacheKey("prompt", { system: "sys-b", temperature: 0 });
    expect(k1).not.toBe(k2);
  });

  test("different taskTypes produce different keys", () => {
    const k1 = llmCacheKey("prompt", { taskType: "write", temperature: 0 });
    const k2 = llmCacheKey("prompt", { taskType: "revise", temperature: 0 });
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

  test("different prompts produce different cache slots", () => {
    const k1 = llmCacheKey("prompt-a", { temperature: 0 });
    const k2 = llmCacheKey("prompt-b", { temperature: 0 });
    setCachedLLMResult(k1, "a");
    setCachedLLMResult(k2, "b");
    expect(getCachedLLMResult(k1)).toBe("a");
    expect(getCachedLLMResult(k2)).toBe("b");
  });
});
