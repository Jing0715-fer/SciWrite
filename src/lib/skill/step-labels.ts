// RT9: single source of truth for PipelineStep → i18n key derivation.
//
// History: the repo carried THREE parallel label sets — `oneClick.stepXxx`
// (dialog stepper), `timeline.step.xxx` (run timeline), and STEP_TITLES
// (steps.ts, test-only). RT8 removed the last v1 consumer of oneClick
// labels, so RT9 collapses the first two: this map is the ONLY place a
// step wire-name maps to an i18n key, and both dialogs derive their
// labels from it. `Record<PipelineStep, TranslationKey>` is exhaustive —
// a new STEP without a label fails the compiler, and a deleted i18n key
// fails the TranslationKey type. The oneClick.step* dictionary entries
// were deleted alongside this move (en+zh, 28 lines).
//
// steps.ts is client-safe (constants only); TranslationKey is imported
// type-only so this module stays importable from any context.

import type { TranslationKey } from "@/lib/i18n";
import { STEP, type PipelineStep } from "@/lib/skill/steps";

export const STEP_LABEL_KEYS: Record<PipelineStep, TranslationKey> = {
  [STEP.init]: "timeline.step.init",
  [STEP.gather]: "timeline.step.gather",
  [STEP.knowledge]: "timeline.step.knowledge",
  [STEP.score]: "timeline.step.score",
  [STEP.curate]: "timeline.step.curate",
  [STEP.plan]: "timeline.step.plan",
  // round-cs-2: research gap agent (STEP 3.5) + coherence polish (STEP 8.6)
  [STEP.gapAgent]: "timeline.step.gapAgent",
  [STEP.analyze]: "timeline.step.analyze",
  [STEP.allocate]: "timeline.step.allocate",
  [STEP.generate]: "timeline.step.generate",
  [STEP.verify]: "timeline.step.verify",
  [STEP.compose]: "timeline.step.compose",
  [STEP.repair]: "timeline.step.repair",
  [STEP.polish]: "timeline.step.polish",
  [STEP.translate]: "timeline.step.translate",
  [STEP.review]: "timeline.step.review",
  [STEP.audit]: "timeline.step.audit",
  [STEP.relationships]: "timeline.step.relationships",
  [STEP.pipeline]: "timeline.step.pipeline",
  [STEP.recovery]: "timeline.step.recovery",
  // namespace-only steps that never appear on the timeline still need a
  // label slot (Record<PipelineStep, …> is exhaustive). They fold onto
  // their parent stage's label:
  [STEP.title]: "timeline.step.compose",
  [STEP["generate-wordcount-retry"]]: "timeline.step.generate",
  [STEP["generate-density-retry"]]: "timeline.step.generate",
  [STEP["translate-glossary"]]: "timeline.step.translate",
  [STEP["adversarial-verify"]]: "timeline.step.verify",
  [STEP.paragraph]: "timeline.step.pipeline",
  [STEP.done]: "timeline.status.completed",
};

export function stepLabelKey(step: PipelineStep): TranslationKey {
  return STEP_LABEL_KEYS[step];
}
