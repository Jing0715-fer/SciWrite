/**
 * citation-planner.ts — round-42: importance-driven citation planning.
 *
 * WHY (user requirement): the citation count for an article was previously a
 * MECHANICAL formula — `max(20, targetWords/200)` refs selected by a
 * fixed-count LLM curation ("select exactly N"). Two failure modes:
 *   (a) thin/marginal source pool → irrelevant refs padded in to hit N;
 *   (b) rich pool + short article → low-relevance refs kept because the
 *       count was fixed before relevance was judged.
 *
 * This module implements the user's requested flow:
 *   1. SCORE every gathered source for importance/relevance first, factoring
 *      in "understanding depth" (whether full text is available — a source we
 *      can read completely supports deeper, more accurate discussion).
 *   2. SMART-CURATE with a DYNAMIC citation count: the LLM decides how many
 *      references the article genuinely needs (bounded by guardrails), never
 *      padding with irrelevant sources and always keeping core ones.
 *   3. The downstream plan stage then co-designs the outline AND which
 *      references each section cites (see formatScoredRefLine +
 *   validateSectionCitationPlan, used by both pipeline routes).
 *
 * Design constraints honored here:
 *   - every LLM stage has a mechanical fallback so the pipeline never blocks;
 *   - llm-cache is consulted for deterministic calls (regenerate reuse);
 *   - prompts stay well under llm-session's 28000-char compression cap.
 */

import { chatWithSession } from "@/lib/llm-session";
import { safeParseJSON, scoreRelevance, extractSectionKeywords } from "@/lib/generate-full-helpers";
import { fetchFullTextForPubMed } from "@/lib/databases";
import { maxCitableRefsFor } from "@/lib/v2-config";

/** Understanding depth available for a source. */
export type SourceDepth = "fulltext" | "abstract" | "metadata";

/** Mechanical (no-LLM) profile of what we can actually READ of a source. */
export interface FullTextProfile {
  /** A free full text is (very likely) retrievable for this source. */
  hasFreeFullText: boolean;
  /** PMC id when known (from PubMed esummary articleids, stored in extra). */
  pmcId?: string;
  /** Deep-read structured summary (DataSource.summary from the deep-read
   * endpoint) — a compact full-text substitute for web sources. */
  deepReadSummary?: string;
  depth: SourceDepth;
}

/** LLM-produced importance assessment of one source. */
export interface SourceScore {
  /** 1-based index into the refs array the score was computed against. */
  index: number;
  /** Topical fit to the article topic, 1-10 (LLM judgment). */
  relevance: number;
  /** Scholarly weight — seminal/primary work ranks high, 1-10. */
  importance: number;
  /** Understanding depth available (mechanical input, echoed for context). */
  depth: SourceDepth;
  /** One-line justification from the scorer. */
  reason: string;
  /** Composite 0-10 citation priority: relevance dominates, importance
   * second, full-text availability is a tiebreaker bonus. */
  priority: number;
  /** Mechanical tier derived from priority: core (>=7.5), important (>=5.5),
   * marginal (below). Core refs are force-retained by the smart curator. */
  tier: "core" | "important" | "marginal";
}

export interface SmartCurationResult {
  /** Selected refs, priority-ordered (most important first) so downstream
   * 40-item caps (evidence bank, relationship analysis) keep the best. */
  refs: any[];
  /** Scores aligned 1:1 with `refs` (score.index is the position in refs). */
  scores: SourceScore[];
  /** The citation count the LLM (or fallback) planned for the article. */
  plannedCount: number;
  /** One-line rationale for the count decision. */
  rationale: string;
  /** false when the mechanical fallback produced the selection. */
  llmDriven: boolean;
}

/** Priority composition weights (sum with depth bonus ≤ 1 → max 10). */
function computePriority(relevance: number, importance: number, depth: SourceDepth): number {
  const depthBonus = depth === "fulltext" ? 1 : depth === "abstract" ? 0.5 : 0;
  return Math.max(0, Math.min(10, relevance * 0.55 + importance * 0.35 + depthBonus));
}

function tierFor(priority: number): "core" | "important" | "marginal" {
  if (priority >= 7.5) return "core";
  if (priority >= 5.5) return "important";
  return "marginal";
}

/**
 * Mechanical full-text availability profile for every reference.
 *
 * Matching rules (DataSource rows carry the signals; Reference rows don't):
 *   - pubmed ref ↔ DataSource with same externalId whose `extra` JSON holds
 *     pmcId / hasFreeFullText → PMC free article, full text fetchable;
 *   - web ref ↔ DataSource with same externalId (or url) whose `summary`
 *     looks like a deep-read block ("KEY FINDINGS:" header) → deep-read
 *     summary available as a compact full-text substitute;
 *   - pubmed refs WITHOUT a known PMC marker are marked "abstract" here even
 *     though fetchFullTextForPubMed can still discover a PMC id via elink ID
 *     conversion — the profile is a SCORING hint, not a fetch gate (the
 *     fetch stage tries the top pubmed refs regardless).
 */
export function buildFullTextProfiles(
  refs: any[],
  dataSources: any[]
): Map<string, FullTextProfile> {
  // Index the data sources by their identity keys for O(1) matching.
  const byExternalId = new Map<string, any>();
  const byUrl = new Map<string, any>();
  for (const ds of dataSources || []) {
    if (ds.externalId) byExternalId.set(String(ds.externalId), ds);
    if (ds.url) byUrl.set(String(ds.url), ds);
  }

  const profiles = new Map<string, FullTextProfile>();
  for (const ref of refs || []) {
    const matched =
      (ref.externalId && byExternalId.get(String(ref.externalId))) ||
      (ref.url && byUrl.get(String(ref.url))) ||
      null;

    let profile: FullTextProfile = {
      hasFreeFullText: false,
      depth: ref.abstract ? "abstract" : "metadata",
    };

    if (matched) {
      // PMC free-article markers live in DataSource.extra
      if (matched.extra) {
        try {
          const extra = JSON.parse(matched.extra);
          if (extra?.pmcId || extra?.hasFreeFullText) {
            profile = {
              hasFreeFullText: true,
              pmcId: extra.pmcId || undefined,
              depth: "fulltext",
            };
          }
        } catch {
          // malformed extra JSON — treat as no marker
        }
      }
      // Deep-read summaries are recognizable by their structured header
      if (!profile.hasFreeFullText && matched.summary) {
        const s = String(matched.summary);
        if (s.includes("KEY FINDINGS:") && s.length > 120) {
          profile = {
            hasFreeFullText: true,
            deepReadSummary: s,
            depth: "fulltext",
          };
        }
      }
    }

    profiles.set(ref.id, profile);
  }
  return profiles;
}

/**
 * Mechanical fallback scorer — used per-batch when the LLM call fails, so a
 * rate-limited scoring stage degrades to keyword relevance + recency instead
 * of blocking the pipeline.
 */
function mechanicalScores(
  refs: any[],
  profiles: Map<string, FullTextProfile>,
  topic: string
): SourceScore[] {
  const topicKeywords = extractSectionKeywords(topic);
  return refs.map((r, i) => {
    // Keyword overlap normalized to 1-10 (scoreRelevance counts matches).
    const kw = scoreRelevance(topicKeywords, `${r.title || ""} ${r.abstract || ""} ${r.journal || ""}`);
    const relevance = Math.max(1, Math.min(10, Math.round(kw * 1.6) || 3));
    // Recency + primary-type bias for the importance floor.
    const year = parseInt(String(r.year || "0"), 10);
    const recency = year >= 2018 ? 1.5 : year >= 2010 ? 0.75 : 0;
    const typeBias = r.type === "pubmed" ? 1 : 0.5;
    const importance = Math.max(1, Math.min(10, Math.round(4 + recency + typeBias)));
    const depth = profiles.get(r.id)?.depth || (r.abstract ? "abstract" : "metadata");
    const priority = computePriority(relevance, importance, depth);
    return {
      index: i + 1,
      relevance,
      importance,
      depth,
      reason: "mechanical fallback (keyword overlap + recency)",
      priority,
      tier: tierFor(priority),
    };
  });
}

/**
 * Stage 1 — LLM importance scoring for EVERY gathered reference.
 *
 * Batches of ~20 refs per call (compact single-line entries keep each prompt
 * ~9k chars, far under the llm-session compression cap). Deterministic for
 * the same input → llm-cache gives free reuse on regenerate.
 */
export async function scoreSources(
  projectId: string,
  refs: any[],
  profiles: Map<string, FullTextProfile>,
  topic: string,
  field: string,
  opts: {
    batchSize?: number;
    maxTokens?: number;
    onProgress?: (message: string) => void;
  } = {}
): Promise<{ scores: SourceScore[]; llmBatches: number; fallbackBatches: number }> {
  const batchSize = opts.batchSize ?? 20;
  const scores: SourceScore[] = new Array(refs.length);
  let llmBatches = 0;
  let fallbackBatches = 0;

  const { llmCacheKey, getCachedLLMResult, setCachedLLMResult } = await import("@/lib/llm-cache");

  for (let b = 0; b < refs.length; b += batchSize) {
    const batch = refs.slice(b, b + batchSize);
    const batchNo = Math.floor(b / batchSize) + 1;
    const totalBatches = Math.ceil(refs.length / batchSize);

    const refList = batch
      .map((r, j) => {
        const depth = profiles.get(r.id)?.depth || (r.abstract ? "abstract" : "metadata");
        const ft = depth === "fulltext" ? "yes" : "no";
        const yr = r.year ? ` | YEAR: ${r.year}` : "";
        const abs = r.abstract
          ? `\n    ABSTRACT: ${String(r.abstract).slice(0, 300).replace(/\s+/g, " ")}`
          : "\n    ABSTRACT: (none — judge from the title)";
        return `[${b + j + 1}] TYPE: ${r.type || "web"}${yr} | FULL TEXT: ${ft} | ${(r.authors || "Anon").slice(0, 40)}\n    TITLE: ${String(r.title || "").slice(0, 110)}${abs}`;
      })
      .join("\n");

    const system =
      "You are a meticulous research librarian assessing a citation pool for a review article. " +
      "You judge ONLY from the metadata shown — no speculation beyond the given text.";

    const prompt = `ARTICLE TOPIC: ${topic}
FIELD: ${field}

SOURCES TO SCORE (batch ${batchNo} of ${totalBatches}):
${refList}

Score EVERY source in this batch on two axes:
- relevance (integer 1-10): how directly the source's subject matter serves the TOPIC. 10 = central to the topic; 6 = clearly related; 4 = peripherally related; 3 = barely related; 1 = unrelated.
- importance (integer 1-10): scholarly weight for a review. Seminal/foundational works, primary studies that determined a key result, or definitive methods papers score 8-10; solid but routine studies 5-7; tangential or minor works 1-4.

Rules:
- Judge only from the title/abstract text shown.
- FULL TEXT: yes means the complete article is readable — when two sources are otherwise close, the full-text one can support deeper and more accurate discussion.

Respond as STRICT JSON only:
{
  "scores": [
    { "ref": 1, "relevance": 8, "importance": 7, "reason": "short justification" }
  ]
}
"ref" is the [n] number. Score EVERY source. Output JSON only.`;

    try {
      const cacheKey = llmCacheKey(prompt, { system, temperature: 0.2, taskType: "score", maxTokens: opts.maxTokens });
      const cached = getCachedLLMResult(cacheKey);
      let raw: string;
      if (cached) {
        raw = cached;
      } else {
        raw = await chatWithSession(projectId, prompt, {
          system,
          temperature: 0.2,
          taskType: "score",
          maxTokens: opts.maxTokens,
          metadata: { step: "score", batch: batchNo, total: totalBatches, refs: batch.length },
        });
        setCachedLLMResult(cacheKey, raw);
      }
      llmBatches++;

      const parsed = safeParseJSON(raw, { scores: [] });
      const byRef = new Map<number, any>();
      for (const s of parsed.scores || []) {
        const n = parseInt(String(s.ref), 10);
        if (!isNaN(n)) byRef.set(n, s);
      }
      for (let j = 0; j < batch.length; j++) {
        const idx = b + j + 1;
        const s = byRef.get(idx);
        const depth = profiles.get(refs[b + j].id)?.depth || (refs[b + j].abstract ? "abstract" : "metadata");
        if (s && Number(s.relevance) >= 1 && Number(s.relevance) <= 10 && Number(s.importance) >= 1 && Number(s.importance) <= 10) {
          const relevance = Math.round(Number(s.relevance));
          const importance = Math.round(Number(s.importance));
          const priority = computePriority(relevance, importance, depth);
          scores[b + j] = {
            index: idx,
            relevance,
            importance,
            depth,
            reason: String(s.reason || "").slice(0, 160),
            priority,
            tier: tierFor(priority),
          };
        } else {
          // LLM skipped/malformed this one — mechanical single-ref fill.
          scores[b + j] = mechanicalScores([refs[b + j]], profiles, topic)[0];
        }
      }
    } catch (err: any) {
      // Whole batch failed (rate limit / provider error) — mechanical fill.
      fallbackBatches++;
      console.warn(`[scoreSources] batch ${batchNo} fell back to mechanical scoring: ${err?.message?.slice(0, 100)}`);
      const mech = mechanicalScores(batch, profiles, topic);
      for (let j = 0; j < batch.length; j++) {
        scores[b + j] = { ...mech[j], index: b + j + 1 };
      }
    }

    const usedFallback = scores[b]?.reason.startsWith("mechanical") === true;
    opts.onProgress?.(
      `Scored ${Math.min(b + batchSize, refs.length)}/${refs.length} sources — batch ${batchNo}/${totalBatches}${usedFallback ? " (mechanical fallback)" : ""}`
    );
  }

  // Anyhow-fill (defensive — e.g. empty refs edge)
  for (let i = 0; i < refs.length; i++) {
    if (!scores[i]) {
      const mech = mechanicalScores([refs[i]], profiles, topic)[0];
      scores[i] = { ...mech, index: i + 1 };
    }
  }

  return { scores, llmBatches, fallbackBatches };
}

/** Natural citation density for a review of the given length. */
export function typicalCitationCount(targetWords: number): number {
  return Math.max(6, Math.min(40, Math.round(targetWords / 200)));
}

/**
 * Stage 2 — smart curation with a DYNAMIC citation count.
 *
 * The LLM sees the SCORED pool and decides how many references the article
 * genuinely needs (within [softFloor, hardCap] guardrails). Replaces the old
 * fixed-count curateReferences ("select exactly N") call in both pipelines.
 *
 * Guardrails (mechanical, applied after the LLM answer):
 *   - ALL core-tier refs are force-included (重要引用需要持续保留);
 *   - refs with relevance <= 3 are stripped unless the pool is tiny (< 6);
 *   - count capped at maxCitableRefsFor(targetWords, pool);
 *   - if the LLM count is below the soft floor, top up ONLY with refs whose
 *     relevance >= 4 — a thin pool yields a small citation list rather than
 *     padded irrelevant citations (数据源有限时宁缺毋滥).
 */
export async function smartCurateReferences(
  projectId: string,
  refs: any[],
  scores: SourceScore[],
  topic: string,
  field: string,
  targetWords: number,
  opts: { maxTokens?: number; onProgress?: (message: string) => void } = {}
): Promise<SmartCurationResult> {
  // Small pools need no curation at all — everything is citable.
  if (refs.length <= 6) {
    return {
      refs: [...refs],
      scores: scores.map((s, i) => ({ ...s, index: i + 1 })),
      plannedCount: refs.length,
      rationale: "small pool — every source kept",
      llmDriven: false,
    };
  }

  const hardCap = maxCitableRefsFor(targetWords, refs.length);
  const typical = typicalCitationCount(targetWords);
  // Soft floor: min(6, refs with relevance >= 5) — shrinks for thin pools.
  const eligibleFloor = scores.filter((s) => s.relevance >= 5).length;
  const softFloor = Math.min(6, eligibleFloor, hardCap);

  // Priority-desc listing (scores aligned 1:1 with refs input order).
  const order = scores.map((s, i) => ({ score: s, ref: refs[i] }));
  order.sort((a, b) => b.score.priority - a.score.priority);

  const scoredList = order
    .map((o, i) => {
      const ft = o.score.depth === "fulltext" ? " | FULL TEXT: yes" : "";
      return `[${i + 1}] PRIORITY ${o.score.priority.toFixed(1)} | ${o.score.tier.toUpperCase()} | REL ${o.score.relevance}/10, IMP ${o.score.importance}/10${ft} | (${o.ref.year || "n.d."}) ${String(o.ref.title || "").slice(0, 95)}`;
    })
    .join("\n");

  const system =
    "You are a review-article citation strategist. Given a scored source pool and the article's target length, " +
    "decide which references the article should cite — and HOW MANY it genuinely needs.";

  const prompt = `RESEARCH TOPIC: ${topic}
FIELD: ${field}
TARGET ARTICLE LENGTH: ${targetWords} words
POOL: ${refs.length} gathered references, pre-scored for relevance (topical fit) and importance (scholarly weight).

SCORED SOURCES (sorted by citation priority):
${scoredList}

CITATION BUDGET:
- A ${targetWords}-word review typically cites ~${typical} references.
- Acceptable range: ${softFloor}-${hardCap}. YOU decide the final count — it must follow the POOL, not the typical number.

SELECTION RULES (in priority order):
1. Relevance first: NEVER include a source with REL <= 3. An uncited point is better than an irrelevant citation.
2. Include EVERY source marked CORE (tier column), up to ${hardCap}.
3. If the pool is thin or mostly MARGINAL, choose FEWER references — do NOT pad toward the typical count.
4. For a SHORT article with a RICH pool, drop MARGINAL sources and keep the high-priority ones.
5. Prefer primary research over reviews when both report the same finding; prefer the peer-reviewed version over its preprint.
6. FULL TEXT sources support deeper discussion — break ties toward them.

Respond as STRICT JSON only:
{ "indices": [1, 2, 5, ...], "plannedCount": 18, "rationale": "one sentence explaining the count" }
"indices" are the [n] numbers above (1-based, priority-sorted list). Output JSON only.`;

  let selectedOrder: { score: SourceScore; ref: any }[] = [];
  let rationale = "";
  let llmDriven = false;

  try {
    const { llmCacheKey, getCachedLLMResult, setCachedLLMResult } = await import("@/lib/llm-cache");
    const cacheKey = llmCacheKey(prompt, { system, temperature: 0.2, taskType: "curate-smart", maxTokens: opts.maxTokens });
    const cached = getCachedLLMResult(cacheKey);
    let raw: string;
    if (cached) {
      raw = cached;
    } else {
      raw = await chatWithSession(projectId, prompt, {
        system,
        temperature: 0.2,
        taskType: "curate-smart",
        maxTokens: opts.maxTokens,
        metadata: { step: "curate-smart", pool: refs.length, typical, softFloor, hardCap },
      });
      setCachedLLMResult(cacheKey, raw);
    }

    const parsed = safeParseJSON(raw, { indices: [] });
    const picked = new Set<number>();
    for (const n of parsed.indices || []) {
      const idx = parseInt(String(n), 10);
      if (!isNaN(idx) && idx >= 1 && idx <= order.length) picked.add(idx);
    }

    // Guardrail 1: force-include every CORE-tier source (up to hardCap).
    for (let i = 0; i < order.length && selectedOrder.length < hardCap; i++) {
      if (order[i].score.tier === "core") selectedOrder.push(order[i]);
    }
    // Guardrail 2: add the LLM's picks (dedup, cap).
    for (const idx of picked) {
      if (selectedOrder.length >= hardCap) break;
      const o = order[idx - 1];
      if (o && !selectedOrder.includes(o)) selectedOrder.push(o);
    }
    // Guardrail 3: strip relevance <= 3 unless the pool is tiny.
    if (refs.length > 6) {
      selectedOrder = selectedOrder.filter((o) => o.score.relevance > 3);
    }
    // Guardrail 4: soft-floor top-up with relevance >= 4 refs only.
    if (selectedOrder.length < softFloor) {
      for (const o of order) {
        if (selectedOrder.length >= softFloor) break;
        if (!selectedOrder.includes(o) && o.score.relevance >= 4) selectedOrder.push(o);
      }
    }
    rationale = String(parsed.rationale || "").slice(0, 240);
    llmDriven = true;
    if (!rationale) rationale = `LLM selected ${selectedOrder.length} of ${refs.length} scored sources`;
  } catch (err: any) {
    console.warn(`[smartCurateReferences] LLM failed, mechanical fallback: ${err?.message?.slice(0, 100)}`);
  }

  // Mechanical fallback: core + important tiers up to typical, then marginal
  // by priority — never including relevance <= 3.
  if (selectedOrder.length === 0) {
    selectedOrder = order.filter((o) => o.score.tier !== "marginal" && o.score.relevance > 3).slice(0, Math.min(typical, hardCap));
    if (selectedOrder.length === 0) {
      // Degenerate pool (everything irrelevant) — keep the top-priority few
      // so the article can still be written.
      selectedOrder = order.slice(0, Math.min(3, hardCap));
    }
    rationale = `mechanical fallback — ${selectedOrder.length} sources by priority (tier + relevance >= 4)`;
  }

  // Re-sort by priority (force-included cores may have interleaved) and cap.
  selectedOrder.sort((a, b) => b.score.priority - a.score.priority);
  selectedOrder = selectedOrder.slice(0, hardCap);

  opts.onProgress?.(`${selectedOrder.length} of ${refs.length} sources selected for the citation pool`);

  return {
    refs: selectedOrder.map((o) => o.ref),
    scores: selectedOrder.map((o, i) => ({ ...o.score, index: i + 1 })),
    plannedCount: selectedOrder.length,
    rationale,
    llmDriven,
  };
}

/**
 * Fetch PMC full texts (and reuse deep-read summaries) for the citation pool.
 *
 * `refs` should be priority-ordered (smartCurateReferences already returns
 * them that way) so the first `maxCount` fetches hit the most important
 * sources — the budget is small and importance decides who gets read in full
 * (能获取到全文的一定要看全文 — within fetch-budget reality).
 *
 * Returns refId → full-text block. Deep-read summaries are prefixed so the
 * consuming prompts can label them honestly.
 */
export async function fetchFullTextsForRefs(
  refs: any[],
  profiles: Map<string, FullTextProfile>,
  opts: {
    maxCount?: number;
    maxChars?: number;
    onProgress?: (message: string, extra?: Record<string, any>) => void;
  } = {}
): Promise<Map<string, string>> {
  const maxCount = opts.maxCount ?? 8;
  const maxChars = opts.maxChars ?? 15000;
  const fullTexts = new Map<string, string>();

  // Deep-read summaries cost nothing — include all of them first.
  let deepReadCount = 0;
  for (const ref of refs) {
    const profile = profiles.get(ref.id);
    if (profile?.deepReadSummary && !fullTexts.has(ref.id)) {
      fullTexts.set(ref.id, `DEEP-READ SUMMARY (extracted from the full page):\n${profile.deepReadSummary.slice(0, 4000)}`);
      deepReadCount++;
    }
  }

  // PMC fetches, priority order (refs arrive sorted), pubmed-only.
  const candidates = refs.filter(
    (r) => r.type === "pubmed" && r.externalId && !fullTexts.has(r.id)
  );
  let fetched = 0;
  for (const ref of candidates) {
    if (fetched >= maxCount) break;
    try {
      const pmcId = profiles.get(ref.id)?.pmcId;
      const fullText = await fetchFullTextForPubMed(ref.externalId, pmcId);
      if (fullText && fullText.length > 500) {
        fullTexts.set(ref.id, fullText.slice(0, maxChars));
        fetched++;
        opts.onProgress?.(
          `Fetched full text for PMID:${ref.externalId} (${fetched}/${Math.min(maxCount, candidates.length)}, ${Math.round(fullText.length / 1000)}k chars)`,
          { pmid: ref.externalId, chars: fullText.length }
        );
      }
    } catch {
      // Skip failed fetches — never blocks the pipeline.
    }
  }

  if (deepReadCount > 0 && fetched === 0) {
    opts.onProgress?.(`Full-text stage: ${deepReadCount} deep-read summaries available, no PMC full texts fetched.`);
  }
  return fullTexts;
}

/**
 * Synthesize a CORE-tier score for a primary paper that the coverage
 * backfill force-added to the pool AFTER scoring ran (v2's
 * ensurePrimaryPaperCoverage). Deliberately backfilled papers are treated as
 * high-priority so the citation-plan validator force-retains them.
 */
export function synthesizeBackfillScore(ref: any, profile?: FullTextProfile): SourceScore {
  const depth: SourceDepth = profile?.depth || (ref.abstract ? "abstract" : "metadata");
  const relevance = 7;
  const importance = 8;
  const priority = computePriority(relevance, importance, depth);
  return {
    index: 0,
    relevance,
    importance,
    depth,
    reason: "coverage backfill — primary paper force-added by the pipeline",
    priority,
    tier: "core",
  };
}

/**
 * Compact scored-list line for plan prompts (shared by both pipelines so the
 * outline stage sees the SAME priority/tier/depth signals the curator saw).
 */
export function formatScoredRefLine(ref: any, score: SourceScore, index: number): string {
  const yr = ref.year ? ` (${ref.year})` : "";
  const ft = score.depth === "fulltext" ? " | FULL TEXT: yes" : "";
  const auth = String(ref.authors || "Anon").slice(0, 40);
  return `[${index}] ${score.tier.toUpperCase()} | REL ${score.relevance}/10, IMP ${score.importance}/10${ft} |${yr} ${auth}. ${String(ref.title || "").slice(0, 95)}`;
}

/**
 * Mechanical guardrails for the plan stage's joint outline+citation map.
 *
 * Applied after the plan LLM returns sections with per-section ref indices:
 *   - indices validated (1..pool), deduped, capped per section;
 *   - every section topped up to `minPerSection` refs (2) from uncited
 *     pool refs in priority order — only relevance >= 4 refs are added, and
 *     if the pool is exhausted the section simply gets fewer (never forced);
 *   - CORE-tier retention: any core ref cited by NO section is appended to
 *     the section whose title+focus best matches it by keyword overlap
 *     (重要引用需要持续保留).
 *
 * Works on either key name ("refIndices" for v2, "suggestedRefIndices" for
 * v1's legacy schema) so both pipelines share the enforcement.
 */
export function validateSectionCitationPlan(
  sections: any[],
  refs: any[],
  scores: SourceScore[],
  opts: { key?: string; minPerSection?: number; maxPerSection?: number } = {}
): { totalPlanned: number; coreCovered: number; coreMissing: number; toppedUp: number } {
  const key = opts.key || "refIndices";
  const minPer = opts.minPerSection ?? 2;
  const maxPer = opts.maxPerSection ?? 12;
  const poolSize = refs.length;
  let toppedUp = 0;

  const cited = new Set<number>();

  // Pass 1: validate + cap each section's plan, collect coverage.
  for (const section of sections) {
    const raw = Array.isArray(section[key]) ? section[key] : [];
    const valid: number[] = [];
    const seen = new Set<number>();
    for (const n of raw) {
      const idx = parseInt(String(n), 10);
      if (!isNaN(idx) && idx >= 1 && idx <= poolSize && !seen.has(idx)) {
        seen.add(idx);
        valid.push(idx);
      }
    }
    section[key] = valid.slice(0, maxPer);
    for (const n of section[key]) cited.add(n);
  }

  // Pass 2: per-section soft minimum, top-up in priority order (the pool is
  // priority-ordered already, so index order IS priority order).
  for (const section of sections) {
    const have = new Set<number>(section[key]);
    if (have.size >= minPer) continue;
    for (let i = 1; i <= poolSize && have.size < minPer; i++) {
      if (have.has(i) || cited.has(i)) continue;
      const score = scores[i - 1];
      if (!score || score.relevance < 4) continue; // never force weak refs
      have.add(i);
      cited.add(i);
      section[key].push(i);
      toppedUp++;
    }
  }

  // Pass 3: core retention — append uncited core refs to their best section.
  let coreCovered = 0;
  let coreMissing = 0;
  for (let i = 0; i < poolSize; i++) {
    const score = scores[i];
    if (!score || score.tier !== "core") continue;
    if (cited.has(i + 1)) {
      coreCovered++;
      continue;
    }
    // Find the section with the best keyword overlap for this ref.
    const refKeywords = extractSectionKeywords(`${refs[i].title || ""} ${refs[i].abstract || ""}`);
    let bestSection: any = null;
    let bestScore = -1;
    for (const section of sections) {
      const s = scoreRelevance(refKeywords, `${section.title || ""} ${section.focus || ""}`);
      if (s > bestScore) {
        bestScore = s;
        bestSection = section;
      }
    }
    if (bestSection && Array.isArray(bestSection[key]) && bestSection[key].length < maxPer) {
      bestSection[key].push(i + 1);
      cited.add(i + 1);
      coreCovered++;
    } else {
      coreMissing++;
    }
  }

  const totalPlanned = cited.size;
  return { totalPlanned, coreCovered, coreMissing, toppedUp };
}
