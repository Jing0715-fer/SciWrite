/**
 * Skill telemetry collector (RT7) — the RT6 backlog item 5:
 * "Degradation-flag surfacing: the v2 complete-event stats block could carry
 * per-skill degraded counts from the telemetry envelope."
 *
 * Before RT7 the executor logged every skill invocation (cache-hit / ok /
 * DEGRADED) but nothing AGGREGATED them — a run that quietly degraded
 * three skills looked identical, in the final stats block, to a fully clean
 * run. You had to grep the server log to know.
 *
 * Design:
 *   - The collector is a MODULE-LEVEL, IN-PROCESS aggregate. The v2 route
 *     resets it at pipeline start and reads it at the complete event —
 *     one run at a time per process is the deployment reality (the v2
 *     pipeline is a single long-lived SSE request).
 *   - Observer-only by construction: every entry point swallows its own
 *     errors. Telemetry can never break a pipeline.
 *   - The executor reports via recordSkillTelemetry() inside its finish()
 *     envelope — no call-site changes anywhere.
 */

import type { SkillId, SkillTelemetry } from "./types";

interface SkillAggregate {
  calls: number;
  degraded: number;
  cacheHits: number;
  totalMs: number;
}

const aggregates = new Map<SkillId, SkillAggregate>();

function bump(skill: SkillId, patch: Partial<SkillAggregate>): void {
  try {
    const cur = aggregates.get(skill) ?? { calls: 0, degraded: 0, cacheHits: 0, totalMs: 0 };
    cur.calls += patch.calls ?? 0;
    cur.degraded += patch.degraded ?? 0;
    cur.cacheHits += patch.cacheHits ?? 0;
    cur.totalMs += patch.totalMs ?? 0;
    aggregates.set(skill, cur);
  } catch {
    // Observer-only: telemetry must never throw into the pipeline.
  }
}

/** Executor hook — one row per finished skill invocation (all outcomes). */
export function recordSkillTelemetry(t: SkillTelemetry): void {
  bump(t.skill, {
    calls: 1,
    degraded: t.degraded ? 1 : 0,
    cacheHits: t.fromCache ? 1 : 0,
    totalMs: t.ms,
  });
}

/** Snapshot for the complete-event stats block. */
export function getSkillStats(): {
  calls: Record<string, number>;
  degraded: Record<string, number>;
  cacheHits: Record<string, number>;
  totalMs: Record<string, number>;
} {
  const out = { calls: {}, degraded: {}, cacheHits: {}, totalMs: {} } as ReturnType<typeof getSkillStats>;
  try {
    for (const [skill, agg] of aggregates) {
      out.calls[skill] = agg.calls;
      out.degraded[skill] = agg.degraded;
      out.cacheHits[skill] = agg.cacheHits;
      out.totalMs[skill] = agg.totalMs;
    }
  } catch {}
  return out;
}

/** Only the skills that degraded — the compact "what went soft" view. */
export function getSkillDegradedCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const [skill, agg] of aggregates) {
      if (agg.degraded > 0) out[skill] = agg.degraded;
    }
  } catch {}
  return out;
}

/** The v2 route calls this at pipeline start (one run per reset). */
export function resetSkillTelemetry(): void {
  try {
    aggregates.clear();
  } catch {}
}
