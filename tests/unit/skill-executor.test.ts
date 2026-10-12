/**
 * round-RT5 QA: executor I/O-path tests with MOCKED llm-session/llm-cache
 * (mock.module hoists before the executor import resolves).
 *
 * Covers: cache-hit replay, cache-miss chat + cache store, postProcess
 * routing, fatal-validation escalation to fallback, exception fallback,
 * no-fallback rethrow, telemetry envelope, chatOverrides passthrough.
 */

import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — BEFORE importing the executor (ESM live-binding order).
// ---------------------------------------------------------------------------

// RT8 (test-suite isolation): bun runs test files in ONE process in
// non-alphabetical order, and mock.module is process-global with no
// rollback (a later mock.module call does NOT override — verified against
// bun 1.3.14). The module-level mock below therefore used to leak into
// llm-cache.test.ts (historical "8 env-dependent failures" documented as
// suite-order interference since RT6). Fix: a query-suffixed dynamic import
// ("…?real") bypasses the path-keyed mock registry and loads the REAL
// module; every mocked function delegates to it once `mockActive` flips
// false in afterAll. Later files then exercise the real implementation.
let actualCache: typeof import("@/lib/llm-cache") | null = null;
let mockActive = true;
const actualCachePromise: Promise<any> = import("@/lib/llm-cache?real").then(
  (m) => {
    actualCache = m as any;
    return m;
  },
);

let lastChatCall: { prompt: string; opts: any } | null = null;
let chatReply = '```json\n{"scores":[]}\n```';
let chatShouldThrow: Error | null = null;
let cacheStore: Map<string, string> = new Map();
let cacheHits = 0;

mock.module("@/lib/llm-session", () => ({
  chatWithSession: async (_projectId: string, prompt: string, opts: any) => {
    lastChatCall = { prompt, opts };
    if (chatShouldThrow) throw chatShouldThrow;
    return chatReply;
  },
}));

mock.module("@/lib/llm-cache", () => ({
  llmCacheKey: (prompt: string, _opts: Record<string, any>) =>
    mockActive
      ? Promise.resolve(`k:${prompt.slice(0, 24)}`)
      : actualCache!.llmCacheKey(prompt, _opts),
  getCachedLLMResult: (key: string) => {
    if (!mockActive) return actualCache!.getCachedLLMResult(key);
    const v = cacheStore.get(key);
    if (v !== undefined) cacheHits++;
    return v ?? null;
  },
  setCachedLLMResult: (key: string, value: string) => {
    if (!mockActive) return actualCache!.setCachedLLMResult(key, value);
    cacheStore.set(key, value);
  },
  // The mock replaces the WHOLE module namespace — every export the real
  // module has must exist here or later files' imports resolve to
  // undefined. These two are only ever exercised AFTER the flag flips
  // (this file's own tests never call them), so a plain passthrough is
  // enough (optional-chained for the load race, defensively).
  clearLLMCache: () => actualCache?.clearLLMCache(),
  getLLMCacheStats: () =>
    actualCache?.getLLMCacheStats() ?? { size: 0, hits: 0, misses: 0, hitRate: 0 },
}));

import { runSkill } from "@/lib/skill/executor";
import type { SkillDefinition } from "@/lib/skill/types";

beforeEach(() => {
  lastChatCall = null;
  chatShouldThrow = null;
  cacheStore = new Map();
  cacheHits = 0;
  chatReply = '```json\n{"items":[]}\n```';
});

// RT8: once this file's tests are done, flip the delegation flag so any
// LATER-loaded test file (llm-cache.test.ts among them) exercises the real
// llm-cache implementation instead of this file's 2-function test double.
// (mock.module cannot be un-registered — the flag is the rollback.)
afterAll(async () => {
  await actualCachePromise; // ensure the real module is loaded before flipping
  mockActive = false;
});

/** Minimal test skill — one string field in/out, JSON reply shape {items}. */
function makeSkill(overrides: Partial<SkillDefinition<any, any>> = {}): SkillDefinition<any, any> {
  return {
    id: "score", // any registered id; used for telemetry only here
    taskType: "score",
    sseStep: "score",
    title: "Test skill",
    chat: { temperature: 0.2 },
    buildPrompt: (input: any) => ({ system: "sys", prompt: `prompt for ${input}` }),
    ...overrides,
  } as SkillDefinition<any, any>;
}

describe("skill executor paths", () => {
  test("cache miss → chat → cache store → parse → postProcess → ok", async () => {
    let postSeen = false;
    const skill = makeSkill({
      postProcess: (parsed: any) => {
        postSeen = true;
        return { items: (parsed.items ?? []).length };
      },
    });
    const res = await runSkill(skill, "input-a", {
      projectId: "p1",
      fallbackValue: { items: [] as any[] },
    });
    expect(res.ok).toBe(true);
    expect(res.degraded).toBe(false);
    expect(res.fromCache).toBe(false);
    expect(res.output).toEqual({ items: 0 });
    expect(postSeen).toBe(true);
    expect(lastChatCall).not.toBeNull();
    // Session metadata carries the unified step + skill id.
    expect(lastChatCall!.opts.metadata.step).toBe("score");
    expect(lastChatCall!.opts.metadata.skill).toBe("score");
    expect(lastChatCall!.opts.taskType).toBe("score");
    expect(lastChatCall!.opts.temperature).toBe(0.2);
    // Reply was cached.
    expect(cacheStore.size).toBe(1);
  });

  test("second identical call replays from cache (no chat)", async () => {
    const skill = makeSkill();
    await runSkill(skill, "input-b", { projectId: "p1", fallbackValue: { items: [] } });
    const res2 = await runSkill(skill, "input-b", { projectId: "p1", fallbackValue: { items: [] } });
    expect(res2.fromCache).toBe(true);
    expect(res2.ok).toBe(true);
    expect(cacheHits).toBe(1);
  });

  test("noCache skips both cache read and write", async () => {
    const skill = makeSkill();
    await runSkill(skill, "x", { projectId: "p1", fallbackValue: { items: [] }, noCache: true });
    await runSkill(skill, "x", { projectId: "p1", fallbackValue: { items: [] }, noCache: true });
    expect(cacheStore.size).toBe(0);
    expect(cacheHits).toBe(0);
  });

  test("chatOverrides merge over the skill's static chat options", async () => {
    const skill = makeSkill({ chat: { temperature: 0.9, maxTokens: 1000 } });
    await runSkill(skill, "x", {
      projectId: "p1",
      fallbackValue: {},
      noCache: true,
      chatOverrides: { maxTokens: 4096 },
    });
    expect(lastChatCall!.opts.temperature).toBe(0.9); // static kept
    expect(lastChatCall!.opts.maxTokens).toBe(4096); // override won
  });

  test("chat exception → skill fallback → degraded result + telemetry", async () => {
    chatShouldThrow = new Error("429 rate-limit storm");
    const skill = makeSkill({
      fallback: (input: any) => ({ items: `mechanical for ${input}` }),
    });
    const res = await runSkill(skill, "input-c", { projectId: "p1", fallbackValue: { items: [] } });
    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.output).toEqual({ items: "mechanical for input-c" });
    expect(res.issues[0]).toContain("fallback: 429");
    expect(res.telemetry.degraded).toBe(true);
  });

  test("fatal validation issue → fallback even when parse succeeded", async () => {
    chatReply = '{"items":[]}';
    const skill = makeSkill({
      validate: () => ({ ok: false, issues: ["fatal: contract violation", "advisory note"] }),
      fallback: () => ({ items: "safe default" }),
    });
    const res = await runSkill(skill, "x", { projectId: "p1", fallbackValue: { items: [] } });
    expect(res.degraded).toBe(true);
    expect(res.output).toEqual({ items: "safe default" });
  });

  test("advisory-only validation issues are recorded, not fatal", async () => {
    chatReply = '{"items":[]}';
    const skill = makeSkill({
      validate: () => ({ ok: false, issues: ["advisory: thin coverage"] }),
    });
    const res = await runSkill(skill, "x", { projectId: "p1", fallbackValue: { items: [] } });
    expect(res.degraded).toBe(false);
    expect(res.issues).toEqual(["advisory: thin coverage"]);
  });

  test("no fallback defined → the exception RETHROWS (hard-fail skill)", async () => {
    chatShouldThrow = new Error("boom");
    const skill = makeSkill(); // no fallback
    await expect(
      runSkill(skill, "x", { projectId: "p1", fallbackValue: { items: [] } }),
    ).rejects.toThrow("boom");
  });

  test("garbage reply parses to the fallback value (shared robust parser)", async () => {
    chatReply = "not json at all {{{";
    const skill = makeSkill();
    const res = await runSkill(skill, "x", { projectId: "p1", fallbackValue: { items: [] } });
    expect(res.ok).toBe(true); // parse degradation is not a skill failure
    expect(res.output).toEqual({ items: [] });
  });

  test("custom parse replaces the default JSON parser", async () => {
    chatReply = "plain prose reply";
    const skill = makeSkill({ parse: (raw) => ({ items: [raw.trim()] }) });
    const res = await runSkill(skill, "x", { projectId: "p1", fallbackValue: { items: [] } });
    expect(res.output).toEqual({ items: ["plain prose reply"] });
  });

  test("telemetry envelope carries skill id, timing and sizes", async () => {
    const res = await runSkill(makeSkill(), "x", { projectId: "p1", fallbackValue: { items: [] } });
    expect(res.telemetry.skill).toBe("score");
    expect(res.telemetry.ms).toBeGreaterThanOrEqual(0);
    expect(res.telemetry.promptChars).toBeGreaterThan(0);
    expect(res.telemetry.outputChars).toBeGreaterThan(0);
  });

  test("injected structured logger receives the telemetry row", async () => {
    const seen: any[] = [];
    const res = await runSkill(makeSkill(), "x", {
      projectId: "p1",
      fallbackValue: { items: [] },
      log: (level, msg, data) => seen.push({ level, msg, data }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].level).toBe("info");
    expect(seen[0].msg).toContain("skill score ok");
    expect(seen[0].data.skill).toBe("score");
    expect(res.telemetry.skill).toBe("score");
  });
});
