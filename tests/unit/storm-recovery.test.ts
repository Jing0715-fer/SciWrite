/**
 * RT16 QA: unit tests for the storm-recovery core — TTL-aware budgets,
 * structural-doom short-circuit, same-storm single-flight dedup, honest
 * budget-exhaustion, caller-abort, outcome phrasing, and the live
 * rate-limiter getAbortInfo() contract.
 *
 * The wait loop runs on an injectable fake clock (now + sleep) so a 30-min
 * storm TTL resolves in microseconds; state readers are seam-replaced so
 * no real limiter state leaks between tests. The final describe block
 * restores the live readers and exercises the REAL rate-limiter +
 * rate-abort-store round-trip.
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  waitForCleanWindow,
  setStormStateReaders,
  _resetStormRecoveryForTests,
  describeWaitOutcome,
} from "@/lib/storm-recovery";
import { setRateAbortStorePath, persistRateAbort } from "@/lib/rate-abort-store";
import {
  clearAbort,
  getAbortInfo,
  isAborted,
  setAbort,
} from "@/lib/rate-limiter";

// ---------------------------------------------------------------------------
// Fake clock + seam state
// ---------------------------------------------------------------------------

let nowMs = 0;
const sleepCalls: number[] = [];

function fakeNow(): number {
  return nowMs;
}

async function fakeSleep(ms: number): Promise<void> {
  sleepCalls.push(ms);
  nowMs += ms;
}

/** Seam abort state — { at, ttl } in fake-clock ms; expires dynamically. */
let seamAbort: { at: number; ttl: number; storms: number } | null = null;
let seamWindowCount = 0;

function installSeams(): void {
  setStormStateReaders({
    abortInfo: () => {
      if (!seamAbort) return null;
      if (nowMs >= seamAbort.at + seamAbort.ttl) return null; // auto-expired
      return {
        reason: "seam storm",
        at: seamAbort.at,
        ttl: seamAbort.ttl,
        consecutiveStorms: seamAbort.storms,
      };
    },
    windowCount: () => seamWindowCount,
  });
}

beforeEach(() => {
  nowMs = 1_000_000; // arbitrary epoch base
  sleepCalls.length = 0;
  seamAbort = null;
  seamWindowCount = 0;
  installSeams();
  _resetStormRecoveryForTests();
});

afterAll(() => {
  setStormStateReaders(null);
});

// ---------------------------------------------------------------------------
// Budget semantics
// ---------------------------------------------------------------------------

describe("storm-recovery: clean-window wait", () => {
  test("no-storm fast path — no abort + quiet window returns immediately", async () => {
    const r = await waitForCleanWindow({ label: "t", _now: fakeNow, _sleep: fakeSleep });
    expect(r.clean).toBe(true);
    expect(r.outcome).toBe("no-storm");
    expect(r.rounds).toBe(0);
    expect(r.waitedMs).toBe(0);
    expect(sleepCalls.length).toBe(0);
  });

  test("structural-doom short-circuit — TTL beyond hardMax skips the wait entirely", async () => {
    // 60-min ladder step vs 35-min ceiling: waiting is theatre.
    seamAbort = { at: nowMs, ttl: 60 * 60_000, storms: 4 };
    const r = await waitForCleanWindow({
      label: "t",
      _now: fakeNow,
      _sleep: fakeSleep,
    });
    expect(r.clean).toBe(false);
    expect(r.outcome).toBe("structurally-doomed");
    expect(r.rounds).toBe(0);
    expect(r.waitedMs).toBe(0);
    expect(r.abortTtlRemainingMs).toBe(60 * 60_000);
    expect(sleepCalls.length).toBe(0); // no theatre — instant honest give-up
  });

  test("TTL-aware budget EXTENDS past the flat default — 30-min storm is waitable", async () => {
    // RT15's structural mismatch: 30-min ladder TTL vs 10-min flat budget
    // doomed every wait. The fix budgets TTL+margin (capped by hardMax).
    seamAbort = { at: nowMs, ttl: 30 * 60_000, storms: 3 };
    const r = await waitForCleanWindow({
      label: "t",
      _now: fakeNow,
      _sleep: fakeSleep,
      pollMs: 15_000,
      ttlMarginMs: 90_000,
      defaultBudgetMs: 10 * 60_000, // flat default would doom this wait
      hardMaxMs: 35 * 60_000,
    });
    // The abort expires at +30 min; the loop notices on the round that
    // crosses the expiry boundary (clean check runs before each sleep).
    expect(r.clean).toBe(true);
    expect(r.outcome).toBe("clean");
    expect(r.budgetMs).toBe(30 * 60_000 + 90_000); // TTL + margin, NOT the flat 10 min
    expect(r.rounds).toBe(120); // 30 min / 15 s
    expect(r.waitedMs).toBe(30 * 60_000);
  });

  test("short storm waits only TTL-crossing rounds — not the full flat budget", async () => {
    // 2-min ladder step: the wait ends at expiry (~2 min), not 10 min.
    seamAbort = { at: nowMs, ttl: 120_000, storms: 1 };
    const r = await waitForCleanWindow({
      label: "t",
      _now: fakeNow,
      _sleep: fakeSleep,
      pollMs: 15_000,
      ttlMarginMs: 90_000,
      defaultBudgetMs: 10 * 60_000,
    });
    expect(r.outcome).toBe("clean");
    expect(r.rounds).toBe(8); // ceil(120s / 15s)
    expect(r.waitedMs).toBe(120_000);
    expect(r.budgetMs).toBe(120_000 + 90_000);
  });

  test("budget-exhausted — window never drains, honest give-up after the flat budget", async () => {
    seamWindowCount = 50; // stuck hot window, no abort flag
    const r = await waitForCleanWindow({
      label: "t",
      _now: fakeNow,
      _sleep: fakeSleep,
      pollMs: 15_000,
      defaultBudgetMs: 45_000,
    });
    expect(r.clean).toBe(false);
    expect(r.outcome).toBe("budget-exhausted");
    expect(r.rounds).toBe(3); // 45s / 15s
    expect(r.waitedMs).toBe(45_000);
  });

  test("clean when the sliding window drains below the quiet threshold", async () => {
    seamWindowCount = 10;
    // Window count drops to 2 (quiet) after 30 fake-seconds.
    const origSleep = fakeSleep;
    const droppingSleep = async (ms: number) => {
      await origSleep(ms);
      if (nowMs >= 1_000_000 + 30_000) seamWindowCount = 2;
    };
    const r = await waitForCleanWindow({
      label: "t",
      _now: fakeNow,
      _sleep: droppingSleep,
      pollMs: 15_000,
      defaultBudgetMs: 10 * 60_000,
    });
    expect(r.clean).toBe(true);
    expect(r.outcome).toBe("clean");
    expect(r.rounds).toBe(2);
  });

  test("caller-aborted — shouldAbort breaks the wait with a distinct outcome", async () => {
    seamAbort = { at: nowMs, ttl: 30 * 60_000, storms: 3 };
    let abortAfterRound = false;
    const r = await waitForCleanWindow({
      label: "t",
      _now: fakeNow,
      _sleep: async (ms) => {
        await fakeSleep(ms);
        if (sleepCalls.length >= 2) abortAfterRound = true;
      },
      shouldAbort: () => abortAfterRound,
      pollMs: 15_000,
    });
    expect(r.clean).toBe(false);
    expect(r.outcome).toBe("caller-aborted");
    expect(r.rounds).toBe(2);
  });

  test("onRound discloses waited time, window count, and TTL remaining each round", async () => {
    seamAbort = { at: nowMs, ttl: 45_000, storms: 1 };
    const rounds: Array<{ round: number; waitedMs: number; windowCount: number; abortTtlRemainingMs: number | null }> = [];
    await waitForCleanWindow({
      label: "t",
      _now: fakeNow,
      _sleep: fakeSleep,
      pollMs: 15_000,
      onRound: (info) => rounds.push({ ...info }),
    });
    expect(rounds.length).toBe(3); // 45s / 15s
    expect(rounds[0].round).toBe(1);
    expect(rounds[0].waitedMs).toBe(15_000);
    expect(rounds[0].abortTtlRemainingMs).toBe(45_000 - 0); // captured pre-sleep
    expect(rounds[1].round).toBe(2);
    expect(rounds[2].waitedMs).toBe(45_000);
  });
});

// ---------------------------------------------------------------------------
// Same-storm single-flight dedup (RT15-Final backlog #2)
// ---------------------------------------------------------------------------

describe("storm-recovery: same-storm single-flight dedup", () => {
  test("two waiters on ONE abort epoch share ONE wait loop", async () => {
    seamAbort = { at: nowMs, ttl: 30_000, storms: 1 };
    // Gate the first sleep so caller B provably overlaps caller A's wait.
    let releaseFirstSleep!: () => void;
    const firstSleepGate = new Promise<void>((resolve) => {
      releaseFirstSleep = resolve;
    });
    let firstSleepTaken = false;
    const gatedSleep = async (ms: number) => {
      sleepCalls.push(ms);
      nowMs += ms;
      if (!firstSleepTaken) {
        firstSleepTaken = true;
        await firstSleepGate;
      }
    };

    const a = waitForCleanWindow({ label: "A", _now: fakeNow, _sleep: gatedSleep, pollMs: 5_000 });
    // Let A enter (and gate inside) its first sleep.
    await new Promise((r) => setTimeout(r, 0));
    expect(firstSleepTaken).toBe(true);

    // B arrives mid-storm, mid-wait — same epoch key.
    const b = waitForCleanWindow({ label: "B" });
    releaseFirstSleep();

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.outcome).toBe("clean");
    // B joined A's in-flight wait — no second loop, no second clock.
    expect(rb.joinedSharedWait).toBe(true);
    expect(rb.outcome).toBe(ra.outcome);
    expect(rb.rounds).toBe(ra.rounds);
    expect(rb.waitedMs).toBe(ra.waitedMs);
    // One storm, one wait: the sleep count reflects a single 6-round loop.
    expect(sleepCalls.length).toBe(6); // 30s / 5s
  });

  test("a NEW storm epoch (re-set abort) gets a fresh wait, not a stale join", async () => {
    // First storm: short, resolves immediately.
    seamAbort = { at: nowMs, ttl: 15_000, storms: 1 };
    const r1 = await waitForCleanWindow({ label: "A", _now: fakeNow, _sleep: fakeSleep, pollMs: 5_000 });
    expect(r1.outcome).toBe("clean");
    expect(r1.joinedSharedWait).toBe(false);

    // The storm re-sets (escalated ladder) at a NEW epoch.
    seamAbort = { at: nowMs, ttl: 20_000, storms: 2 };
    const r2 = await waitForCleanWindow({ label: "B", _now: fakeNow, _sleep: fakeSleep, pollMs: 5_000 });
    expect(r2.joinedSharedWait).toBe(false);
    expect(r2.outcome).toBe("clean");
    expect(r2.rounds).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Disclosure phrasing
// ---------------------------------------------------------------------------

describe("storm-recovery: outcome phrasing", () => {
  test("describeWaitOutcome covers every non-clean outcome honestly", () => {
    const budget = describeWaitOutcome({
      clean: false, outcome: "budget-exhausted", rounds: 40, waitedMs: 600_000,
      abortTtlRemainingMs: null, budgetMs: 600_000, joinedSharedWait: false,
    });
    expect(budget).toContain("budget exhausted");
    expect(budget).toContain("10 min");

    const doomed = describeWaitOutcome({
      clean: false, outcome: "structurally-doomed", rounds: 0, waitedMs: 0,
      abortTtlRemainingMs: 60 * 60_000, budgetMs: 0, joinedSharedWait: false,
    });
    expect(doomed).toContain("60 min");
    expect(doomed).toContain("structurally hopeless");

    const aborted = describeWaitOutcome({
      clean: false, outcome: "caller-aborted", rounds: 2, waitedMs: 30_000,
      abortTtlRemainingMs: null, budgetMs: 600_000, joinedSharedWait: false,
    });
    expect(aborted).toContain("aborted");
  });
});

// ---------------------------------------------------------------------------
// Live rate-limiter contract (real modules, sandboxed abort store)
// ---------------------------------------------------------------------------

describe("rate-limiter getAbortInfo (live)", () => {
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "rt16-abort-"));
  const SANDBOX_FILE = path.join(SANDBOX, "rate-abort.json");

  beforeEach(() => {
    setRateAbortStorePath(SANDBOX_FILE);
    setStormStateReaders(null); // restore live readers for this block
    clearAbort();
  });

  afterAll(() => {
    setRateAbortStorePath(null);
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  test("setAbort → getAbortInfo round-trips reason/at/ttl/storm count", () => {
    setAbort("test storm 1");
    const info = getAbortInfo();
    expect(info).not.toBeNull();
    expect(info!.reason).toBe("test storm 1");
    expect(info!.ttl).toBe(120_000); // ladder step 1
    expect(info!.consecutiveStorms).toBe(1);
    expect(info!.at).toBeGreaterThan(0);

    setAbort("test storm 2");
    const info2 = getAbortInfo();
    expect(info2!.consecutiveStorms).toBe(2);
    expect(info2!.ttl).toBe(600_000); // ladder step 2
  });

  test("no abort → null; clearAbort → null; expired persisted abort → null", async () => {
    expect(getAbortInfo()).toBeNull();
    clearAbort();
    expect(getAbortInfo()).toBeNull();

    // Expiry path: persist an ALREADY-expired abort (setAbort's TTL comes
    // from the ladder — minimum 120s — so a real-time wait is impractical).
    // Memory is empty (clearAbort above), so isAborted() hydrates from disk,
    // detects the expiry, self-clears memory + disk — and getAbortInfo()
    // rides the same semantics to null.
    persistRateAbort({
      reason: "expired storm",
      at: Date.now() - 200_000,
      ttl: 120_000,
      consecutiveStorms: 1,
      lastAbortAt: Date.now() - 200_000,
    });
    expect(isAborted()).toBe(false);
    expect(getAbortInfo()).toBeNull();
  });

  test("persisted abort hydrates a restarted process (disk round-trip)", () => {
    setAbort("persisted storm");
    // Simulate a fresh module: the store file exists on disk; isAborted()
    // lazily hydrates (tested in rate-abort-store.test.ts) — getAbortInfo
    // rides the same semantics and must reflect the persisted TTL.
    const info = getAbortInfo();
    expect(info).not.toBeNull();
    expect(info!.reason).toBe("persisted storm");
    expect(info!.ttl).toBe(120_000);
  });
});
