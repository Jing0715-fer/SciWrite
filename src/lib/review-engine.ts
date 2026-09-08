/**
 * round-59: review & auto-repair engine — the shared core behind BOTH the
 * standalone review endpoint (POST /api/ai/review) and the in-pipeline
 * auto-repair loop (generate-full-v2 STEP 8.5).
 *
 * WHY THIS EXISTS: the round-57 protections made fabrication VISIBLE (the
 * fact-check layer surfaces every uncorroborated high-risk claim as a Review
 * weakness), but visibility is not repair. A one-click generation ended with
 * "here are the problems — now go fix them yourself" (manual revise → manual
 * retranslate → manual re-review). This engine closes the loop INSIDE the
 * pipeline: review → surgical revise → mechanical citation renormalization →
 * guard → re-review, bounded at REPAIR_MAX_REVISIONS, all BEFORE the Chinese
 * half is composed so the final English text is translated exactly once.
 *
 * DESIGN CONTRACTS:
 *   - Pure core: reviewArticleCore / reviseArticleCore take content STRINGS
 *     and never touch the DB — persistence stays with the callers (the review
 *     route writes Review rows; the v2 pipeline writes them after the article
 *     exists). This is what lets the v2 loop run in-memory between compose
 *     and article-save.
 *   - Best-effort fact-check: on tool failure the review degrades to the
 *     pre-round-57 baseline (factReport.ran === false), never throws.
 *   - Surgical revisions: minimal-edit prompt with strict preservation rules
 *     (citations, headings, reference list, no new facts). "full" mode keeps
 *     the legacy manual-revise behavior (address everything) unchanged.
 *   - Mechanical guards: every revision must survive revisionGuard (word
 *     count / citation / structure floors) and is then renormalized
 *     deterministically (out-of-range markers stripped, orphaned references
 *     dropped, numbering compacted) — an LLM can never renumber the article
 *     into a broken state.
 */

import { chatWithSession } from "@/lib/llm-session";
import { countWords } from "@/lib/writing";
import { splitBodyAndReferences } from "@/lib/citation-audit";
import {
  factCheckArticle,
  factFindingsPromptBlock,
  factFindingToWeakness,
  type FactCheckFinding,
  type FactCheckReport,
} from "@/lib/fact-check";
import {
  REVISION_MIN_CITATION_RATIO,
  REVISION_MIN_WORD_RATIO,
} from "@/lib/v2-config";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface ReviewCoreInput {
  title: string;
  abstract?: string | null;
  content: string;
}

export interface ReviewCoreParsed {
  scores: {
    novelty?: number;
    significance?: number;
    clarity?: number;
    methodology?: number;
    citations?: number;
    overall?: number;
  };
  verdict: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  suggestions: any[];
}

export interface ReviewCoreResult {
  parsed: ReviewCoreParsed;
  /** null ⇒ the fact-check layer failed wholesale (review still ran) */
  factReport: FactCheckReport | null;
  /** fact-check findings force-merged into weaknesses (CONTRADICTED/UNVERIFIABLE only) */
  factWeaknesses: string[];
  /** LLM weaknesses + fact weaknesses, deduped, capped at 10 — what gets persisted */
  mergedWeaknesses: string[];
}

export interface RevisionFeedback {
  round: number;
  verdict: string;
  summary: string;
  scores?: Record<string, number | null | undefined>;
  strengths: string[];
  weaknesses: string[];
  suggestions: any[];
}

export interface Actionability {
  actionable: boolean;
  /** findings that MUST be repaired (CONTRADICTED, or UNVERIFIABLE and unhedged) */
  hardFindings: FactCheckFinding[];
  trigger: "none" | "fact" | "verdict";
  reason: string;
}

/* ------------------------------------------------------------------ *
 * 1. Review core (fact-check + reviewing LLM, no DB)
 * ------------------------------------------------------------------ */

/**
 * Run the full review stack on an article WITHOUT touching the database:
 * external fact-check (web-searched adjudication of high-risk claims) →
 * structured LLM peer review → force-merge the fact findings into the
 * weaknesses. Mirrors the review route's runReview exactly (same prompts,
 * same merge logic) so persisted reviews are indistinguishable whether they
 * came from the endpoint or the pipeline loop.
 */
export async function reviewArticleCore(
  projectId: string,
  article: ReviewCoreInput,
  opts: { topic?: string; maxClaims?: number } = {}
): Promise<ReviewCoreResult> {
  // ---- external fact-check (best-effort, never throws) ----
  let factBlock = "";
  let factWeaknesses: string[] = [];
  let factReport: FactCheckReport | null = null;
  try {
    const report = await factCheckArticle(projectId, article.content, {
      maxClaims: opts.maxClaims ?? 8,
      topic: opts.topic || "",
    });
    if (report.ran && report.findings.length > 0) {
      factBlock = factFindingsPromptBlock(report.findings);
      factWeaknesses = report.findings
        .filter((f) => f.verdict === "CONTRADICTED" || f.verdict === "UNVERIFIABLE")
        .map(factFindingToWeakness);
    }
    factReport = report;
  } catch (fcErr: any) {
    // Best-effort by contract — a fact-check failure must never fail review.
    console.warn(
      `[review-engine] fact-check degraded to baseline review: ${fcErr?.message?.slice(0, 120) || fcErr}`,
    );
  }

  const system =
    "You are a rigorous scientific peer reviewer in the style of a top-tier journal " +
    "(Nature/Science/Cell). You evaluate manuscripts on multiple dimensions and " +
    "provide structured, actionable feedback. Be specific, critical, and constructive.";

  const prompt = `ARTICLE TITLE: ${article.title}
${article.abstract ? `ABSTRACT: ${article.abstract}\n` : ""}
ARTICLE CONTENT:
${article.content}
${factBlock}
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
  "suggestions": [
    {"section": "Introduction", "issue": "what's wrong", "fix": "how to fix it"},
    {"section": "Results", "issue": "...", "fix": "..."}
  ]
}
Be demanding but fair. Focus on scientific rigor, citation completeness, and clarity.
Output JSON only.`;

  const raw = await chatWithSession(projectId, prompt, {
    system,
    temperature: 0.4,
    taskType: "review",
    metadata: { mode: "review-core", title: article.title },
  });
  const parsed = safeParseJSON(raw, {
    scores: { overall: 5 },
    verdict: "major-revision",
    summary: "Review parsing failed.",
    strengths: [],
    weaknesses: [],
    suggestions: [],
  });

  // Force-merge the external fact-check findings into the weaknesses (deduped
  // against the LLM's own) — the reviewing LLM is *told* to keep them, but a
  // lazy/generous model must not be able to bury a CONTRADICTED finding.
  // Cap the merged list at 10 (LLM weaknesses + facts).
  const llmWeaknesses: string[] = Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [];
  const mergedWeaknesses = [...llmWeaknesses];
  for (const w of factWeaknesses) {
    if (mergedWeaknesses.length >= 10) break;
    const already = mergedWeaknesses.some(
      (x) =>
        typeof x === "string" &&
        x.replace(/\s+/g, "").slice(0, 80) === w.replace(/\s+/g, "").slice(0, 80),
    );
    if (!already) mergedWeaknesses.push(w);
  }

  return { parsed, factReport, factWeaknesses, mergedWeaknesses };
}

/* ------------------------------------------------------------------ *
 * 2. Actionability — should the repair loop revise?
 * ------------------------------------------------------------------ */

/** Attribution/uncertainty markers that make an UNVERIFIABLE claim already
 *  responsibly hedged ("has been reported", "may", "according to [5]" …).
 *  A hedged uncorroborated claim is DISCLOSED, not broken — revising it again
 *  would just churn. An unhedged definitive assertion is the failure mode
 *  this loop exists to kill. */
const HEDGE_RE =
  /\b(?:has been|have been|had been|is|are|was|were)\s+(?:reported|suggested|proposed|described|observed|identified|shown|found)|\b(?:reportedly|according to|one study|some studies|several studies|a number of studies|studies have|appears? to|seems? to|may|Might|might|could|suggests?|proposed|putative|hypothesized|purportedly)\b/i;

function isHedged(sentence: string): boolean {
  return HEDGE_RE.test(sentence);
}

/**
 * Decide whether a review round justifies an automatic revision.
 *
 *  - "fact" trigger (hard): any CONTRADICTED claim, or any UNVERIFIABLE claim
 *    that is not already hedged. These are exactly the fabrication vectors
 *    round-57 exposed (the M412K mouse/human confusion surfaced as an
 *    unhedged UNVERIFIABLE).
 *  - "verdict" trigger (soft): reject, or major-revision with a failing
 *    citations score — mechanically repairable citation-level problems.
 *  - "none": a minor-revision verdict with no factual findings is STYLE
 *    feedback; auto-polishing prose against it risks degradation for no
 *    accuracy gain, so the loop stops and the review is disclosed as-is.
 */
export function actionableFindings(res: ReviewCoreResult): Actionability {
  const hard = (res.factReport?.findings || []).filter((f) => {
    if (f.verdict === "CONTRADICTED") return true;
    if (f.verdict === "UNVERIFIABLE") return !isHedged(f.sentence);
    return false;
  });
  if (hard.length > 0) {
    return {
      actionable: true,
      hardFindings: hard,
      trigger: "fact",
      reason: `${hard.length} externally uncorroborated or contradicted claim(s)`,
    };
  }
  const verdict = res.parsed.verdict || "";
  const citations = res.parsed.scores?.citations ?? 10;
  const overall = res.parsed.scores?.overall ?? 10;
  if (verdict === "reject" || (verdict === "major-revision" && (citations < 6 || overall < 6))) {
    return {
      actionable: true,
      hardFindings: [],
      trigger: "verdict",
      reason: `verdict ${verdict} (overall ${overall}/10, citations ${citations}/10)`,
    };
  }
  return { actionable: false, hardFindings: [], trigger: "none", reason: "" };
}

/* ------------------------------------------------------------------ *
 * 3. Revision core (no DB)
 * ------------------------------------------------------------------ */

function buildFeedbackBlock(f: RevisionFeedback): string {
  const s = f.scores || {};
  return `REVIEWER FEEDBACK (Round ${f.round}):
Verdict: ${f.verdict}
Summary: ${f.summary}
Scores: novelty=${s.novelty ?? "?"}/10, significance=${s.significance ?? "?"}/10, clarity=${s.clarity ?? "?"}/10, methodology=${s.methodology ?? "?"}/10, citations=${s.citations ?? "?"}/10, overall=${s.overall ?? "?"}/10

STRENGTHS:
${(f.strengths || []).map((x: string, i: number) => `${i + 1}. ${x}`).join("\n")}

WEAKNESSES:
${(f.weaknesses || []).map((x: string, i: number) => `${i + 1}. ${x}`).join("\n")}

REVISION SUGGESTIONS:
${(f.suggestions || []).map((x: any, i: number) => `${i + 1}. [${x?.section ?? "?"}] ${x?.issue ?? ""} → ${x?.fix ?? ""}`).join("\n")}`;
}

/** Strip the wrappers LLMs love to add around a "revised article". */
function stripRevisionWrappers(text: string): string {
  let t = (text || "").trim();
  t = t.replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  t = t.replace(/^(?:here(?:'s| is)[^\n:]{0,80}|revised article[^\n:]{0,40}|the revised article[^\n:]{0,40})[:：]\s*\n*/i, "");
  return t.trim();
}

/**
 * Revise an article against reviewer feedback. Two modes:
 *
 *  - "full"      — legacy manual-revise behavior (address ALL weaknesses and
 *                  suggestions). Used by POST /api/ai/review mode=revise.
 *  - "surgical"  — round-59 in-pipeline mode: MINIMAL edits that resolve the
 *                  verified factual problems (fact-check verdicts) and
 *                  citation-level findings. Hard preservation rules so the
 *                  mechanical guards downstream have a stable contract.
 */
export async function reviseArticleCore(
  projectId: string,
  article: { title: string; content: string },
  feedback: RevisionFeedback,
  mode: "surgical" | "full" = "full",
  opts: { maxTokens?: number } = {}
): Promise<string> {
  const feedbackBlock = buildFeedbackBlock(feedback);

  let system: string;
  let prompt: string;
  if (mode === "surgical") {
    system =
      "You are a meticulous scientific editor who repairs review articles before publication. " +
      "You make the MINIMAL set of precise edits that resolve verified factual problems and " +
      "citation-level findings. You never invent new facts, never remove citations, and never " +
      "restructure the article.";
    prompt = `ARTICLE TITLE: ${article.title}
CURRENT ARTICLE (markdown):
${article.content}

${feedbackBlock}

REVISION RULES (STRICT — violating any of these rejects your revision):
1. FACT-CHECK entries in the weaknesses describe claims that were externally verified against independent web evidence:
   - "CONTRADICTED" → the claim conflicts with independent evidence. Remove the claim, or rewrite it to say only what the evidence supports. If two cited sources genuinely conflict, either remove the statement or explicitly acknowledge the discrepancy.
   - "UNVERIFIABLE" → no independent evidence was found. Soften the sentence with attribution or hedging ("has been reported to", "one study suggested", "according to [n]") or remove it if it is load-bearing. Never leave it as an unqualified definitive assertion.
   - Claims the fact-check marked VERIFIED must NOT be altered.
2. Make the MINIMAL edits — do not rewrite sections that have no findings. Do not polish style.
3. Do NOT add new facts, numbers, or claims that are not already in the article.
4. Preserve every inline citation marker [n] EXACTLY as-is (same numbers, attached to the same statements they currently support).
5. Keep the "## References" list at the end EXACTLY as-is (same entries, same order, same numbering).
6. Keep every "## " section heading text EXACTLY as-is.
7. Address the remaining (non-fact-check) reviewer weaknesses ONLY where they concern factual accuracy, citation usage, or unsupported statements — ignore stylistic preferences.

Output the complete revised article in Markdown. Do NOT add commentary — output only the revised article.`;
  } else {
    system =
      "You are a scientific editor who revises articles to address peer-review feedback " +
      "while preserving scientific accuracy and all inline citations [n] / [SOURCE:ID].";
    prompt = `ARTICLE TITLE: ${article.title}
CURRENT CONTENT:
${article.content}

${feedbackBlock}

Revise the article to address ALL weaknesses and suggestions. Preserve:
- All inline citations [n] and [SOURCE:ID] markers exactly.
- The section structure (## headings).
- The ### Citations / ## References block at the end.

Output the revised article in Markdown. Do NOT add commentary — output only the revised article.`;
  }

  const revised = await chatWithSession(projectId, prompt, {
    system,
    temperature: mode === "surgical" ? 0.3 : 0.5,
    taskType: "revise",
    maxTokens: opts.maxTokens ?? 16384,
    metadata: { mode: `revise-${mode}`, round: feedback.round },
  });
  return stripRevisionWrappers(revised);
}

/* ------------------------------------------------------------------ *
 * 4. Mechanical citation utilities (deterministic, shared)
 * ------------------------------------------------------------------ */

/** All citation markers, including comma/range lists: [1], [2,3], [4-6]. */
const CITE_MARKER_RE = /\[(\d+(?:[,\-–\s]\d+)*)\]/g;

/** Expand the inner text of one citation marker into its numbers. */
function expandCitationInner(inner: string): number[] {
  return inner
    .split(/[,;]\s*/)
    .flatMap((s: string) => {
      const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) {
        const arr: number[] = [];
        for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) arr.push(n);
        return arr;
      }
      const n = parseInt(s);
      return isNaN(n) ? [] : [n];
    });
}

/** Parse "[n] …" reference lines out of a references text block. */
function parseRefLines(referencesText: string): { num: number; text: string }[] {
  const out: { num: number; text: string }[] = [];
  for (const line of referencesText.split("\n")) {
    const m = line.match(/^\s*\[(\d+)\]\s*(.+?)\s*$/);
    if (m) out.push({ num: parseInt(m[1]), text: m[2] });
  }
  return out;
}

/** Count "## " section headings in a markdown body (### subheads excluded). */
export function countSectionHeadings(body: string): number {
  const matches = body.match(/^##\s+\S/gm);
  return matches ? matches.length : 0;
}

/** Distinct citation numbers that are in range 1..refCount. */
export function distinctCitations(body: string, refCount: number): Set<number> {
  const set = new Set<number>();
  let m: RegExpExecArray | null;
  const re = new RegExp(CITE_MARKER_RE.source, "g");
  while ((m = re.exec(body)) !== null) {
    for (const n of expandCitationInner(m[1])) {
      if (n >= 1 && n <= refCount) set.add(n);
    }
  }
  return set;
}

export interface RevisionGuardResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Mechanical quality gate every revision must pass BEFORE it can replace the
 * article. Floors (not equality — a surgical revision legitimately removes
 * flagged sentences): word count, reference-list length, distinct citations,
 * plus EXACT preservation of section structure (heading count) and the
 * references block. A failed guard keeps the pre-revision article.
 */
export function revisionGuard(originalContent: string, revisedContent: string): RevisionGuardResult {
  const reasons: string[] = [];
  if (!revisedContent || revisedContent.trim().length === 0) {
    return { ok: false, reasons: ["revision is empty"] };
  }
  const oSplit = splitBodyAndReferences(originalContent);
  const rSplit = splitBodyAndReferences(revisedContent);
  if (!rSplit.referencesText.trim()) reasons.push("references block missing");
  const oRefs = parseRefLines(oSplit.referencesText).length;
  const rRefs = parseRefLines(rSplit.referencesText).length;
  if (oRefs > 0 && rRefs < Math.ceil(oRefs * REVISION_MIN_CITATION_RATIO)) {
    reasons.push(`reference list collapsed (${oRefs} → ${rRefs})`);
  }
  const oHead = countSectionHeadings(oSplit.body);
  const rHead = countSectionHeadings(rSplit.body);
  if (oHead > 0 && rHead !== oHead) {
    reasons.push(`section heading count changed (${oHead} → ${rHead})`);
  }
  const oWords = countWords(oSplit.body);
  const rWords = countWords(rSplit.body);
  if (oWords > 0 && rWords < Math.floor(oWords * REVISION_MIN_WORD_RATIO)) {
    reasons.push(`word count collapsed (${oWords} → ${rWords})`);
  }
  const oCit = distinctCitations(oSplit.body, oRefs || Infinity).size;
  const rCit = distinctCitations(rSplit.body, rRefs || Infinity).size;
  if (oCit > 0 && rCit < Math.ceil(oCit * REVISION_MIN_CITATION_RATIO)) {
    reasons.push(`distinct citations collapsed (${oCit} → ${rCit})`);
  }
  return { ok: reasons.length === 0, reasons };
}

export interface CitationNormResult {
  content: string;
  /** surviving references after orphan drop */
  refCount: number;
  /** references removed because nothing cites them anymore */
  droppedRefs: number;
  /** out-of-range citation numbers removed from markers */
  strippedNumbers: number;
  /** true when reference numbering changed (survivors renumbered 1..N) */
  renumbered: boolean;
  /** old citation number → new citation number (empty when unchanged) */
  oldToNew: Map<number, number>;
}

/**
 * Deterministically renormalize citation numbering in a composed (or revised)
 * article: strip out-of-range citation numbers, drop references nothing
 * cites anymore, compact the numbering 1..N in original order, and rebuild
 * the reference list from the ORIGINAL lines (text preserved verbatim).
 * Purely textual — works on in-memory content, no DB.
 */
export function renormalizeArticleCitations(content: string): CitationNormResult {
  const { body, referencesText } = splitBodyAndReferences(content);
  const refLines = parseRefLines(referencesText);
  const base: CitationNormResult = {
    content,
    refCount: refLines.length,
    droppedRefs: 0,
    strippedNumbers: 0,
    renumbered: false,
    oldToNew: new Map(),
  };
  if (refLines.length === 0 || !body.trim()) return base;

  const maxRef = refLines.length;

  // 1. Strip out-of-range numbers from every marker (valid ones kept).
  let stripped = 0;
  const bodyStripped = body.replace(CITE_MARKER_RE, (match, inner: string) => {
    const nums = expandCitationInner(inner);
    const valid = nums.filter((n) => n >= 1 && n <= maxRef);
    if (valid.length === nums.length) return match;
    stripped += nums.length - valid.length;
    if (valid.length === 0) return "";
    return `[${valid.sort((a, b) => a - b).join(",")}]`;
  });

  // 2. Which old numbers are still cited?
  const cited = distinctCitations(bodyStripped, maxRef);
  const survivors = refLines.filter((r) => cited.has(r.num));

  // 3. No orphans → only the OOR strip applies; numbering unchanged.
  if (survivors.length === refLines.length) {
    if (stripped === 0) return base;
    return {
      content: bodyStripped.trimEnd() + "\n\n## References\n\n" + rebuildRefLines(refLines),
      refCount: refLines.length,
      droppedRefs: 0,
      strippedNumbers: stripped,
      renumbered: false,
      oldToNew: new Map(),
    };
  }

  // 4. Orphans exist — drop them and compact the numbering in original order.
  const oldToNew = new Map<number, number>();
  survivors.forEach((r, i) => oldToNew.set(r.num, i + 1));
  const newBody = bodyStripped.replace(CITE_MARKER_RE, (match, inner: string) => {
    const nums = expandCitationInner(inner);
    const mapped = nums.map((n) => oldToNew.get(n)).filter((v): v is number => v !== undefined);
    if (mapped.length === 0) return "";
    mapped.sort((a, b) => a - b);
    return `[${mapped.join(",")}]`;
  });
  const newRefText = survivors
    .map((r, i) => `[${i + 1}] ${r.text}`)
    .join("\n");
  return {
    content: newBody.trimEnd() + "\n\n## References\n\n" + newRefText,
    refCount: survivors.length,
    droppedRefs: refLines.length - survivors.length,
    strippedNumbers: stripped,
    renumbered: true,
    oldToNew,
  };
}

function rebuildRefLines(lines: { num: number; text: string }[]): string {
  return lines.map((r, i) => `[${i + 1}] ${r.text}`).join("\n");
}

/**
 * Split a markdown body into section contents (text between "## " headings,
 * headings excluded). Returns null when the body has no "## " headings.
 * Order is positional — callers pair it with an equally-ordered title array.
 */
export function splitBodySections(body: string): { headings: string[]; contents: string[] } | null {
  const headingRe = /^##\s+(.+)$/gm;
  const headings: string[] = [];
  const indices: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    headings.push(m[1].trim());
    indices.push(m.index);
  }
  if (headings.length === 0) return null;
  const contents: string[] = [];
  for (let i = 0; i < headings.length; i++) {
    const start = indices[i];
    // skip past the heading line itself
    const afterHeading = body.indexOf("\n", start);
    const contentStart = afterHeading === -1 ? body.length : afterHeading + 1;
    const end = i + 1 < headings.length ? indices[i + 1] : body.length;
    contents.push(body.slice(contentStart, end).trim());
  }
  return { headings, contents };
}

/**
 * Replace every "## " heading in the body with the ORIGINAL section title (by
 * position). The bilingual compose stage builds the Chinese half from the
 * paragraph titles — if a revision rewords an English heading, the two halves
 * would structurally diverge. Restoring the original headings deterministically
 * pins the structure while keeping the revised section CONTENTS.
 * Returns null when the heading counts mismatch (caller should treat the
 * revision as malformed).
 */
export function restoreOriginalHeadings(body: string, titles: string[]): string | null {
  const split = splitBodySections(body);
  if (!split || split.headings.length !== titles.length) return null;
  let out = "";
  for (let i = 0; i < titles.length; i++) {
    out += `## ${titles[i]}\n\n${split.contents[i]}`;
    if (i < titles.length - 1) out += "\n\n";
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 5. Local JSON helper (same contract as the review route's)
 * ------------------------------------------------------------------ */

function safeParseJSON(raw: string, fallback: any): any {
  if (typeof raw !== "string") return fallback;
  const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]);
  } catch {
    return fallback;
  }
}
