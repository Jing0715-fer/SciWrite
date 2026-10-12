import { test, expect, describe, beforeEach } from "bun:test";
import {
  recordSessionPromptSize,
  getSessionContextStats,
  resetSessionContextStats,
} from "@/lib/session-context-stats";

/**
 * RT9: session-context cost telemetry (RT8 backlog #5). The aggregate is
 * module-level in-process state reset by the v2 route at pipeline start —
 * same observer-only contract as skill/telemetry-collector. These tests
 * pin: per-taskType aggregation (calls / totalChars / maxChars), snapshot
 * isolation (returned objects are copies), and reset semantics.
 */
describe("session-context-stats", () => {
  beforeEach(() => {
    resetSessionContextStats();
  });

  test("aggregates calls / totalChars / maxChars per taskType", () => {
    recordSessionPromptSize("generate", 5_000);
    recordSessionPromptSize("generate", 7_000);
    recordSessionPromptSize("verify", 21_058);

    const stats = getSessionContextStats();
    expect(stats.generate).toEqual({ calls: 2, totalChars: 12_000, maxChars: 7_000 });
    expect(stats.verify).toEqual({ calls: 1, totalChars: 21_058, maxChars: 21_058 });
  });

  test("empty taskType keys to \"unknown\" (never crashes the LLM call path)", () => {
    recordSessionPromptSize("", 100);
    const stats = getSessionContextStats();
    expect(stats.unknown).toEqual({ calls: 1, totalChars: 100, maxChars: 100 });
  });

  test("snapshot returns copies — mutating the snapshot does not poison the aggregate", () => {
    recordSessionPromptSize("review", 1_000);
    const first = getSessionContextStats();
    first.review.calls = 999;
    const second = getSessionContextStats();
    expect(second.review.calls).toBe(1);
  });

  test("reset clears everything (per-run scoping)", () => {
    recordSessionPromptSize("generate", 5_000);
    resetSessionContextStats();
    expect(getSessionContextStats()).toEqual({});
  });

  test("zero-size prompts still count as calls (degenerate but observable)", () => {
    recordSessionPromptSize("generate", 0);
    const stats = getSessionContextStats();
    expect(stats.generate).toEqual({ calls: 1, totalChars: 0, maxChars: 0 });
  });
});
