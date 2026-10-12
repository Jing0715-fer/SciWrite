/**
 * Skill definitions — review/revision family (RT6).
 *
 * Migrated from review-engine.ts (B-family, the STRICT-JSON reviewer + the
 * prose revision paths):
 *   - review-core   ← reviewArticleCore's reviewing LLM call
 *   - revision      ← reviseArticleCore (prose output, surgical|full modes)
 *   - revision-scoped ← reviseArticleScoped's per-section LLM call (prose)
 *
 * Degradation contract (kept identical to the legacy sites):
 *   - review-core has NO skill fallback — an LLM/provider failure rethrows
 *     to the caller (the review route turns it into an HTTP error; the v2
 *     repair loop catches it and skips the round), while a garbage-JSON
 *     reply degrades via the parse fallbackValue (safeParseJSON), exactly
 *     like the hand-rolled site did.
 *   - revision / revision-scoped have NO skill fallback either — the
 *     whole-article path rethrows to its caller, the per-section path keeps
 *     its per-section catch at the call-site (one failed section keeps its
 *     original text).
 * Prose skills override `parse` with the identity (no JSON parsing) and do
 * their wrapper-stripping in postProcess — the executor's prose slot.
 */

import type { ReviewCoreParsed } from "@/lib/review-engine";
import { stripRevisionWrappers } from "@/lib/writing";
import type { SkillDefinition } from "./types";

// ---------------------------------------------------------------------------
// review — structured peer review of the article
// (legacy: review-engine.ts reviewArticleCore, LLM block)
// ---------------------------------------------------------------------------

export interface ReviewSkillInput {
  title: string;
  abstract?: string | null;
  content: string;
  /** Pre-rendered fact-check findings block ("" when fact-check degraded). */
  factBlock: string;
}

/** The parse-fallback shape — identical to the legacy safeParseJSON default. */
export const REVIEW_CORE_PARSE_FALLBACK: ReviewCoreParsed = {
  scores: { overall: 5 },
  verdict: "major-revision",
  summary: "Review parsing failed.",
  strengths: [],
  weaknesses: [],
  suggestions: [],
};

export const reviewCoreSkill: SkillDefinition<ReviewSkillInput, ReviewCoreParsed> = {
  id: "review",
  taskType: "review",
  sseStep: "review",
  title: "Peer-review the article",
  chat: { temperature: 0.4 },

  buildPrompt(input) {
    const system =
      "You are a rigorous scientific peer reviewer in the style of a top-tier journal " +
      "(Nature/Science/Cell). You evaluate manuscripts on multiple dimensions and " +
      "provide structured, actionable feedback. Be specific, critical, and constructive.";

    const prompt = `ARTICLE TITLE: ${input.title}
${input.abstract ? `ABSTRACT: ${input.abstract}\n` : ""}
ARTICLE CONTENT:
${input.content}
${input.factBlock}
Provide a comprehensive peer review. Score each dimension 0-10 (10 = excellent).
Respond as STRICT JSON:
{
  "scores": {
    "novelty": 0,
    "significance": 0,
    "clarity": 0,
    "methodology": 0,
    "citations": 0,
    "overall": 0
  },
  "verdict": "accept|minor-revision|major-revision|reject",
  "summary": "2-3 sentence overall assessment",
  "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
  "weaknesses": ["specific weakness 1", "specific weakness 2", "specific weakness 3"],
  "weakness_classes": ["fixable", "advisory"],
  "suggestions": [
    {"section": "Introduction", "issue": "what's wrong", "fix": "how to fix it"},
    {"section": "Results", "issue": "...", "fix": "..."}
  ]
}
CLASSIFY each weakness in "weakness_classes" (same order, exactly one entry per weakness):
- "fixable" — a revision of THIS manuscript can repair it: factual errors, misattributed citations, unsupported claims, missing citations for stated facts, structural/organizational problems, unclear or contradictory prose.
- "advisory" — a revision cannot repair it: insufficient breadth/depth, missing subtopics, lack of novelty or experimental data, scope limitations inherent to a literature review. These are disclosed to the author, not repaired.
Be demanding but fair. Focus on scientific rigor, citation completeness, and clarity.
Output JSON only.`;

    return { system, prompt };
  },

  metadata: (input) => ({
    mode: "review-core",
    title: input.title,
  }),

  /**
   * round-RT3 (R4) normalization, verbatim: per-weakness class whitelist —
   * garbage/missing values become "fixable" so legacy behavior (models that
   * drop the field) is preserved.
   */
  postProcess(parsed) {
    const rawClasses: unknown = (parsed as any).weakness_classes;
    const llmWeaknesses: string[] = Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [];
    parsed.weaknessClasses = llmWeaknesses.map((_, i) => {
      const c = Array.isArray(rawClasses) ? String((rawClasses as any[])[i] ?? "") : "";
      return /advis/i.test(c) ? "advisory" : "fixable";
    });
    return parsed;
  },

  // No fallback: provider failures rethrow (legacy semantics — the review
  // route surfaces them; the v2 repair loop catches per-round).
};

// ---------------------------------------------------------------------------
// revision — whole-article revision against reviewer feedback (prose)
// (legacy: review-engine.ts reviseArticleCore)
// ---------------------------------------------------------------------------

export interface ReviseSkillInput {
  title: string;
  content: string;
  /** Pre-rendered reviewer feedback block (buildFeedbackBlock output). */
  feedbackBlock: string;
  mode: "surgical" | "full";
  round: number;
  /** Section headings pinned by the structural contract (surgical mode). */
  contractTitles: string[];
  /** Mechanical-guard violations from a rejected previous attempt. */
  retryFeedback?: string;
}

export const reviseArticleSkill: SkillDefinition<ReviseSkillInput, string> = {
  id: "revision",
  taskType: "revise",
  sseStep: "repair",
  title: "Revise the article against review feedback",
  chat: { temperature: 0.5, maxTokens: 16384 },

  buildPrompt(input) {
    let system: string;
    let prompt: string;
    if (input.mode === "surgical") {
      const structuralContract =
        input.contractTitles.length > 0
          ? `\nSTRUCTURAL CONTRACT (NON-NEGOTIABLE — any violation rejects your revision):\nThe article has EXACTLY ${input.contractTitles.length} "## " section headings. Your output must contain EXACTLY ${input.contractTitles.length} "## " headings, in this exact order, with this exact wording:\n${input.contractTitles.map((t, i) => `${i + 1}. ## ${t}`).join("\n")}\nDo NOT merge, split, add, remove, reword, or reorder sections. Edit section CONTENTS only.\n`
          : "";
      const retryBlock = input.retryFeedback
        ? `\n⚠ YOUR PREVIOUS REVISION ATTEMPT WAS REJECTED by the mechanical guard for these exact violations:\n${input.retryFeedback}\nFix ONLY these structural violations and produce the full revised article again.\n`
        : "";
      system =
        "You are a meticulous scientific editor who repairs review articles before publication. " +
        "You make the MINIMAL set of precise edits that resolve verified factual problems and " +
        "citation-level findings. You never invent new facts, never remove citations, and never " +
        "restructure the article.";
      prompt = `ARTICLE TITLE: ${input.title}
CURRENT ARTICLE (markdown):
${input.content}

${input.feedbackBlock}
${structuralContract}${retryBlock}
REVISION RULES (STRICT — violating any of these rejects your revision):
1. FACT-CHECK entries in the weaknesses describe claims that were externally verified against independent evidence:
   - "CONTRADICTED" → the claim conflicts with independent evidence. Remove the claim, or rewrite it to say only what the evidence supports. If two cited sources genuinely conflict, either remove the statement or explicitly acknowledge the discrepancy.
   - "UNVERIFIABLE" → no independent evidence was found. Soften the sentence with attribution or hedging ("has been reported to", "one study suggested", "according to [n]") or remove it if it is load-bearing. Never leave it as an unqualified definitive assertion.
   - Claims the fact-check marked VERIFIED must NOT be altered.
2. Make the MINIMAL edits — do not rewrite sections that have no findings. Do not polish style.
3. Do NOT add new facts, numbers, or claims that are not already in the article.
4. Preserve every inline citation marker [n] EXACTLY as-is (same numbers, attached to the same statements they currently support).
5. Keep the "## References" list at the end EXACTLY as-is (same entries, same order, same numbering).
6. Keep every "## " section heading text EXACTLY as-is (see the STRUCTURAL CONTRACT above).
7. Address the remaining (non-fact-check) reviewer weaknesses ONLY where they concern factual accuracy, citation usage, or unsupported statements — ignore stylistic preferences.

Output the complete revised article in Markdown. Do NOT add commentary — output only the revised article.`;
    } else {
      system =
        "You are a scientific editor who revises articles to address peer-review feedback " +
        "while preserving scientific accuracy and all inline citations [n] / [SOURCE:ID].";
      prompt = `ARTICLE TITLE: ${input.title}
CURRENT CONTENT:
${input.content}

${input.feedbackBlock}

Revise the article to address ALL weaknesses and suggestions. Preserve:
- All inline citations [n] and [SOURCE:ID] markers exactly.
- The section structure (## headings).
- The ### Citations / ## References block at the end.

Output the revised article in Markdown. Do NOT add commentary — output only the revised article.`;
    }
    return { system, prompt };
  },

  metadata: (input) => ({
    mode: `revise-${input.mode}`,
    round: input.round,
  }),

  /** Prose skill — the reply IS the output (no JSON). */
  parse: (raw) => raw,

  postProcess(revised) {
    return stripRevisionWrappers(revised);
  },

  // No fallback: rethrows to the caller (legacy — the v2 repair loop's
  // per-attempt try/catch owns the degradation).
};

// ---------------------------------------------------------------------------
// revision-scoped — single-section surgical revision (prose)
// (legacy: review-engine.ts reviseArticleScoped, per-section LLM call)
// ---------------------------------------------------------------------------

export interface ReviseSectionSkillInput {
  title: string;
  /** The section's "## " heading (context only, never rewritten). */
  heading: string;
  sectionText: string;
  findingsBlock: string;
  scoresLine: string;
  round: number;
  /** 0-based section index (metadata: section = idx + 1). */
  sectionIdx: number;
}

export const reviseSectionSkill: SkillDefinition<ReviseSectionSkillInput, string> = {
  id: "revision",
  taskType: "revise",
  sseStep: "repair",
  title: "Revise one flagged section",
  chat: { temperature: 0.3, maxTokens: 8192 },

  buildPrompt(input) {
    const system =
      "You are a meticulous scientific editor who repairs ONE section of a review article. " +
      "You make the MINIMAL set of precise edits that resolve the verified factual problems " +
      "listed for this section. You never invent new facts, never add citations, and never " +
      "touch anything outside this section.";
    const prompt = `ARTICLE TITLE: ${input.title}
SECTION HEADING (context only — do NOT output it): "## ${input.heading}"
REVIEW CONTEXT (whole article): ${input.scoresLine}

CURRENT SECTION TEXT (revise ONLY this):
${input.sectionText}

FINDINGS TO RESOLVE IN THIS SECTION:
${input.findingsBlock}

REVISION RULES (STRICT — violating any of these rejects your revision):
1. FACT-CHECK entries:
   - "CONTRADICTED" → the claim conflicts with evidence. Remove the claim, or rewrite it to say only what the evidence supports. If two cited sources genuinely conflict, either remove the statement or explicitly acknowledge the discrepancy.
   - "UNVERIFIABLE" (unhedged) → soften the sentence with attribution or hedging ("has been reported to", "one study suggested", "according to [n]") or remove it if it is load-bearing. Never leave it as an unqualified definitive assertion.
   - Claims the fact-check marked VERIFIED must NOT be altered.
2. MINIMAL edits — every paragraph without a finding stays byte-identical. Do not polish style.
3. Do NOT add new facts, numbers, or claims that are not already in this section.
4. Inline citation markers [n] stay attached to the same statements; remove a marker ONLY together with removing its flagged claim.
5. Output ONLY the revised section body text — no heading, no commentary, no markdown fences, no "here is" preamble.

Output the revised section text now.`;
    return { system, prompt };
  },

  metadata: (input) => ({
    mode: "revise-scoped",
    round: input.round,
    section: input.sectionIdx + 1,
  }),

  /** Prose skill. */
  parse: (raw) => raw,

  postProcess(revised) {
    let out = stripRevisionWrappers(revised);
    // Strip a leading "## heading" echo if the model added one.
    out = out.replace(/^##\s+[^\n]*\n+/, "").trim();
    return out;
  },

  // No fallback: rethrows; the per-section catch at the call-site keeps the
  // original section text (legacy semantics).
};
