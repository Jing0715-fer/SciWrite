/**
 * round-RT7 QA: unit tests for the migrated skill families —
 *   - coherence family: coherence-review / coherence-edit
 *     (skills-coherence.ts, legacy coherence-polish.ts)
 *   - gap family: gap-design / gap-research (skills-gap.ts, legacy
 *     research-gap.ts — the identify LLM pass + the relevance gate)
 *   - knowledge family: knowledge / knowledge-summary (skills-knowledge.ts,
 *     legacy knowledge-verify.ts — the per-batch fill + the gap digest)
 *
 * Every test pins the LEGACY semantics the migration promised to keep
 * (verbatim prompts are spot-checked by their invariant markers, not by
 * full-string equality — the source of truth stays in the skill files).
 *
 * The behavior-equivalence locks that matter most here:
 *   - the CR-B#1 batch-range check (locally renumbered rows must NOT leak
 *     into other batches' rows),
 *   - the MISSING-only fill policy (a field that already has a value is
 *     never overwritten),
 *   - the sentinel-echo rejection (cleanFill vs "[journal=MISSING]"),
 *   - the round-RT2 keep-0 distinction (parseOk=false → PubMed fallback
 *     ids; parseOk=true + keep:[] → the caller's mechanical ranking),
 *   - the degenerate-output guard (≤80 chars → the original section text).
 */

import { test, expect, describe } from "bun:test";
import {
  coherenceEditSkill,
  coherenceReviewSkill,
  COHERENCE_MAX_FINDINGS,
  COHERENCE_MAX_SECTIONS,
} from "@/lib/skill/skills-coherence";
import {
  gapDesignSkill,
  gapResearchSkill,
  GAP_AGENT_MAX_GAPS,
} from "@/lib/skill/skills-gap";
import {
  knowledgeDigestSkill,
  knowledgeFillSkill,
  cleanFill,
  validFill,
} from "@/lib/skill/skills-knowledge";
import { SKILLS } from "@/lib/skill/registry";

// ---------------------------------------------------------------------------
// coherence family (legacy coherence-polish.ts)
// ---------------------------------------------------------------------------

const COHERENCE_INPUT = {
  title: "PCSK9 and LDL receptor trafficking",
  topic: "PCSK9",
  numberedBody: "## 1. Introduction\n\nPCSK9 binds [1].\n\n## 2. Structure\n\nThe structure was solved [2].",
  sectionCount: 2,
};

describe("skill/coherence-review", () => {
  test("contract: id/taskType/sseStep + registered", () => {
    expect(coherenceReviewSkill.id).toBe("coherence-review");
    expect(coherenceReviewSkill.taskType).toBe("review"); // legacy role routing
    expect(coherenceReviewSkill.sseStep).toBe("polish"); // RT6 unification: the pass lives in STEP 8.6
    expect(SKILLS.coherenceReview).toBe(coherenceReviewSkill);
    expect(coherenceReviewSkill.chat.temperature).toBe(0.3);
    expect(typeof coherenceReviewSkill.fallback).toBe("function"); // non-fatal by design
  });

  test("prompt: full body + the six finding kinds + the cap", () => {
    const { system, prompt } = coherenceReviewSkill.buildPrompt(COHERENCE_INPUT);
    expect(system).toContain("FINAL coherence pass");
    expect(prompt).toContain("ARTICLE TITLE: PCSK9 and LDL receptor trafficking");
    expect(prompt).toContain("## 2. Structure");
    for (const kind of ["repetition", "contradiction", "terminology", "numeric", "transition", "cross-ref"]) {
      expect(prompt).toContain(kind);
    }
    expect(prompt).toContain(`at most ${COHERENCE_MAX_FINDINGS} findings`);
    expect(prompt).toContain("STRICT JSON");
  });

  test("postProcess: type whitelist + section range + cap + truncation", () => {
    const parsed = {
      summary: "Mostly coherent.",
      findings: [
        { type: "repetition", sections: [1, 2], description: "x".repeat(600), suggestion: "y".repeat(500) },
        { type: "nonsense-kind", sections: [1, 2], description: "dropped" }, // invalid type
        { type: "numeric", sections: [99, 100], description: "every section out of range — dropped" },
        { type: "transition", sections: [1], description: "single-section — still valid per legacy (no ≥2 filter)" },
        ...Array.from({ length: 12 }, (_, i) => ({ type: "terminology", sections: [1, 2], description: `d${i}` })),
      ],
    };
    const out = coherenceReviewSkill.postProcess!(parsed as any, COHERENCE_INPUT);
    // cap at COHERENCE_MAX_FINDINGS
    expect(out.findings.length).toBeLessThanOrEqual(COHERENCE_MAX_FINDINGS);
    // invalid type dropped, fully-out-of-range sections dropped, valid single-section kept
    expect(out.findings.some((f) => f.type === "repetition")).toBe(true);
    expect(out.findings.some((f) => f.type === "numeric")).toBe(false);
    // description truncated to 500, suggestion to 400
    const first = out.findings[0];
    expect(first.description.length).toBeLessThanOrEqual(500);
    expect(first.suggestion.length).toBeLessThanOrEqual(400);
    // sections are deduped + sorted
    expect(first.sections).toEqual([1, 2]);
  });

  test("fallback: empty review (legacy ran:false envelope is the caller's job)", () => {
    const out = coherenceReviewSkill.fallback!(COHERENCE_INPUT, new Error("429"));
    expect(out).toEqual({ summary: "", findings: [] });
  });
});

const EDIT_INPUT = {
  title: "PCSK9 and LDL receptor trafficking",
  heading: "Structure",
  prevTail: "…PCSK9 was first identified as a proprotein convertase.",
  nextHead: "The LDL receptor binds PCSK9 at the EGF-A domain…",
  sectionText: "PCSK9 comprises a prodomain, a catalytic domain, and a C-terminal domain [3]. The catalytic domain cleaves LDLR.",
  findings: [
    { type: "terminology" as const, sections: [2, 4], description: "domain naming drifts", suggestion: "use prodomain consistently" },
  ],
};

describe("skill/coherence-edit", () => {
  test("contract: prose skill — identity parse, wrapper strip in postProcess", () => {
    expect(coherenceEditSkill.id).toBe("coherence-edit");
    expect(coherenceEditSkill.taskType).toBe("revise");
    expect(coherenceEditSkill.sseStep).toBe("polish");
    expect(SKILLS.coherenceEdit).toBe(coherenceEditSkill);
    expect(coherenceEditSkill.parse!("raw", "")).toBe("raw");
    expect(coherenceEditSkill.chat.temperature).toBe(0.3);
  });

  test("prompt: heading pinned + neighbors + findings + strict rules", () => {
    const { system, prompt } = coherenceEditSkill.buildPrompt(EDIT_INPUT);
    expect(system).toContain("never invent facts");
    expect(prompt).toContain("SECTION HEADING (do NOT reword it): ## Structure");
    expect(prompt).toContain("PREVIOUS SECTION'S CLOSING");
    expect(prompt).toContain("NEXT SECTION'S OPENING");
    expect(prompt).toContain("TERMINOLOGY DRIFT");
    expect(prompt).toContain("±15%");
    expect(prompt).toContain("PRESERVE every inline citation marker");
  });

  test("postProcess: strips codefence + own-heading echo, keeps foreign headings", () => {
    const body = "PCSK9 comprises a prodomain [3] and a catalytic domain, with the C-terminal domain mediating LDLR binding and uptake in hepatocytes.";
    const fenced = "```\n" + body + "\n```";
    const withOwnHeading = "## Structure\n\n" + body;
    const withForeignHeading = "## 2. Structure\n\n" + body; // different wording — kept
    expect(coherenceEditSkill.postProcess!(fenced, EDIT_INPUT)).toBe(body);
    expect(coherenceEditSkill.postProcess!(withOwnHeading, EDIT_INPUT)).toBe(body);
    expect(coherenceEditSkill.postProcess!(withForeignHeading, EDIT_INPUT)).toContain("## 2. Structure");
  });

  test("validate: degenerate output (≤80 chars) is FATAL → fallback returns the original text", () => {
    const short = "Too short.";
    const v = coherenceEditSkill.validate!(short, EDIT_INPUT);
    expect(v.ok).toBe(false);
    expect(v.issues[0].startsWith("fatal:")).toBe(true);
    const out = coherenceEditSkill.fallback!(EDIT_INPUT, new Error("x"));
    expect(out).toBe(EDIT_INPUT.sectionText);
    // a real-length output passes
    expect(coherenceEditSkill.validate!(EDIT_INPUT.sectionText, EDIT_INPUT).ok).toBe(true);
  });

  test("COHERENCE_MAX_SECTIONS re-exported for the caller's ≤5 loop", () => {
    expect(COHERENCE_MAX_SECTIONS).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// gap family (legacy research-gap.ts)
// ---------------------------------------------------------------------------

const GAP_INPUT = {
  topic: "xCT/GPATC3 heterodimer structure",
  field: "structural biology",
  coverageLines: "§1: Structure — FOCUS: cryo-EM\n  allocated refs (2):\n    - xCT structure paper",
  sectionCount: 3,
  sectionTitles: ["Structure", "Function", "Disease links"],
  remainingCapacity: 2,
};

describe("skill/gap-design (identify pass)", () => {
  test("contract: id/taskType/sseStep + registered", () => {
    expect(gapDesignSkill.id).toBe("gap-design");
    expect(gapDesignSkill.taskType).toBe("gather");
    expect(gapDesignSkill.sseStep).toBe("gapAgent");
    expect(SKILLS.gapDesign).toBe(gapDesignSkill);
    expect(gapDesignSkill.chat.temperature).toBe(0.3);
  });

  test("prompt: coverage lines + remaining capacity + query contract", () => {
    const { system, prompt } = gapDesignSkill.buildPrompt(GAP_INPUT);
    expect(system).toContain("evidence auditor");
    expect(prompt).toContain("RESEARCH TOPIC: xCT/GPATC3 heterodimer structure");
    expect(prompt).toContain("§1: Structure");
    expect(prompt).toContain("up to 2 CRITICAL evidence gaps"); // remainingCapacity, not the global MAX_GAPS
    expect(prompt).toContain("sectionIndex is 0-based");
  });

  test("postProcess: range check + query whitelist + per-gap cap + sectionTitle fill", () => {
    const parsed = {
      gaps: [
        { sectionIndex: 1, gap: "cryo-EM structure of the heterodimer", queries: [{ database: "pubmed", query: "xCT GPATC3 cryo-EM" }, { database: "web", query: "xCT structure review" }, { database: "pubmed", query: "EXTRA query beyond cap" }] },
        { sectionIndex: 99, gap: "out of range", queries: [{ database: "pubmed", query: "x" }] }, // dropped
        { sectionIndex: 1, gap: "no valid queries", queries: [{ database: "arxiv", query: "x" }] }, // dropped (no valid db)
        { sectionIndex: "2", gap: "string index coerced", queries: [{ database: "web", query: "disease link mechanism" }] },
      ],
    };
    const out = gapDesignSkill.postProcess!(parsed as any, GAP_INPUT);
    expect(out.gaps).toHaveLength(2);
    expect(out.gaps[0].queries).toHaveLength(2); // per-gap cap
    expect(out.gaps[0].queries[0].query).toBe("xCT GPATC3 cryo-EM");
    expect(out.gaps[1].sectionIndex).toBe(2);
    expect(out.gaps[1].sectionTitle).toBe("Disease links"); // filled from sectionTitles
  });

  test("fallback: empty gaps (mechanical gaps still run at the call-site)", () => {
    expect(gapDesignSkill.fallback!(GAP_INPUT, new Error("429"))).toEqual({ gaps: [] });
  });

  test("GAP_AGENT_MAX_GAPS re-exported (the call-site budget math)", () => {
    expect(GAP_AGENT_MAX_GAPS).toBe(3);
  });
});

const GATE_CANDIDATES = [
  { source: "pubmed" as const, title: "Cryo-EM of the human xCT-GPATC3 heterodimer", gapIndex: 0, queryUsed: "q1", externalId: null, authors: null, journal: null, year: null, url: null, doi: null, abstract: null, extra: null },
  { source: "web" as const, title: "Encyclopedia entry: cystine transport", gapIndex: 0, queryUsed: "q2", externalId: null, authors: null, journal: null, year: null, url: null, doi: null, abstract: null, extra: null },
  { source: "pubmed" as const, title: "System xc- function in ferroptosis", gapIndex: 0, queryUsed: "q1", externalId: null, authors: null, journal: null, year: null, url: null, doi: null, abstract: null, extra: null },
];

const GATE_INPUT = {
  topic: "xCT/GPATC3 heterodimer structure",
  gaps: [{ sectionIndex: 0, sectionTitle: "Structure", gap: "cryo-EM structure of the heterodimer", queries: [] }],
  candidates: GATE_CANDIDATES,
  maxNewRefs: 2,
};

describe("skill/gap-research (relevance gate)", () => {
  test("contract: id/taskType/sseStep + registered", () => {
    expect(gapResearchSkill.id).toBe("gap-research");
    expect(gapResearchSkill.taskType).toBe("gather");
    expect(gapResearchSkill.sseStep).toBe("gapAgent");
    expect(SKILLS.gapResearch).toBe(gapResearchSkill);
    expect(gapResearchSkill.chat.temperature).toBe(0.2);
  });

  test("prompt: gaps + C-numbered candidates + STRICT keep JSON", () => {
    const { system, prompt } = gapResearchSkill.buildPrompt(GATE_INPUT);
    expect(system).toContain("literature-screening assistant");
    expect(prompt).toContain("GAP 1 (§1 Structure)");
    expect(prompt).toContain("C1 [pubmed] Cryo-EM of the human xCT-GPATC3 heterodimer");
    expect(prompt).toContain('STRICT JSON: { "keep": ["C1", "C3"] }');
  });

  test("parse: parseOk flag survives (round-RT2 keep-0 distinction)", () => {
    const ok = gapResearchSkill.parse!('{"keep": ["C1", "C3"]}', { keep: [], parseOk: false });
    expect(ok).toEqual({ keep: ["C1", "C3"], parseOk: true });
    const unparseable = gapResearchSkill.parse!("Sure! Here are the ones I would keep: C1 and C3.", { keep: [], parseOk: false });
    expect(unparseable.parseOk).toBe(false);
    expect(unparseable.keep).toEqual([]);
  });

  test("postProcess: keep whitelist C\\d+ + uppercase", () => {
    const out = gapResearchSkill.postProcess!({ keep: ["c1", "C3", "junk", 7, "C12"], parseOk: true } as any);
    expect(out.keep).toEqual(["C1", "C3", "C12"]);
    expect(out.parseOk).toBe(true);
  });

  test("fallback: PubMed candidates' C-ids, capped at maxNewRefs (legacy catch)", () => {
    const out = gapResearchSkill.fallback!(GATE_INPUT, new Error("429 storm"));
    // PubMed candidates are C1 and C3; maxNewRefs=2 keeps both.
    expect(out.keep).toEqual(["C1", "C3"]);
    expect(out.parseOk).toBe(false);
    const capped = gapResearchSkill.fallback!({ ...GATE_INPUT, maxNewRefs: 1 }, new Error("x"));
    expect(capped.keep).toEqual(["C1"]);
  });
});

// ---------------------------------------------------------------------------
// knowledge family (legacy knowledge-verify.ts)
// ---------------------------------------------------------------------------

const FILL_ROWS = [
  { authors: "Jeong", year: "2022", journal: "Science" }, // complete — nothing fillable
  { authors: null, year: null, journal: null }, // everything missing
  { authors: "Zhao", year: null, journal: null }, // partial
];

const FILL_INPUT = {
  topic: "MscL mechanosensitive channels",
  field: "biophysics",
  batchNo: 2,
  totalBatches: 5,
  list: "(13) (pubmed:123) TITLE: MscL gating\n(14) (pubmed:124) TITLE: MscS\n(15) (web) TITLE: Mechanosensitive channel review",
  firstIndex: 13,
  batchSize: 3,
  rows: FILL_ROWS,
};

describe("skill/knowledge (per-batch fill)", () => {
  test("contract: id/taskType/sseStep + registered + NO fallback (hard-fail)", () => {
    expect(knowledgeFillSkill.id).toBe("knowledge");
    expect(knowledgeFillSkill.taskType).toBe("gather");
    expect(knowledgeFillSkill.sseStep).toBe("knowledge"); // RT6 unification: legacy "knowledge-verify" was outside the namespace
    expect(SKILLS.knowledge).toBe(knowledgeFillSkill);
    expect(knowledgeFillSkill.chat.temperature).toBe(0.2);
    expect(knowledgeFillSkill.fallback).toBeUndefined(); // provider failures rethrow (storm semantics at the call-site)
  });

  test("prompt: batch ordinals + MISSING contract + STRICT JSON", () => {
    const { system, prompt } = knowledgeFillSkill.buildPrompt(FILL_INPUT);
    expect(system).toContain("METADATA COMPLETION");
    expect(prompt).toContain("batch 2 of 5");
    expect(prompt).toContain("(13) (pubmed:123) TITLE: MscL gating");
    expect(prompt).toContain("Only fill fields marked MISSING");
  });

  test("postProcess: CR-B#1 batch-range check — locally renumbered rows are dropped", () => {
    // The model renumbered the batch 1..3 (classic failure); global range is 13..15.
    // Row 14 is the all-missing row, so n=14's authors/year/journal all land.
    const parsed = {
      sources: [
        { n: 1, known: true, authors: "Local Renumber", year: "2021", journal: "Nature", confidence: 0.9 },
        { n: 14, known: true, authors: "Global OK", year: "2023", journal: "Cell", confidence: 0.8 },
      ],
      missing: [],
    };
    const out = knowledgeFillSkill.postProcess!(parsed as any, FILL_INPUT);
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0].index).toBe(14);
    expect(out.sources[0].fill.authors).toBe("Global OK");
    expect(out.sources[0].fill.year).toBe("2023");
  });

  test("postProcess: MISSING-only fill policy + confidence clamp", () => {
    const parsed = {
      sources: [
        // row 13 is COMPLETE — the LLM's authors/year/journal values must be ignored
        { n: 13, known: true, authors: "Overwrite Attempt", year: "1999", journal: "Wrong Journal", confidence: 1.7 },
        // row 14 has everything missing — all three fillable
        { n: 14, known: true, authors: "Bass", year: "2002", journal: "Nature", confidence: -0.2 },
        // row 15: authors present ("Zhao") — only year/journal fillable
        { n: 15, known: false, authors: "Ignore Me", year: "2007", journal: "J Biol Chem", confidence: 0.5 },
      ],
      missing: [],
    };
    const out = knowledgeFillSkill.postProcess!(parsed as any, FILL_INPUT);
    const byIndex = new Map(out.sources.map((c) => [c.index, c]));
    expect(byIndex.get(13)!.fill).toEqual({}); // complete row: nothing filled
    expect(byIndex.get(14)!.fill).toEqual({ authors: "Bass", year: "2002", journal: "Nature" });
    expect(byIndex.get(15)!.fill).toEqual({ year: "2007", journal: "J Biol Chem" }); // authors NOT overwritten
    expect(byIndex.get(14)!.confidence).toBe(0); // -0.2 clamped
    expect(byIndex.get(13)!.confidence).toBe(1); // 1.7 clamped
  });

  test("postProcess: sentinel echoes rejected; kind whitelist on missing", () => {
    const parsed = {
      sources: [],
      missing: [
        { title: "Great Structure Paper", authors: "[authors=MISSING]", year: "1990", journal: "(journal=MISSING)", kind: "not-a-kind" },
        { title: "MISSING", kind: "landmark" }, // sentinel title → dropped
      ],
    };
    const out = knowledgeFillSkill.postProcess!(parsed as any, FILL_INPUT);
    expect(out.missing).toHaveLength(1);
    expect(out.missing[0].authors).toBeUndefined(); // sentinel echo rejected
    expect(out.missing[0].journal).toBeUndefined();
    expect(out.missing[0].kind).toBe("landmark"); // invalid kind → default
  });
});

const DIGEST_INPUT = {
  topic: "MscL mechanosensitive channels",
  field: "biophysics",
  digestTitles: "(1) MscL gating\n(2) MscS structure",
};

describe("skill/knowledge-summary (gap digest)", () => {
  test("contract: id/taskType/sseStep + registered + soft fallback", () => {
    expect(knowledgeDigestSkill.id).toBe("knowledge-summary");
    expect(knowledgeDigestSkill.taskType).toBe("gather");
    expect(knowledgeDigestSkill.sseStep).toBe("knowledge");
    expect(SKILLS.knowledgeSummary).toBe(knowledgeDigestSkill);
    expect(knowledgeDigestSkill.chat.temperature).toBe(0.2);
    expect(typeof knowledgeDigestSkill.fallback).toBe("function"); // additive stage, never load-bearing
  });

  test("prompt: compact title lines + up-to-8 suggestions", () => {
    const { system, prompt } = knowledgeDigestSkill.buildPrompt(DIGEST_INPUT);
    expect(system).toContain("assessing literature coverage");
    expect(prompt).toContain("(1) MscL gating");
    expect(prompt).toContain("Up to 8 suggestions");
  });

  test("postProcess: clean + kind whitelist; fallback: empty missing", () => {
    const parsed = { missing: [{ title: "Seminal MscS Paper", kind: "review" }, { title: "", kind: "landmark" }] };
    const out = knowledgeDigestSkill.postProcess!(parsed as any);
    expect(out.missing).toHaveLength(1);
    expect(out.missing[0].kind).toBe("review");
    expect(knowledgeDigestSkill.fallback!(DIGEST_INPUT, new Error("429"))).toEqual({ missing: [] });
  });
});

// ---------------------------------------------------------------------------
// cleanFill / validFill kernel locks (moved from knowledge-verify.ts)
// ---------------------------------------------------------------------------

describe("cleanFill/validFill kernel (relocation lock)", () => {
  test("control chars stripped; sentinel echoes rejected; quotes/periods trimmed", () => {
    expect(cleanFill("  Bass  ", 40)).toBe("Bass");
    expect(cleanFill('"Bass."', 40)).toBe("Bass");
    expect(cleanFill("[journal=MISSING]", 40)).toBeNull();
    expect(cleanFill("journal=MISSING", 40)).toBeNull();
    expect(cleanFill("(unknown)", 40)).toBeNull();
    expect(cleanFill("N/A", 40)).toBeNull();
    expect(cleanFill("B\u0007ass", 40)).toBe("Bass"); // control char
    expect(cleanFill("B".repeat(50), 10)).toBe("B".repeat(10)); // capped
    expect(cleanFill(undefined, 40)).toBeNull();
  });

  test("validFill field shapes", () => {
    expect(validFill("year", "2020")).toBe(true);
    expect(validFill("year", "20x0")).toBe(false);
    expect(validFill("year", "1800")).toBe(false);
    expect(validFill("authors", "ab")).toBe(false); // <3
    expect(validFill("journal", "x")).toBe(false); // <2
    expect(validFill("authors", "Bass et al.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// telemetry collector (RT7 backlog #5 — degradation surfacing)
// ---------------------------------------------------------------------------

import {
  getSkillDegradedCounts,
  getSkillStats,
  recordSkillTelemetry,
  resetSkillTelemetry,
} from "@/lib/skill/telemetry-collector";

describe("skill telemetry collector", () => {
  test("aggregates calls/degraded/cacheHits per skill; reset clears", () => {
    resetSkillTelemetry();
    recordSkillTelemetry({ skill: "score", ms: 100, fromCache: false, degraded: false, parseIssues: [], promptChars: 10, outputChars: 5 });
    recordSkillTelemetry({ skill: "score", ms: 200, fromCache: true, degraded: false, parseIssues: [], promptChars: 10, outputChars: 5 });
    recordSkillTelemetry({ skill: "gap-design", ms: 300, fromCache: false, degraded: true, parseIssues: ["fallback: 429"], promptChars: 10, outputChars: 5 });

    const stats = getSkillStats();
    expect(stats.calls.score).toBe(2);
    expect(stats.calls["gap-design"]).toBe(1);
    expect(stats.cacheHits.score).toBe(1);
    expect(stats.totalMs.score).toBe(300);

    // degraded view carries ONLY degraded skills (the compact wire shape)
    expect(getSkillDegradedCounts()).toEqual({ "gap-design": 1 });

    resetSkillTelemetry();
    expect(getSkillStats().calls).toEqual({});
    expect(getSkillDegradedCounts()).toEqual({});
  });
});
