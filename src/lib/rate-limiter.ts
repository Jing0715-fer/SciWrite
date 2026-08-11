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
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens > 0) {
      this.tokens -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      const waitMs = this.refillIntervalMs;
      setTimeout(() => this.pump(), waitMs);
    });
  }
}

// ---------------------------------------------------------------------------
// Sliding 10-min window — counts calls; triggers cool-down when > threshold.
// ---------------------------------------------------------------------------

class SlidingWindow {
  private windowMs: number;
  private threshold: number;
  private coolDownMs: number;
  private timestamps: number[] = [];

  constructor(windowMs = 10 * 60 * 1000, threshold = 15, coolDownMs = 60 * 1000) {
    this.windowMs = windowMs;
    this.threshold = threshold;
    this.coolDownMs = coolDownMs;
  }

  /** Returns cool-down ms to wait before the next call (0 = no cool-down). */
  nextCoolDownMs(): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.threshold) {
      // Cool down for `coolDownMs` since the most recent call
      return this.coolDownMs;
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
const window = new SlidingWindow(10 * 60 * 1000, 15, 60 * 1000);
const quota = new QuotaState();

// In-memory abort flag — set by the first 429/quota-exhaustion event.
// Once set, all subsequent calls in the same Node process throw
// RateLimitAbortedError until clearAbort() is called (used by long-running
// pipelines like generate-full to short-circuit the rest of the loop).
let aborted = false;

export function isAborted(): boolean {
  return aborted;
}

export function clearAbort() {
  aborted = false;
}

export function setAbort(reason: string) {
  aborted = true;
  console.warn(`[rate-limiter] ABORT set: ${reason}`);
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
  // (2) Process-wide abort guard.
  if (aborted) {
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
    if (aborted) {
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
      const isAbort = aborted;

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
      // For 429 specifically, also surface as abort after the final retry —
      // long-running pipelines should stop burning quota.
      if (attempt === maxRetries - 1 && is429) {
        setAbort(`429 after ${maxRetries} retries on '${label}'`);
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
  if (aborted) {
    throw new RateLimitAbortedError(`pre-flight: abort flag set for '${label}'`);
  }
}
