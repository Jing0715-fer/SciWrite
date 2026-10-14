/**
 * Storm-recovery core (RT16) — shared, TTL-aware, single-flight "wait for a
 * clean provider window" used by stage-level retry hooks (gather web-search
 * clean-window retry, score-stage rescore).
 *
 * Re-implements the storm-resilience design proven live in the RT14/RT15
 * E2E storms (lost in the 2026-10-14 sandbox reset — see worklog RT16 entry)
 * WITH the RT16 backlog fixes designed in from the start:
 *
 *  1. TTL-aware budgets (RT15-FINAL backlog #1 — "storm ladder TTL vs
 *     recovery budget structural mismatch"). The RT15 evidence: the abort
 *     ladder escalates 2min → 10min → 30min → 60min, while the recovery
 *     waits carried flat 10/15-min budgets — once the ladder hit its 30-min
 *     step, EVERY wait was structurally doomed (10 min of waiting theatre
 *     ending in a foregone give-up). The fix takes the abort TTL as the
 *     budget source of truth:
 *       budget = clamp(TTL-remaining + margin, pollMs, hardMax)
 *     - short storms (2-min ladder step) wait only ~3.5 min, not 10;
 *     - 30-min-step storms get a 31.5-min budget — a REAL chance to wait
 *       out the storm and recover (RT8's "outlast the storm" pattern, live-
 *       proven: the 2026-10-12 E2E fully recovered after a ~19-min TTL);
 *     - anything beyond hardMax (35 min — covers the 30-min ladder step
 *       plus margin) is honestly declared structurally hopeless and the
 *       wait is SKIPPED entirely — no theatre, instant disclosure.
 *
 *  2. Same-storm single-flight dedup (RT15-FINAL backlog #2 — "same-storm
 *     duplicate waiting"). When two stages want recovery during the SAME
 *     storm (web-retry + rescore both degraded by one 429 wave), the naive
 *     design waits twice serially — the RT15 E2E burned 25 min of wall
 *     clock on two stacked waits for one storm. Here the first waiter
 *     performs THE wait; later waiters on the same abort epoch join the
 *     in-flight promise and receive the same outcome. Each caller still
 *     runs its own capability probe afterwards (RT12 lesson: an empty
 *     in-process window says NOTHING about account recovery — the probe
 *     is the only ground truth).
 *
 * Probe discipline (RT12 lesson, twice-proven live): the WAIT ends when the
 * in-process limiter looks clean (abort flag expired + sliding window
 * drained). That is necessary but NOT sufficient — the provider may still
 * throttle the account. Callers MUST probe with one real capability call
 * (webSearchDetailed for the gather hook; the first rescore batch itself
 * for the score hook — LLM calls re-enter withRateLimit, so a still-hot
 * provider refuses immediately) before spending the retry pool.
 */

import { getAbortInfo, getWindowCount } from "@/lib/rate-limiter";
import type { RateAbortInfo } from "@/lib/rate-limiter";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One waiting round, reported to the caller's onRound after each poll. */
export interface StormWaitRound {
  /** 1-based round counter. */
  round: number;
  /** Total wall-clock ms waited after this round's sleep. */
  waitedMs: number;
  /** Sliding-window call count now (the "recent activity" proxy). */
  windowCount: number;
  /** Abort TTL remaining (ms) or null when the flag is gone. */
  abortTtlRemainingMs: number | null;
}

export type StormWaitOutcomeKind =
  | "no-storm" // nothing to wait for — caller probes immediately
  | "clean" // abort expired + window drained within budget
  | "budget-exhausted" // storm outlasted the effective budget — honest give-up
  | "structurally-doomed" // TTL remaining alone exceeds hardMax — wait skipped
  | "caller-aborted"; // caller's shouldAbort flipped (client disconnect etc.)

export interface StormWaitResult {
  clean: boolean;
  outcome: StormWaitOutcomeKind;
  /** Number of poll rounds actually slept. */
  rounds: number;
  /** Total wall-clock ms actually waited. */
  waitedMs: number;
  /** Abort TTL remaining at entry (ms) — disclosure for doomed/exhausted. */
  abortTtlRemainingMs: number | null;
  /** The effective budget the wait ran under (0 when skipped). */
  budgetMs: number;
  /** True when this caller joined an in-flight wait instead of starting one. */
  joinedSharedWait: boolean;
}

export interface StormWaitOptions {
  /** Stage label for logs ("gather-web-retry", "score-rescore"). */
  label: string;
  /** Flat budget when no abort TTL is known (window-only drain). Default 10 min. */
  defaultBudgetMs?: number;
  /** Absolute wait ceiling — anything needing more is structurally hopeless. Default 35 min. */
  hardMaxMs?: number;
  /** Margin added to TTL remaining (TTL expiry ≠ instant recovery). Default 90 s. */
  ttlMarginMs?: number;
  /** Poll interval — also the wait granularity. Default 15 s. */
  pollMs?: number;
  /** Sliding-window counts at/below this read "quiet". Default 3. */
  windowQuietThreshold?: number;
  /** Live progress disclosure — fired after every poll round. */
  onRound?: (round: StormWaitRound) => void;
  /** Break the wait when this flips true (client disconnect, run abort...). */
  shouldAbort?: () => boolean;
  /** Test seam: clock. Default Date.now. */
  _now?: () => number;
  /** Test seam: sleep. Default real setTimeout. */
  _sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// State-reading seams — tests replace these; production reads the limiter.
// ---------------------------------------------------------------------------

let readAbortInfo: () => RateAbortInfo | null = getAbortInfo;
let readWindowCount: () => number = getWindowCount;

/**
 * Test hook: swap the abort/window readers (null restores the live ones).
 * The dedup map is reset by _resetStormRecoveryForTests.
 */
export function setStormStateReaders(
  seam: { abortInfo?: () => RateAbortInfo | null; windowCount?: () => number } | null,
): void {
  readAbortInfo = seam?.abortInfo ?? getAbortInfo;
  readWindowCount = seam?.windowCount ?? getWindowCount;
}

/** Test hook: clear the single-flight map between tests. */
export function _resetStormRecoveryForTests(): void {
  inFlightWaits.clear();
}

// ---------------------------------------------------------------------------
// Single-flight dedup: one wait per abort epoch (RT15-FINAL backlog #2).
// ---------------------------------------------------------------------------

const inFlightWaits = new Map<string, Promise<StormWaitResult>>();

function stormKey(info: RateAbortInfo | null): string {
  // The abort epoch (set-time + ttl) identifies the storm. No abort flag ⇒
  // the wait is a pure window drain, keyed by "window".
  return info ? `abort:${info.at}:${info.ttl}` : "window-drain";
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

const DEFAULTS = {
  defaultBudgetMs: 10 * 60_000,
  hardMaxMs: 35 * 60_000,
  ttlMarginMs: 90_000,
  pollMs: 15_000,
  windowQuietThreshold: 3,
};

export async function waitForCleanWindow(
  opts: StormWaitOptions,
): Promise<StormWaitResult> {
  const now = opts._now ?? Date.now;
  const sleep = opts._sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? DEFAULTS.pollMs;
  const hardMaxMs = opts.hardMaxMs ?? DEFAULTS.hardMaxMs;
  const ttlMarginMs = opts.ttlMarginMs ?? DEFAULTS.ttlMarginMs;
  const defaultBudgetMs = opts.defaultBudgetMs ?? DEFAULTS.defaultBudgetMs;
  const windowQuietThreshold = opts.windowQuietThreshold ?? DEFAULTS.windowQuietThreshold;

  const info = readAbortInfo();
  const windowBusy = () => readWindowCount() > windowQuietThreshold;

  // Fast path: nothing to wait for — the caller goes straight to its probe.
  if (!info && !windowBusy()) {
    return {
      clean: true,
      outcome: "no-storm",
      rounds: 0,
      waitedMs: 0,
      abortTtlRemainingMs: null,
      budgetMs: 0,
      joinedSharedWait: false,
    };
  }

  // TTL-aware budget computation (RT16 #1). ttlRemaining is read at entry;
  // the loop re-reads live state each round.
  let budgetMs: number;
  let ttlRemainingAtEntry: number | null = null;
  if (info) {
    const ttlRemaining = info.at + info.ttl - now();
    ttlRemainingAtEntry = ttlRemaining;
    if (ttlRemaining + ttlMarginMs > hardMaxMs) {
      // Structurally hopeless under the hard ceiling — skip the theatre.
      // (RT15-Final candidate (b) made honest: deep-storm give-up is a
      // designed, instantly-disclosed outcome, never a slow one.)
      console.warn(
        `[storm-recovery] '${opts.label}' skipped wait — abort TTL ${Math.round(ttlRemaining / 60_000)} min exceeds the ${Math.round(hardMaxMs / 60_000)}-min recovery ceiling (storm ladder step too deep)`,
      );
      return {
        clean: false,
        outcome: "structurally-doomed",
        rounds: 0,
        waitedMs: 0,
        abortTtlRemainingMs: ttlRemaining,
        budgetMs: 0,
        joinedSharedWait: false,
      };
    }
    // Wait exactly as long as the storm can possibly last (TTL + margin),
    // never less than one poll round, never past the hard ceiling.
    budgetMs = Math.max(Math.min(ttlRemaining + ttlMarginMs, hardMaxMs), pollMs);
  } else {
    budgetMs = Math.min(defaultBudgetMs, hardMaxMs);
  }

  // Same-storm single-flight (RT16 #2): join an in-flight wait on the same
  // abort epoch instead of restarting the clock behind it.
  const key = stormKey(info);
  const existing = inFlightWaits.get(key);
  if (existing) {
    const base = await existing;
    console.warn(
      `[storm-recovery] '${opts.label}' joined the in-flight '${key}' wait (rounds=${base.rounds}, outcome=${base.outcome}) — one storm, one wait`,
    );
    return { ...base, joinedSharedWait: true };
  }

  const startedAt = now();
  const deadline = startedAt + budgetMs;
  const run = (async (): Promise<StormWaitResult> => {
    let rounds = 0;
    while (true) {
      // Clean check FIRST — a storm may expire between budget computation
      // and the first poll (short TTLs, joined late).
      const liveInfo = readAbortInfo();
      const liveTtlRemaining = liveInfo ? liveInfo.at + liveInfo.ttl - now() : null;
      if (!liveInfo && !windowBusy()) {
        return {
          clean: true,
          outcome: "clean",
          rounds,
          waitedMs: now() - startedAt,
          abortTtlRemainingMs: ttlRemainingAtEntry,
          budgetMs,
          joinedSharedWait: false,
        };
      }
      if (opts.shouldAbort?.()) {
        return {
          clean: false,
          outcome: "caller-aborted",
          rounds,
          waitedMs: now() - startedAt,
          abortTtlRemainingMs: liveTtlRemaining,
          budgetMs,
          joinedSharedWait: false,
        };
      }
      // One more round only if it fits the budget.
      if (now() + pollMs > deadline) {
        return {
          clean: false,
          outcome: "budget-exhausted",
          rounds,
          waitedMs: now() - startedAt,
          abortTtlRemainingMs: liveTtlRemaining,
          budgetMs,
          joinedSharedWait: false,
        };
      }
      await sleep(pollMs);
      rounds += 1;
      opts.onRound?.({
        round: rounds,
        waitedMs: now() - startedAt,
        windowCount: readWindowCount(),
        abortTtlRemainingMs: liveTtlRemaining,
      });
    }
  })();

  inFlightWaits.set(key, run);
  try {
    return await run;
  } finally {
    inFlightWaits.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Stage-facing helpers — shared disclosure strings + stats entry shape.
// ---------------------------------------------------------------------------

/** Recovery entry recorded on the pipeline stats object and surfaced in the
 *  timeline's recovery badge (RT15's recovery-badge design, re-landed). */
export interface StormRecoveryEntry {
  stage: string;
  outcome: "recovered" | "probe-refused" | "gave-up" | "structurally-doomed";
  rounds: number;
  waitedMs: number;
  /** Queries/batches actually retried after the wait. */
  retriedCount: number;
  /** Retries that came back healthy (LLM-scored / real results). */
  recoveredCount: number;
  joinedSharedWait: boolean;
  /** Human-readable disclosure (already event-emitted; stats copy). */
  detail: string;
}

/** Shared stats-recorder shape — route passes one lambda per stage hook. */
export type StormRecoveryRecorder = (entry: StormRecoveryEntry) => void;

/** Outcome-kind → human phrase for the give-up disclosure events. */
export function describeWaitOutcome(r: StormWaitResult): string {
  switch (r.outcome) {
    case "budget-exhausted":
      return `recovery wait budget exhausted (${Math.round(r.waitedMs / 60_000)} min waited; provider still throttled)`;
    case "structurally-doomed":
      return `rate-limit cooldown (${Math.round((r.abortTtlRemainingMs ?? 0) / 60_000)} min) exceeds the recovery ceiling — waiting is structurally hopeless`;
    case "caller-aborted":
      return "run aborted during the recovery wait";
    default:
      return r.outcome;
  }
}
