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
 *  target words.
 *
 *  round-57 (P1-2): was 200 — a 3000-word review capped at 20 refs while the
 *  pool held 265, and curation dropped in-pool landmark papers (Askew 2015,
 *  Kurima 2002 …) whose findings the article then narrated UNCITED. Real
 *  review articles run ~1 citation per 100–150 words; 120 raises the 3000-
 *  word cap to 25 without padding short articles (the MIN still dominates
 *  below ~2400 words). */
export const CITABLE_REFS_PER_WORDS = 120;

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

/* ------------------------------------------------------------------ *
 * round-59: auto review & repair loop (generate-full-v2 STEP 8.5)
 * ------------------------------------------------------------------ */

/** Maximum surgical revisions the in-pipeline repair loop will apply.
 *  Each revision is followed by a re-review, so the worst case is
 *  REPAIR_MAX_REVISIONS + 1 review rounds (1 initial + one per revise). */
export const REPAIR_MAX_REVISIONS = 2;

/** A revised article must keep at least this fraction of the original body's
 *  word count — guards against an LLM "revision" that collapses the article
 *  into a summary of itself. */
export const REVISION_MIN_WORD_RATIO = 0.6;

/** A revised article must keep at least this fraction of the original's
 *  distinct in-range citations AND reference-list entries — guards against a
 *  revision that quietly strips the evidence grounding out of the article. */
export const REVISION_MIN_CITATION_RATIO = 0.6;
