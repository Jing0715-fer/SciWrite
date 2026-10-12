import { test, expect, describe } from "bun:test";
import { isStatelessTaskType } from "@/lib/llm-session";

/**
 * RT8 (dev-mode memory ceiling): stateless verification task types skip
 * loadSessionContext in chatWithSession / chatWithSessionStream — their
 * prompts are fully self-contained (claim sentence + reference metadata),
 * so the 20-row × ~28KB context load per call was pure DB + RSS churn
 * (the RT7 E2E OOM analysis flagged it: 14+ verify batch calls + 4
 * standalone adversarial-review calls per run).
 *
 * The DB-write side (saveSessionMessage) is intentionally NOT skipped —
 * the observability rows survive; only the context LOAD is skipped.
 */
describe("RT8: isStatelessTaskType", () => {
  test("verification task types are stateless", () => {
    expect(isStatelessTaskType("verify")).toBe(true); // in-pipeline adversarialVerifySection
    expect(isStatelessTaskType("adversarial-review")).toBe(true); // standalone route
    expect(isStatelessTaskType("fact-check")).toBe(true); // reserved (skill currently routes as "review")
    expect(isStatelessTaskType("topicality")).toBe(true); // reserved
  });

  test("RT9: the review family is stateless (verdict passes, self-contained prompts)", () => {
    // fact-check ×8, review ×2, coherence-review ×2 all ride taskType
    // "review" — their prompts carry the full article/claim payload, and
    // the RT8 E2E showed no verdict drift for the stateless verify family.
    expect(isStatelessTaskType("review")).toBe(true);
  });

  test("generation-side task types keep session context", () => {
    for (const tt of [
      "gather",
      "generate",
      "translate",
      "revise",
      "relationships",
      "plan",
      "write",
      "score",
      "curate",
      "curate-smart",
      "analyze",
      "allocate",
      "outline",
      "query-expand",
      "result-filter",
      "auto-fix",
    ]) {
      expect(isStatelessTaskType(tt)).toBe(false);
    }
  });

  test("empty / unknown task types are not stateless (fail-safe to context loading)", () => {
    expect(isStatelessTaskType("")).toBe(false);
    expect(isStatelessTaskType("some-new-task")).toBe(false);
    expect(isStatelessTaskType("verifyish")).toBe(false); // no prefix matching by design
  });
});
