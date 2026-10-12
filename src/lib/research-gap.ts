/**
 * Research Gap Agent (round-cs-2) — autonomous evidence-gap discovery + targeted
 * supplementary retrieval for generate-full-v2.
 *
 * Problem this module solves (user complaint, 2026-09):
 * "文章生成是一次生成，前后章独立，彼此联系很少，需要重复利用 agent 能力，
 *  长时间自主收集信息" — the v2 pipeline gathered sources ONCE at the very
 * start (STEP 1), then never looked for more no matter what the outline later
 * promised. A section planned on "cryo-EM structures of X" shipped thin or
 * uncited whenever the initial searches happened to miss that literature,
 * because nothing between plan (STEP 3) and write (STEP 6) could notice the
 * mismatch and go get more evidence.
 *
 * The gap agent closes that loop. It runs BETWEEN plan and analyze:
 *
 *   1. identifyEvidenceGaps — the LLM sees the planned outline TOGETHER WITH
 *      the titles of the references allocated to each section, and names the
 *      specific claims/areas the outline promises that no allocated source
 *      covers (bounded to GAP_AGENT_MAX_GAPS). Sections with zero allocated
 *      refs are force-included mechanically — that defect needs no judgment.
 *   2. runGapResearch — for every gap, executes TARGETED searches (PubMed for
 *      scholarly evidence, web for context), dedupes against the existing
 *      pool (externalId / URL / normalized title), and passes candidates
 *      through an LLM relevance gate so only sources that genuinely fill a
 *      named gap survive.
 *
 * The result: bounded autonomous research — the agent can go BACK for more
 * information after seeing what the outline needs, the way a human writer
 * keeps searching while drafting. All failures are non-fatal: an empty or
 * errored gap round leaves the pool exactly as curation built it.
 *
 * RT7: the two LLM calls are now skills (skills-gap.ts — gap-design for the
 * identify pass, gap-research for the relevance gate). This module keeps the
 * pool orchestration (the mechanical-gap pass, the search loop, dedupe sets,
 * the storm-guard short-circuit, the keep-0 keyword ranking) and the legacy
 * function signatures the v2 route consumes.
 */

import { webSearch } from "@/lib/ai";
import { queryDatabase } from "@/lib/databases";
import { logger } from "@/lib/logger";
import { isAborted } from "@/lib/rate-limiter";
import { runSkill } from "@/lib/skill/executor";
import { gapDesignSkill, gapResearchSkill, GAP_AGENT_MAX_GAPS } from "@/lib/skill/registry";
import type { EvidenceGap, GapCandidate, GapDesignInput, GapResearchInput } from "@/lib/skill/registry";

// RT7: shared contracts moved to the skill family file; re-exported here so
// existing imports (the v2 route, tests) keep working unchanged.
export { GAP_AGENT_MAX_GAPS, GAP_AGENT_MAX_QUERIES_PER_GAP } from "@/lib/skill/skills-gap";
export type { EvidenceGap, GapQuery, GapCandidate } from "@/lib/skill/skills-gap";

/** Hard cap on new references merged into the pool per run. */
export const GAP_AGENT_MAX_NEW_REFS = 6;
/** Do not grow the analyze-stage pool beyond this (extractEvidenceBank cap). */
export const GAP_AGENT_POOL_CEILING = 40;
/** Web results per individual web search call. */
const GAP_WEB_RESULT_COUNT = 8;

/** round-RT2: generic-corpus stopwords for the keep-0 mechanical ranker. */
const GAP_STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "been", "were", "which", "their",
  "these", "those", "about", "would", "could", "should", "between", "into",
  "such", "than", "then", "them", "there", "where", "while", "also", "both",
  "each", "more", "most", "other", "over", "some", "such", "only", "same",
  "very", "just", "does", "doing", "when", "what", "will", "shall", "using",
  "used", "study", "studies", "paper", "papers", "review", "article",
]);

export interface GapAgentReport {
  ran: boolean;
  gapsFound: number;
  mechanicalGaps: number;
  queriesRun: number;
  candidates: number;
  newRefs: GapCandidate[];
  rejected: string[];
  reason: string;
}

const log = (m: string) => logger("gap-agent").info(m);

/** Normalize an identity string for dedupe comparison. */
function normId(s: string | null | undefined): string {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Title-based dedupe key: lowercase, strip punctuation, first 90 chars. */
function titleKey(t: string | null | undefined): string {
  return normId(t).replace(/[^\p{L}\p{N} ]/gu, "").slice(0, 90);
}

/**
 * Stage 1 — identify evidence gaps between the planned outline and the
 * references currently allocated to each section.
 *
 * Mechanical gaps (0 allocated refs) are force-included without the LLM.
 */
export async function identifyEvidenceGaps(
  projectId: string,
  sections: any[],
  curatedRefs: any[],
  topic: string,
  field: string,
  opts: { maxTokens?: number } = {},
): Promise<{ gaps: EvidenceGap[]; mechanicalGaps: number; llmError?: string }> {
  const gaps: EvidenceGap[] = [];
  let mechanicalGaps = 0;

  // --- Mechanical pass: a section with zero allocated refs IS a gap. ---
  for (let i = 0; i < sections.length; i++) {
    const refs: number[] = Array.isArray(sections[i]?.refIndices) ? sections[i].refIndices : [];
    if (refs.length === 0) {
      mechanicalGaps++;
      const topicWords = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 4).join(" ");
      const sectionPhrase = String(sections[i]?.title || `section ${i + 1}`).slice(0, 80);
      gaps.push({
        sectionIndex: i,
        sectionTitle: String(sections[i]?.title || `Section ${i + 1}`),
        gap: `Section "${sectionPhrase}" has ZERO allocated references but must make grounded claims.`,
        queries: [
          { database: "pubmed", query: `${sectionPhrase} ${topicWords}`.replace(/\s+/g, " ").slice(0, 240) },
          { database: "web", query: `${sectionPhrase} ${topicWords} research` .replace(/\s+/g, " ").slice(0, 240) },
        ],
      });
    }
  }

  // --- LLM pass: judgment gaps — content the outline promises but the
  //     allocated sources cannot support. ---
  const coverageLines = sections
    .map((s: any, i: number) => {
      const refs: number[] = Array.isArray(s.refIndices) ? s.refIndices : [];
      const refTitles = refs
        .slice(0, 8)
        .map((n) => curatedRefs[n - 1]?.title)
        .filter(Boolean)
        .map((t) => `    - ${String(t).slice(0, 90)}`)
        .join("\n");
      return `§${i + 1}: ${String(s.title).slice(0, 80)} — FOCUS: ${String(s.focus || "").slice(0, 140)}
  allocated refs (${refs.length}):${refTitles ? `\n${refTitles}` : " NONE"}`;
    })
    .join("\n\n");

  const input: GapDesignInput = {
    topic,
    field,
    coverageLines,
    sectionCount: sections.length,
    sectionTitles: sections.map((s: any) => String(s?.title || "")),
    // Mechanical gaps already occupy the budget — the LLM tops up to the cap.
    remainingCapacity: Math.max(0, GAP_AGENT_MAX_GAPS - gaps.length),
  };
  const result = await runSkill(gapDesignSkill, input, {
    projectId,
    fallbackValue: { gaps: [] },
    noCache: true,
    chatOverrides: opts.maxTokens != null ? { maxTokens: opts.maxTokens } : undefined,
  });

  // Non-fatal: mechanical gaps (if any) still run; the pool is unchanged.
  if (result.degraded) {
    return {
      gaps,
      mechanicalGaps,
      llmError: (result.issues[0] || "identify unavailable").replace(/^fallback:\s*/, "").slice(0, 160),
    };
  }

  return { gaps: [...gaps, ...result.output.gaps], mechanicalGaps };
}

/**
 * Stage 2 — execute the gap searches and return deduped, relevance-gated
 * candidates ready to merge into the curated pool.
 *
 * `existingPool` should be the FULL reference pool (anything already
 * gathered/curated) so nothing already in hand is fetched twice.
 */
export async function runGapResearch(
  projectId: string,
  topic: string,
  gaps: EvidenceGap[],
  existingPool: any[],
  opts: {
    maxNewRefs?: number;
    maxTokens?: number;
    onProgress?: (message: string) => void;
  } = {},
): Promise<{ candidates: GapCandidate[]; queriesRun: number; rejected: string[]; relevanceGateError?: string }> {
  const maxNewRefs = Math.min(opts.maxNewRefs ?? GAP_AGENT_MAX_NEW_REFS, GAP_AGENT_MAX_NEW_REFS);
  const rejected: string[] = [];
  const queriesRun: { database: string; query: string; results: number; ok: boolean }[] = [];
  const candidates: GapCandidate[] = [];

  // Identity sets for dedupe: externalId, url, normalized title.
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  for (const r of existingPool) {
    const eid = normId(r?.externalId);
    if (eid) seenIds.add(`${normId(r?.type) || "pubmed"}:${eid}`);
    const u = normId(r?.url);
    if (u) seenUrls.add(u);
    const tk = titleKey(r?.title);
    if (tk) seenTitles.add(tk);
  }

  const pushCandidate = (c: GapCandidate) => {
    const eid = normId(c.externalId);
    const idKey = eid ? `${normId(c.source) === "web" ? "web" : "pubmed"}:${eid}` : "";
    const url = normId(c.url);
    const tk = titleKey(c.title);
    if (idKey && seenIds.has(idKey)) return false;
    if (url && seenUrls.has(url)) return false;
    if (tk && seenTitles.has(tk)) return false;
    if (idKey) seenIds.add(idKey);
    if (url) seenUrls.add(url);
    if (tk) seenTitles.add(tk);
    candidates.push(c);
    return true;
  };

  for (let gi = 0; gi < gaps.length; gi++) {
    const gap = gaps[gi];
    for (const q of gap.queries) {
      try {
        if (q.database === "pubmed") {
          const r = await queryDatabase("pubmed", q.query, { searchOpts: { context: topic } });
          let added = 0;
          for (const item of r.items || []) {
            const title = String(item.title || "").trim();
            // Same junk guard as gather: titleless or bare-ID rows are
            // unverifiable and un-citable.
            if (!title || title === String(item.externalId || "")) continue;
            if (pushCandidate({
              source: "pubmed",
              externalId: item.externalId || null,
              title,
              authors: item.authors || null,
              journal: item.journal || null,
              year: item.year || null,
              url: item.url || null,
              doi: item.doi || null,
              abstract: item.abstract || null,
              extra: item.extra,
              gapIndex: gi,
              queryUsed: q.query,
            })) added++;
          }
          queriesRun.push({ database: "pubmed", query: q.query, results: r.items?.length || 0, ok: true });
          opts.onProgress?.(`Gap ${gi + 1} PubMed "${q.query.slice(0, 45)}" → ${r.items?.length || 0} results, ${added} new`);
        } else {
          const results = await webSearch(q.query, GAP_WEB_RESULT_COUNT);
          let added = 0;
          for (const item of results) {
            const title = String(item.name || "").trim();
            if (!title) continue;
            if (pushCandidate({
              source: "web",
              externalId: item.url,
              title,
              authors: null,
              year: item.date?.match(/\b(19|20)\d{2}\b/)?.[0] || null,
              url: item.url,
              doi: null,
              abstract: item.snippet || null,
              extra: { host: item.host_name, rank: item.rank },
              gapIndex: gi,
              queryUsed: q.query,
            })) added++;
          }
          queriesRun.push({ database: "web", query: q.query, results: results.length, ok: true });
          opts.onProgress?.(`Gap ${gi + 1} web "${q.query.slice(0, 45)}" → ${results.length} results, ${added} new`);
        }
      } catch (err: any) {
        queriesRun.push({ database: q.database, query: q.query, results: 0, ok: false });
        rejected.push(`${q.database} "${q.query.slice(0, 50)}": ${String(err?.message ?? err).slice(0, 80)}`);
        log(`search failed — ${rejected[rejected.length - 1]}`);
      }
    }
  }

  if (candidates.length === 0) {
    return { candidates: [], queriesRun: queriesRun.length, rejected };
  }

  // round-cs-2 (storm guard): if the account-level rate limiter has already
  // hoisted the abort flag, do NOT burn the gate's 5×≤30s retry budget —
  // degrade straight to the deterministic PubMed-only fallback.
  if (isAborted()) {
    const pubmedOnly = candidates.filter((c) => c.source === "pubmed").slice(0, maxNewRefs);
    rejected.push(`relevance gate skipped — provider abort flag set (429 storm); kept ${pubmedOnly.length} PubMed candidate(s)`);
    return { candidates: pubmedOnly, queriesRun: queriesRun.length, rejected };
  }

  // --- Relevance gate (LLM skill): only keep candidates that genuinely
  //     fill a named gap. Fallback on LLM failure: keep PubMed candidates
  //     (database provenance is a strong-enough signal) capped at maxNewRefs. ---
  const gateInput: GapResearchInput = { topic, gaps, candidates, maxNewRefs };
  const gate = await runSkill(gapResearchSkill, gateInput, {
    projectId,
    fallbackValue: { keep: [], parseOk: false },
    noCache: true,
    chatOverrides: opts.maxTokens != null ? { maxTokens: opts.maxTokens } : undefined,
  });
  if (gate.degraded) {
    // Provider failure — the skill fallback already selected the PubMed
    // candidates' C-ids; surface the reason on the report.
    rejected.push(`relevance gate failed: ${(gate.issues[0] || "unknown").replace(/^fallback:\s*/, "").slice(0, 80)} — fell back to PubMed candidate(s)`);
  }

  const keepSet = new Set(gate.output.keep);
  const gated = candidates.filter((_, i) => keepSet.has(`C${i + 1}`));
  if (gated.length > 0) {
    // PubMed first, then web — scholarly sources carry the missing claims.
    gated.sort((a, b) => (a.source === "pubmed" ? -1 : 1) - (b.source === "pubmed" ? -1 : 1));
    return {
      candidates: gated.slice(0, maxNewRefs),
      queriesRun: queriesRun.length,
      rejected,
      relevanceGateError: gate.degraded
        ? (gate.issues[0] || "").replace(/^fallback:\s*/, "").slice(0, 160)
        : undefined,
    };
  }

  // ── round-RT2 (keep-0 fallback intelligence): the old behavior blindly
  // admitted every PubMed candidate whenever the gate kept nothing, which
  // conflated two different situations: (a) the gate GENUINELY rejected
  // all candidates as off-topic, and we admitted them anyway — the LLM's
  // judgment was silently overridden; (b) the gate's JSON failed to parse
  // (weak review model wrapped it in prose) and `{keep:[]}` was the
  // FALLBACK, not a verdict. Now:
  //   • parse failure (output.parseOk === false) → old PubMed-candidate
  //     fallback (database provenance is a reasonable proxy when the gate
  //     never actually spoke);
  //   • genuine keep-0 → mechanical topical ranking of ALL candidates
  //     against the gap texts; only candidates with real keyword overlap
  //     with a named gap survive (PubMed preferred on ties).
  if (!gate.output.parseOk) {
    const pubmedOnly = candidates.filter((c) => c.source === "pubmed").slice(0, maxNewRefs);
    rejected.push(
      `relevance gate response unparseable — fell back to ${pubmedOnly.length} PubMed candidate(s)`,
    );
    return { candidates: pubmedOnly, queriesRun: queriesRun.length, rejected };
  }
  const gapText = gaps.map((g) => `${g.gap} ${g.sectionTitle}`).join(" ").toLowerCase();
  const gapKeywords = new Set(
    gapText.split(/[^a-z0-9+]+/).filter((w: string) => w.length > 3 && !GAP_STOPWORDS.has(w))
  );
  const ranked = candidates
    .map((c) => {
      const text = `${c.title || ""} ${String(c.abstract || "")}`.toLowerCase();
      let overlap = 0;
      for (const w of gapKeywords) if (text.includes(w)) overlap++;
      return { c, overlap, pubmed: c.source === "pubmed" ? 1 : 0 };
    })
    .filter((r) => r.overlap >= 2) // ≥2 distinct gap keywords to count as on-topic
    .sort((a, b) => b.overlap - a.overlap || b.pubmed - a.pubmed);
  const survivors = ranked.slice(0, Math.min(3, maxNewRefs)).map((r) => r.c);
  rejected.push(
    `relevance gate kept 0 of ${candidates.length} — mechanical ranking kept ${survivors.length} topical candidate(s) (≥2 gap keywords)`,
  );
  return { candidates: survivors, queriesRun: queriesRun.length, rejected };
}
