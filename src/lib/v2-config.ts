/**
 * Centralized tuning constants for the V2 generation pipeline
 * (generate-full-v2) and the LLM session helpers (llm-session).
 *
 * Everything that was previously a magic number buried in route bodies now
 * lives here so the pipeline behavior is auditable and tunable in one place.
 */

/** Verification passes batch citations in groups of this size. Larger batches
 *  risk LLM output truncation; smaller ones add round-trips. */
export const VERIFY_BATCH_SIZE = 10;

/** A citation is removed from the article when the adversarial verifier's
 *  confidence (0-100) that it is unsupported is >= this threshold. */
export const VERIFY_REMOVE_CONFIDENCE = 80;

/** Lower bound of the citable-reference pool offered to the writer LLM. */
export const MIN_CITABLE_REFS = 20;

/** The citable pool grows with target length: one reference per this many
 *  target words (e.g. 2000 words → up to 10 extra refs above the minimum). */
export const CITABLE_REFS_PER_WORDS = 200;

/**
 * Hard cap on the total characters of (context + prompt) handed to the LLM
 * in llm-session. Older context turns are dropped until the assembled
 * prompt fits. CLI providers also impose an OS argv limit (~128KB Linux,
 * 32KB Windows) so staying well under that is load-bearing.
 */
export const SESSION_MAX_TOTAL_CHARS = 28000;

/** Default number of most-recent session messages considered for context. */
export const SESSION_DEFAULT_MAX_MESSAGES = 20;

/** Computed ceiling for the citable-reference pool at a given target length. */
export function maxCitableRefsFor(targetWords: number, available: number): number {
  return Math.min(available, Math.max(MIN_CITABLE_REFS, Math.floor(targetWords / CITABLE_REFS_PER_WORDS)));
}
