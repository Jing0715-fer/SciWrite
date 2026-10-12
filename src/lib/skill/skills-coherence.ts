/**
 * Skill definitions — coherence family (RT7).
 *
 * Migrated from coherence-polish.ts (the RT6 backlog's B-family stragglers):
 *   - coherence-review ← reviewArticleCoherence's reviewing LLM call
 *   - coherence-edit   ← polishArticleCoherence's per-section re-edit (prose)
 *
 * Degradation contract (kept identical to the legacy sites — both non-fatal):
 *   - coherence-review: an LLM/provider failure degrades via the skill
 *     fallback (empty findings); the caller turns `degraded` into the legacy
 *     `ran:false + error` envelope. A garbage-JSON reply degrades via the
 *     parse fallbackValue (safeParseJSON → {summary:"",findings:[]}), which
 *     legacy treated as a CLEAN review (ran:true, 0 findings) — preserved.
 *   - coherence-edit: prose skill (identity parse, wrapper-stripping in
 *     postProcess). A degenerate output (≤80 chars after stripping) or a
 *     provider failure takes the skill fallback → the ORIGINAL section text
 *     (the caller checks `ok` and keeps the section as-is, exactly the
 *     legacy per-section catch).
 *
 * Step unification (RT6 §1 continued): the legacy metadata.step was
 * "coherence" (outside PIPELINE_STEPS); both skills now ride the polish
 * stage's step ("polish"), with `sub` rows preserved in metadata.
 *
 * Import-cycle discipline: this file imports ONLY types from business
 * modules (import type) — prompt text and per-item validation live here;
 * pool orchestration (splitting, findings→section grouping, the ≤5-section
 * loop) stays at the call-site.
 */

import type { SkillDefinition } from "./types";

// ---------------------------------------------------------------------------
// Shared contracts (moved here from coherence-polish.ts; re-exported there)
// ---------------------------------------------------------------------------

/** Finding kinds the coherence reviewer may report. */
export type CoherenceFindingType =
  | "repetition"
  | "contradiction"
  | "terminology"
  | "numeric"
  | "transition"
  | "cross-ref";

export interface CoherenceFinding {
  type: CoherenceFindingType;
  /** 1-based section numbers involved (≥2 for genuine cross-section issues). */
  sections: number[];
  /** What the cross-section defect is (specific — quote the conflicting text). */
  description: string;
  /** The minimal fix (what to change, in which section). */
  suggestion: string;
}

export interface CoherenceReviewOutput {
  summary: string;
  findings: CoherenceFinding[];
}

/** Hard cap on findings pursued per pass (budget + focus). */
export const COHERENCE_MAX_FINDINGS = 10;
/** Hard cap on sections re-edited per pass. */
export const COHERENCE_MAX_SECTIONS = 5;

const VALID_TYPES: CoherenceFindingType[] = [
  "repetition",
  "contradiction",
  "terminology",
  "numeric",
  "transition",
  "cross-ref",
];

// ---------------------------------------------------------------------------
// coherence-review — whole-article cross-section review
// (legacy: coherence-polish.ts reviewArticleCoherence, LLM block)
// ---------------------------------------------------------------------------

export interface CoherenceReviewInput {
  title: string;
  topic?: string;
  /** Pre-assembled numbered body (the caller splits + renumbers — pool orchestration). */
  numberedBody: string;
  /** Section count (for the sections-range check in postProcess). */
  sectionCount: number;
}

export const coherenceReviewSkill: SkillDefinition<CoherenceReviewInput, CoherenceReviewOutput> = {
  id: "coherence-review",
  taskType: "review", // legacy role routing (REVIEW_TASK_TYPES)
  sseStep: "polish", // RT6 unification: the coherence pass lives in STEP 8.6 (polish)
  title: "Review cross-section coherence",
  chat: { temperature: 0.3 },

  buildPrompt(input) {
    const system = `You are a senior review-article editor performing the FINAL coherence pass on a nearly-finished scientific review${input.topic ? ` about: ${input.topic}` : ""}.
Your ONLY job is to find CROSS-SECTION defects — problems that live BETWEEN sections, invisible to per-section checks. You do not judge single-section quality, style, or citation formatting.`;

    const prompt = `ARTICLE TITLE: ${input.title}
FULL ARTICLE BODY (section headings are numbered by position):

${input.numberedBody}

Find the following kinds of CROSS-SECTION defects (report ONLY issues that involve 2+ sections, or a section's relationship to its neighbors):

1. repetition — the same claim/example/finding restated in multiple sections (not a legitimate brief back-reference).
2. contradiction — two sections state incompatible facts (different values, different directionality of a mechanism, different species/attribution for the same finding).
3. terminology — the same entity named differently across sections (name vs. abbreviation, synonym switching, inconsistent species residue numbering).
4. numeric — the same quantity reported with different values/units in different sections.
5. transition — a section opens with no connection to the previous one (reads like an independent essay), or a promised link ("discussed below") never lands.
6. cross-ref — a forward/backward reference that points at the wrong section ("as shown above in Section 3" when the content is in Section 5).

Rules:
- Each finding must name the section numbers it involves (1-based, in order of appearance).
- Quote the conflicting words in the description (short excerpts, <25 words each).
- The suggestion is the MINIMAL fix and must say WHICH section changes.
- Report at most ${COHERENCE_MAX_FINDINGS} findings, most severe first. If the article is already coherent, report none.

Respond as STRICT JSON:
{
  "summary": "one-sentence overall coherence verdict",
  "findings": [
    { "type": "repetition", "sections": [2, 5], "description": "...", "suggestion": "..." }
  ]
}
Output JSON only.`;

    return { system, prompt };
  },

  metadata: () => ({ sub: "review" }),

  /**
   * Finding normalization, verbatim from the legacy call-site: type
   * whitelist, sections range-clamped to the real section count, cap at
   * COHERENCE_MAX_FINDINGS, description/suggestion truncated.
   */
  postProcess(parsed, input) {
    const findings: CoherenceFinding[] = [];
    for (const f of parsed.findings || []) {
      if (findings.length >= COHERENCE_MAX_FINDINGS) break;
      const type = VALID_TYPES.includes(f?.type) ? (f.type as CoherenceFindingType) : null;
      const secsRaw: number[] = (Array.isArray(f?.sections) ? f.sections : [])
        .map((n: any) => parseInt(String(n), 10))
        .filter((n: number) => !isNaN(n) && n >= 1 && n <= input.sectionCount);
      if (!type || secsRaw.length === 0 || !f?.description) continue;
      const secSet = new Set<number>(secsRaw);
      findings.push({
        type,
        sections: [...secSet].sort((a: number, b: number) => a - b),
        description: String(f.description).slice(0, 500),
        suggestion: String(f.suggestion || "").slice(0, 400),
      });
    }
    return { summary: String(parsed.summary || "").slice(0, 300), findings };
  },

  /** Whole-invocation failure (provider error / storm) → empty review. */
  fallback: () => ({ summary: "", findings: [] }),
};

// ---------------------------------------------------------------------------
// coherence-edit — per-section re-edit in full-article context (prose)
// (legacy: coherence-polish.ts polishArticleCoherence, per-section LLM call)
// ---------------------------------------------------------------------------

export interface CoherenceEditInput {
  title: string;
  /** The section's "## " heading (byte-preserved by construction; never reworded). */
  heading: string;
  /** Previous section's closing (~320 chars) — transition context. */
  prevTail: string;
  /** Next section's opening (~320 chars) — dedup context. */
  nextHead: string;
  /** The section body to re-edit. */
  sectionText: string;
  /** The findings that name this section (owned by it: the LATER section changes). */
  findings: CoherenceFinding[];
}

const TYPE_LABEL: Record<CoherenceFindingType, string> = {
  repetition: "REPEATED CONTENT (this section restates it — remove/condense to a one-clause back-reference)",
  contradiction: "CONTRADICTION (align this section with the established fact; if both are cited and genuinely conflicting, state the discrepancy explicitly)",
  terminology: "TERMINOLOGY DRIFT (adopt the name/abbreviation the article uses on first mention, then stay consistent)",
  numeric: "NUMERIC INCONSISTENCY (use the value established earlier; if these are genuinely different quantities, disambiguate the wording)",
  transition: "MISSING/BROKEN TRANSITION (open with one short bridging sentence that connects to the previous section — no new claims, no citations)",
  "cross-ref": "BROKEN CROSS-REFERENCE (fix the section pointer so it names the section that actually contains the content)",
};

export const coherenceEditSkill: SkillDefinition<CoherenceEditInput, string> = {
  id: "coherence-edit",
  taskType: "revise", // legacy role routing (generate-side of the review loop)
  sseStep: "polish",
  title: "Re-edit one section for coherence",
  chat: { temperature: 0.3 },

  buildPrompt(input) {
    const findingsBlock = input.findings
      .map(
        (f, i) =>
          `${i + 1}. [${TYPE_LABEL[f.type]}] involves section(s) ${f.sections.join(", ")}: ${f.description}\n   FIX: ${f.suggestion || "(apply the minimal consistent fix)"}`,
      )
      .join("\n");

    const system =
      "You are a meticulous scientific editor polishing ONE section of a finished review article for cross-section coherence. " +
      "You never invent facts, never touch citations, and never restructure the article.";

    const prompt = `ARTICLE TITLE: ${input.title}
This is ONE section of a multi-section review. You are re-editing it in FULL ARTICLE CONTEXT.

SECTION HEADING (do NOT reword it): ## ${input.heading}
PREVIOUS SECTION'S CLOSING (for transition context):
${input.prevTail}
NEXT SECTION'S OPENING (do not duplicate its content):
${input.nextHead}

CURRENT SECTION TEXT:
${input.sectionText}

CROSS-SECTION FINDINGS TO RESOLVE IN THIS SECTION:
${findingsBlock}

RE-EDIT RULES (STRICT):
1. Resolve each finding with the MINIMAL edit. Do not rewrite what the findings do not touch.
2. PRESERVE every inline citation marker [n] EXACTLY as written — same numbers attached to the same statements. Never add, remove, or renumber citations.
3. Do NOT introduce new facts, numbers, claims, or citations. You may only REMOVE, reword, condense, or re-point existing content.
4. Keep the section's length within ±15% of the original (bridges are one sentence; deduplication removes, it does not replace).
5. Output ONLY the re-edited section body text — no heading, no commentary, no quotes around it.`;

    return { system, prompt };
  },

  metadata: () => ({ sub: "polish" }),

  /** Prose skill — the reply IS the output (no JSON). */
  parse: (raw) => raw,

  /**
   * Wrapper-stripping, verbatim from the legacy call-site: codefences and a
   * heading echo (only when it matches the section's own heading).
   */
  postProcess(revised, input) {
    let cleaned = revised.trim();
    cleaned = cleaned
      .replace(/^```[a-z]*\s*/i, "")
      .replace(/```\s*$/i, "")
      .replace(/^#{1,3}\s+.*\n+/, (m0) =>
        m0.trim().toLowerCase() === `## ${input.heading}`.toLowerCase() ? "" : m0,
      )
      .trim();
    return cleaned;
  },

  /**
   * Degenerate-output guard (legacy: cleaned.length > 80 to adopt): a fatal
   * issue escalates to the skill fallback below.
   */
  validate: (output) => ({
    ok: output.length > 80,
    issues:
      output.length <= 80
        ? [`fatal: degenerate polish output (${output.length} chars) — section kept as-is`]
        : [],
  }),

  /**
   * Legacy per-section catch semantics: a failed or degenerate edit returns
   * the ORIGINAL section text — the caller sees `degraded` and keeps the
   * section as-is.
   */
  fallback: (input) => input.sectionText,
};
