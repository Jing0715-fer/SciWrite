import { loadRateAbort, persistRateAbort, rateAbortStorePath } from "@/lib/rate-abort-store";

/**
 * Global rate-limiter & quota tracker for z-ai-web-dev-sdk calls.
 *
 * Re-implements v17-1 (token bucket), v20-1 (429 retry with backoff),
 * v45-1 (abort on rate limit), v51-1 (pre-test quota check), v52-1
 * (adaptive cool-down > 15 calls).
 *
 * Design:
 *  - Single global TokenBucket (capacity = 2, refill = 1 token / 2s)
 *    Throttles request SPACING to <= 1 req / 2s — well under the
 *    provider's 30 req / 10min limit.
 *  - Sliding 10-minute window counts successful calls; when > threshold,
 *    a proportional cool-down is enforced BEFORE the next call.
 *  - Daily-quota state is read from `x-ratelimit-user-daily-remaining`
 *    response header and cached in memory. When it drops to 0, all
 *    subsequent calls abort with QuotaExhaustedError.
 *  - 429 / 5xx responses are retried with exponential backoff
 *    (1s, 2s, 4s, 8s, 16s — max 5 attempts).
 *  - RT4 P0-1: the abort flag + storm ladder PERSIST to disk
 *    (db/rate-abort.json) so a dev-server restart keeps its storm memory
 *    instead of immediately re-probing a throttled account; provider
 *    reset hints (Retry-After / X-RateLimit-Reset) extend the TTL when
 *    present.
 */

export class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExhaustedError";
  }
}

export class RateLimitAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitAbortedError";
  }
}

/** Result of a successful (or to-be-attempted) rate-limited call. */
export interface RateLimitHeaders {
  dailyRemaining?: number;
  dailyLimit?: number;
  retryAfter?: number;
}

// ---------------------------------------------------------------------------
// Token bucket — limits request spacing to <= 1 req / `refillIntervalMs`.
// ---------------------------------------------------------------------------

class TokenBucket {
  private capacity: number;
  private refillIntervalMs: number;
  private tokens: number;
  private lastRefill: number;
  private waiters: Array<() => void> = [];
  // Single recurring pump timer — replaces the per-waiter setTimeout that
  // stranded callers (see below) and guarantees every waiter is served as
  // soon as a token is available.
  private pumpTimer: ReturnType<typeof setInterval> | null = null;

  constructor(capacity = 2, refillIntervalMs = 2000) {
    this.capacity = capacity;
    this.refillIntervalMs = refillIntervalMs;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = Math.floor(elapsed / this.refillIntervalMs);
    if (newTokens > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + newTokens);
      this.lastRefill = this.lastRefill + newTokens * this.refillIntervalMs;
    }
  }

  private pump() {
    while (this.waiters.length > 0) {
      this.refill();
      if (this.tokens <= 0) break;
      this.tokens -= 1;
      const w = this.waiters.shift()!;
      w();
    }
    // Stop the timer once every waiter has been served — no idle interval.
    if (this.waiters.length === 0 && this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens > 0) {
      this.tokens -= 1;
      return;
    }
    // FIX (waiter-stranding race): previously each waiter scheduled its own
    // `setTimeout(pump, refillIntervalMs)`. When two callers queued in the
    // same tick, the second timer fired ~1ms after the first had already
    // consumed the fresh token, found `tokens=0`, and exited — leaving the
    // second waiter stranded until some FUTURE caller scheduled another
    // timer. A shared recurring pump timer serves all waiters reliably.
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      if (!this.pumpTimer) {
        this.pumpTimer = setInterval(() => this.pump(), this.refillIntervalMs);
        // The interval would keep the process alive if never cleared;
        // unref so it can't block shutdown (guarded by the pump's own
        // self-clear when waiters drain).
        if (typeof this.pumpTimer === "object" && "unref" in this.pumpTimer) {
          (this.pumpTimer as any).unref();
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Sliding 10-min window — counts calls; triggers cool-down when > threshold.
// ---------------------------------------------------------------------------

class SlidingWindow {
  private windowMs: number;
  private threshold: number;
  private timestamps: number[] = [];

  constructor(windowMs = 10 * 60 * 1000, threshold = 15, _coolDownMs?: number) {
    this.windowMs = windowMs;
    this.threshold = threshold;
  }

  /**
   * Returns cool-down ms to wait before the next call (0 = no cool-down).
   *
   * FIX (proportional pacing): the old implementation returned a flat 60s
   * for EVERY call past the threshold — call 16 waited 60s, call 17 waited
   * another 60s, and so on, stacking 10+ minutes of pure waiting onto v2
   * runs (~30 LLM calls). Now calls past the threshold are paced at
   * `windowMs / threshold` (one call per threshold-th of the window) which
   * is the minimum spacing that keeps the rolling window at/below the
   * threshold — 3× faster than the flat penalty, with the same safety.
   */
  nextCoolDownMs(): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.threshold) {
      return Math.round(this.windowMs / this.threshold);
    }
    return 0;
  }

  record() {
    this.timestamps.push(Date.now());
  }

  count() {
    const now = Date.now();
    return this.timestamps.filter((t) => now - t < this.windowMs).length;
  }
}

// ---------------------------------------------------------------------------
// Quota state — cached from response headers.
// ---------------------------------------------------------------------------

class QuotaState {
  dailyRemaining: number | null = null;
  dailyLimit: number | null = null;
  lastUpdated = 0;

  updateFromHeaders(headers: Headers | undefined | null) {
    if (!headers) return;
    const daily = headers.get("x-ratelimit-user-daily-remaining");
    const limit = headers.get("x-ratelimit-user-daily-limit");
    if (daily) {
      const n = parseInt(daily, 10);
      if (!Number.isNaN(n)) this.dailyRemaining = n;
    }
    if (limit) {
      const n = parseInt(limit, 10);
      if (!Number.isNaN(n)) this.dailyLimit = n;
    }
    this.lastUpdated = Date.now();
  }

  isExhausted(): boolean {
    if (this.dailyRemaining === null) return false;
    if (this.dailyRemaining > 0) return false;
    // CR-A#1 fix: daily quotas ROLL OVER. An "exhausted" reading older than
    // 6h is stale — keep it and every LLM call in this process is bricked
    // until a restart (with a days-alive dev server, that's effectively
    // forever). Forget the stale reading; the next successful response
    // re-seeds it from headers.
    if (Date.now() - this.lastUpdated > 6 * 3600_000) {
      console.warn("[rate-limiter] stale exhausted-quota reading (>6h old) — resetting (daily quota rolls over)");
      this.dailyRemaining = null;
      return false;
    }
    return true;
  }

  snapshot(): RateLimitHeaders {
    return {
      dailyRemaining: this.dailyRemaining ?? undefined,
      dailyLimit: this.dailyLimit ?? undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Singletons — process-wide.
// ---------------------------------------------------------------------------

const bucket = new TokenBucket(2, 2000);
// Threshold raised 15 → 20 with proportional pacing (see SlidingWindow):
// the provider allows 30 req/10min; 20 + 30s spacing keeps ~33% headroom
// while letting bursts of 20 through unimpeded (the old 15@60s config
// slowed every v2 run by 10+ minutes).
// Exported for /api/quota-status (was hardcoded 15 there while the window
// moved to 20 — RT4 consistency fix).
export const SLIDING_WINDOW_THRESHOLD = 20;
const window = new SlidingWindow(10 * 60 * 1000, SLIDING_WINDOW_THRESHOLD);
const quota = new QuotaState();

// In-memory abort flag — set by the first 429/quota-exhaustion event.
//
// FIX (stale-abort poisoning): the flag used to be a plain boolean that
// ONLY a manual clearAbort() could reset, so (a) an abort left behind by a
// crashed run poisoned every subsequent run in the same process, and
// (b) a NEW run's clearAbort() erased an IN-FLIGHT run's abort, sending it
// back to hammering the provider with 429s. Aborts now carry a timestamp
// and auto-expire — stale ones clear themselves, fresh ones still
// short-circuit every caller, and no run needs to touch another run's abort
// state. clearAbort() is kept as a force-reset escape hatch.
//
// CR-A#3 fix (escalating TTL): a FLAT 120s TTL made the client re-probe the
// provider with a fresh 5-attempt backoff chain every ~2-4 minutes for as
// long as a storm lasted — ~10 requests per 4 min of self-inflicted load
// that kept the account throttled (client-side storm persistence). The TTL
// now escalates on consecutive storms: 2 min → 10 min → 30 min → 60 min,
// de-escalating only after a genuinely successful call.
//
// RT4 P0-1 fix (restart amnesia): the flag + ladder used to be lost on a
// dev-server restart — a fresh process immediately re-probed a throttled
// account with the full 5-attempt chain, re-triggering the 429 storm it
// had just survived (observed live twice in the 2026-10-10 E2E). The state
// now persists to db/rate-abort.json: isAborted() lazily hydrates from
// disk when memory is empty; every mutation writes through; expiry and
// clearAbort() remove the file. A provider reset hint (Retry-After /
// X-RateLimit-Reset) can only LENGTHEN the TTL, never shorten it.
const ABORT_TTL_STEPS_MS = [120_000, 600_000, 1_800_000, 3_600_000];
const ABORT_TTL_CAP_MS = 24 * 3_600_000; // sanity cap — never trust a hint beyond a day
let consecutiveStorms = 0;
let lastAbortAt = 0;
let abortInfo: { reason: string; at: number; ttl: number } | null = null;

export function isAborted(): boolean {
  // RT4 P0-1: hydrate from disk when memory is empty — a restarted server
  // inherits the previous process's storm memory instead of re-probing.
  if (!abortInfo) {
    const persisted = loadRateAbort();
    if (persisted) {
      abortInfo = { reason: persisted.reason, at: persisted.at, ttl: persisted.ttl };
      consecutiveStorms = persisted.consecutiveStorms;
      lastAbortAt = persisted.lastAbortAt;
      console.warn(
        `[rate-limiter] restored persisted abort state (storm #${consecutiveStorms}, set ${Math.round((Date.now() - persisted.at) / 1000)}s ago, ttl ${Math.round(persisted.ttl / 1000)}s) from ${rateAbortStorePath()}`,
      );
    }
  }
  if (!abortInfo) return false;
  if (Date.now() - abortInfo.at > abortInfo.ttl) {
    console.warn(`[rate-limiter] abort auto-expired (set ${Math.round((Date.now() - abortInfo.at) / 1000)}s ago, ttl ${Math.round(abortInfo.ttl / 1000)}s): ${abortInfo.reason.slice(0, 80)}`);
    abortInfo = null;
    persistRateAbort(null); // RT4: expiry must also clear the disk marker
    return false;
  }
  return true;
}

/** Force-clear the abort flag (escape hatch; stale aborts also self-expire).
 *  RT4: also resets the storm ladder and removes the persisted marker —
 *  a manual clear means "start over" in every sense. */
export function clearAbort() {
  abortInfo = null;
  consecutiveStorms = 0;
  lastAbortAt = 0;
  persistRateAbort(null);
}

export function setAbort(reason: string, providerHintMs?: number | null) {
  const step = Math.min(consecutiveStorms, ABORT_TTL_STEPS_MS.length - 1);
  let ttl = ABORT_TTL_STEPS_MS[step];
  // RT4 P0-1: honor a provider reset hint (Retry-After / X-RateLimit-Reset)
  // when one was parsed — a 15-min Retry-After beats a 2-min ladder step.
  // Hints can only lengthen the TTL, are capped at 24h, and sub-second
  // hints are ignored (they carry no signal beyond the ladder).
  if (typeof providerHintMs === "number" && Number.isFinite(providerHintMs) && providerHintMs > ttl) {
    ttl = Math.min(providerHintMs, ABORT_TTL_CAP_MS);
  }
  abortInfo = { reason, at: Date.now(), ttl };
  lastAbortAt = Date.now();
  consecutiveStorms += 1;
  persistRateAbort({
    reason,
    at: abortInfo.at,
    ttl,
    consecutiveStorms,
    lastAbortAt,
  });
  console.warn(`[rate-limiter] ABORT set (storm #${consecutiveStorms}, ttl ${Math.round(ttl / 1000)}s${providerHintMs && providerHintMs > ABORT_TTL_STEPS_MS[step] ? " — extended by provider hint" : ""}): ${reason}`);
}

/**
 * Parse a provider reset hint from response headers (RT4 P0-1).
 * Supports: `Retry-After: <seconds>` and `Retry-After: <HTTP-date>`;
 * `X-RateLimit-Reset: <epoch-seconds-or-ms>`. Returns milliseconds-from-now,
 * or null when no usable hint is present (missing header, past date,
 * absurd >24h delta — a hint that cannot be trusted).
 */
export function parseRetryAfterMs(
  h: { get(name: string): string | null } | null | undefined,
): number | null {
  if (!h || typeof h.get !== "function") return null;
  const ra = h.get("retry-after") ?? h.get("Retry-After");
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n) && n >= 0 && n < ABORT_TTL_CAP_MS / 1000) {
      return n * 1000;
    }
    const d = Date.parse(ra);
    if (!Number.isNaN(d)) {
      const delta = d - Date.now();
      // A past date means "already reset" — no extension signal.
      if (delta > 0 && delta < ABORT_TTL_CAP_MS) return delta;
    }
  }
  const xrr = h.get("x-ratelimit-reset") ?? h.get("X-RateLimit-Reset");
  if (xrr) {
    const n = Number(xrr);
    if (Number.isFinite(n) && n > 0) {
      // Epoch seconds vs epoch ms — anything below ~1e12 is seconds.
      const epochMs = n > 1e12 ? n : n * 1000;
      const delta = epochMs - Date.now();
      if (delta > 0 && delta < ABORT_TTL_CAP_MS) return delta;
    }
  }
  return null;
}

export function getQuotaSnapshot(): RateLimitHeaders {
  return quota.snapshot();
}

export function getWindowCount(): number {
  return window.count();
}

// ---------------------------------------------------------------------------
// Core: rate-limited retry wrapper around an async LLM call.
// ---------------------------------------------------------------------------

/**
 * Run `fn` under the rate limiter. `fn` must accept an optional Headers
 * capture callback (so we can read x-ratelimit-* headers from the SDK
 * response). Returns whatever `fn` returns.
 *
 * Behavior:
 *   1. If quota is exhausted → throw QuotaExhaustedError immediately.
 *   2. If a previous call set the abort flag → throw RateLimitAbortedError.
 *   3. Acquire a token-bucket token (blocks up to ~2s if rate is exhausted).
 *   4. Apply sliding-window cool-down (60s) when > 15 calls in 10 min.
 *   5. Call `fn`. On 429 / 5xx → exponential backoff (1s/2s/4s/8s/16s).
 *   6. After success → record window timestamp, update quota headers.
 */
export async function withRateLimit<T>(
  fn: (captureHeaders: (h: Headers | undefined | null) => void) => Promise<T>,
  opts: { maxRetries?: number; label?: string } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const label = opts.label ?? "llm";

  // (1) Quota guard — fail fast.
  if (quota.isExhausted()) {
    const err = new QuotaExhaustedError(
      `daily quota exhausted (remaining=0); aborting '${label}'`,
    );
    setAbort(err.message);
    throw err;
  }
  // (2) Process-wide abort guard (auto-expiring — see abortInfo above).
  if (isAborted()) {
    throw new RateLimitAbortedError(
      `previous call aborted; skipping '${label}'`,
    );
  }

  // (4) Sliding-window cool-down.
  const coolDown = window.nextCoolDownMs();
  if (coolDown > 0) {
    console.warn(
      `[rate-limiter] cool-down ${coolDown}ms for '${label}' (window count=${window.count()})`,
    );
    await new Promise((r) => setTimeout(r, coolDown));
  }

  // (3) Token bucket — throttles request spacing.
  await bucket.acquire();

  // (5) Retry loop with exponential backoff.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (isAborted()) {
      throw new RateLimitAbortedError(`abort flag set before attempt ${attempt}`);
    }
    let capturedHeaders: Headers | undefined | null;
    try {
      const result = await fn((h) => {
        capturedHeaders = h ?? undefined;
      });
      // (6) Success — update quota + window.
      quota.updateFromHeaders(capturedHeaders);
      window.record();
      // A success after a ≥10-min quiet period is real evidence the storm
      // is over — de-escalate the abort TTL ladder (CR-A#3).
      if (consecutiveStorms > 0 && Date.now() - lastAbortAt > 10 * 60_000) {
        consecutiveStorms = 0;
        // RT4 P0-1: ladder reset writes through — a restarted server must
        // not inherit an escalated ladder that this process already
        // earned its way out of.
        if (abortInfo) {
          persistRateAbort({ reason: abortInfo.reason, at: abortInfo.at, ttl: abortInfo.ttl, consecutiveStorms, lastAbortAt });
        } else {
          persistRateAbort(null);
        }
      }
      return result;
    } catch (err: any) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      const msg = String(err?.message ?? err);

      // Detect quota exhaustion from headers (some providers set 0 in header
      // but don't return 429).
      if (quota.isExhausted()) {
        const e = new QuotaExhaustedError(
          `quota exhausted mid-call for '${label}'`,
        );
        setAbort(e.message);
        throw e;
      }

      const is429 = status === 429 || /rate.?limit|too many requests/i.test(msg);
      const is5xx = typeof status === "number" && status >= 500 && status < 600;
      const isAbort = isAborted();

      if (isAbort) {
        throw new RateLimitAbortedError(`abort during '${label}'`);
      }
      if (!is429 && !is5xx) {
        // Non-retriable error — propagate.
        throw err;
      }

      // CR-A#2 fix (limiter learns from failures): record FAILED attempts in
      // the sliding window too. Previously only successes counted, so a
      // 429-rejected burst never slowed the NEXT call — the opening burst of
      // every run could re-trigger the provider's rolling limit entirely
      // self-inflicted. Failed 429/5xx attempts now occupy window slots, so
      // pacing kicks in immediately after a rejected burst.
      if (is429 || is5xx) {
        window.record();
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s (jittered ±20%).
      const baseMs = Math.pow(2, attempt) * 1000;
      const jitter = baseMs * (0.8 + Math.random() * 0.4);
      console.warn(
        `[rate-limiter] '${label}' attempt ${attempt + 1}/${maxRetries} ` +
          `got ${status ?? "err"} — backing off ${Math.round(jitter)}ms`,
      );
      // For 429 specifically, also surface as abort after the final retry —
      // long-running pipelines should stop burning quota.
      // round-cs-3: throw RateLimitAbortedError (not the raw 429 error) so
      // (a) callers can fail fast via instanceof instead of message-sniffing,
      // and (b) ai.ts's withAbortWaitout treats a sustained storm as ONE
      // coherent wait-out + single retry instead of every batch re-entering
      // the full 5-attempt backoff chain against the same dead provider.
      if (attempt === maxRetries - 1 && is429) {
        // RT4 P0-1: honor provider reset hints when the 429 error (or the
        // captured headers of the failed response) carries them.
        const errHeaders =
          (err?.response?.headers ?? err?.headers ?? null) as Headers | null;
        const hintMs = parseRetryAfterMs(errHeaders) ?? parseRetryAfterMs(capturedHeaders);
        setAbort(`429 after ${maxRetries} retries on '${label}'`, hintMs);
        await new Promise((r) => setTimeout(r, jitter));
        throw new RateLimitAbortedError(
          `429 after ${maxRetries} retries on '${label}' — rate-limit storm, abort flag set`,
        );
      }
      await new Promise((r) => setTimeout(r, jitter));
    }
  }

  throw lastErr ?? new Error(`withRateLimit exhausted retries for '${label}'`);
}

/**
 * Pre-flight check: throw QuotaExhaustedError if the cached quota says we
 * have 0 calls left today. Used by long-running pipelines to bail out
 * BEFORE doing any work (saves gather/plan tokens).
 */
export function preFlightQuotaCheck(label = "pre-flight"): void {
  if (quota.isExhausted()) {
    const err = new QuotaExhaustedError(
      `pre-flight quota check failed for '${label}' (remaining=0)`,
    );
    setAbort(err.message);
    throw err;
  }
  if (isAborted()) {
    throw new RateLimitAbortedError(`pre-flight: abort flag set for '${label}'`);
  }
}
