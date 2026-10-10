/**
 * File-backed persistence for the rate-limiter abort state (RT4 P0-1).
 *
 * Problem it fixes: the abort flag (and the escalating storm ladder) lived
 * only in module memory — a dev-server restart FORGOT an active quota storm
 * and immediately re-probed the provider with a fresh 5-attempt backoff
 * chain, re-triggering the account-level 429 (client-side storm
 * persistence). The 2026-10-10 E2E absorbed two such storms.
 *
 * Design:
 *  - Tiny JSON file (default `<cwd>/db/rate-abort.json`, env-overridable via
 *    RATE_ABORT_STORE_PATH, test-injectable via setRateAbortStorePath).
 *  - `loadRateAbort()` / `persistRateAbort()` are fully fault-tolerant:
 *    a read-only FS or a corrupt file degrades to "no persisted state"
 *    (never throws — the limiter must not brick on a telemetry file).
 *  - Writes are best-effort; `persistRateAbort(null)` removes the file so a
 *    clean state leaves no stale marker behind.
 */

import fs from "fs";
import path from "path";

export interface PersistedRateAbort {
  reason: string;
  /** epoch ms when the abort was set */
  at: number;
  /** ttl ms — abort auto-expires after at + ttl */
  ttl: number;
  /** consecutive-storm counter for the escalating TTL ladder */
  consecutiveStorms: number;
  /** epoch ms of the last abort (de-escalation reference) */
  lastAbortAt: number;
}

let overridePath: string | null = null;

/** Test hook: point the store at a sandbox path (null = default). */
export function setRateAbortStorePath(p: string | null): void {
  overridePath = p;
}

export function rateAbortStorePath(): string {
  if (overridePath) return overridePath;
  const env = process.env.RATE_ABORT_STORE_PATH;
  if (env) return env;
  return path.join(process.cwd(), "db", "rate-abort.json");
}

/**
 * Load the persisted abort state. Returns null when absent, corrupt, or
 * unreadable — callers treat null as "no storm memory".
 */
export function loadRateAbort(): PersistedRateAbort | null {
  try {
    const p = rateAbortStorePath();
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    if (
      typeof raw?.reason === "string" &&
      typeof raw?.at === "number" &&
      Number.isFinite(raw.at) &&
      typeof raw?.ttl === "number" &&
      Number.isFinite(raw.ttl) &&
      raw.ttl > 0
    ) {
      return {
        reason: raw.reason,
        at: raw.at,
        ttl: raw.ttl,
        consecutiveStorms:
          typeof raw.consecutiveStorms === "number" && Number.isFinite(raw.consecutiveStorms)
            ? Math.max(0, Math.floor(raw.consecutiveStorms))
            : 0,
        lastAbortAt:
          typeof raw.lastAbortAt === "number" && Number.isFinite(raw.lastAbortAt)
            ? raw.lastAbortAt
            : raw.at,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist the abort state (or clear it — `null` removes the file).
 * Best-effort: a failure is logged and swallowed.
 */
export function persistRateAbort(info: PersistedRateAbort | null): void {
  try {
    const p = rateAbortStorePath();
    if (info === null) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* already gone / unreadable — fine */
      }
      return;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(info));
  } catch (e) {
    console.warn("[rate-abort-store] persist failed (continuing in-memory only):", e);
  }
}
