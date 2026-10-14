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

  test("RT10 (re-landed RT17-3c): revise is stateless", () => {
    // reviseArticle / reviseSection / coherenceEdit all ride taskType
    // "revise": their prompts are 100% self-contained (full article or
    // section text + review feedback, typically 20-40KB) versus the
    // ≤1.2KB generation-chatter preamble a context load prepends — the
    // load was pure DB + RSS churn (20-row findMany per repair round,
    // several rounds per E2E).
    //
    // E2E gate for this flip (drift detectors on the next armed run):
    // repair ROUND COUNT, mechanical-guard rejection rate, and
    // coherence-review finding count. Any sustained move in those means
    // the preamble was doing real work for the repair loop and this flip
    // should be reverted (see the matching comment in llm-session.ts).
    expect(isStatelessTaskType("revise")).toBe(true);
  });

  test("RT10: full expected set exactly (no accidental statelessness)", () => {
    // The exact intended set — compiled here so adding a member to
    // STATELESS_TASK_TYPES without updating this contract fails loudly.
    const EXPECTED_STATELESS = [
      "verify", // in-pipeline adversarialVerifySection
      "adversarial-review", // standalone adversarial-review route (lib taskType)
      "fact-check", // reserved
      "topicality", // reserved
      "review", // RT9 review family
      "revise", // RT10 repair family
    ] as const;
    for (const tt of EXPECTED_STATELESS) {
      expect(isStatelessTaskType(tt)).toBe(true);
    }
    // And the known generation-side taskType universe is exactly the
    // complement — nothing else may silently skip context loading.
    const GENERATION_SIDE = [
      "gather",
      "generate",
      "translate",
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
    ] as const;
    for (const tt of GENERATION_SIDE) {
      expect(isStatelessTaskType(tt)).toBe(false);
    }
    // Exhaustiveness: the two lists are disjoint and together cover every
    // taskType the codebase actually emits (see skill registry + routes).
    const overlap = EXPECTED_STATELESS.filter((tt) =>
      (GENERATION_SIDE as readonly string[]).includes(tt),
    );
    expect(overlap).toEqual([]);
  });

  test("generation-side task types keep session context", () => {
    for (const tt of [
      "gather",
      "generate",
      "translate",
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
