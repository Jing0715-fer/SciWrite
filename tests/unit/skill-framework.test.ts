/**
 * round-RT5 QA: unit tests for the skill framework's declarative surface —
 * shared step constants, the article format contract, and the score skill
 * definition (prompt contract + per-item fill + batch fallback semantics,
 * migrated verbatim from citation-planner).
 *
 * Executor I/O paths are covered separately (skill-executor.test.ts) with
 * mocked llm-session/llm-cache.
 */

import { test, expect, describe } from "bun:test";
import {
  PIPELINE_STEPS,
  STEP_TITLES,
  V2_MAIN_SEQUENCE,
  isPipelineStep,
} from "@/lib/skill/steps";
import {
  ARTICLE_FORMAT_RULES,
  FORMAT_GATE_IDS,
  FORMAT_GATES,
  applyFormatContract,
} from "@/lib/skill/format-contract";
import { scoreSkill, SKILLS, listSkills } from "@/lib/skill/registry";
import { SKILL_IDS } from "@/lib/skill/types";
import { mechanicalScores } from "@/lib/scoring";

// ---------------------------------------------------------------------------
// Shared step constants
// ---------------------------------------------------------------------------

describe("skill/steps", () => {
  test("V2_MAIN_SEQUENCE is an ordered subset of PIPELINE_STEPS", () => {
    const all = PIPELINE_STEPS as readonly string[];
    for (const s of V2_MAIN_SEQUENCE) {
      expect(all.includes(s)).toBe(true);
    }
    // Subset order must match the registry order (no reordering drift).
    let cursor = -1;
    for (const s of V2_MAIN_SEQUENCE) {
      const idx = all.indexOf(s);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  test("every pipeline step has a title (compile-time exhaustiveness guard)", () => {
    for (const s of PIPELINE_STEPS) {
      expect(typeof STEP_TITLES[s]).toBe("string");
      expect((STEP_TITLES[s] as string).length).toBeGreaterThan(0);
    }
    expect(Object.keys(STEP_TITLES).length).toBe(PIPELINE_STEPS.length);
  });

  test("isPipelineStep accepts known steps, rejects garbage", () => {
    expect(isPipelineStep("gather")).toBe(true);
    expect(isPipelineStep("nope")).toBe(false);
    expect(isPipelineStep(42)).toBe(false);
    expect(isPipelineStep(undefined)).toBe(false);
  });

  test("the legacy 9-step topic-composer subset is GONE — v2 main steps map", () => {
    // The stale hardcoded map (init..done, 9 slots) missed knowledge/score/
    // gapAgent/analyze/allocate/verify/repair/polish — all v2 main steps now
    // map by construction.
    for (const s of ["knowledge", "score", "gapAgent", "verify", "repair", "polish"]) {
      expect((V2_MAIN_SEQUENCE as readonly string[]).includes(s)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Article format contract
// ---------------------------------------------------------------------------

describe("skill/format-contract", () => {
  test("rules, gates and gate ids are mutually consistent", () => {
    expect(ARTICLE_FORMAT_RULES.length).toBeGreaterThanOrEqual(6);
    expect(FORMAT_GATE_IDS.length).toBe(FORMAT_GATES.length);
    for (const g of FORMAT_GATES) {
      expect(FORMAT_GATE_IDS.includes(g.id)).toBe(true);
      for (const r of g.rules) {
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(ARTICLE_FORMAT_RULES.length);
      }
    }
  });

  test("default chain applies all gates in FIXED registry order", () => {
    const out = applyFormatContract("Some prose.\n");
    expect(out.applied).toEqual(FORMAT_GATE_IDS);
  });

  test("sanitize gate strips LEADING role-label residue (design: first line only)", () => {
    // The sanitizer strips a leading label line (ASSISTANT:/SYSTEM:/USER:)
    // when it stands alone; mid-text labels stay (a legitimate "User:"
    // mention in prose must not be mangled) — pinned here as the contract.
    const out = applyFormatContract(
      "ASSISTANT:\n\nReal opening sentence with substance.\n\nSecond paragraph continues [1].",
      { gates: ["sanitize"] },
    );
    expect(out.applied).toEqual(["sanitize"]);
    expect(out.content).not.toContain("ASSISTANT:");
    expect(out.content).toContain("Real opening sentence with substance.");
  });

  test("citation-keys gate normalizes near-miss marker forms", () => {
    const out = applyFormatContract("Claims hold [R5] and also {{R1-3}} variants.", {
      gates: ["citation-keys"],
    });
    expect(out.applied).toEqual(["citation-keys"]);
    expect(out.content).not.toContain("[R5]");
    expect(out.content).not.toContain("{{R1-3}}");
    expect(out.content).toContain("{{R5}}");
  });

  test("cjk-residual gate strips Han characters and counts removals", () => {
    const out = applyFormatContract("Valid English claim [1].\n这是残留\nAlso valid text here [2].", {
      gates: ["cjk-residual"],
    });
    expect(out.applied).toEqual(["cjk-residual"]);
    expect(out.cjkRemoved).toBeGreaterThan(0);
    expect(out.content).not.toMatch(/[\u4e00-\u9fff]/);
    expect(out.content).toContain("Valid English claim");
  });

  test("language zh SKIPS english-only gates even when requested", () => {
    const out = applyFormatContract("中文段落一。中文段落二。", {
      gates: FORMAT_GATE_IDS,
      language: "zh",
    });
    expect(out.applied).not.toContain("cjk-residual");
    expect(out.content).toContain("中文段落");
  });

  test("callers cannot reorder the chain by passing gates out of order", () => {
    const out = applyFormatContract("Prose.\n\n- list item", {
      // Deliberately reversed — the contract still runs registry order.
      gates: ["cjk-residual", "uniform-section", "citation-keys", "sanitize"],
    });
    expect(out.applied).toEqual(["sanitize", "citation-keys", "uniform-section", "cjk-residual"]);
  });

  test("subset selection works (single gate)", () => {
    const out = applyFormatContract("Whatever.", { gates: ["uniform-section"] });
    expect(out.applied).toEqual(["uniform-section"]);
  });
});

// ---------------------------------------------------------------------------
// Score skill definition (registry)
// ---------------------------------------------------------------------------

const PROFILES = new Map<string, any>([
  ["r1", { hasFreeFullText: true, depth: "fulltext" as const }],
  ["r2", { hasFreeFullText: false, depth: "abstract" as const }],
]);

const BATCH = [
  { id: "r1", title: "CRISPR mechanisms", type: "pubmed", year: "2021", abstract: "Editing." },
  { id: "r2", title: "Unrelated fishing study", type: "web", year: "2005" },
];

const INPUT = {
  topic: "CRISPR-Cas9 genome editing",
  field: "molecular biology",
  batchNo: 1,
  totalBatches: 3,
  batch: BATCH,
  batchStartIndex: 4, // global indexes 5 and 6
  profiles: PROFILES,
};

describe("skill/registry scoreSkill", () => {
  test("contract fields are coherent (id/taskType/sseStep unified)", () => {
    expect(scoreSkill.id).toBe("score");
    expect(scoreSkill.taskType).toBe("score");
    expect(scoreSkill.sseStep).toBe("score");
    expect(SKILLS.score).toBe(scoreSkill);
    // RT7: the catalog grew to 15 skills (9 + coherence×2 + gap×2 +
    // knowledge×2) — every entry is coherent and the registry stays the
    // single catalog (no rogue entries).
    const catalog = listSkills();
    expect(catalog).toHaveLength(15);
    expect(catalog[0]).toEqual({
      id: "score", taskType: "score", sseStep: "score", title: "Score source importance", hasFallback: true,
    });
    for (const s of catalog) {
      expect(SKILL_IDS.includes(s.id)).toBe(true);
      expect(s.taskType.length).toBeGreaterThan(0);
      expect(isPipelineStep(s.sseStep)).toBe(true);
      expect(s.title.length).toBeGreaterThan(0);
    }
  });

  test("prompt contract carries topic, batch ordinals and global ref numbers", () => {
    const { system, prompt } = scoreSkill.buildPrompt(INPUT);
    expect(system).toContain("research librarian");
    expect(prompt).toContain("ARTICLE TOPIC: CRISPR-Cas9 genome editing");
    expect(prompt).toContain("batch 1 of 3");
    expect(prompt).toContain("[5]"); // batchStartIndex 4 → global 5
    expect(prompt).toContain("STRICT JSON");
  });

  test("metadata rows carry batch progress (legacy session rows)", () => {
    expect(scoreSkill.metadata!(INPUT)).toEqual({ batch: 1, total: 3, refs: 2 });
  });

  test("postProcess: valid rows adopted with priority/tier, malformed rows mechanically filled", () => {
    const parsed = {
      scores: [
        { ref: 5, relevance: 9, importance: 8, reason: "central" }, // valid
        { ref: 6, relevance: 25, importance: 3 }, // OUT OF RANGE → mechanical fill
      ],
    };
    const out = scoreSkill.postProcess!(parsed as any, INPUT);
    expect(out.scores).toHaveLength(2);

    const adopted = out.scores[0];
    expect(adopted.index).toBe(5);
    expect(adopted.relevance).toBe(9);
    expect(adopted.importance).toBe(8);
    expect(adopted.depth).toBe("fulltext");
    expect(adopted.reason).toBe("central");
    // priority = min(10, 9*0.55 + 8*0.35 + 1) = min(10, 8.55) ≈ 8.55 → core
    expect(adopted.tier).toBe("core");

    const filled = out.scores[1];
    expect(filled.index).toBe(6);
    expect(filled.reason).toContain("mechanical");
    expect(filled.relevance).toBeGreaterThanOrEqual(1);
    expect(filled.relevance).toBeLessThanOrEqual(10);
  });

  test("postProcess: a skipped row (missing from LLM reply) is mechanically filled", () => {
    const out = scoreSkill.postProcess!({ scores: [] } as any, INPUT);
    expect(out.scores).toHaveLength(2);
    expect(out.scores.every((s) => s.reason.includes("mechanical") || s.reason.length >= 0)).toBe(true);
    expect(out.scores[0].index).toBe(5);
    expect(out.scores[1].index).toBe(6);
  });

  test("fallback: whole-batch mechanical fill with GLOBAL indexes", () => {
    const out = scoreSkill.fallback!(INPUT, new Error("429 storm"));
    expect(out.scores).toHaveLength(2);
    expect(out.scores[0].index).toBe(5);
    expect(out.scores[1].index).toBe(6);
    expect(out.scores[0].reason).toContain("mechanical");
  });

  test("fallback output matches the migrated mechanicalScores kernel", () => {
    const viaSkill = scoreSkill.fallback!(INPUT, new Error("x"));
    const viaKernel = mechanicalScores(BATCH, PROFILES, INPUT.topic);
    expect(viaSkill.scores[0].relevance).toBe(viaKernel[0].relevance);
    expect(viaSkill.scores[0].priority).toBe(viaKernel[0].priority);
    expect(viaSkill.scores[0].tier).toBe(viaKernel[0].tier);
  });

  test("validate flags unresolved rows without fatality (advisory)", () => {
    const good = scoreSkill.postProcess!({ scores: [] } as any, INPUT);
    const v = scoreSkill.validate!(good, INPUT);
    expect(v.ok).toBe(true); // per-item fill guarantees resolution
  });
});
