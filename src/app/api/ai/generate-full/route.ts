/**
 * POST /api/ai/generate-full — v1 pipeline URL, now delegated to v2.
 *
 * RT8 (one-orchestrator merge, RT7 backlog #1): the v1 pipeline's 4007-line
 * stage orchestration was deleted; this URL now runs the v2 evidence-grounded
 * pipeline exclusively. Rationale (audited before deletion):
 *
 *   - The ONLY live consumer was the dialog's local "v1 · Standard" toggle
 *     (default v2, never persisted). Every script, watchdog, E2E harness and
 *     test posts to -v2. topic-composer.tsx (the one other v1 caller) was
 *     dead code and was removed in the same round.
 *   - The v2 SSE envelope is a deliberate superset of v1's (the complete
 *     payload carries a V1-shaped stats block alongside the flat fields),
 *     and the client shape-reads the payload — old consumers keep working.
 *   - v1-only request knobs (sectionRefTopN/sectionDsTopN/…/gatherJsonCharLimit)
 *     are ignored by v2, same as before the merge.
 *   - Delegation (module re-export) instead of an HTTP redirect: no
 *     port/origin coupling, POST body preserved, and the URL stays valid for
 *     stray clients and bookmarks.
 *
 * Behavior changes a v1 user would notice (disclosed by design):
 *   - citations are keyed {{Rn}} markers converted by code (not LLM-written
 *     numeric [n]), then adversarially verified;
 *   - the run is checkpointed per section and auto-resumable;
 *   - knowledge / evidence / repair / polish stages run (v1 had none of
 *     them) — wall clock is correspondingly longer.
 *
 * NOTE: route-segment config (runtime / maxDuration) cannot be re-exported —
 * Next.js requires these to be statically parseable per file — so they are
 * declared locally and only the POST handler is re-exported.
 */
export const runtime = "nodejs";
export const maxDuration = 1800;

export { POST } from "../generate-full-v2/route";
