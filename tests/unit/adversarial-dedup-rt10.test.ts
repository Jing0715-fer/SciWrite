import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { RateLimitAbortedError, QuotaExhaustedError } from "@/lib/rate-limiter";

/**
 * RT10 (re-landed as RT17-3c after the 2026-10-14 sandbox reset): the
 * standalone adversarial-review route dedups into @/lib/adversarial-verify.
 * These tests pin the lib extension that made the dedup possible:
 *
 *   - VerifySectionOpts.taskType / cooldownMs / onBatchDone with DEFAULTS
 *     equal to the old in-pipeline behavior — the v2 generate-loop call
 *     site passes none of them, so the default contract is load-bearing
 *     (taskType "verify", ≥1.4s real cool-down, maxTokens undefined);
 *   - adversarialVerifyWithRouteRetry, the pure adapter that maps the lib's
 *     PROPAGATE contract onto the route's historical retry semantics
 *     (2 attempts / 15s cool-down / honest rateSkipped; non-rate errors
 *     rethrow verbatim).
 *
 * Mock discipline (suite convention — see skill-executor.test.ts /
 * sse-sequence.test.ts): mock.module is process-global with no rollback;
 * bun runs test files in one process in non-alphabetical order. Two
 * hardening measures:
 *
 *   1. The mocked @/lib/llm-session namespace re-exports the FULL real
 *      surface (chatWithSession fake + everything else delegating to the
 *      "?real" import). afterAll flips `mockActive` so LATER-loaded files
 *      (llm-session-stateless among them) exercise real behavior instead
 *      of a stubbed namespace.
 *   2. The adversarial-verify module under test is imported through a
 *      QUERY-SUFFIXED specifier ("?rt10"): bun's mock registry is
 *      path-keyed, so "?rt10" bypasses it and forces a FRESH module
 *      evaluation whose llm-session import binds to THIS file's mock —
 *      regardless of whether skill-executor / sse-sequence (which register
 *      their own llm-session mocks and may run before or after this file)
 *      already fixed the plain instance's bindings. Verified against bun
 *      1.3.14: a query-suffixed import of a module whose dependency was
 *      re-mocked binds the LATEST registry entry; earlier files' bindings
 *      are untouched.
 */

// ---------------------------------------------------------------------------
// Mock @/lib/llm-session — BEFORE the dynamic adversarial-verify import.
// ---------------------------------------------------------------------------

let mockActive = true;
const realLlmSession: any = await import("@/lib/llm-session?real");

let lastChatCall: { projectId: string; prompt: string; opts: any } | null = null;
let chatCallCount = 0;
let chatReply = JSON.stringify({
  checks: [{ id: 1, verdict: "SUPPORTED", confidence: 90, reason: "covers the claim" }],
});
/** Per-call error plan (consumed first); then `chatError` (sticky). */
let chatErrorPlan: Error[] = [];
let chatError: Error | null = null;

mock.module("@/lib/llm-session", () => ({
  chatWithSession: async (projectId: string, prompt: string, opts: any) => {
    if (!mockActive) return realLlmSession.chatWithSession(projectId, prompt, opts);
    chatCallCount++;
    lastChatCall = { projectId, prompt, opts };
    if (chatErrorPlan.length > 0) throw chatErrorPlan.shift()!;
    if (chatError) throw chatError;
    return chatReply;
  },
  chatWithSessionStream: async (...args: any[]) => {
    if (!mockActive) return realLlmSession.chatWithSessionStream(...args);
    throw new Error("chatWithSessionStream is not expected in adversarial-dedup tests");
  },
  loadSessionContext: async (...args: any[]) => {
    if (!mockActive) return realLlmSession.loadSessionContext(...args);
    return [] as any[];
  },
  saveSessionMessage: async (...args: any[]) => {
    if (!mockActive) return realLlmSession.saveSessionMessage(...args);
  },
  clearSession: async (...args: any[]) => {
    if (!mockActive) return realLlmSession.clearSession(...args);
  },
  isStatelessTaskType: (tt: string) => realLlmSession.isStatelessTaskType(tt),
}));

// Fresh module instance bound to the mock above (see header note 2).
const adversarialVerify: typeof import("@/lib/adversarial-verify") = await import(
  "@/lib/adversarial-verify?rt10"
);
const { adversarialVerifySection, adversarialVerifyWithRouteRetry } = adversarialVerify;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_RESULT = {
  checked: 0,
  removals: [],
  flagged: [],
  removedNums: [],
  llmCalls: 0,
  unverifiedChecks: 0,
} as const;

const REFS = [
  { title: "Alpha gating mechanisms", authors: "A. Author", journal: "J Biol", year: "2020", abstract: "Ion channel gating." },
  { title: "Beta modulation of kinetics", authors: "B. Author", journal: "J Mol", year: "2021", abstract: "" },
];

const CONTENT_1CITE = "Alpha channels gate ion flow with high selectivity [1].";
const CONTENT_2CITES =
  "Alpha channels gate ion flow with high selectivity [1]. Beta subunits modulate the gating kinetics [2].";

beforeEach(() => {
  lastChatCall = null;
  chatCallCount = 0;
  chatReply = JSON.stringify({
    checks: [{ id: 1, verdict: "SUPPORTED", confidence: 90, reason: "covers the claim" }],
  });
  chatErrorPlan = [];
  chatError = null;
});

afterAll(async () => {
  // Ensure the real module is loaded (it is, via the top-level ?real
  // import) before flipping delegation on — the registry entry this file
  // installed persists for the whole process.
  mockActive = false;
});

// ---------------------------------------------------------------------------
// Lib-level: VerifySectionOpts defaults + new knobs (5 tests)
// ---------------------------------------------------------------------------

describe("RT10: adversarialVerifySection opts", () => {
  test("defaults preserve the in-pipeline contract (taskType verify, no maxTokens, ≥1.4s cool-down)", async () => {
    const t0 = Date.now();
    const res = await adversarialVerifySection("p1", CONTENT_1CITE, REFS);
    const elapsed = Date.now() - t0;

    // The v2 generate-loop call site passes none of the new opts — these
    // defaults ARE its behavior contract (pinned, not assumed).
    expect(lastChatCall!.opts.taskType).toBe("verify");
    expect(lastChatCall!.opts.maxTokens).toBeUndefined();
    expect(lastChatCall!.opts.metadata.step).toBe("adversarial-verify");
    expect(lastChatCall!.opts.system).toContain("CITATION-TYPE MISMATCH");
    expect(lastChatCall!.opts.system).toContain("NUMERIC CLAIMS");

    expect(res).toEqual({
      checked: 1,
      removals: [],
      flagged: [],
      removedNums: [],
      llmCalls: 1,
      unverifiedChecks: 0,
    });
    // Single batch + default 1500ms cool-down after it → real elapsed time
    // lower bound (1400ms headroom for timer jitter).
    expect(elapsed).toBeGreaterThanOrEqual(1400);
  });

  test("taskType + maxTokens pass through to chatWithSession (route uses \"adversarial-review\")", async () => {
    const t0 = Date.now();
    const res = await adversarialVerifySection("p1", CONTENT_1CITE, REFS, {
      taskType: "adversarial-review",
      maxTokens: 1234,
      cooldownMs: 20,
    });
    expect(lastChatCall!.opts.taskType).toBe("adversarial-review");
    expect(lastChatCall!.opts.maxTokens).toBe(1234);
    expect(res.checked).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1000); // cooldownMs honored
  });

  test("onBatchDone fires once per settled batch (2 batches → 2 calls, running counters)", async () => {
    const seen: any[] = [];
    const res = await adversarialVerifySection("p1", CONTENT_2CITES, REFS, {
      batchSize: 1,
      cooldownMs: 20,
      onBatchDone: (info) => seen.push({ ...info }),
    });
    expect(seen.length).toBe(2);
    expect(seen[0]).toEqual({
      batchIndex: 1,
      batchSize: 1,
      llmCalls: 1,
      failed: false,
      unverifiedChecks: 0,
    });
    expect(seen[1]).toEqual({
      batchIndex: 2,
      batchSize: 1,
      llmCalls: 2,
      failed: false,
      unverifiedChecks: 0,
    });
    expect(res.llmCalls).toBe(2);
    expect(res.checked).toBe(2);
  });

  test("rate-limit errors PROPAGATE (no retry guard, no onBatchDone, single attempt)", async () => {
    chatError = new RateLimitAbortedError("abort flag set");
    const onBatchDone = mock(() => {});
    let caught: any = null;
    try {
      await adversarialVerifySection("p1", CONTENT_1CITE, REFS, {
        cooldownMs: 20,
        onBatchDone,
      });
    } catch (err: any) {
      caught = err;
    }
    // The unwind must reach the caller's graceful-skip handler verbatim —
    // the old route swallowed this into an empty fake-success report.
    expect(caught).toBeInstanceOf(RateLimitAbortedError);
    expect(chatCallCount).toBe(1); // 3s-retry guard NOT triggered for rate errors
    expect(onBatchDone).not.toHaveBeenCalled(); // unwind ≠ settled batch
  });

  test("non-rate failure → 3s retry → honest unverified (llmCalls=2, hook still fires with failed=true)", async () => {
    chatErrorPlan = [new Error("boom"), new Error("boom again")];
    const seen: any[] = [];
    const res = await adversarialVerifySection("p1", CONTENT_1CITE, REFS, {
      cooldownMs: 20,
      onBatchDone: (info) => seen.push({ ...info }),
    });
    expect(res.checked).toBe(0);
    expect(res.unverifiedChecks).toBe(1); // saved UNVERIFIED, surfaced honestly
    expect(res.llmCalls).toBe(2); // initial + retry
    expect(res.removals).toEqual([]);
    expect(res.flagged).toEqual([]);
    expect(seen.length).toBe(1);
    expect(seen[0].failed).toBe(true);
    expect(seen[0].unverifiedChecks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Route mapping pure function: adversarialVerifyWithRouteRetry (6 tests)
// ---------------------------------------------------------------------------

describe("RT10: adversarialVerifyWithRouteRetry (route semantics mapping)", () => {
  function scriptedRun(script: (typeof EMPTY_RESULT | Error)[]): {
    run: any;
    calls: any[];
  } {
    const calls: any[] = [];
    const run = async (projectId: string, content: string, refs: any[], opts: any) => {
      calls.push({ projectId, content, refs, opts });
      const step = script[calls.length - 1];
      if (step instanceof Error) throw step;
      return step;
    };
    return { run, calls };
  }

  function spySleep(): { sleep: any; sleeps: number[] } {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    return { sleep, sleeps };
  }

  test("success: first attempt wins, no cool-down sleep", async () => {
    const { run, calls } = scriptedRun([{ ...EMPTY_RESULT, checked: 3 }]);
    const { sleep, sleeps } = spySleep();
    const outcome = await adversarialVerifyWithRouteRetry(
      "p1", "content", REFS, { taskType: "adversarial-review" },
      { run, sleep },
    );
    expect(outcome.rateSkipped).toBe(false);
    expect(outcome.result!.checked).toBe(3);
    expect(calls.length).toBe(1);
    expect(calls[0].opts.taskType).toBe("adversarial-review"); // opts pass through to run
    expect(sleeps).toEqual([]);
  });

  test("rate-limited once, then recovers: one 15s-cooled retry, result delivered", async () => {
    const { run, calls } = scriptedRun([
      new RateLimitAbortedError("429 storm"),
      { ...EMPTY_RESULT, checked: 5 },
    ]);
    const { sleep, sleeps } = spySleep();
    const outcome = await adversarialVerifyWithRouteRetry("p1", "content", REFS, {}, { run, sleep });
    expect(outcome.rateSkipped).toBe(false);
    expect(outcome.result!.checked).toBe(5);
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([15000]); // ROUTE_VERIFY_RETRY_COOLDOWN_MS default
  });

  test("double RateLimitAborted → honest rateSkipped (reason rate-limited)", async () => {
    const { run, calls } = scriptedRun([
      new RateLimitAbortedError("first abort"),
      new RateLimitAbortedError("second abort"),
    ]);
    const { sleep, sleeps } = spySleep();
    const outcome = await adversarialVerifyWithRouteRetry("p1", "content", REFS, {}, { run, sleep });
    expect(outcome.rateSkipped).toBe(true);
    expect(outcome.result).toBeUndefined();
    expect(outcome.reason).toBe("rate-limited");
    expect(outcome.message).toContain("second abort"); // final attempt's error
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([15000]);
  });

  test("mixed rate errors (abort then quota) → rateSkipped with the FINAL error's reason", async () => {
    const { run } = scriptedRun([
      new RateLimitAbortedError("abort flag set"),
      new QuotaExhaustedError("quota exhausted"),
    ]);
    const { sleep, sleeps } = spySleep();
    const outcome = await adversarialVerifyWithRouteRetry("p1", "content", REFS, {}, { run, sleep });
    expect(outcome.rateSkipped).toBe(true);
    expect(outcome.reason).toBe("quota-exhausted");
    expect(outcome.message).toContain("quota exhausted");
    expect(sleeps).toEqual([15000]);
  });

  test("non-rate errors rethrow verbatim (single attempt, no sleep)", async () => {
    const fatal = new Error("provider 500");
    const { run, calls } = scriptedRun([fatal]);
    const { sleep, sleeps } = spySleep();
    let caught: any = null;
    try {
      await adversarialVerifyWithRouteRetry("p1", "content", REFS, {}, { run, sleep });
    } catch (err: any) {
      caught = err;
    }
    expect(caught).toBe(fatal); // identity — the route's 500 path owns it
    expect(calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("custom cooldown injection replaces the historical 15s", async () => {
    const { run } = scriptedRun([
      new RateLimitAbortedError("a"),
      new RateLimitAbortedError("b"),
    ]);
    const { sleep, sleeps } = spySleep();
    const outcome = await adversarialVerifyWithRouteRetry(
      "p1", "content", REFS, {}, { run, sleep, cooldownMs: 50 },
    );
    expect(sleeps).toEqual([50]);
    expect(outcome.rateSkipped).toBe(true);
    expect(outcome.reason).toBe("rate-limited");
  });
});
