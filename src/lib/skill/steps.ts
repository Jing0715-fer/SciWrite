/**
 * Shared pipeline-step constants (skill framework, RT5).
 *
 * THE PROBLEM this file kills: the step namespace was duplicated FOUR times
 * with drift — the server sent `send("step", { step: <inline string> })`
 * (~60 inline literals in generate-full-v2 alone), the client kept THREE
 * independent copies (unified-writing-dialog STEPS, topic-composer's
 * OUTDATED 9-step v1 subset still labeled "Step n/9", i18n timeline labels),
 * and a separate taskType namespace existed alongside (knowledge-verify
 * sends taskType "gather"). No single source of truth.
 *
 * This module is the single source of truth. It is CLIENT-SAFE (pure
 * constants, zero server imports) so client components and server routes
 * import the same names.
 */

/** Every step name the v2 pipeline has ever emitted on the SSE wire. */
export const PIPELINE_STEPS = [
  "init",
  "gather",
  "knowledge",
  "score",
  "curate",
  "plan",
  "gapAgent",
  "analyze",
  "allocate",
  "generate",
  "verify",
  "compose",
  "title",
  "repair",
  "polish",
  "relationships",
  "review",
  "translate",
  "audit",
  "recovery",
  "pipeline",
  "paragraph",
  "done",
] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/**
 * The v2 main-sequence order (progress-bar order; generate/verify interleave
 * per section). topic-composer's hardcoded v1 subset ("Step n/9") was a
 * stale drift — importing THIS array fixes it.
 */
export const V2_MAIN_SEQUENCE = [
  "gather",
  "knowledge",
  "score",
  "curate",
  "plan",
  "gapAgent",
  "analyze",
  "allocate",
  "generate",
  "verify",
  "compose",
  "repair",
  "polish",
  "translate",
] as const;

export type V2MainStep = (typeof V2_MAIN_SEQUENCE)[number];

/** English display titles for steps (UI fallback; i18n overrides these). */
export const STEP_TITLES: Record<PipelineStep, string> = {
  init: "Initialize pipeline",
  gather: "Gather sources",
  knowledge: "Knowledge cross-check",
  score: "Score source importance",
  curate: "Curate citation pool",
  plan: "Plan sections",
  gapAgent: "Gap agent — targeted research",
  analyze: "Analyze evidence",
  allocate: "Allocate evidence",
  generate: "Generate sections",
  verify: "Adversarially verify citations",
  compose: "Compose article",
  title: "Generate article title",
  repair: "AI review & auto-repair",
  polish: "Coherence polish",
  relationships: "Analyze source relationships",
  review: "Peer review",
  translate: "Translate",
  audit: "Audit citations",
  recovery: "Recover pipeline",
  pipeline: "Pipeline",
  paragraph: "Paragraph detail",
  done: "Done",
};

/**
 * Type guard shared by client consumers that switch on step names.
 */
export function isPipelineStep(x: unknown): x is PipelineStep {
  return typeof x === "string" && (PIPELINE_STEPS as readonly string[]).includes(x);
}
