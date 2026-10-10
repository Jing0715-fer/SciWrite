/**
 * Skill registry (RT5) — the declarative catalog of agent operations.
 *
 * Migrated first (the "A-family" isomorphic pattern): `score` — importance
 * scoring of gathered references. Its prompt contract, per-item validation
 * and mechanical fallback move HERE from citation-planner.ts verbatim;
 * scoreSources (citation-planner) keeps only the batch/pool orchestration
 * and calls runSkill per batch.
 *
 * Migration backlog (IMPROVEMENT_PLAN-RT5): curate / curate-smart (the other
 * two A-family triplets), the B-family STRICT-JSON reviewers
 * (review-engine / fact-check / evidence pipeline), the C-family translate
 * post-processing chains, plan/generate/verify/review v1+v2 merge.
 */

import {
  computePriority,
  mechanicalScores,
  tierFor,
  type FullTextProfile,
  type SourceDepth,
  type SourceScore,
} from "@/lib/scoring";
import type { SkillDefinition } from "./types";

// ---------------------------------------------------------------------------
// score — LLM importance scoring for a batch of gathered references
// ---------------------------------------------------------------------------

export interface ScoreInput {
  topic: string;
  field: string;
  /** 1-based batch ordinal (progress/metadata only). */
  batchNo: number;
  totalBatches: number;
  /** The refs in this batch (any-shape reference rows). */
  batch: any[];
  /** Global 0-based start index of this batch within the full refs array. */
  batchStartIndex: number;
  profiles: Map<string, FullTextProfile>;
}

export interface ScoreOutput {
  /** Scores aligned 1:1 with input.batch (global indexes). */
  scores: SourceScore[];
}

export const scoreSkill: SkillDefinition<ScoreInput, ScoreOutput> = {
  id: "score",
  taskType: "score",
  sseStep: "score",
  title: "Score source importance",
  chat: { temperature: 0.2 },

  buildPrompt(input) {
    const refList = input.batch
      .map((r, j) => {
        const depth: SourceDepth =
          input.profiles.get(r.id)?.depth || (r.abstract ? "abstract" : "metadata");
        const ft = depth === "fulltext" ? "yes" : "no";
        const yr = r.year ? ` | YEAR: ${r.year}` : "";
        const abs = r.abstract
          ? `\n    ABSTRACT: ${String(r.abstract).slice(0, 300).replace(/\s+/g, " ")}`
          : "\n    ABSTRACT: (none — judge from the title)";
        return `[${input.batchStartIndex + j + 1}] TYPE: ${r.type || "web"}${yr} | FULL TEXT: ${ft} | ${(r.authors || "Anon").slice(0, 40)}\n    TITLE: ${String(r.title || "").slice(0, 110)}${abs}`;
      })
      .join("\n");

    const system =
      "You are a meticulous research librarian assessing a citation pool for a review article. " +
      "You judge ONLY from the metadata shown — no speculation beyond the given text.";

    const prompt = `ARTICLE TOPIC: ${input.topic}
FIELD: ${input.field}

SOURCES TO SCORE (batch ${input.batchNo} of ${input.totalBatches}):
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

    return { system, prompt };
  },

  metadata: (input) => ({
    batch: input.batchNo,
    total: input.totalBatches,
    refs: input.batch.length,
  }),

  /**
   * Legacy per-item semantics, verbatim: a valid LLM row (relevance and
   * importance both integers within 1-10) is adopted with priority/tier
   * composition; a skipped/malformed row gets a mechanical single-ref fill.
   */
  postProcess(parsed, input) {
    const byRef = new Map<number, any>();
    for (const s of (parsed as any).scores || []) {
      const n = parseInt(String(s.ref), 10);
      if (!isNaN(n)) byRef.set(n, s);
    }
    const out: SourceScore[] = new Array(input.batch.length);
    for (let j = 0; j < input.batch.length; j++) {
      const globalIdx = input.batchStartIndex + j + 1;
      const ref = input.batch[j];
      const s = byRef.get(globalIdx);
      const depth: SourceDepth =
        input.profiles.get(ref.id)?.depth || (ref.abstract ? "abstract" : "metadata");
      if (
        s &&
        Number(s.relevance) >= 1 &&
        Number(s.relevance) <= 10 &&
        Number(s.importance) >= 1 &&
        Number(s.importance) <= 10
      ) {
        const relevance = Math.round(Number(s.relevance));
        const importance = Math.round(Number(s.importance));
        const priority = computePriority(relevance, importance, depth);
        out[j] = {
          index: globalIdx,
          relevance,
          importance,
          depth,
          reason: String(s.reason || "").slice(0, 160),
          priority,
          tier: tierFor(priority),
        };
      } else {
        // LLM skipped/malformed this one — mechanical single-ref fill.
        out[j] = mechanicalScores([ref], input.profiles, input.topic)[0];
        out[j].index = globalIdx;
      }
    }
    return { scores: out };
  },

  validate: (output) => ({
    ok: output.scores.every((s) => s && Number.isFinite(s.index)),
    issues: output.scores.some((s) => !s)
      ? ["some batch rows unresolved after per-item fill"]
      : [],
  }),

  /** Whole-batch failure (rate limit / provider error) — mechanical fill. */
  fallback(input) {
    const mech = mechanicalScores(input.batch, input.profiles, input.topic);
    return {
      scores: mech.map((s, j) => ({ ...s, index: input.batchStartIndex + j + 1 })),
    };
  },
};

// ---------------------------------------------------------------------------
// Registry — the skill catalog (grows as call-sites migrate).
// ---------------------------------------------------------------------------

/** All registered skills, keyed by their authority id. */
export const SKILLS = {
  score: scoreSkill,
} as const;

export type RegisteredSkillId = keyof typeof SKILLS;

/** Skill catalog metadata for tooling/UI (no definitions leaked). */
export function listSkills(): Array<{
  id: string;
  taskType: string;
  sseStep: string;
  title: string;
  hasFallback: boolean;
}> {
  return Object.values(SKILLS).map((s) => ({
    id: s.id,
    taskType: s.taskType,
    sseStep: s.sseStep,
    title: s.title,
    hasFallback: typeof s.fallback === "function",
  }));
}
