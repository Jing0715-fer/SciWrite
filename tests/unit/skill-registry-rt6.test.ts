/**
 * round-RT6 QA: unit tests for the migrated skill families —
 *   - A-family remainder: curate / curate-smart (skills-curation.ts)
 *   - B-family reviewers: review / revision / revision-scoped
 *     (skills-review.ts), fact-check / evidence-extract / evidence-allocate
 *     (skills-evidence.ts)
 *   - the three NEW structural gates in the format contract
 *     (remove-ref-blocks / ascii-punctuation / section-markdown), including
 *     the behavior-equivalence lock against writing.ts's
 *     normalizeArticleBodySections (the exact sequence the v2
 *     repair/polish/compose exits used to hand-assemble).
 *
 * Every test pins the LEGACY semantics the migration promised to keep
 * (verbatim prompts are spot-checked by their invariant markers, not by
 * full-string equality — the source of truth stays in the skill files).
 */

import { test, expect, describe } from "bun:test";
import {
  curateSkill,
  curateSmartSkill,
  deriveScoredOrder,
} from "@/lib/skill/skills-curation";
import {
  reviewCoreSkill,
  reviseArticleSkill,
  reviseSectionSkill,
  REVIEW_CORE_PARSE_FALLBACK,
} from "@/lib/skill/skills-review";
import {
  factCheckArbitrateSkill,
  evidenceExtractSkill,
  evidenceAllocateSkill,
} from "@/lib/skill/skills-evidence";
import {
  applyFormatContract,
  FORMAT_GATE_IDS,
  FORMAT_GATES,
} from "@/lib/skill/format-contract";
import { SKILLS } from "@/lib/skill/registry";
import { normalizeArticleBodySections, stripRevisionWrappers } from "@/lib/writing";

// ---------------------------------------------------------------------------
// A-family: curate (legacy curateReferences LLM block)
// ---------------------------------------------------------------------------

const CURATE_INPUT = {
  topic: "TMC1 mechanotransduction",
  field: "biophysics",
  references: [
    { id: "a", title: "TMC1 structure", authors: "Jeong", year: "2022" },
    { id: "b", title: "Hair cell transduction", authors: "Zhao", year: "2020" },
    { id: "c", title: "Unrelated algae paper", authors: "Kim", year: "2011" },
    { id: "d", title: "TMC2 channel", authors: "Lab", year: "2019" },
  ],
  maxCount: 2,
};

describe("skill/curate (A-family)", () => {
  test("contract: id/taskType/sseStep + registered", () => {
    expect(curateSkill.id).toBe("curate");
    expect(curateSkill.taskType).toBe("curate");
    expect(curateSkill.sseStep).toBe("curate");
    expect(SKILLS.curate).toBe(curateSkill);
    expect(curateSkill.chat.temperature).toBe(0.3); // legacy call temperature
  });

  test("prompt: topic, target count, 1-based ref list", () => {
    const { system, prompt } = curateSkill.buildPrompt(CURATE_INPUT);
    expect(system).toContain("research curator");
    expect(prompt).toContain("RESEARCH TOPIC: TMC1 mechanotransduction");
    expect(prompt).toContain("Select the 2 MOST relevant");
    expect(prompt).toContain("[1] Jeong (2022) TMC1 structure");
    expect(prompt).toContain("STRICT JSON");
  });

  test("metadata rows match the legacy session shape", () => {
    expect(curateSkill.metadata!(CURATE_INPUT)).toEqual({ total: 4, maxCount: 2 });
  });

  test("postProcess: range filter + cap at maxCount (legacy)", () => {
    const out = curateSkill.postProcess!({ indices: [3, 99, 1, 2] } as any, CURATE_INPUT);
    // 99 out of range; cap at 2 → [3, 1]
    expect(out.indices).toEqual([3, 1]);
  });

  test("fallback: empty indices (caller slices mechanically, legacy catch)", () => {
    const out = curateSkill.fallback!(CURATE_INPUT, new Error("429"));
    expect(out).toEqual({ indices: [] });
  });
});

// ---------------------------------------------------------------------------
// A-family: curate-smart (legacy smartCurateReferences LLM block)
// ---------------------------------------------------------------------------

const SMART_INPUT = {
  topic: "TMC1 mechanotransduction",
  field: "biophysics",
  targetWords: 3000,
  refs: [
    { id: "a", title: "TMC1 structure", year: "2022" },
    { id: "b", title: "Hair cell transduction", year: "2020" },
    { id: "c", title: "Algae", year: "2011" },
    { id: "d", title: "TMC2 channel", year: "2019" },
    { id: "e", title: "Stereocilia mechanics", year: "2018" },
    { id: "f", title: "Channel gating", year: "2021" },
    { id: "g", title: "More refs", year: "2017" },
  ],
  scores: [
    { index: 1, relevance: 9, importance: 9, depth: "fulltext" as const, reason: "", priority: 9.4, tier: "core" as const },
    { index: 2, relevance: 8, importance: 7, depth: "abstract" as const, reason: "", priority: 7.1, tier: "core" as const },
    { index: 3, relevance: 2, importance: 1, depth: "metadata" as const, reason: "", priority: 1.3, tier: "marginal" as const },
    { index: 4, relevance: 7, importance: 8, depth: "abstract" as const, reason: "", priority: 7.0, tier: "important" as const },
    { index: 5, relevance: 6, importance: 6, depth: "abstract" as const, reason: "", priority: 5.7, tier: "important" as const },
    { index: 6, relevance: 5, importance: 5, depth: "metadata" as const, reason: "", priority: 4.6, tier: "important" as const },
    { index: 7, relevance: 4, importance: 4, depth: "metadata" as const, reason: "", priority: 3.7, tier: "marginal" as const },
  ],
  typical: 25,
  softFloor: 6,
  hardCap: 30,
};

describe("skill/curate-smart (A-family)", () => {
  test("contract + registered", () => {
    expect(curateSmartSkill.id).toBe("curate-smart");
    expect(curateSmartSkill.taskType).toBe("curate-smart");
    expect(curateSmartSkill.sseStep).toBe("curate"); // unified SSE step
    expect(SKILLS.curateSmart).toBe(curateSmartSkill);
    expect(curateSmartSkill.chat.temperature).toBe(0.2);
  });

  test("deriveScoredOrder sorts priority-desc (legacy order derivation)", () => {
    const order = deriveScoredOrder(SMART_INPUT);
    expect(order).toHaveLength(7);
    expect(order[0].score.priority).toBeGreaterThanOrEqual(order[6].score.priority);
    expect(order[0].ref.id).toBe("a"); // priority 9.4 first
    expect(order[6].ref.id).toBe("c"); // priority 1.3 last
  });

  test("prompt: budget window, rules and STRICT JSON schema", () => {
    const { system, prompt } = curateSmartSkill.buildPrompt(SMART_INPUT);
    expect(system).toContain("citation strategist");
    expect(prompt).toContain("3000 words");
    expect(prompt).toContain("Acceptable range: 6-30");
    expect(prompt).toContain("PRIORITY 9.4"); // sorted list leads with top priority
    expect(prompt).toContain("plannedCount");
  });

  test("metadata rows match the legacy session shape", () => {
    expect(curateSmartSkill.metadata!(SMART_INPUT)).toEqual({
      pool: 7,
      typical: 25,
      softFloor: 6,
      hardCap: 30,
    });
  });

  test("postProcess: dedupe (insertion order) + range filter + rationale cap", () => {
    const out = curateSmartSkill.postProcess!(
      { indices: [2, 2, 5, 99, 1], rationale: "x".repeat(500) } as any,
      SMART_INPUT,
    );
    expect(out.indices).toEqual([2, 5, 1]); // dedupe keeps first, 99 dropped
    expect(out.rationale.length).toBe(240); // legacy slice(0, 240)
  });

  test("fallback: empty indices + empty rationale (caller mechanical path)", () => {
    const out = curateSmartSkill.fallback!(SMART_INPUT, new Error("storm"));
    expect(out).toEqual({ indices: [], rationale: "" });
  });
});

// ---------------------------------------------------------------------------
// B-family: review-core (legacy reviewArticleCore LLM block)
// ---------------------------------------------------------------------------

const REVIEW_INPUT = {
  title: "TMC1 review",
  abstract: null,
  content: "## Introduction\n\nTMC1 forms the channel [1].",
  factBlock: "",
};

describe("skill/review-core (B-family)", () => {
  test("contract + registered; NO fallback (provider failures rethrow, legacy)", () => {
    expect(reviewCoreSkill.id).toBe("review");
    expect(reviewCoreSkill.taskType).toBe("review");
    expect(reviewCoreSkill.sseStep).toBe("review");
    expect(SKILLS.review).toBe(reviewCoreSkill);
    expect(reviewCoreSkill.chat.temperature).toBe(0.4);
    expect(reviewCoreSkill.fallback).toBeUndefined();
  });

  test("prompt: title/content/fact block + weakness-class schema", () => {
    const { system, prompt } = reviewCoreSkill.buildPrompt({
      ...REVIEW_INPUT,
      factBlock: "FACT-CHECK FINDINGS:\n- CONTRADICTED claim",
    });
    expect(system).toContain("peer reviewer");
    expect(prompt).toContain("ARTICLE TITLE: TMC1 review");
    expect(prompt).toContain("TMC1 forms the channel [1].");
    expect(prompt).toContain("FACT-CHECK FINDINGS:");
    expect(prompt).toContain("weakness_classes");
    expect(prompt).toContain("Output JSON only.");
  });

  test("metadata: legacy mode row", () => {
    expect(reviewCoreSkill.metadata!(REVIEW_INPUT)).toEqual({
      mode: "review-core",
      title: "TMC1 review",
    });
  });

  test("postProcess: weakness classes normalized (advisory kept, garbage → fixable)", () => {
    const parsed: any = {
      scores: { overall: 7 },
      verdict: "minor-revision",
      summary: "ok",
      strengths: ["s1"],
      weaknesses: ["w1", "w2", "w3"],
      weakness_classes: ["advisory", "GARBAGE VALUE", undefined],
      suggestions: [],
    };
    const out = reviewCoreSkill.postProcess!(parsed, REVIEW_INPUT);
    expect(out.weaknessClasses).toEqual(["advisory", "fixable", "fixable"]);
  });

  test("postProcess: missing weakness_classes array → all fixable (legacy)", () => {
    const parsed: any = {
      scores: {}, verdict: "accept", summary: "", strengths: [],
      weaknesses: ["a", "b"], suggestions: [],
    };
    const out = reviewCoreSkill.postProcess!(parsed, REVIEW_INPUT);
    expect(out.weaknessClasses).toEqual(["fixable", "fixable"]);
  });

  test("parse fallback shape is the legacy safeParseJSON default", () => {
    expect(REVIEW_CORE_PARSE_FALLBACK.scores.overall).toBe(5);
    expect(REVIEW_CORE_PARSE_FALLBACK.verdict).toBe("major-revision");
    expect(REVIEW_CORE_PARSE_FALLBACK.summary).toBe("Review parsing failed.");
  });
});

// ---------------------------------------------------------------------------
// B-family: revision (whole-article prose skill)
// ---------------------------------------------------------------------------

const REVISE_INPUT = {
  title: "TMC1 review",
  content: "## Introduction\n\nIntro text.\n\n## Structure\n\nBody.\n\n## References\n\n[1] Ref.",
  feedbackBlock: "WEAKNESSES:\n- w1",
  mode: "surgical" as const,
  round: 2,
  contractTitles: ["Introduction", "Structure", "References"],
  retryFeedback: "Heading count mismatch",
};

describe("skill/revision (B-family, prose)", () => {
  test("contract + registered; NO fallback; maxTokens 16384 legacy", () => {
    expect(reviseArticleSkill.id).toBe("revision");
    expect(reviseArticleSkill.taskType).toBe("revise");
    expect(reviseArticleSkill.sseStep).toBe("repair");
    expect(SKILLS.revision).toBe(reviseArticleSkill);
    expect(reviseArticleSkill.chat.maxTokens).toBe(16384);
    expect(reviseArticleSkill.fallback).toBeUndefined();
  });

  test("surgical prompt pins the STRUCTURAL CONTRACT + retry block", () => {
    const { system, prompt } = reviseArticleSkill.buildPrompt(REVISE_INPUT);
    expect(system).toContain("meticulous scientific editor");
    expect(prompt).toContain("STRUCTURAL CONTRACT (NON-NEGOTIABLE");
    expect(prompt).toContain('3. ## References');
    expect(prompt).toContain("YOUR PREVIOUS REVISION ATTEMPT WAS REJECTED");
    expect(prompt).toContain("Heading count mismatch");
  });

  test("full mode: no structural contract, legacy revise-all prompt", () => {
    const { system, prompt } = reviseArticleSkill.buildPrompt({
      ...REVISE_INPUT,
      mode: "full",
      retryFeedback: undefined,
    });
    expect(prompt).not.toContain("STRUCTURAL CONTRACT");
    expect(prompt).not.toContain("PREVIOUS REVISION ATTEMPT");
    expect(prompt).toContain("address ALL weaknesses and suggestions");
  });

  test("metadata: legacy mode/round rows", () => {
    expect(reviseArticleSkill.metadata!(REVISE_INPUT)).toEqual({
      mode: "revise-surgical",
      round: 2,
    });
  });

  test("prose parse is the identity (no JSON)", () => {
    expect(reviseArticleSkill.parse!("raw prose", "" as any)).toBe("raw prose");
  });

  test("postProcess strips revision wrappers (fence-only and preamble-only)", () => {
    // NOTE (legacy quirk, pinned): the stripper runs fence-stripping BEFORE
    // preamble-stripping, so an output with BOTH a preamble AND a fence
    // keeps the leading fence — the legacy single-pass order, kept verbatim.
    const fenced = "```markdown\n## Introduction\n\nText.\n```";
    const viaSkill = reviseArticleSkill.postProcess!(fenced, REVISE_INPUT);
    expect(viaSkill).not.toContain("```");
    expect(viaSkill).toContain("## Introduction");

    const preamble = "Here's the revised article:\n\nBody text.";
    expect(reviseArticleSkill.postProcess!(preamble, REVISE_INPUT)).toBe("Body text.");
  });
});

// ---------------------------------------------------------------------------
// B-family: revision-scoped (per-section prose skill)
// ---------------------------------------------------------------------------

describe("skill/revision-scoped (B-family, prose)", () => {
  const SCOPED_INPUT = {
    title: "TMC1 review",
    heading: "Introduction",
    sectionText: "The channel conducts ions [1].",
    findingsBlock: 'FACT-CHECK CONTRADICTED (quantitative): "claims 180°"',
    scoresLine: "verdict=minor-revision, overall=7/10, citations=8/10",
    round: 1,
    sectionIdx: 2,
  };

  test("contract + registered; maxTokens 8192 legacy", () => {
    expect(reviseSectionSkill.id).toBe("revision");
    expect(reviseSectionSkill.taskType).toBe("revise");
    expect(reviseSectionSkill.sseStep).toBe("repair");
    expect(SKILLS.revisionScoped).toBe(reviseSectionSkill);
    expect(reviseSectionSkill.chat.maxTokens).toBe(8192);
    expect(reviseSectionSkill.chat.temperature).toBe(0.3);
    expect(reviseSectionSkill.fallback).toBeUndefined();
  });

  test("prompt: heading as CONTEXT ONLY, findings, minimal-edit rules", () => {
    const { system, prompt } = reviseSectionSkill.buildPrompt(SCOPED_INPUT);
    expect(system).toContain("repairs ONE section");
    expect(prompt).toContain('SECTION HEADING (context only — do NOT output it): "## Introduction"');
    expect(prompt).toContain("FINDINGS TO RESOLVE IN THIS SECTION:");
    expect(prompt).toContain("MINIMAL edits");
  });

  test("metadata: legacy mode/round/section rows", () => {
    expect(reviseSectionSkill.metadata!(SCOPED_INPUT)).toEqual({
      mode: "revise-scoped",
      round: 1,
      section: 3, // 0-based idx 2 → legacy 1-based row
    });
  });

  test("postProcess strips wrappers AND a leading heading echo", () => {
    const echo = "## Introduction\n\nRevised body text that is long enough to matter here.";
    const out = reviseSectionSkill.postProcess!(echo, SCOPED_INPUT);
    expect(out.startsWith("## ")).toBe(false);
    expect(out).toContain("Revised body text");
  });
});

// ---------------------------------------------------------------------------
// B-family: fact-check arbitration
// ---------------------------------------------------------------------------

const CLAIM = {
  id: 7,
  category: "quantitative" as const,
  sentence: "The channel shifts by 180° [5].",
  citedNums: [5],
  searchQuery: "TMC1 180",
};

const ARB_INPUT = {
  claim: CLAIM,
  evidence: [
    { name: "Result A", snippet: "180 degree rotation reported", url: "https://a", host_name: "a.org" },
    { name: "Result B", snippet: "other", url: "https://b", host_name: "b.org" },
    { name: "Result C", snippet: "more", url: "https://c", host_name: "c.org" },
    { name: "Result D", snippet: "extra", url: "https://d", host_name: "d.org" },
  ],
  citedRefs: [{ authors: "Jeong", year: "2022", title: "TMC1 structure" }],
  abstracts: [],
};

describe("skill/fact-check (B-family)", () => {
  test("contract + registered; thinking disabled; NO fallback", () => {
    expect(factCheckArbitrateSkill.id).toBe("fact-check");
    expect(factCheckArbitrateSkill.taskType).toBe("review");
    expect(factCheckArbitrateSkill.sseStep).toBe("review");
    expect(SKILLS.factCheck).toBe(factCheckArbitrateSkill);
    expect(factCheckArbitrateSkill.chat.temperature).toBe(0.1);
    expect(factCheckArbitrateSkill.chat.maxTokens).toBe(3000);
    expect((factCheckArbitrateSkill.chat as any).thinking).toBe(false);
    expect(factCheckArbitrateSkill.fallback).toBeUndefined();
  });

  test("prompt: claim, cited sources, evidence blocks (cap 5), verdict schema", () => {
    const { system, prompt } = factCheckArbitrateSkill.buildPrompt(ARB_INPUT);
    expect(system).toContain("forensic fact-checker");
    expect(prompt).toContain('CHECK 7 (category: quantitative)');
    expect(prompt).toContain('The channel shifts by 180° [5].');
    expect(prompt).toContain("SENTENCE CITES: [5]");
    expect(prompt).toContain("[E1] Result A");
    expect(prompt).toContain("[E4]"); // 4 ≤ 5 evidence blocks kept (legacy slice(0,5))
  });

  test("parse: ok JSON passes through; no-JSON THROWS (legacy explicit error)", () => {
    expect(() =>
      factCheckArbitrateSkill.parse!("no json here at all", { checks: [] } as any),
    ).toThrow("arbiter returned no JSON");
    const ok = factCheckArbitrateSkill.parse!(
      '{"checks":[{"id":7,"verdict":"VERIFIED","confidence":80,"reason":"r","evidence_quote":"q"}]}',
      { checks: [] } as any,
    );
    expect(ok.checks[0].verdict).toBe("VERIFIED");
  });

  test("postProcess: verdict whitelist + confidence clamp + url cap 3", () => {
    const out = factCheckArbitrateSkill.postProcess!(
      {
        checks: [
          {
            verdict: "maybe",
            confidence: 250,
            reason: "x".repeat(400),
            evidence_quote: "y".repeat(400),
          },
        ],
      } as any,
      ARB_INPUT,
    );
    expect(out.claimId).toBe(7);
    expect(out.verdict).toBe("UNVERIFIABLE"); // garbage verdict → UNVERIFIABLE
    expect(out.confidence).toBe(100); // clamped
    expect(out.reason.length).toBe(300);
    expect(out.evidenceQuote.length).toBe(300);
    expect(out.evidenceUrls).toHaveLength(3); // cap 3 of 4
    expect(out.evidenceUrls[0]).toBe("https://a");
  });

  test("metadata: legacy claimCategory/cited rows", () => {
    expect(factCheckArbitrateSkill.metadata!(ARB_INPUT)).toEqual({
      claimCategory: "quantitative",
      cited: true,
    });
  });
});

// ---------------------------------------------------------------------------
// B-family: evidence-extract (per-batch)
// ---------------------------------------------------------------------------

const EXTRACT_INPUT = {
  topic: "TMC1",
  field: "biophysics",
  batch: [
    { id: "a", title: "TMC1", authors: "Jeong", year: "2022", journal: "Nature", abstract: "Structure." },
    { id: "b", title: "TMC2", authors: "Lab", year: "2019" },
  ],
  batchNo: 2,
  totalBatches: 4,
  batchStartIndex: 3,
  totalRefs: 10,
  fullTexts: new Map([["a", "Full text words ".repeat(100)]]),
};

describe("skill/evidence-extract (B-family)", () => {
  test("contract + registered", () => {
    expect(evidenceExtractSkill.id).toBe("evidence-extract");
    expect(evidenceExtractSkill.taskType).toBe("analyze");
    expect(evidenceExtractSkill.sseStep).toBe("analyze");
    expect(SKILLS.evidenceExtract).toBe(evidenceExtractSkill);
    expect(evidenceExtractSkill.chat.temperature).toBe(0.2);
  });

  test("prompt: batch ordinal, [REF-n] global numbering, full-text excerpt", () => {
    const { system, prompt } = evidenceExtractSkill.buildPrompt(EXTRACT_INPUT);
    expect(system).toContain("anti-hallucination");
    expect(prompt).toContain("SOURCES (batch 2):");
    expect(prompt).toContain("[REF-4]"); // batchStartIndex 3 → first ref [REF-4]
    expect(prompt).toContain("FULL-TEXT EXCERPT");
    expect(prompt).toContain('"evidence"');
  });

  test("postProcess: range filter, short-claim drop, kind finding, cap 400", () => {
    const out = evidenceExtractSkill.postProcess!(
      {
        evidence: [
          { ref: 1, claims: ["A legitimate claim long enough to pass."] },
          { ref: 99, claims: ["Out of range ref entirely."] },
          { ref: 2, claims: ["too short", " ".repeat(500)] },
        ],
      } as any,
      EXTRACT_INPUT,
    );
    // ref 99 dropped; "too short" (<9 chars) dropped; 500-space claim capped
    expect(out.evidence).toHaveLength(2);
    expect(out.evidence.every((e) => e.kind === "finding")).toBe(true);
    expect(out.evidence.find((e) => e.refIndex === 2)!.claim.length).toBeLessThanOrEqual(400);
  });

  test("metadata: legacy batch/refs rows", () => {
    expect(evidenceExtractSkill.metadata!(EXTRACT_INPUT)).toEqual({ batch: 2, refs: 2 });
  });

  test("fallback: empty evidence (batch contributes 0, legacy catch)", () => {
    expect(evidenceExtractSkill.fallback!(EXTRACT_INPUT, new Error("x"))).toEqual({ evidence: [] });
  });
});

// ---------------------------------------------------------------------------
// B-family: evidence-allocate
// ---------------------------------------------------------------------------

const ALLOC_INPUT = {
  topic: "TMC1",
  sections: [
    { title: "Introduction", focus: "context" },
    { title: "Structure", focus: "cryo-EM" },
  ],
  refs: [
    { title: "r1", authors: "A", year: "2020" },
    { title: "r2", authors: "B", year: "2021" },
    { title: "r3", authors: "C", year: "2022" },
  ],
  evidence: [
    { refIndex: 1, claim: "c1", kind: "finding" as const },
    { refIndex: 2, claim: "c2", kind: "finding" as const },
  ],
  minRefs: 6,
  maxRefs: 14,
};

describe("skill/evidence-allocate (B-family)", () => {
  test("contract + registered", () => {
    expect(evidenceAllocateSkill.id).toBe("evidence-allocate");
    expect(evidenceAllocateSkill.taskType).toBe("allocate");
    expect(evidenceAllocateSkill.sseStep).toBe("allocate");
    expect(SKILLS.evidenceAllocate).toBe(evidenceAllocateSkill);
    expect(evidenceAllocateSkill.chat.temperature).toBe(0.2);
  });

  test("prompt: section plan, ref list, evidence digest, min/max window", () => {
    const { system, prompt } = evidenceAllocateSkill.buildPrompt(ALLOC_INPUT);
    expect(system).toContain("architect");
    expect(system).toContain("Aim for 6-14 references per section"); // legacy: budget window rides the SYSTEM prompt
    expect(prompt).toContain("SECTION 1: Introduction");
    expect(prompt).toContain("[REF-1]");
    expect(prompt).toContain('"allocations"');
  });

  test("postProcess: section range filter, ref range filter, dedupe", () => {
    const out = evidenceAllocateSkill.postProcess!(
      {
        allocations: [
          { section: 1, refs: [1, 1, 2, 99] },
          { section: 5, refs: [3] }, // out of range section → dropped
          { section: 2, refs: [] },  // empty → dropped (legacy)
        ],
      } as any,
      ALLOC_INPUT,
    );
    expect(out.allocations).toHaveLength(1);
    expect(out.allocations[0]).toEqual({ section: 1, refs: [1, 2] });
  });

  test("fallback: empty allocations (caller returns keyword alloc, legacy catch)", () => {
    expect(evidenceAllocateSkill.fallback!(ALLOC_INPUT, new Error("x"))).toEqual({ allocations: [] });
  });
});

// ---------------------------------------------------------------------------
// Format contract: the three NEW structural gates
// ---------------------------------------------------------------------------

describe("format-contract RT6 structural gates", () => {
  test("registry order: structural preludes FIRST, then sanitize…cjk", () => {
    expect(FORMAT_GATE_IDS).toEqual([
      "remove-ref-blocks",
      "ascii-punctuation",
      "section-markdown",
      "sanitize",
      "citation-keys",
      "uniform-section",
      "cjk-residual",
    ]);
    expect(FORMAT_GATES.find((g) => g.id === "ascii-punctuation")!.englishOnly).toBe(true);
    expect(FORMAT_GATES.find((g) => g.id === "remove-ref-blocks")!.englishOnly).toBeUndefined();
    expect(FORMAT_GATES.find((g) => g.id === "section-markdown")!.englishOnly).toBeUndefined();
  });

  test("remove-ref-blocks strips a trailing References block", () => {
    const content = "## Introduction\n\nProse [1].\n\n## References\n\n[1] Some ref.";
    const out = applyFormatContract(content, { gates: ["remove-ref-blocks"] });
    expect(out.applied).toEqual(["remove-ref-blocks"]);
    expect(out.content).not.toContain("## References");
    expect(out.content).toContain("Prose [1].");
  });

  test("ascii-punctuation converts fullwidth punctuation (EN only)", () => {
    const en = applyFormatContract("Claim with fullwidth comma，and period．", {
      gates: ["ascii-punctuation"],
      language: "en",
    });
    expect(en.applied).toEqual(["ascii-punctuation"]);
    expect(en.content).not.toContain("，");
    // zh skips the englishOnly gate even when requested
    const zh = applyFormatContract("中文，标点。", {
      gates: ["ascii-punctuation"],
      language: "zh",
    });
    expect(zh.applied).toEqual([]);
    expect(zh.content).toContain("，");
  });

  test("section-markdown normalizes stray sub-headings", () => {
    const out = applyFormatContract("## Section\n\n### Sub head\n\nProse here.", {
      gates: ["section-markdown"],
    });
    expect(out.applied).toEqual(["section-markdown"]);
    // normalizeSectionMarkdown demotes/normalizes heading lines — the exact
    // behavior is writing.ts's; the contract only pins REGISTRATION + order.
    expect(typeof out.content).toBe("string");
    expect(out.content.length).toBeGreaterThan(0);
  });

  test("BEHAVIOR LOCK: on heading-free input the 4-gate chain ≡ the legacy chunked combinator's no-## branch", () => {
    // normalizeArticleBodySections has TWO modes: with ## headings it is the
    // CHUNKED combinator (per-section, headings pinned — repair/polish/v1
    // compose keep that call AS-IS by design); with NO ## headings it is
    // exactly the whole-text 4-function chain, which the registered gates
    // now own. This lock pins the no-## equivalence (writing.ts :697-701).
    const samples = [
      "Prose with １ fullwidth，punct and a trailing block.\n\n### Citations\n\n[1] A.\n[2] B.",
      "Plain paragraph with no headings at all. Just text [1].\n\n- a stray list item",
    ];
    for (const body of samples) {
      const viaLegacy = normalizeArticleBodySections(body);
      const viaContract = applyFormatContract(body, {
        gates: ["remove-ref-blocks", "ascii-punctuation", "section-markdown", "uniform-section"],
        language: "en",
      }).content;
      expect(viaContract).toBe(viaLegacy);
    }
    // And the chunked mode is NOT the whole-text chain (the reason
    // repair/polish/v1-compose keep the combinator call):
    const multi = "## One\n\nText [1].\n\n## References\n\n[1] Ref A.\n\n## Two\n\nMore.";
    const viaContract = applyFormatContract(multi, {
      gates: ["remove-ref-blocks", "ascii-punctuation", "section-markdown", "uniform-section"],
      language: "en",
    }).content;
    expect(viaContract).not.toBe(normalizeArticleBodySections(multi));
  });

  test("subset + reorder resistance extends to the new gates", () => {
    const out = applyFormatContract("Prose.", {
      gates: ["section-markdown", "ascii-punctuation", "remove-ref-blocks"],
    });
    expect(out.applied).toEqual(["remove-ref-blocks", "ascii-punctuation", "section-markdown"]);
  });
});

// ---------------------------------------------------------------------------
// stripRevisionWrappers relocation (writing.ts)
// ---------------------------------------------------------------------------

describe("writing/stripRevisionWrappers (relocated RT6)", () => {
  test("strips fences, 'here is' preambles; mid-text labels survive", () => {
    expect(stripRevisionWrappers("```markdown\nBody\n```")).toBe("Body");
    expect(stripRevisionWrappers("Here's the revised article:\n\nBody")).toBe("Body");
    expect(stripRevisionWrappers("The revised article follows:\n\nBody")).toBe("Body");
    expect(stripRevisionWrappers("Plain body")).toBe("Plain body");
  });
});
