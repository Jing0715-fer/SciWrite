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
 *  - Sliding 10-minute window counts successful calls; when > 15,
 *    a 60s cool-down is enforced BEFORE the next call.
 *  - Daily-quota state is read from `x-ratelimit-user-daily-remaining`
 *    response header and cached in memory. When it drops to 0, all
 *    subsequent calls abort with QuotaExhaustedError.
 *  - 429 / 5xx responses are retried with exponential backoff
 *    (1s, 2s, 4s, 8s, 16s — max 5 attempts).
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
    return this.dailyRemaining !== null && this.dailyRemaining <= 0;
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
const window = new SlidingWindow(10 * 60 * 1000, 20);
const quota = new QuotaState();

// In-memory abort flag — set by the first 429/quota-exhaustion event.
//
// FIX (stale-abort poisoning): the flag used to be a plain boolean that
// ONLY a manual clearAbort() could reset, so (a) an abort left behind by a
// crashed run poisoned every subsequent run in the same process, and
// (b) a NEW run's clearAbort() erased an IN-FLIGHT run's abort, sending it
// back to hammering the provider with 429s. Aborts now carry a timestamp
// and auto-expire (ABORT_TTL_MS) — stale ones clear themselves, fresh ones
// still short-circuit every caller, and no run needs to touch another
// run's abort state. clearAbort() is kept as a force-reset escape hatch.
const ABORT_TTL_MS = 120_000;
let abortInfo: { reason: string; at: number } | null = null;

export function isAborted(): boolean {
  if (!abortInfo) return false;
  if (Date.now() - abortInfo.at > ABORT_TTL_MS) {
    console.warn(`[rate-limiter] abort auto-expired (set ${Math.round((Date.now() - abortInfo.at) / 1000)}s ago): ${abortInfo.reason.slice(0, 80)}`);
    abortInfo = null;
    return false;
  }
  return true;
}

/** Force-clear the abort flag (escape hatch; stale aborts also self-expire). */
export function clearAbort() {
  abortInfo = null;
}

export function setAbort(reason: string) {
  abortInfo = { reason, at: Date.now() };
  console.warn(`[rate-limiter] ABORT set: ${reason}`);
}

/** Milliseconds until the current abort auto-expires (0 if none/already expired). */
export function abortRemainingMs(): number {
  if (!abortInfo) return 0;
  return Math.max(0, ABORT_TTL_MS - (Date.now() - abortInfo.at));
}

/**
 * round-58 FIX (transient-abort pipeline death): a 429-retry exhaustion
 * mid-run sets a 120s-TTL abort; the OLD behavior threw
 * RateLimitAbortedError immediately at the next call — which the v2 route
 * treats as FATAL, killing a 20-55min production run after all its gather
 * work (reproduced: round-52 E2E #1 died to a 429-storm abort; round-58
 * run died at `plan` 6s after `curate`'s fallback set the abort). Since the
 * abort TTL is bounded, the resilient behavior for TRANSIENT (429-type)
 * aborts is to sleep until expiry (≤2 wait cycles) and proceed. QUOTA-type
 * aborts still fail fast — waiting cannot resurrect a daily quota.
 */
async function waitOutTransientAbort(label: string, maxCycles = 2): Promise<boolean> {
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    if (!isAborted()) return true;
    const reason = abortInfo?.reason ?? "";
    if (/quota/i.test(reason)) return false; // fail fast — not recoverable by waiting
    const waitMs = abortRemainingMs() + 2000;
    console.warn(
      `[rate-limiter] transient abort active for '${label}' (${Math.round(waitMs / 1000)}s left, cycle ${cycle + 1}/${maxCycles}) — waiting it out instead of killing the pipeline`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return !isAborted();
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
  opts: { maxRetries?: number; label?: string; patience429?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const label = opts.label ?? "llm";
  // round-58: extra 429-storm patience cycles. Each cycle = the standard
  // retry ladder (1s→16s) + a ~2min abort-TTL cool-down, then a FRESH retry
  // ladder. Long pipelines (45-60min) must outlast minutes-long provider
  // 429 storms instead of dying on the first exhausted ladder — reproduced
  // twice today (run#1 died at curate→plan cascade, run#2 died on the very
  // first gather call after 22min of provider-side refusal).
  let patienceLeft = opts.patience429 ?? 0;

  // (1) Quota guard — fail fast.
  if (quota.isExhausted()) {
    const err = new QuotaExhaustedError(
      `daily quota exhausted (remaining=0); aborting '${label}'`,
    );
    setAbort(err.message);
    throw err;
  }
  // (2) Process-wide abort guard (auto-expiring — see abortInfo above).
  // round-58: transient (429-type) aborts are waited out (bounded ≤2 TTL
  // cycles) instead of thrown — a 120s-old abort must not FATAL a 55min
  // pipeline. Quota aborts still throw immediately.
  if (isAborted()) {
    const recovered = await waitOutTransientAbort(label);
    if (!recovered) {
      throw new RateLimitAbortedError(
        `previous call aborted; skipping '${label}'`,
      );
    }
    // Woke up post-expiry — re-check quota in case it was a quota abort.
    if (quota.isExhausted()) {
      const err = new QuotaExhaustedError(
        `quota exhausted after abort-wait for '${label}'`,
      );
      setAbort(err.message);
      throw err;
    }
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

  // (5) Retry loop with exponential backoff (+ round-58 patience cycles).
  let lastErr: unknown = null;
  let attempt = 0;
  while (attempt < maxRetries) {
    if (isAborted()) {
      // round-58: same transient-abort wait-out inside the retry loop —
      // a concurrent call's abort during our backoff must not fail this call.
      const recoveredMidLoop = await waitOutTransientAbort(label, 1);
      if (!recoveredMidLoop) {
        throw new RateLimitAbortedError(`abort flag set before attempt ${attempt}`);
      }
    }
    let capturedHeaders: Headers | undefined | null;
    try {
      const result = await fn((h) => {
        capturedHeaders = h ?? undefined;
      });
      // (6) Success — update quota + window.
      quota.updateFromHeaders(capturedHeaders);
      window.record();
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

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s (jittered ±20%).
      const baseMs = Math.pow(2, attempt) * 1000;
      const jitter = baseMs * (0.8 + Math.random() * 0.4);
      console.warn(
        `[rate-limiter] '${label}' attempt ${attempt + 1}/${maxRetries} ` +
          `got ${status ?? "err"} — backing off ${Math.round(jitter)}ms`,
      );

      // round-58: patience cycle — when the ladder is exhausted on 429 and
      // patience remains, cool down for a full abort TTL (~2min) and start a
      // FRESH ladder instead of failing the call (and the pipeline behind it).
      if (attempt === maxRetries - 1 && is429) {
        if (patienceLeft > 0) {
          patienceLeft--;
          console.warn(
            `[rate-limiter] '${label}' 429 ladder exhausted — patience cycle ` +
              `(${patienceLeft} left): cooling ~${ABORT_TTL_MS / 1000}s then retrying`,
          );
          setAbort(`429 patience cycle on '${label}'`);
          await waitOutTransientAbort(label, 1);
          attempt = 0;
          continue;
        }
        // No patience left — surface as abort; long-running pipelines see
        // RateLimitAbortedError (callers with their own fallbacks degrade
        // gracefully instead of FATAL-ing only when they handle it).
        setAbort(`429 after ${maxRetries} retries on '${label}'`);
      }
      await new Promise((r) => setTimeout(r, jitter));
    }
    attempt++;
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
