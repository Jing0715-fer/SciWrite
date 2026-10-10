/**
 * round-RT4 P0-1/P0-2 QA: unit tests for the persisted rate-abort store,
 * provider reset-hint parsing, and the abort-state persistence contract.
 *
 * Covers the contract from IMPROVEMENT_PLAN-RT4 P0-1:
 *  - store round-trip / corrupt-file / clear semantics (fault-tolerant)
 *  - parseRetryAfterMs: seconds, HTTP-date (future/past), X-RateLimit-Reset
 *    (epoch s and ms), >24h sanity cap, missing headers
 *  - setAbort writes through; isAborted() hydrates a "restarted" process
 *    from disk (restart amnesia fix); expiry clears the disk marker
 *  - TTL ladder + provider-hint extension (hints lengthen, never shorten)
 *  - clearAbort resets memory + ladder + file
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  loadRateAbort,
  persistRateAbort,
  rateAbortStorePath,
  setRateAbortStorePath,
} from "@/lib/rate-abort-store";
import {
  clearAbort,
  isAborted,
  parseRetryAfterMs,
  setAbort,
  SLIDING_WINDOW_THRESHOLD,
} from "@/lib/rate-limiter";

// ---------------------------------------------------------------------------
// Sandbox: every test writes to a throwaway file, never the real
// db/rate-abort.json, and the limiter's module state is reset between tests.
// ---------------------------------------------------------------------------

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "rt4-abort-"));
const SANDBOX_FILE = path.join(SANDBOX, "rate-abort.json");

function headers(obj: Record<string, string>): { get(name: string): string | null } {
  return {
    get(name: string): string | null {
      for (const k of Object.keys(obj)) {
        if (k.toLowerCase() === name.toLowerCase()) return obj[k];
      }
      return null;
    },
  };
}

beforeEach(() => {
  setRateAbortStorePath(SANDBOX_FILE);
  clearAbort();
});

afterAll(() => {
  setRateAbortStorePath(null);
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// Store layer
// ---------------------------------------------------------------------------

describe("rate-abort-store", () => {
  test("load returns null when no file exists", () => {
    expect(loadRateAbort()).toBeNull();
  });

  test("persist + load round-trips all fields", () => {
    persistRateAbort({
      reason: "429 after 5 retries on 'chat'",
      at: 1_000,
      ttl: 600_000,
      consecutiveStorms: 2,
      lastAbortAt: 1_000,
    });
    const loaded = loadRateAbort();
    expect(loaded).not.toBeNull();
    expect(loaded!.reason).toBe("429 after 5 retries on 'chat'");
    expect(loaded!.at).toBe(1_000);
    expect(loaded!.ttl).toBe(600_000);
    expect(loaded!.consecutiveStorms).toBe(2);
    expect(loaded!.lastAbortAt).toBe(1_000);
  });

  test("persist(null) removes the file", () => {
    persistRateAbort({ reason: "x", at: 1, ttl: 1000, consecutiveStorms: 1, lastAbortAt: 1 });
    expect(fs.existsSync(SANDBOX_FILE)).toBe(true);
    persistRateAbort(null);
    expect(fs.existsSync(SANDBOX_FILE)).toBe(false);
    expect(loadRateAbort()).toBeNull();
  });

  test("corrupt JSON degrades to null (never throws)", () => {
    fs.writeFileSync(SANDBOX_FILE, "{not json!!");
    expect(loadRateAbort()).toBeNull();
  });

  test("wrong-typed / missing fields are rejected", () => {
    fs.writeFileSync(SANDBOX_FILE, JSON.stringify({ reason: 42, at: "1", ttl: 1000 }));
    expect(loadRateAbort()).toBeNull();
    fs.writeFileSync(SANDBOX_FILE, JSON.stringify({ reason: "ok" }));
    expect(loadRateAbort()).toBeNull();
    // ttl must be positive + finite
    fs.writeFileSync(SANDBOX_FILE, JSON.stringify({ reason: "ok", at: 1, ttl: -5 }));
    expect(loadRateAbort()).toBeNull();
  });

  test("defaults repair absent ladder fields (consecutiveStorms/lastAbortAt)", () => {
    fs.writeFileSync(SANDBOX_FILE, JSON.stringify({ reason: "ok", at: 1234, ttl: 60_000 }));
    const loaded = loadRateAbort();
    expect(loaded!.consecutiveStorms).toBe(0);
    expect(loaded!.lastAbortAt).toBe(1234);
  });

  test("setRateAbortStorePath injection changes the target file", () => {
    const other = path.join(SANDBOX, "other.json");
    setRateAbortStorePath(other);
    expect(rateAbortStorePath()).toBe(other);
    persistRateAbort({ reason: "y", at: 5, ttl: 5000, consecutiveStorms: 0, lastAbortAt: 5 });
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(SANDBOX_FILE)).toBe(false);
    setRateAbortStorePath(SANDBOX_FILE);
  });

  test("persist creates parent directories on demand", () => {
    const nested = path.join(SANDBOX, "a", "b", "c", "abort.json");
    setRateAbortStorePath(nested);
    persistRateAbort({ reason: "z", at: 7, ttl: 7000, consecutiveStorms: 0, lastAbortAt: 7 });
    expect(fs.existsSync(nested)).toBe(true);
    setRateAbortStorePath(SANDBOX_FILE);
  });
});

// ---------------------------------------------------------------------------
// parseRetryAfterMs
// ---------------------------------------------------------------------------

describe("parseRetryAfterMs", () => {
  test("null / non-header-like input → null", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs({} as any)).toBeNull();
  });

  test("no relevant headers → null", () => {
    expect(parseRetryAfterMs(headers({ "content-type": "application/json" }))).toBeNull();
  });

  test("Retry-After in seconds", () => {
    expect(parseRetryAfterMs(headers({ "Retry-After": "30" }))).toBe(30_000);
    expect(parseRetryAfterMs(headers({ "retry-after": "900" }))).toBe(900_000);
  });

  test("Retry-After as future HTTP-date", () => {
    const future = new Date(Date.now() + 5 * 60_000).toUTCString();
    const ms = parseRetryAfterMs(headers({ "Retry-After": future }));
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(4 * 60_000);
    expect(ms!).toBeLessThan(6 * 60_000);
  });

  test("Retry-After as PAST HTTP-date → null (already reset)", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(headers({ "Retry-After": past }))).toBeNull();
  });

  test("X-RateLimit-Reset epoch-seconds", () => {
    const reset = Math.floor(Date.now() / 1000) + 120; // +2 min
    const ms = parseRetryAfterMs(headers({ "X-RateLimit-Reset": String(reset) }));
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(110_000);
    expect(ms!).toBeLessThan(130_000);
  });

  test("X-RateLimit-Reset epoch-milliseconds", () => {
    const reset = Date.now() + 120_000; // +2 min in ms
    const ms = parseRetryAfterMs(headers({ "X-RateLimit-Reset": String(reset) }));
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(110_000);
    expect(ms!).toBeLessThan(130_000);
  });

  test("absurd >24h hints are ignored (sanity cap)", () => {
    expect(parseRetryAfterMs(headers({ "Retry-After": "999999" }))).toBeNull();
    const far = new Date(Date.now() + 48 * 3600_000).toUTCString();
    expect(parseRetryAfterMs(headers({ "Retry-After": far }))).toBeNull();
  });

  test("non-numeric garbage → null", () => {
    expect(parseRetryAfterMs(headers({ "Retry-After": "soon" }))).toBeNull();
    expect(parseRetryAfterMs(headers({ "X-RateLimit-Reset": "later" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Limiter integration: persistence write-through + restart hydration
// ---------------------------------------------------------------------------

describe("rate-limiter abort persistence", () => {
  test("SLIDING_WINDOW_THRESHOLD is 20 (matches the window)", () => {
    expect(SLIDING_WINDOW_THRESHOLD).toBe(20);
  });

  test("setAbort writes through to the store; isAborted() true", () => {
    setAbort("429 storm test");
    expect(isAborted()).toBe(true);
    const persisted = loadRateAbort();
    expect(persisted).not.toBeNull();
    expect(persisted!.reason).toBe("429 storm test");
    expect(persisted!.ttl).toBe(120_000); // ladder step 0
    expect(persisted!.consecutiveStorms).toBe(1);
  });

  test("RESTART AMNESIA FIX: a fresh memory hydrates from disk", () => {
    // Simulate a crashed/restarted process: memory empty (clearAbort clears
    // both), but the previous process left a live storm on disk.
    clearAbort(); // memory + file clear — start from a known-clean slate
    persistRateAbort({
      reason: "429 after 5 retries on 'chat'",
      at: Date.now(),
      ttl: 600_000,
      consecutiveStorms: 2,
      lastAbortAt: Date.now(),
    });
    // Memory is empty (clearAbort ran) — isAborted() must hydrate from disk.
    expect(isAborted()).toBe(true);
    // And the ladder level survived the restart:
    setAbort("second storm after restart");
    const persisted = loadRateAbort();
    expect(persisted!.consecutiveStorms).toBe(3); // 2 restored + 1 new
    expect(persisted!.ttl).toBe(1_800_000); // ladder step 2 (30 min)
  });

  test("an EXPIRED persisted abort self-clears and removes the file", () => {
    persistRateAbort({
      reason: "stale storm",
      at: Date.now() - 700_000, // set 700s ago…
      ttl: 600_000, // …with a 600s ttl → expired
      consecutiveStorms: 1,
      lastAbortAt: Date.now() - 700_000,
    });
    expect(isAborted()).toBe(false);
    expect(fs.existsSync(SANDBOX_FILE)).toBe(false); // disk marker removed
  });

  test("provider hint LENGTHENS the TTL beyond the ladder step", () => {
    setAbort("429 with Retry-After", 900_000); // 15 min > 2 min step 0
    expect(isAborted()).toBe(true);
    expect(loadRateAbort()!.ttl).toBe(900_000);
  });

  test("provider hint NEVER SHORTENS the TTL (ladder wins when longer)", () => {
    // Two aborts put the ladder at step 1 (10 min) for the NEXT call.
    setAbort("storm A");
    setAbort("storm B"); // consecutiveStorms = 2 → next step index 2
    expect(loadRateAbort()!.ttl).toBe(600_000);
    // Storm C: ladder step 2 (30 min) vs a 1-min hint → hint ignored,
    // TTL stays on the ladder, NOT on the hint.
    setAbort("storm C with a weak hint", 60_000);
    expect(loadRateAbort()!.ttl).toBe(1_800_000);
  });

  test("hint is capped at 24h", () => {
    setAbort("huge hint", 48 * 3600_000);
    expect(loadRateAbort()!.ttl).toBe(24 * 3600_000);
  });

  test("TTL ladder escalates 2min → 10min → 30min → 60min (capped)", () => {
    setAbort("s1");
    expect(loadRateAbort()!.ttl).toBe(120_000);
    setAbort("s2");
    expect(loadRateAbort()!.ttl).toBe(600_000);
    setAbort("s3");
    expect(loadRateAbort()!.ttl).toBe(1_800_000);
    setAbort("s4");
    expect(loadRateAbort()!.ttl).toBe(3_600_000);
    setAbort("s5"); // capped at the last step
    expect(loadRateAbort()!.ttl).toBe(3_600_000);
  });

  test("clearAbort resets memory, ladder AND file", () => {
    setAbort("s1");
    setAbort("s2");
    expect(fs.existsSync(SANDBOX_FILE)).toBe(true);
    clearAbort();
    expect(isAborted()).toBe(false);
    expect(fs.existsSync(SANDBOX_FILE)).toBe(false);
    // Ladder reset: the next abort starts at step 0 again.
    setAbort("fresh start");
    expect(loadRateAbort()!.ttl).toBe(120_000);
  });
});
