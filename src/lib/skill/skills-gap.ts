/**
 * Skill definitions — research-gap family (RT7).
 *
 * Migrated from research-gap.ts (RT6 backlog's B-family stragglers):
 *   - gap-design  ← identifyEvidenceGaps' LLM pass (judgment gaps + queries)
 *   - gap-research ← runGapResearch's LLM relevance gate
 *
 * Degradation contract (kept identical to the legacy sites — non-fatal):
 *   - gap-design: an LLM/provider failure degrades via the skill fallback
 *     (empty gaps) — mechanical gaps (sections with zero allocated refs)
 *     still run; the pool is unchanged. The caller maps `degraded` to the
 *     legacy `llmError` field.
 *   - gap-research: the relevance gate. Provider failure → the skill
 *     fallback returns the PubMed candidates' C-ids (legacy catch:
 *     "fell back to N PubMed candidate(s)"). Parse failure is DISTINGUISHED
 *     from a genuine keep-0 verdict via the output's `parseOk` flag
 *     (round-RT2 semantics: unparseable → PubMed fallback; genuine keep-0 →
 *     the caller's mechanical topical ranking).
 *
 * Step unification: legacy metadata.step was "gapAgent" (in namespace) —
 * kept; `sub` rows ("identify" / "relevanceGate") preserved in metadata.
 *
 * Import-cycle discipline: pool orchestration (the mechanical-gap pass, the
 * search loop, dedupe sets, the storm-guard short-circuit, keep-0 keyword
 * ranking) stays at the call-site; prompt text + output normalization live
 * here. GapQuery/EvidenceGap/GapCandidate types moved here (research-gap.ts
 * re-exports for compatibility).
 */

import { parseLlmJson } from "@/lib/llm-json";
import type { SkillDefinition } from "./types";

// ---------------------------------------------------------------------------
// Shared contracts (moved here from research-gap.ts; re-exported there)
// ---------------------------------------------------------------------------

export interface GapQuery {
  database: "pubmed" | "web";
  query: string;
}

export interface EvidenceGap {
  /** 0-based index into the plan's sections array. */
  sectionIndex: number;
  sectionTitle: string;
  /** What specific evidence is missing (used as the relevance-gate target). */
  gap: string;
  queries: GapQuery[];
}

/** Normalized candidate reference — same shape gather-stage items have. */
export interface GapCandidate {
  source: "pubmed" | "web";
  externalId?: string | null;
  title: string;
  authors?: string | null;
  journal?: string | null;
  year?: string | null;
  url?: string | null;
  doi?: string | null;
  abstract?: string | null;
  extra?: any;
  /** Which gap's search produced this candidate. */
  gapIndex: number;
  queryUsed: string;
}

/** Max LLM-judgment gaps per identify call (mechanical gaps bypass this). */
export const GAP_AGENT_MAX_GAPS = 3;
/** Maximum search queries executed per gap (1 scholarly + 1 web is typical). */
export const GAP_AGENT_MAX_QUERIES_PER_GAP = 2;

// ---------------------------------------------------------------------------
// gap-design — identify evidence gaps + design the retrieval queries
// (legacy: research-gap.ts identifyEvidenceGaps, LLM pass)
// ---------------------------------------------------------------------------

export interface GapDesignInput {
  topic: string;
  field: string;
  /** Pre-rendered outline+allocation lines (the caller maps sections×curatedRefs). */
  coverageLines: string;
  /** Section count (sectionIndex range check). */
  sectionCount: number;
  /** Section titles by index (sectionTitle fill). */
  sectionTitles: string[];
  /** Remaining gap budget after mechanical gaps (MAX_GAPS − mechanical count). */
  remainingCapacity: number;
}

export interface GapDesignOutput {
  gaps: EvidenceGap[];
}

export const gapDesignSkill: SkillDefinition<GapDesignInput, GapDesignOutput> = {
  id: "gap-design",
  taskType: "gather", // legacy role routing
  sseStep: "gapAgent",
  title: "Identify evidence gaps and design retrieval queries",
  chat: { temperature: 0.3 },

  buildPrompt(input) {
    const system = `You are a rigorous evidence auditor for a ${input.field} review article on: ${input.topic}.
Your ONLY job is to find EVIDENCE GAPS: specific claims or subject areas a planned section must cover that its allocated references do NOT support (judging from titles/abstracts). You do not write content.`;

    const prompt = `RESEARCH TOPIC: ${input.topic}
PLANNED OUTLINE + CURRENTLY ALLOCATED SOURCES:
${input.coverageLines}

Identify up to ${input.remainingCapacity} CRITICAL evidence gaps — where a section promises something (a structure, a mechanism, a disease link, a method, a quantitative comparison) that NO allocated source visibly supports.

Rules:
- Only name a gap when the section FOCUS requires the missing evidence — not stylistic wishes.
- A gap must be SPECIFIC enough to search for ("cryo-EM structure of the human xCT/GPATC3 heterodimer" not "more structural details").
- For each gap give 1-${GAP_AGENT_MAX_QUERIES_PER_GAP} precise queries: one PubMed query (scholarly, keyword-style) and optionally one web query (broader, may add review/context).
- Queries must center on the specific molecule/method named in the gap — never generic phrases.

Respond as STRICT JSON:
{
  "gaps": [
    { "sectionIndex": 1, "gap": "specific missing evidence", "queries": [ { "database": "pubmed", "query": "..." } ] }
  ]
}
sectionIndex is 0-based. Output JSON only. If every section is adequately covered, output {"gaps":[]}.`;

    return { system, prompt };
  },

  metadata: () => ({ sub: "identify" }),

  /**
   * Gap normalization, verbatim from the legacy call-site: sectionIndex
   * range check, gap string check, query whitelist (database ∈ pubmed/web)
   * + per-gap query cap + 240-char truncation, sectionTitle fill, cap at
   * the remaining capacity (mechanical gaps already occupy the budget).
   */
  postProcess(parsed, input) {
    const gaps: EvidenceGap[] = [];
    for (const g of parsed.gaps || []) {
      if (gaps.length >= input.remainingCapacity) break;
      const idx = parseInt(String(g.sectionIndex), 10);
      if (isNaN(idx) || idx < 0 || idx >= input.sectionCount) continue;
      if (!g.gap || typeof g.gap !== "string") continue;
      const queries: GapQuery[] = (Array.isArray(g.queries) ? g.queries : [])
        .filter((q: any) => q?.query && (q.database === "pubmed" || q.database === "web"))
        .slice(0, GAP_AGENT_MAX_QUERIES_PER_GAP)
        .map((q: any) => ({ database: q.database, query: String(q.query).slice(0, 240) }));
      if (queries.length === 0) continue;
      gaps.push({
        sectionIndex: idx,
        sectionTitle: String(input.sectionTitles[idx] || `Section ${idx + 1}`),
        gap: String(g.gap).slice(0, 400),
        queries,
      });
    }
    return { gaps };
  },

  /** LLM failure → no judgment gaps; mechanical gaps still run at the call-site. */
  fallback: () => ({ gaps: [] }),
};

// ---------------------------------------------------------------------------
// gap-research — the relevance gate over gap-search candidates
// (legacy: research-gap.ts runGapResearch, LLM gate block)
// ---------------------------------------------------------------------------

export interface GapResearchInput {
  topic: string;
  gaps: EvidenceGap[];
  /** The deduped candidates to screen (the caller already deduped against the pool). */
  candidates: GapCandidate[];
  maxNewRefs: number;
}

export interface GapResearchOutput {
  /** Regularized C-ids to keep ("C1", "C3", …). */
  keep: string[];
  /**
   * False when the reply failed to parse (parseLlmJson ok=false) — the
   * round-RT2 distinction: unparseable → the caller falls back to PubMed
   * candidates; genuine keep-0 (parseOk=true) → the caller's mechanical
   * topical ranking.
   */
  parseOk: boolean;
}

export const gapResearchSkill: SkillDefinition<GapResearchInput, GapResearchOutput> = {
  id: "gap-research",
  taskType: "gather", // legacy role routing
  sseStep: "gapAgent",
  title: "Screen gap-research candidates against named gaps",
  chat: { temperature: 0.2 },

  buildPrompt(input) {
    const gapLines = input.gaps
      .map((g, i) => `GAP ${i + 1} (§${g.sectionIndex + 1} ${g.sectionTitle}): ${g.gap}`)
      .join("\n");
    const candLines = input.candidates
      .slice(0, 24)
      .map(
        (c, i) =>
          `C${i + 1} [${c.source}] ${String(c.title).slice(0, 110)} | ${String(c.abstract || "").replace(/\s+/g, " ").slice(0, 160)}`,
      )
      .join("\n");

    const system =
      "You are a precise literature-screening assistant. Judge each candidate only by its title and snippet against the stated gaps.";

    const prompt = `RESEARCH TOPIC: ${input.topic}
EVIDENCE GAPS:
${gapLines}

SEARCH CANDIDATES:
${candLines}

Which candidates genuinely help fill one of the gaps (a source can fill any gap, not only the one that found it)? A candidate is IRRELEVANT if it merely mentions the topic without containing the missing evidence. Prefer primary research papers over news/encyclopedia pages.

Respond as STRICT JSON: { "keep": ["C1", "C3"] }
Output JSON only.`;

    return { system, prompt };
  },

  metadata: () => ({ sub: "relevanceGate" }),

  /**
   * parseLlmJson (not safeParseJSON) so the ok-flag survives as `parseOk` —
   * the round-RT2 keep-0 semantics need the distinction.
   */
  parse(raw) {
    const r = parseLlmJson<{ keep?: string[] }>(raw, { keep: [] });
    return {
      keep: Array.isArray(r.value.keep) ? r.value.keep : [],
      parseOk: r.ok,
    };
  },

  /** C-id regularization, verbatim: uppercase + C\d+ whitelist. */
  postProcess(parsed) {
    return {
      keep: (parsed.keep || [])
        .map((k: any) => String(k).trim().toUpperCase())
        .filter((k: string) => /^C\d+$/.test(k)),
      parseOk: parsed.parseOk,
    };
  },

  /**
   * Provider failure → the legacy catch: keep the PubMed candidates capped
   * at maxNewRefs (database provenance as the proxy).
   */
  fallback(input) {
    const keep = input.candidates
      .map((c, i) => (c.source === "pubmed" ? `C${i + 1}` : null))
      .filter((k): k is string => k != null)
      .slice(0, input.maxNewRefs);
    return { keep, parseOk: false };
  },
};
