/**
 * Skill definitions — curation family (RT6).
 *
 * Migrated from the A-family isomorphic triplets (RT5 audit): the two
 * remaining "cache → chat → parse → mechanical-fallback" sites after `score`
 * moved to the executor in RT5:
 *   - curate       ← generate-full-helpers.ts curateReferences (LLM block)
 *   - curate-smart ← citation-planner.ts smartCurateReferences (LLM block)
 *
 * Behavior contract kept identical: prompt text, temperature, taskType,
 * cache-key derivation (prompt+system+temp+taskType+maxTokens), per-item
 * range filtering and the mechanical fallbacks (empty indices ⇒ the caller
 * applies its own slice/priority fallback, exactly as before).
 *
 * The batch/pool orchestration (maxCount short-circuit, guardrails,
 * hard-cap re-sort) stays at the call-sites — a skill owns ONE agent
 * operation, not the pipeline around it.
 */

import type { SourceScore } from "@/lib/scoring";
import type { SkillDefinition } from "./types";

// ---------------------------------------------------------------------------
// curate — reduce a gathered pool to the most relevant references
// (legacy: generate-full-helpers.ts curateReferences)
// ---------------------------------------------------------------------------

export interface CurateInput {
  topic: string;
  field: string;
  /** The full gathered pool (the prompt lists them 1-based). */
  references: any[];
  /** Target pool size after curation. */
  maxCount: number;
}

export interface CurateOutput {
  /** 1-based indexes into `references`, range-filtered and capped. */
  indices: number[];
}

export const curateSkill: SkillDefinition<CurateInput, CurateOutput> = {
  id: "curate",
  taskType: "curate",
  sseStep: "curate",
  title: "Curate the reference pool",
  chat: { temperature: 0.3 },

  buildPrompt(input) {
    const system = "You are a research curator who selects the most relevant references for a review article.";
    const refList = input.references
      .map((r, i) => {
        const auth = r.authors || "Anon";
        const yr = r.year ? ` (${r.year})` : "";
        return `[${i + 1}] ${auth}${yr} ${r.title?.slice(0, 80) || ""}`;
      })
      .join("\n");

    const prompt = `RESEARCH TOPIC: ${input.topic}
FIELD: ${input.field}
TARGET: Select the ${input.maxCount} MOST relevant references for a comprehensive review.

AVAILABLE REFERENCES (${input.references.length} total):
${refList}

Select the most relevant, recent, and authoritative references. Prioritize:
1. Recent publications (last 5 years)
2. Seminal/foundational papers
3. Review articles covering the topic
4. Primary research with key findings
5. The ORIGINAL papers behind key advances (e.g., the primary structure
   determination, functional demonstration, or therapy papers) — a review
   about a structure/mechanism/therapy topic MUST cite the primary papers,
   not only reviews describing them
6. When a preprint AND its peer-reviewed version are both listed, select the
   peer-reviewed version — never select both

Respond as STRICT JSON: { "indices": [1, 3, 5, 7, ...] }
Use 1-based indices. Select exactly ${input.maxCount} references.`;

    return { system, prompt };
  },

  metadata: (input) => ({
    total: input.references.length,
    maxCount: input.maxCount,
  }),

  /** Legacy semantics: range-filter, cap at maxCount (verbatim). */
  postProcess(parsed, input) {
    const indices = ((parsed as any).indices || [])
      .filter((n: number) => n >= 1 && n <= input.references.length)
      .slice(0, input.maxCount);
    return { indices };
  },

  /**
   * Whole-call failure (rate limit / provider error / garbage JSON) —
   * empty indices; the caller falls back to references.slice(0, maxCount)
   * exactly like the legacy catch.
   */
  fallback() {
    return { indices: [] };
  },
};

// ---------------------------------------------------------------------------
// curate-smart — citation-budget curation over a SCORED pool
// (legacy: citation-planner.ts smartCurateReferences, LLM block only)
// ---------------------------------------------------------------------------

export interface CurateSmartInput {
  topic: string;
  field: string;
  /** Target article length in words. */
  targetWords: number;
  /** Pool refs, parallel to `scores` (same order as scoreSources output). */
  refs: any[];
  scores: SourceScore[];
  /** Typical citation count for the target length (caller-derived). */
  typical: number;
  /** Soft floor / hard cap for the citation budget (caller-derived). */
  softFloor: number;
  hardCap: number;
}

export interface CurateSmartOutput {
  /** 1-based indexes into the PRIORITY-SORTED list (insertion order, deduped). */
  indices: number[];
  rationale: string;
}

/** Priority-desc pairing of refs with their scores (legacy order derivation). */
export function deriveScoredOrder(input: CurateSmartInput): { score: SourceScore; ref: any }[] {
  const order = input.scores.map((s, i) => ({ score: s, ref: input.refs[i] }));
  order.sort((a, b) => b.score.priority - a.score.priority);
  return order;
}

export const curateSmartSkill: SkillDefinition<CurateSmartInput, CurateSmartOutput> = {
  id: "curate-smart",
  taskType: "curate-smart",
  sseStep: "curate",
  title: "Plan the citation budget (smart curation)",
  chat: { temperature: 0.2 },

  buildPrompt(input) {
    const order = deriveScoredOrder(input);
    const scoredList = order
      .map((o, i) => {
        const ft = o.score.depth === "fulltext" ? " | FULL TEXT: yes" : "";
        return `[${i + 1}] PRIORITY ${o.score.priority.toFixed(1)} | ${o.score.tier.toUpperCase()} | REL ${o.score.relevance}/10, IMP ${o.score.importance}/10${ft} | (${o.ref.year || "n.d."}) ${String(o.ref.title || "").slice(0, 95)}`;
      })
      .join("\n");

    const system =
      "You are a review-article citation strategist. Given a scored source pool and the article's target length, " +
      "decide which references the article should cite — and HOW MANY it genuinely needs.";

    const prompt = `RESEARCH TOPIC: ${input.topic}
FIELD: ${input.field}
TARGET ARTICLE LENGTH: ${input.targetWords} words
POOL: ${input.refs.length} gathered references, pre-scored for relevance (topical fit) and importance (scholarly weight).

SCORED SOURCES (sorted by citation priority):
${scoredList}

CITATION BUDGET:
- A ${input.targetWords}-word review typically cites ~${input.typical} references.
- Acceptable range: ${input.softFloor}-${input.hardCap}. YOU decide the final count — it must follow the POOL, not the typical number.

SELECTION RULES (in priority order):
1. Relevance first: NEVER include a source with REL <= 3. An uncited point is better than an irrelevant citation.
2. Include EVERY source marked CORE (tier column), up to ${input.hardCap}.
3. LANDMARKS ARE MANDATORY (round-57): first discoveries, gene/protein cloning papers, structure determinations, and clinical-trial milestones for the topic's central molecules are ALWAYS in scope for a review — include them even when their raw priority ties with newer work. A review that narrates a discovery without citing its primary paper is a failed review.
4. If the pool is thin or mostly MARGINAL, choose FEWER references — do NOT pad toward the typical count.
5. For a SHORT article with a RICH pool, drop MARGINAL sources and keep the high-priority ones.
6. Prefer primary research over reviews when both report the same finding; prefer the peer-reviewed version over its preprint.
7. FULL TEXT sources support deeper discussion — break ties toward them.

Respond as STRICT JSON only:
{ "indices": [1, 2, 5, ...], "plannedCount": 18, "rationale": "one sentence explaining the count" }
"indices" are the [n] numbers above (1-based, priority-sorted list). Output JSON only.`;

    return { system, prompt };
  },

  metadata: (input) => ({
    pool: input.refs.length,
    typical: input.typical,
    softFloor: input.softFloor,
    hardCap: input.hardCap,
  }),

  /** Legacy `picked` set semantics: parse, dedupe (insertion order), range-filter. */
  postProcess(parsed, input) {
    const order = deriveScoredOrder(input);
    const picked: number[] = [];
    const seen = new Set<number>();
    for (const n of (parsed as any).indices || []) {
      const idx = parseInt(String(n), 10);
      if (!isNaN(idx) && idx >= 1 && idx <= order.length && !seen.has(idx)) {
        seen.add(idx);
        picked.push(idx);
      }
    }
    const rationale = String((parsed as any).rationale || "").slice(0, 240);
    return { indices: picked, rationale };
  },

  /**
   * Whole-call failure — empty indices: the caller's mechanical fallback
   * (core/important tiers by priority, legacy) takes over; llmDriven=false.
   */
  fallback() {
    return { indices: [], rationale: "" };
  },
};
