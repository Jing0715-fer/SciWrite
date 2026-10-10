/**
 * Pure scoring kernel (RT5 skill framework).
 *
 * Extracted VERBATIM from citation-planner.ts so the score skill definition
 * (skill/registry.ts) can import the mechanical fallback WITHOUT a module
 * cycle (citation-planner → registry → citation-planner). Zero behavior
 * change: same functions, same formulas, same exported types.
 */

import { extractSectionKeywords, scoreRelevance } from "@/lib/generate-full-helpers";

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

export function computePriority(relevance: number, importance: number, depth: SourceDepth): number {
  const depthBonus = depth === "fulltext" ? 1 : depth === "abstract" ? 0.5 : 0;
  return Math.max(0, Math.min(10, relevance * 0.55 + importance * 0.35 + depthBonus));
}

export function tierFor(priority: number): "core" | "important" | "marginal" {
  if (priority >= 7.5) return "core";
  if (priority >= 5.5) return "important";
  return "marginal";
}

/**
 * Mechanical (zero-LLM) scoring: keyword overlap → relevance, recency +
 * type bias → importance. The per-item and per-batch fallback for the score
 * skill, unchanged from its citation-planner residence.
 */
export function mechanicalScores(
  refs: any[],
  profiles: Map<string, { depth?: SourceDepth }>,
  topic: string,
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
    const depth =
      (profiles.get(r.id)?.depth as SourceDepth | undefined) ||
      (r.abstract ? "abstract" : "metadata");
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
