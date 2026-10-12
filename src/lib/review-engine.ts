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
// RT6 (B-family migration): the review/revision LLM calls run through the
// shared skill executor. The skills import ReviewCoreParsed TYPE-ONLY from
// this module (compile-time, no runtime cycle); this module imports the
// skill definitions at runtime (one direction only).
import { runSkill } from "@/lib/skill/executor";
import {
  reviewCoreSkill,
  REVIEW_CORE_PARSE_FALLBACK,
  reviseArticleSkill,
  reviseSectionSkill,
} from "@/lib/skill/skills-review";
import { stripRevisionWrappers } from "@/lib/writing";

// Backward-compat re-export (the function now lives in writing.ts).
export { stripRevisionWrappers };

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
  /** round-RT3 (R4): per-weakness classification, same order as `weaknesses`:
   *  "fixable" (fact/citation/structure — a revision can actually repair it
   *  within budget) or "advisory" (breadth/novelty/scope — a writer cannot
   *  conjure new experiments by revising). Missing/short arrays ⇒ unknown
   *  for that slot (callers fall back to fixable to preserve legacy
   *  behavior for models that drop the field). */
  weaknessClasses?: string[];
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
  /** count of LLM weaknesses classified "fixable" (R4) — see weaknessClasses */
  fixableWeaknessCount: number;
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
 * external fact-check (cited-abstract-first, then web-searched, adjudication
 * of high-risk claims) → structured LLM peer review → force-merge the fact
 * findings into the weaknesses. Mirrors the review route's runReview
 * exactly (same prompts, same merge logic) so persisted reviews are
 * indistinguishable whether they came from the endpoint or the pipeline loop.
 *
 * round-61 (P0-A): opts.refAbstracts supplies the abstracts of the article's
 * own references — the fact-check layer then corroborates cited claims
 * against the cited source's own abstract BEFORE burning web-search quota
 * (eliminates the false-positive UNVERIFIABLE class seen in the round-60
 * production, where 6/6 flagged claims were actually faithful paraphrases
 * of their cited abstracts).
 */
export async function reviewArticleCore(
  projectId: string,
  article: ReviewCoreInput,
  opts: {
    topic?: string;
    maxClaims?: number;
    /** citation number → abstract of that reference (the article's own pool) */
    refAbstracts?: Map<number, { title: string; abstract: string }>;
  } = {}
): Promise<ReviewCoreResult> {
  // ---- external fact-check (best-effort, never throws) ----
  let factBlock = "";
  let factWeaknesses: string[] = [];
  let factReport: FactCheckReport | null = null;
  try {
    const report = await factCheckArticle(projectId, article.content, {
      maxClaims: opts.maxClaims ?? 8,
      topic: opts.topic || "",
      ...(opts.refAbstracts ? { refAbstracts: opts.refAbstracts } : {}),
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

  // RT6 (B-family migration): the review LLM call + prompt + weakness-class
  // normalization run in the skill (skills-review.ts reviewCoreSkill). No
  // fallback ⇒ provider failures rethrow exactly like the legacy call; a
  // garbage-JSON reply degrades to REVIEW_CORE_PARSE_FALLBACK via the
  // executor's shared safeParseJSON.
  const reviewResult = await runSkill(
    reviewCoreSkill,
    { title: article.title, abstract: article.abstract, content: article.content, factBlock },
    {
      projectId,
      fallbackValue: REVIEW_CORE_PARSE_FALLBACK,
      noCache: true, // legacy: no LLM cache on the review path
    },
  );
  const parsed = reviewResult.output;
  const llmWeaknesses: string[] = Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [];
  const weaknessClasses = parsed.weaknessClasses ?? [];
  const fixableWeaknessCount = weaknessClasses.filter((c) => c === "fixable").length;

  // Force-merge the external fact-check findings into the weaknesses (deduped
  // against the LLM's own) — the reviewing LLM is *told* to keep them, but a
  // lazy/generous model must not be able to bury a CONTRADICTED finding.
  // Cap the merged list at 10 (LLM weaknesses + facts).
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

  return { parsed, factReport, factWeaknesses, mergedWeaknesses, fixableWeaknessCount };
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
 *    round-RT3 (R4): a major-revision whose LLM weaknesses are ALL
 *    "advisory" (breadth/novelty/scope — see weaknessClasses) no longer
 *    triggers: the RT2 production burned 2 extra rounds chasing "not
 *    enough breadth" that no revision of the same sources could ever fix.
 *    Unparseable/missing classes count as fixable (legacy behavior).
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
  if (verdict === "reject") {
    return {
      actionable: true,
      hardFindings: [],
      trigger: "verdict",
      reason: `verdict ${verdict} (overall ${overall}/10, citations ${citations}/10)`,
    };
  }
  if (verdict === "major-revision" && (citations < 6 || overall < 6)) {
    // R4: citation-level failure is mechanical and always fixable; an
    // overall<6 verdict is only actionable when at least one LLM weakness
    // is actually repairable by a revision.
    const fixable = res.fixableWeaknessCount ?? (res.parsed.weaknesses?.length || 0);
    if (citations < 6 || fixable > 0) {
      return {
        actionable: true,
        hardFindings: [],
        trigger: "verdict",
        reason: `verdict ${verdict} (overall ${overall}/10, citations ${citations}/10, ${fixable} fixable weakness(es))`,
      };
    }
    return {
      actionable: false,
      hardFindings: [],
      trigger: "none",
      reason: `verdict ${verdict} with advisory-only weaknesses (${res.parsed.weaknesses?.length || 0} advisory) — disclosed, not repaired`,
    };
  }
  return { actionable: false, hardFindings: [], trigger: "none", reason: "" };
}

/* ------------------------------------------------------------------ *
 * 2.5 round-RT3 (R1): repair-loop convergence — when to stop early
 * ------------------------------------------------------------------ */

export interface RepairRoundSnapshot {
  /** review overall score (0-10); null = unparseable */
  overall: number | null;
  /** hard fact findings this round (CONTRADICTED + unhedged UNVERIFIABLE) */
  hardCount: number;
  /** CONTRADICTED findings only — new ones must never be ignored */
  contradictedCount: number;
  /** fixable LLM weakness count (R4) */
  fixableCount: number;
}

export interface ConvergenceDecision {
  stop: boolean;
  reason: string;
}

/**
 * Early-exit gate for the repair loop (STEP 8.5). The RT2 production run
 * spent 3 review rounds (14.6 min, 35 % of wall-clock) where rounds 2-3
 * each bought ~1 finding and the overall score moved 6/10 → 6/10. Rule:
 * STOP when a round improved the overall score by < 1 point AND the hard
 * findings did not shrink AND no NEW contradiction appeared — the loop is
 * converging on noise at that point and the remaining issues are exactly
 * what the Review tab discloses. The FIRST round (no previous snapshot)
 * never stops (the initial revision is where all the value is), and a
 * score that got WORSE without new contradictions is also converged
 * churn (re-revising against the same feedback produces the same result).
 */
export function shouldStopForConvergence(
  prev: RepairRoundSnapshot | null,
  cur: RepairRoundSnapshot,
): ConvergenceDecision {
  if (!prev) return { stop: false, reason: "" };
  // A new or growing contradiction is always worth one more round.
  if (cur.contradictedCount > prev.contradictedCount) {
    return { stop: false, reason: "" };
  }
  // Hard-finding shrinkage means the revisions are still landing.
  if (cur.hardCount < prev.hardCount) {
    return { stop: false, reason: "" };
  }
  const gain =
    cur.overall != null && prev.overall != null ? cur.overall - prev.overall : null;
  if (gain != null && gain < 1) {
    return {
      stop: true,
      reason: `converged — overall ${prev.overall}→${cur.overall} (<1 gain), ${cur.hardCount} hard finding(s) unchanged; remaining issues disclosed in the Review tab`,
    };
  }
  return { stop: false, reason: "" };
}

/** Convenience: snapshot a completed review round for the convergence gate. */
export function repairRoundSnapshotOf(res: ReviewCoreResult): RepairRoundSnapshot {
  const findings = res.factReport?.findings || [];
  const hard = findings.filter(
    (f) =>
      f.verdict === "CONTRADICTED" ||
      (f.verdict === "UNVERIFIABLE" && !isHedged(f.sentence)),
  );
  return {
    overall: res.parsed.scores?.overall ?? null,
    hardCount: hard.length,
    contradictedCount: findings.filter((f) => f.verdict === "CONTRADICTED").length,
    fixableCount: res.fixableWeaknessCount ?? 0,
  };
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

/**
 * Strip the wrappers LLMs love to add around a "revised article".
 * (RT6: moved verbatim to lib/writing.ts — shared with the revision skills;
 * re-exported above.)
 */

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
  opts: { maxTokens?: number; retryFeedback?: string } = {}
): Promise<string> {
  const feedbackBlock = buildFeedbackBlock(feedback);

  // round-61 (P0-B): STRUCTURAL CONTRACT — derive the exact section
  // headings from the input and pin them in the prompt (the skill renders
  // the contract block). The round-60 production showed an LLM "surgical"
  // revision merging 9 sections into 7 (guard caught it, but the revision
  // budget was wasted). The contract makes the constraint explicit instead
  // of implicit.
  const contractTitles: string[] = [];
  if (mode === "surgical") {
    const split = splitBodyAndReferences(article.content);
    const headingRe = /^##\s+(.+)$/gm;
    let hm: RegExpExecArray | null;
    while ((hm = headingRe.exec(split.body)) !== null) contractTitles.push(hm[1].trim());
  }

  // RT6 (B-family migration): prompt/parse/wrapper-stripping live in the
  // skill (skills-review.ts reviseArticleSkill, prose slot). Surgical mode
  // overrides the temperature (0.3 vs full's 0.5) exactly like the legacy
  // call. No fallback ⇒ provider failures rethrow to the caller (the v2
  // repair loop's per-attempt catch owns the degradation).
  const result = await runSkill(
    reviseArticleSkill,
    {
      title: article.title,
      content: article.content,
      feedbackBlock,
      mode,
      round: feedback.round,
      contractTitles,
      retryFeedback: opts.retryFeedback,
    },
    {
      projectId,
      fallbackValue: "",
      noCache: true, // legacy: no LLM cache on the revision path
      chatOverrides: {
        temperature: mode === "surgical" ? 0.3 : 0.5,
        ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      },
    },
  );
  return result.output;
}

/* ------------------------------------------------------------------ *
 * 3b. Section-scoped revision (round-61 P1)
 * ------------------------------------------------------------------ */

export interface ScopedRevisionResult {
  ok: boolean;
  /** the reassembled full article (body + references) — null when !ok */
  content: string | null;
  /** 0-based indices of sections that were revised */
  revisedSections: number[];
  /** per-section finding counts (diagnostics) */
  findingsPerSection: Record<number, number>;
  reason?: string;
}

const normText = (s: string) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * SECTION-SCOPED surgical revision (round-61 P1): instead of rewriting the
 * whole article (which the round-60 production showed collapses the section
 * structure 9→7), locate ONLY the sections containing flagged claims / named
 * suggestions, revise each section's content in an isolated LLM call, and
 * reassemble with every heading and the reference block byte-preserved.
 * Structurally safe by construction — headings never enter an LLM prompt as
 * rewritable material.
 *
 * Falls back (ok:false) when nothing locates into a section, so the caller
 * can drop to the whole-article surgical mode.
 */
export async function reviseArticleScoped(
  projectId: string,
  article: { title: string; content: string },
  feedback: RevisionFeedback,
  hardFindings: FactCheckFinding[] = []
): Promise<ScopedRevisionResult> {
  const split = splitBodyAndReferences(article.content);
  const sec = splitBodySections(split.body);
  if (!sec || sec.headings.length === 0) {
    return { ok: false, content: null, revisedSections: [], findingsPerSection: {}, reason: "no sections found" };
  }

  // 1. Locate hard findings (sentence containment, first 60 normalized chars).
  const affected = new Map<number, string[]>();
  for (const f of hardFindings) {
    const key = normText(f.sentence).slice(0, 60);
    if (!key) continue;
    let matched = -1;
    for (let i = 0; i < sec.contents.length; i++) {
      if (normText(sec.contents[i]).includes(key)) { matched = i; break; }
    }
    if (matched < 0) continue;
    const line = `FACT-CHECK ${f.verdict} (${f.category}): "${f.sentence.slice(0, 300)}" — ${f.reason || "no reason given"}${f.evidenceQuote ? ` | evidence: "${f.evidenceQuote.slice(0, 160)}"` : ""}`;
    if (!affected.has(matched)) affected.set(matched, []);
    affected.get(matched)!.push(line);
  }

  // 2. Locate reviewer suggestions by section-title matching (only factual /
  // citation-flavored ones — the surgical contract ignores pure style).
  for (const s of feedback.suggestions || []) {
    const target = String(s?.section || "").trim().toLowerCase();
    const issue = String(s?.issue || "").trim();
    const fix = String(s?.fix || "").trim();
    if (!target || (!issue && !fix)) continue;
    const idx = sec.headings.findIndex(
      (h) => h.toLowerCase().includes(target) || target.includes(h.toLowerCase().slice(0, 30))
    );
    if (idx < 0) continue;
    const line = `REVIEWER SUGGESTION for this section: issue — ${issue} → fix — ${fix}`;
    if (!affected.has(idx)) affected.set(idx, []);
    affected.get(idx)!.push(line);
  }

  if (affected.size === 0) {
    return { ok: false, content: null, revisedSections: [], findingsPerSection: {}, reason: "no findings located in any section" };
  }

  // Cap: at most 5 sections per round (budget + focus).
  const sectionIdxs = [...affected.keys()].sort((a, b) => a - b).slice(0, 5);
  const revisedContents = [...sec.contents];
  const revisedDone: number[] = [];
  const findingsPerSection: Record<number, number> = {};

  const scoresLine = (() => {
    const s = feedback.scores || {};
    return `verdict=${feedback.verdict}, overall=${s.overall ?? "?"}/10, citations=${s.citations ?? "?"}/10`;
  })();

  for (const idx of sectionIdxs) {
    const findingsBlock = affected.get(idx)!.join("\n");
    findingsPerSection[idx] = affected.get(idx)!.length;

    // RT6 (B-family migration): per-section prose skill (skills-review.ts
    // reviseSectionSkill) — wrapper/heading stripping in postProcess. The
    // per-section try/catch stays HERE: one failed section keeps its
    // original text (legacy semantics — no skill fallback by design).
    try {
      const result = await runSkill(
        reviseSectionSkill,
        {
          title: article.title,
          heading: sec.headings[idx],
          sectionText: sec.contents[idx],
          findingsBlock,
          scoresLine,
          round: feedback.round,
          sectionIdx: idx,
        },
        {
          projectId,
          fallbackValue: "",
          noCache: true, // legacy: no LLM cache on the revision path
        },
      );
      const revised = result.output;
      if (revised.length < 40) continue; // degenerate output — keep original
      revisedContents[idx] = revised;
      revisedDone.push(idx);
    } catch {
      // one failed section does not sink the round — its content stays as-is
    }
  }

  if (revisedDone.length === 0) {
    return { ok: false, content: null, revisedSections: [], findingsPerSection: {}, reason: "all section revisions failed or degenerated" };
  }

  // 3. Reassemble — headings and references byte-preserved.
  let out = "";
  for (let i = 0; i < sec.headings.length; i++) {
    out += `## ${sec.headings[i]}\n\n${revisedContents[i]}`;
    if (i < sec.headings.length - 1) out += "\n\n";
  }
  const content = out.trimEnd() + "\n\n" + split.referencesText.trim();
  return { ok: true, content, revisedSections: revisedDone, findingsPerSection };
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
    // round-cs-6: blank line between entries (same rendering fix)
    .join("\n\n");
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
  // round-cs-6: blank line between entries — single "\n" joins render as
  // one merged paragraph in most markdown viewers.
  return lines.map((r, i) => `[${i + 1}] ${r.text}`).join("\n\n");
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
 * 5. JSON helper — round-RT2: the weak local copy (greedy brace + bare
 *    JSON.parse, no fence stripping, no JSON5, no repair) is replaced by
 *    the canonical shared extractor imported above (lib/llm-json.ts). A
 *    review-role model that wraps its verdict JSON in prose or uses
 *    trailing commas used to land here as a parse failure → the
 *    “major-revision overall 5” fallback → PHANTOM repair rounds on a
 *    perfectly fine article.
 * ------------------------------------------------------------------ */
