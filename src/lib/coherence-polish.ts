/**
 * Whole-Article Coherence Polish (round-cs-2) — cross-section review + context-
 * aware per-section polishing for generate-full-v2 STEP 8.6.
 *
 * Problem this module solves (user complaint, 2026-09):
 * "文章生成不再是一次生成，前后章独立，彼此联系很少，需要不断根据上下文
 *  打磨内容，尤其避免科学性错误和文献引用错误" — sections are drafted
 * independently (each sees only a digest of earlier ones), so the composed
 * article ships with the classic one-shot artifacts: near-duplicate claims in
 * two sections, the same quantity stated with different values, a protein
 * renamed mid-article, missing bridges between chapters, and claims that
 * quietly contradict each other. None of these are visible to the per-citation
 * adversarial verify (STEP 7, single-section scope) or the fact-check review
 * (STEP 8.5, claim-level scope) — they only exist BETWEEN sections.
 *
 * This pass closes that gap:
 *   1. reviewArticleCoherence — ONE LLM call sees the ENTIRE body and reports
 *      cross-section findings only: repetition / contradiction / terminology
 *      drift / numeric inconsistency / missing transition / broken forward or
 *      backward references.
 *   2. polishArticleCoherence — for each affected section (≤5), an isolated
 *      LLM call re-edits that section WITH its neighbors' edges (previous
 *      section's closing sentences + next section's opening) so the fix lands
 *      in full article context. Headings and the reference block are
 *      byte-preserved by construction; inline [n] citations must survive
 *      verbatim; no new facts may be introduced (anti-fabrication contract).
 *
 * The route guards the result with the same mechanical gauntlet as the repair
 * loop (revisionGuard + renormalizeArticleCitations + restoreOriginalHeadings).
 * Every failure is non-fatal: a failed polish keeps the article as composed.
 */

import { chatWithSession } from "@/lib/llm-session";
import { splitBodySections } from "@/lib/review-engine";
import { splitBodyAndReferences } from "@/lib/citation-audit";
import { safeParseJSON } from "@/lib/generate-full-helpers";
import { logger } from "@/lib/logger";

const log = (m: string) => logger("coherence").info(m);

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

export interface CoherenceReviewResult {
  ran: boolean;
  findings: CoherenceFinding[];
  summary: string;
  error?: string;
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

/**
 * Stage 1 — whole-article coherence review. ONE call, full body, and ONLY
 * cross-section issues: anything confined to a single section is out of scope
 * (STEP 7/8.5 already own those).
 */
export async function reviewArticleCoherence(
  projectId: string,
  article: { title: string; content: string },
  opts: { topic?: string; maxTokens?: number } = {},
): Promise<CoherenceReviewResult> {
  const split = splitBodyAndReferences(article.content);
  const sections = splitBodySections(split.body);
  if (!sections || sections.headings.length < 2) {
    return { ran: false, findings: [], summary: "fewer than 2 sections — nothing cross-section to review", error: "unsectioned" };
  }

  const numberedBody = split.body
    .split(/^##\s+/m)
    .filter((s) => s.trim().length > 0)
    .map((s, i) => `## ${s.replace(/\n+$/, "")}`)
    .join("\n\n");

  const system = `You are a senior review-article editor performing the FINAL coherence pass on a nearly-finished scientific review${opts.topic ? ` about: ${opts.topic}` : ""}.
Your ONLY job is to find CROSS-SECTION defects — problems that live BETWEEN sections, invisible to per-section checks. You do not judge single-section quality, style, or citation formatting.`;

  const prompt = `ARTICLE TITLE: ${article.title}
FULL ARTICLE BODY (section headings are numbered by position):

${numberedBody}

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

  try {
    const raw = await chatWithSession(projectId, prompt, {
      system,
      temperature: 0.3,
      taskType: "review",
      maxTokens: opts.maxTokens,
      metadata: { step: "coherence", sub: "review" },
    });
    const parsed = safeParseJSON(raw, { summary: "", findings: [] });
    const findings: CoherenceFinding[] = [];
    for (const f of parsed.findings || []) {
      if (findings.length >= COHERENCE_MAX_FINDINGS) break;
      const type = VALID_TYPES.includes(f?.type) ? (f.type as CoherenceFindingType) : null;
      const secsRaw: number[] = (Array.isArray(f?.sections) ? f.sections : [])
        .map((n: any) => parseInt(String(n), 10))
        .filter((n: number) => !isNaN(n) && n >= 1 && n <= sections.headings.length);
      if (!type || secsRaw.length === 0 || !f?.description) continue;
      const secSet = new Set<number>(secsRaw);
      findings.push({
        type,
        sections: [...secSet].sort((a: number, b: number) => a - b),
        description: String(f.description).slice(0, 500),
        suggestion: String(f.suggestion || "").slice(0, 400),
      });
    }
    return { ran: true, findings, summary: String(parsed.summary || "").slice(0, 300) };
  } catch (err: any) {
    return { ran: false, findings: [], summary: "", error: String(err?.message ?? err).slice(0, 160) };
  }
}

export interface CoherencePolishResult {
  ok: boolean;
  /** The reassembled full article (body + references) — null when !ok. */
  content: string | null;
  revisedSections: number[];
  findingsAddressed: number;
  reason: string;
}

/**
 * Stage 2 — context-aware per-section polish. Each affected section is
 * re-edited in an isolated call that sees its own text, the EDGES of its
 * neighbors (previous closing + next opening sentences), and the findings
 * that name it — so bridges, deduplication, and terminology alignment land
 * with full-article context while headings and the reference block stay
 * byte-preserved by construction.
 */
export async function polishArticleCoherence(
  projectId: string,
  article: { title: string; content: string },
  findings: CoherenceFinding[],
  opts: { topic?: string; maxTokens?: number; onProgress?: (m: string) => void } = {},
): Promise<CoherencePolishResult> {
  const split = splitBodyAndReferences(article.content);
  const sec = splitBodySections(split.body);
  if (!sec || sec.headings.length === 0) {
    return { ok: false, content: null, revisedSections: [], findingsAddressed: 0, reason: "no sections found" };
  }

  // Group findings by the section that OWNS the fix: for multi-section
  // findings the LATER section changes (the earlier one established the
  // claim/name/value; the later one aligns to it).
  const bySection = new Map<number, CoherenceFinding[]>();
  for (const f of findings) {
    const target = f.sections[f.sections.length - 1];
    if (target == null || target < 1 || target > sec.contents.length) continue;
    if (!bySection.has(target - 1)) bySection.set(target - 1, []);
    bySection.get(target - 1)!.push(f);
  }
  if (bySection.size === 0) {
    return { ok: false, content: null, revisedSections: [], findingsAddressed: 0, reason: "no findings located in any section" };
  }

  const targets = [...bySection.keys()].sort((a, b) => a - b).slice(0, COHERENCE_MAX_SECTIONS);
  const revisedContents = [...sec.contents];
  const revisedDone: number[] = [];
  let addressed = 0;

  const typeLabel: Record<CoherenceFindingType, string> = {
    repetition: "REPEATED CONTENT (this section restates it — remove/condense to a one-clause back-reference)",
    contradiction: "CONTRADICTION (align this section with the established fact; if both are cited and genuinely conflicting, state the discrepancy explicitly)",
    terminology: "TERMINOLOGY DRIFT (adopt the name/abbreviation the article uses on first mention, then stay consistent)",
    numeric: "NUMERIC INCONSISTENCY (use the value established earlier; if these are genuinely different quantities, disambiguate the wording)",
    transition: "MISSING/BROKEN TRANSITION (open with one short bridging sentence that connects to the previous section — no new claims, no citations)",
    "cross-ref": "BROKEN CROSS-REFERENCE (fix the section pointer so it names the section that actually contains the content)",
  };

  for (const idx of targets) {
    const findingsFor = bySection.get(idx)!;
    const heading = sec.headings[idx];
    const prevTail = idx > 0 ? sec.contents[idx - 1].replace(/\s+/g, " ").slice(-320) : "(this is the opening section)";
    const nextHead = idx + 1 < sec.contents.length ? sec.contents[idx + 1].replace(/\s+/g, " ").slice(0, 320) : "(this is the final section)";

    const findingsBlock = findingsFor
      .map((f, i) => `${i + 1}. [${typeLabel[f.type]}] involves section(s) ${f.sections.join(", ")}: ${f.description}\n   FIX: ${f.suggestion || "(apply the minimal consistent fix)"}`)
      .join("\n");

    opts.onProgress?.(`Polishing §${idx + 1} (${findingsFor.length} finding(s))...`);

    try {
      const revised = await chatWithSession(
        projectId,
        `ARTICLE TITLE: ${article.title}
This is ONE section of a multi-section review. You are re-editing it in FULL ARTICLE CONTEXT.

SECTION HEADING (do NOT reword it): ## ${heading}
PREVIOUS SECTION'S CLOSING (for transition context):
${prevTail}
NEXT SECTION'S OPENING (do not duplicate its content):
${nextHead}

CURRENT SECTION TEXT:
${sec.contents[idx]}

CROSS-SECTION FINDINGS TO RESOLVE IN THIS SECTION:
${findingsBlock}

RE-EDIT RULES (STRICT):
1. Resolve each finding with the MINIMAL edit. Do not rewrite what the findings do not touch.
2. PRESERVE every inline citation marker [n] EXACTLY as written — same numbers attached to the same statements. Never add, remove, or renumber citations.
3. Do NOT introduce new facts, numbers, claims, or citations. You may only REMOVE, reword, condense, or re-point existing content.
4. Keep the section's length within ±15% of the original (bridges are one sentence; deduplication removes, it does not replace).
5. Output ONLY the re-edited section body text — no heading, no commentary, no quotes around it.`,
        {
          system:
            "You are a meticulous scientific editor polishing ONE section of a finished review article for cross-section coherence. " +
            "You never invent facts, never touch citations, and never restructure the article.",
          temperature: 0.3,
          taskType: "revise",
          maxTokens: opts.maxTokens,
          metadata: { step: "coherence", sub: "polish", section: idx + 1 },
        },
      );

      let cleaned = revised.trim();
      // Strip accidental heading/codefence wrappers some models add.
      cleaned = cleaned
        .replace(/^```[a-z]*\s*/i, "")
        .replace(/```\s*$/i, "")
        .replace(/^#{1,3}\s+.*\n+/, (m0) => (m0.trim().toLowerCase() === `## ${heading}`.toLowerCase() ? "" : m0))
        .trim();
      if (cleaned.length > 80) {
        revisedContents[idx] = cleaned;
        revisedDone.push(idx);
        addressed += findingsFor.length;
        log(`polished §${idx + 1} — ${findingsFor.length} finding(s): ${findingsFor.map((f) => f.type).join(", ")}`);
      } else {
        log(`polish §${idx + 1} produced degenerate output (${cleaned.length} chars) — section kept as-is`);
      }
    } catch (err: any) {
      log(`polish §${idx + 1} failed: ${String(err?.message ?? err).slice(0, 120)} — section kept as-is`);
    }
  }

  if (revisedDone.length === 0) {
    return { ok: false, content: null, revisedSections: [], findingsAddressed: 0, reason: "every section polish failed or produced degenerate output" };
  }

  const body = revisedContents.map((c, i) => `## ${sec.headings[i]}\n\n${c.trim()}`).join("\n\n");
  const content = body.trim() + (split.referencesText.trim() ? "\n\n" + split.referencesText.trim() : "");
  return { ok: true, content, revisedSections: revisedDone, findingsAddressed: addressed, reason: "ok" };
}
