/**
 * round-RT3 QA: unit tests for the review-engine R1/R4 behavior.
 *
 * Covers the contracts from IMPROVEMENT_PLAN-RT2:
 *  R4 (fixable vs advisory): a major-revision verdict whose LLM weaknesses
 *    are all ADVISORY no longer triggers an automatic revision; missing or
 *    garbage class arrays fall back to fixable (legacy behavior); reject
 *    always triggers; citations<6 always triggers (mechanically repairable).
 *  R1 (convergence): shouldStopForConvergence stops on <1 score gain with
 *    no hard-finding shrinkage and no new contradiction; never stops on the
 *    first round; a new contradiction or shrinking hard findings keep the
 *    loop alive; a WORSE score without new contradictions is converged churn.
 *  repairRoundSnapshotOf: snapshots overall/hard/contradicted/fixable from
 *    a ReviewCoreResult-shaped object, with hedged UNVERIFIABLEs excluded
 *    from the hard count (matching actionableFindings).
 */
import { test, expect, describe } from "bun:test";
import {
  actionableFindings,
  shouldStopForConvergence,
  repairRoundSnapshotOf,
} from "@/lib/review-engine";
import type { ReviewCoreResult } from "@/lib/review-engine";

/** Build a minimal ReviewCoreResult. */
function rc(opts: {
  verdict?: string;
  overall?: number;
  citations?: number;
  weaknesses?: string[];
  weaknessClasses?: string[];
  fixableWeaknessCount?: number;
  findings?: any[];
}): ReviewCoreResult {
  const parsed: any = {
    verdict: opts.verdict ?? "major-revision",
    summary: "",
    strengths: [],
    weaknesses: opts.weaknesses ?? [],
    suggestions: [],
    scores: {
      overall: opts.overall ?? 7,
      citations: opts.citations ?? 8,
    },
  };
  if (opts.weaknessClasses) parsed.weaknessClasses = opts.weaknessClasses;
  return {
    parsed,
    factReport: opts.findings ? { ran: true, findings: opts.findings, summary: {} as any, claims: [] } : null,
    factWeaknesses: [],
    mergedWeaknesses: opts.weaknesses ?? [],
    fixableWeaknessCount:
      opts.fixableWeaknessCount ?? (opts.weaknessClasses
        ? opts.weaknessClasses.filter((c) => c === "fixable").length
        : (opts.weaknesses?.length ?? 0)),
  };
}

describe("actionableFindings (R4 fixable/advisory)", () => {
  test("major-revision + at least one fixable weakness triggers", () => {
    const a = actionableFindings(rc({
      verdict: "major-revision",
      overall: 5,
      weaknesses: ["more breadth needed", "citation missing for X"],
      weaknessClasses: ["advisory", "fixable"],
    }));
    expect(a.actionable).toBe(true);
    expect(a.trigger).toBe("verdict");
    expect(a.reason).toContain("fixable weakness");
  });

  test("major-revision + ALL advisory weaknesses does NOT trigger (the RT2 churn case)", () => {
    const a = actionableFindings(rc({
      verdict: "major-revision",
      overall: 5,
      weaknesses: ["insufficient breadth", "lacks novelty", "scope too narrow"],
      weaknessClasses: ["advisory", "advisory", "advisory"],
    }));
    expect(a.actionable).toBe(false);
    expect(a.reason).toContain("advisory");
  });

  test("missing class array falls back to fixable (legacy behavior)", () => {
    const a = actionableFindings(rc({
      verdict: "major-revision",
      overall: 5,
      weaknesses: ["insufficient breadth"],
    }));
    expect(a.actionable).toBe(true);
  });

  test("citations < 6 always triggers (mechanical, always fixable)", () => {
    const a = actionableFindings(rc({
      verdict: "major-revision",
      overall: 8,
      citations: 4,
      weaknesses: ["insufficient breadth"],
      weaknessClasses: ["advisory"],
    }));
    expect(a.actionable).toBe(true);
    expect(a.trigger).toBe("verdict");
  });

  test("reject always triggers", () => {
    const a = actionableFindings(rc({ verdict: "reject", overall: 2 }));
    expect(a.actionable).toBe(true);
    expect(a.trigger).toBe("verdict");
  });

  test("minor-revision with no fact findings does not trigger", () => {
    const a = actionableFindings(rc({ verdict: "minor-revision" }));
    expect(a.actionable).toBe(false);
    expect(a.trigger).toBe("none");
  });

  test("CONTRADICTED fact finding hard-triggers regardless of classes", () => {
    const a = actionableFindings(rc({
      verdict: "minor-revision",
      weaknesses: [],
      findings: [{ verdict: "CONTRADICTED", sentence: "X shifted by 180 degrees", category: "quantitative" }],
    }));
    expect(a.actionable).toBe(true);
    expect(a.trigger).toBe("fact");
    expect(a.hardFindings).toHaveLength(1);
  });

  test("unhedged UNVERIFIABLE hard-triggers; hedged one does not", () => {
    const unhedged = actionableFindings(rc({
      verdict: "accept",
      findings: [{ verdict: "UNVERIFIABLE", sentence: "X causes Y in humans", category: "first-claim" }],
    }));
    expect(unhedged.actionable).toBe(true);

    const hedged = actionableFindings(rc({
      verdict: "accept",
      findings: [{ verdict: "UNVERIFIABLE", sentence: "X may cause Y in humans, according to some reports", category: "first-claim" }],
    }));
    expect(hedged.actionable).toBe(false);
  });
});

describe("shouldStopForConvergence (R1 early exit)", () => {
  const snap = (over: number | null, hard: number, contra: number) => ({
    overall: over,
    hardCount: hard,
    contradictedCount: contra,
    fixableCount: 1,
  });

  test("first round never stops", () => {
    expect(shouldStopForConvergence(null, snap(3, 5, 2)).stop).toBe(false);
  });

  test("the RT2 shape stops: <1 gain, hard count flat, no new contradictions", () => {
    const d = shouldStopForConvergence(snap(6, 1, 0), snap(6, 1, 0));
    expect(d.stop).toBe(true);
    expect(d.reason).toContain("converged");
    expect(d.reason).toContain("6→6");
  });

  test("a real improvement (>=1 gain) keeps the loop alive", () => {
    expect(shouldStopForConvergence(snap(6, 1, 0), snap(7, 1, 0)).stop).toBe(false);
  });

  test("shrinking hard findings keeps the loop alive even at flat score", () => {
    expect(shouldStopForConvergence(snap(6, 3, 1), snap(6, 1, 0)).stop).toBe(false);
  });

  test("a NEW contradiction always earns another round", () => {
    expect(shouldStopForConvergence(snap(6, 1, 0), snap(6, 1, 1)).stop).toBe(false);
  });

  test("a WORSE score without new contradictions is converged churn", () => {
    const d = shouldStopForConvergence(snap(7, 1, 0), snap(5, 1, 0));
    expect(d.stop).toBe(true);
  });

  test("unparseable score on either side never stops (null-safe)", () => {
    expect(shouldStopForConvergence(snap(null, 1, 0), snap(6, 1, 0)).stop).toBe(false);
    expect(shouldStopForConvergence(snap(6, 1, 0), snap(null, 1, 0)).stop).toBe(false);
  });
});

describe("repairRoundSnapshotOf", () => {
  test("snapshots all four fields, hedged UNVERIFIABLEs excluded from hard count", () => {
    const res = rc({
      verdict: "major-revision",
      overall: 6,
      findings: [
        { verdict: "CONTRADICTED", sentence: "A", category: "quantitative" },
        { verdict: "UNVERIFIABLE", sentence: "B may hold", category: "first-claim" },
        { verdict: "UNVERIFIABLE", sentence: "C holds", category: "first-claim" },
        { verdict: "VERIFIED", sentence: "D", category: "quantitative" },
      ],
    });
    const s = repairRoundSnapshotOf(res);
    expect(s.overall).toBe(6);
    expect(s.hardCount).toBe(2); // CONTRADICTED + unhedged UNVERIFIABLE
    expect(s.contradictedCount).toBe(1);
    expect(s.fixableCount).toBe(res.fixableWeaknessCount);
  });

  test("null factReport yields zeroed counts", () => {
    const s = repairRoundSnapshotOf(rc({ overall: 7 }));
    expect(s.hardCount).toBe(0);
    expect(s.contradictedCount).toBe(0);
    expect(s.overall).toBe(7);
  });
});
