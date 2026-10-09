/**
 * Gather Coverage Assessment (round-RT2) — the mechanical half of
 * "agent-controlled gathering".
 *
 * WHY THIS MODULE EXISTS
 * ───────────────────────
 * The v2 pipeline's initial gather is ONE-SHOT with a FIXED query count: the
 * LLM designs N queries up front, they all run, and whatever arrived is the
 * pool — no measurement, no second look. Two failure shapes follow:
 *
 *   1. UNDER-COVERAGE: a topic facet ("off-target effects" inside a CRISPR
 *      topic) gets zero or near-zero hits because the query-design call
 *      under-weighted it — the article ships thin on exactly that facet.
 *   2. OVER-GATHERING: for a narrow topic every extra query returns
 *      duplicates, yet the pipeline still runs the full fixed program
 *      (query budget burned, minutes wasted).
 *
 * This module computes a mechanical, cheap (no LLM) coverage signal:
 *
 *   • Facets are extracted from the topic itself — the colon/comma segments
 *     ("mechanisms", "clinical applications") plus significant keywords.
 *   • A facet is COVERED when ≥ `minHitsPerFacet` gathered items mention it
 *     in title/abstract (hyphen/space-insensitive token match).
 *   • `coverageRatio` = covered facets / total facets.
 *
 * The route uses it twice:
 *   • after the initial gather → decide whether a TARGETED top-up round is
 *     worth running (uncovered facets get 2-3 purpose-built queries —
 *     intelligence instead of blind fixed counts);
 *   • after each gap-agent round → marginal-yield stop (a round that moved
 *     coverage by ~nothing is the signal to stop, not to re-audit).
 *
 * Pure module: no DB, no LLM, no network — unit-testable and safe to call
 * at any pipeline boundary.
 */

const STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "been", "were", "which", "their",
  "these", "those", "about", "would", "could", "should", "between", "into",
  "such", "than", "then", "them", "there", "where", "while", "also", "both",
  "each", "more", "most", "other", "over", "some", "only", "same", "very",
  "just", "does", "doing", "when", "what", "will", "shall", "and", "the",
  "for", "are", "was", "has", "had", "not", "but", "can", "may", "its",
  "his", "her", "our", "your", "all", "any", "how", "why", "who", "uses",
  "using", "used", "use", "study", "studies", "review", "article", "paper",
  "approaches", "applications", "aspects", "role", "roles", "current",
  "recent", "novel", "new", "key", "major", "significant", "important",
]);

/** Minimum items mentioning a facet for it to count as covered. */
const DEFAULT_MIN_HITS = 3;

export interface FacetCoverage {
  /** The facet as extracted (lowercased, hyphen-free display form). */
  facet: string;
  /** Items whose title/abstract mention the facet. */
  hits: number;
}

export interface CoverageAssessment {
  /** Per-facet hit counts, sorted worst-first. */
  facets: FacetCoverage[];
  /** Facets with 0 hits. */
  uncovered: string[];
  /** Facets with 1..minHits-1 hits (weakly covered). */
  weak: string[];
  /** covered / total facets (0..1). */
  coverageRatio: number;
  /** Total items assessed. */
  totalItems: number;
}

/** Normalize a token for matching: lowercase, hyphens/slashes → space. */
function normToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-–—_/]+/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract topic facets from the topic string.
 *  1. The segments after a colon (topics are often "Big subject: facet 1,
 *     facet 2, and facet 3") split on commas / " and ".
 *  2. Significant (len > 3, non-stopword) keyword tokens of the whole topic
 *     — only the top 12 by order of appearance, deduped.
 */
export function extractTopicFacets(topic: string, maxFacets = 12): string[] {
  const facets: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const t = normToken(raw);
    if (!t || t.length < 4 || STOPWORDS.has(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    facets.push(t);
  };

  const topicStr = String(topic || "");
  // 1. colon-separated detail segments
  const colonParts = topicStr.split(/[:：]/).slice(1);
  for (const part of colonParts) {
    for (const seg of part.split(/[,;]|\band\b|\bor\b/i)) {
      const t = normToken(seg);
      // Multi-word segments: keep the WHOLE phrase when short (≤4 words) —
      // "off-target effects" is a real facet; longer segments degrade to
      // their significant words.
      const words = t.split(" ").filter((w) => w && !STOPWORDS.has(w));
      if (words.length === 0) continue;
      if (words.length <= 4 && t.length <= 40) {
        push(t);
      } else {
        for (const w of words) push(w);
      }
    }
  }
  // 2. significant keywords of the head (pre-colon) + whole topic
  for (const w of normToken(topicStr).split(" ")) {
    push(w);
  }

  return facets.slice(0, maxFacets);
}

/**
 * Assess how well the gathered items cover the topic's facets.
 * `items` are gather-result-shaped objects ({title, abstract}).
 */
export function assessTopicCoverage(
  topic: string,
  items: { title?: string | null; abstract?: string | null }[],
  opts: { minHitsPerFacet?: number } = {}
): CoverageAssessment {
  const minHits = opts.minHitsPerFacet ?? DEFAULT_MIN_HITS;
  const facets = extractTopicFacets(topic);
  if (facets.length === 0 || items.length === 0) {
    return {
      facets: facets.map((f) => ({ facet: f, hits: 0 })),
      uncovered: facets,
      weak: [],
      coverageRatio: 0,
      totalItems: items.length,
    };
  }

  // Pre-tokenize each item once (title + abstract), then count facet hits.
  // A facet matches an item when EVERY significant word of the facet appears
  // in the item text (hyphen/space-insensitive). Single-word facets match
  // directly. This is deliberately cheap — no embeddings, no LLM.
  const itemTexts = items.map((it) =>
    `${normToken(String(it?.title || ""))} ${normToken(String(it?.abstract || ""))}`
  );

  const perFacet: FacetCoverage[] = facets.map((facet) => {
    const words = facet.split(" ").filter((w) => w.length > 1);
    let hits = 0;
    for (const text of itemTexts) {
      let all = true;
      for (const w of words) {
        if (!text.includes(w)) {
          all = false;
          break;
        }
      }
      if (all) hits++;
    }
    return { facet, hits };
  });

  perFacet.sort((a, b) => a.hits - b.hits);
  const uncovered = perFacet.filter((f) => f.hits === 0).map((f) => f.facet);
  const weak = perFacet
    .filter((f) => f.hits > 0 && f.hits < minHits)
    .map((f) => f.facet);
  const coveredCount = perFacet.length - uncovered.length - weak.length;
  const coverageRatio =
    perFacet.length === 0
      ? 0
      : (coveredCount + weak.length * 0.5) / perFacet.length;

  return {
    facets: perFacet,
    uncovered,
    weak,
    coverageRatio,
    totalItems: items.length,
  };
}

/**
 * Marginal-yield decision for iterative gathering loops (gap-agent rounds):
 * should another round run after this one?
 *
 * Signals to STOP:
 *   • coverage already good (ratio ≥ 0.85 and no uncovered facets);
 *   • the last round added fewer than `minGain` new refs (diminishing
 *     returns — same queries would find the same nothing);
 *   • pool size exceeds `poolCeiling`.
 */
export function shouldContinueGathering(opts: {
  assessment: CoverageAssessment;
  newRefsLastRound: number;
  poolSize: number;
  minGain?: number;
  poolCeiling?: number;
}): { continue: boolean; reason: string } {
  const { assessment, newRefsLastRound, poolSize } = opts;
  const minGain = opts.minGain ?? 2;
  const poolCeiling = opts.poolCeiling ?? 40;
  if (assessment.uncovered.length === 0 && assessment.coverageRatio >= 0.85) {
    return { continue: false, reason: `coverage sufficient (${Math.round(assessment.coverageRatio * 100)}%, no uncovered facets)` };
  }
  if (newRefsLastRound < minGain) {
    return {
      continue: false,
      reason: `marginal yield — round merged only ${newRefsLastRound} new ref(s) (< ${minGain}); further rounds would re-run the same misses`,
    };
  }
  if (poolSize >= poolCeiling) {
    return { continue: false, reason: `pool at ceiling (${poolSize}/${poolCeiling})` };
  }
  return { continue: true, reason: "coverage gaps remain" };
}
