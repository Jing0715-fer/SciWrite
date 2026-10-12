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
 *
 * RT7: the two LLM calls are now skills (skills-coherence.ts —
 * coherence-review / coherence-edit). This module keeps the pool
 * orchestration (body splitting, section numbering, findings→section
 * grouping, the ≤5-section loop) and the legacy function signatures the
 * v2 route consumes; prompt text + output normalization + degradation
 * contracts live in the skills.
 */

import { runSkill } from "@/lib/skill/executor";
import { coherenceEditSkill, coherenceReviewSkill, COHERENCE_MAX_SECTIONS } from "@/lib/skill/registry";
import type { CoherenceEditInput, CoherenceReviewInput } from "@/lib/skill/registry";
import type { CoherenceFinding, CoherenceReviewOutput } from "@/lib/skill/registry";
import { splitBodySections } from "@/lib/review-engine";
import { splitBodyAndReferences } from "@/lib/citation-audit";
import { logger } from "@/lib/logger";

// RT7: shared contracts moved to the skill family file; re-exported here so
// existing imports (the v2 route, tests) keep working unchanged.
export {
  COHERENCE_MAX_FINDINGS,
  COHERENCE_MAX_SECTIONS,
  type CoherenceFinding,
  type CoherenceFindingType,
} from "@/lib/skill/skills-coherence";

export type { CoherenceReviewOutput } from "@/lib/skill/skills-coherence";

const log = (m: string) => logger("coherence").info(m);

export interface CoherenceReviewResult {
  ran: boolean;
  findings: CoherenceFinding[];
  summary: string;
  error?: string;
}

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
    .map((s) => `## ${s.replace(/\n+$/, "")}`)
    .join("\n\n");

  const input: CoherenceReviewInput = {
    title: article.title,
    topic: opts.topic,
    numberedBody,
    sectionCount: sections.headings.length,
  };
  const result = await runSkill(coherenceReviewSkill, input, {
    projectId,
    fallbackValue: { summary: "", findings: [] },
    // B-family rule: the legacy site had no cache — keep that exact behavior.
    noCache: true,
    chatOverrides: opts.maxTokens != null ? { maxTokens: opts.maxTokens } : undefined,
  });

  if (result.degraded) {
    // Legacy catch semantics: ran:false + the error message.
    return {
      ran: false,
      findings: [],
      summary: "",
      error: (result.issues[0] || "review unavailable").replace(/^fallback:\s*/, "").slice(0, 160),
    };
  }
  const out: CoherenceReviewOutput = result.output;
  return { ran: true, findings: out.findings, summary: out.summary };
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

  for (const idx of targets) {
    const findingsFor = bySection.get(idx)!;
    const heading = sec.headings[idx];
    const prevTail = idx > 0 ? sec.contents[idx - 1].replace(/\s+/g, " ").slice(-320) : "(this is the opening section)";
    const nextHead = idx + 1 < sec.contents.length ? sec.contents[idx + 1].replace(/\s+/g, " ").slice(0, 320) : "(this is the final section)";

    opts.onProgress?.(`Polishing §${idx + 1} (${findingsFor.length} finding(s))...`);

    const input: CoherenceEditInput = {
      title: article.title,
      heading,
      prevTail,
      nextHead,
      sectionText: sec.contents[idx],
      findings: findingsFor,
    };
    const result = await runSkill(coherenceEditSkill, input, {
      projectId,
      fallbackValue: "",
      noCache: true,
      // Legacy metadata: { step: "coherence", sub: "polish", section: idx+1 }
      // — the skill owns step/sub; the section row rides per-invocation.
      metadata: { section: idx + 1 },
      chatOverrides: opts.maxTokens != null ? { maxTokens: opts.maxTokens } : undefined,
    });

    if (result.ok) {
      revisedContents[idx] = result.output;
      revisedDone.push(idx);
      addressed += findingsFor.length;
      log(`polished §${idx + 1} — ${findingsFor.length} finding(s): ${findingsFor.map((f) => f.type).join(", ")}`);
    } else {
      // Legacy per-section catch / degenerate-output semantics, unified:
      // the skill's fallback returned the ORIGINAL text — keep it as-is.
      log(`polish §${idx + 1} ${result.degraded ? "failed" : "produced degenerate output"}: ${(result.issues[0] || "").slice(0, 120)} — section kept as-is`);
    }
  }

  if (revisedDone.length === 0) {
    return { ok: false, content: null, revisedSections: [], findingsAddressed: 0, reason: "every section polish failed or produced degenerate output" };
  }

  const body = revisedContents.map((c, i) => `## ${sec.headings[i]}\n\n${c.trim()}`).join("\n\n");
  const content = body.trim() + (split.referencesText.trim() ? "\n\n" + split.referencesText.trim() : "");
  return { ok: true, content, revisedSections: revisedDone, findingsAddressed: addressed, reason: "ok" };
}
