/**
 * Skill framework core types (RT5).
 *
 * A "skill" is a DECLARATIVE contract for one agent operation:
 *   buildPrompt → (cache) → chat → parse → validate/postProcess → gates → fallback
 *
 * Before RT5 the 64 LLM call-sites each hand-rolled that skeleton (prompt as
 * an inline template, ad-hoc field validation, per-site try/catch fallback,
 * scattered console.log telemetry) — the three copy-paste families A/B/C
 * found in the code audit (citation-planner score vs generate-full-helpers
 * curate vs curate-smart were line-by-line isomorphic). The executor
 * (executor.ts) owns the skeleton ONCE; a skill definition fills the slots.
 *
 * Unification note: a skill carries ALL THREE legacy names for one
 * operation — `id` (the new authority), `taskType` (llm-session role
 * routing: REVIEW_TASK_TYPES membership), and `sseStep` (the SSE wire
 * event name). The three namespaces previously drifted (knowledge-verify
 * sent taskType "gather"; fact-check sent taskType "review" but step
 * "fact-check").
 */

import type { PipelineStep } from "./steps";

/** Registered skill ids (aligned with the legacy taskType vocabulary). */
export const SKILL_IDS = [
  "gather",
  "query-expand",
  "knowledge",
  "knowledge-summary",
  "score",
  "curate",
  "curate-smart",
  "plan",
  "gap-research",
  "gap-design",
  "evidence-extract",
  "evidence-verify",
  "evidence-allocate",
  "generate",
  "verify",
  "review",
  "revision",
  "fact-check",
  "coherence-review",
  "coherence-edit",
  "compose",
  "title",
  "translate",
  "translate-title",
  "relationships",
  "peer-review",
  "numeric-sweep",
  "write",
  "outline",
  "summarize",
  "analyze-style",
  "suggest-citations",
  "audit-citations",
  "auto-fix",
  "regenerate",
  "revise",
] as const;

export type SkillId = (typeof SKILL_IDS)[number];

/** Result of a skill's output-contract validation. */
export interface SkillValidation {
  ok: boolean;
  issues: string[];
}

/** Structured per-invocation telemetry (replaces scattered console.log). */
export interface SkillTelemetry {
  skill: SkillId;
  ms: number;
  fromCache: boolean;
  degraded: boolean;
  parseIssues: string[];
  promptChars: number;
  outputChars: number;
}

/** Uniform result envelope for every skill invocation. */
export interface SkillResult<O> {
  ok: boolean;
  output: O;
  degraded: boolean;
  fromCache: boolean;
  issues: string[];
  telemetry: SkillTelemetry;
}

/** Chat-level options the executor forwards to chatWithSession. */
export interface SkillChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Hard per-call budget — short-JSON agents pass a tight one. */
  timeoutMs?: number;
  /** Provider routing: review-family vs generate (llm-selection). */
  role?: "generate" | "review";
  /** Disable thinking/reasoning mode (fact-check's forensic adjudication). */
  thinking?: boolean;
}

/**
 * A declarative skill definition.
 *
 * Generic slots:
 *   I — the typed input the skill's prompt is built from
 *   O — the typed output contract (what parse/postProcess produce)
 */
export interface SkillDefinition<I, O> {
  /** Authority id in the unified namespace. */
  id: SkillId;
  /** Legacy llm-session taskType (role routing + cache-key derivation). */
  taskType: string;
  /** SSE wire step name for progress events. */
  sseStep: PipelineStep;
  /** Human title (UI/telemetry). */
  title: string;

  /** Prompt assembly — the ONLY place raw prompt text lives for a skill. */
  buildPrompt(input: I): { system?: string; prompt: string };

  /**
   * Output parsing. Defaults to safeParseJSON(raw, fallbackValue) —
   * override only for non-JSON skills (e.g. prose generation).
   */
  parse?: (raw: string, fallbackValue: O) => O;

  /**
   * Stage-specific post-processing + validation + per-item fallback.
   * Runs INSIDE the executor's success path. The citation-planner score
   * skill uses this for its per-ref range checks with per-item mechanical
   * fill (its legacy semantics). Throw to trigger the skill-level fallback.
   */
  postProcess?: (parsed: O, input: I) => O;

  /**
   * Output-contract validation (whole-result level). Issues are recorded
   * in telemetry; a skill may escalate to fallback by returning ok:false
   * with `fatal: true`-prefixed issues (checked by the executor).
   */
  validate?: (output: O, input: I) => SkillValidation;

  /**
   * Degraded-path fallback for the WHOLE invocation (exceptions, storm
   * aborts, fatal validation). Return the mechanical/empty result.
   */
  fallback?: (input: I, err: unknown) => O | Promise<O>;

  /** Chat-level options forwarded to chatWithSession. */
  chat: SkillChatOptions;

  /** Extra metadata rows persisted with the session message. */
  metadata?: (input: I) => Record<string, unknown>;
}
