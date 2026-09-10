
import { spawn as _spawn } from "child_process";
/** Sync child_process access — the round trigger runs in a non-async closure. */
function nodeChildProcess(): typeof import("child_process") {
  return { spawn: _spawn } as typeof import("child_process");
}

/**
 * Next.js instrumentation hook — the auto-iterate scheduler lives INSIDE the
 * dev server process.
 *
 * round-63: the standalone mini-service scheduler got reaped by the sandbox
 * ~2h after boot (the environment harvests background processes; the dev
 * server demonstrably outlives them, and any revival of the app — manual
 * `bun run dev`, the iterate script's own dev-server restart — now revives
 * the schedule automatically). This hook replaces the mini-service's
 * scheduling role:
 *
 *   - every 60s tick: heartbeat + due-check
 *   - REGULAR cadence: every 6h
 *   - RETRY cadence: 45 min while the last round ended degraded-provider
 *     (the 429 account-level throttle pattern of rounds 60/62/63)
 *   - CATCH-UP on boot: if the last round is >7h stale (the whole sandbox
 *     was reaped and revived), the first round fires 5 min after boot
 *   - CONCURRENCY: the round script's lockfile (PID + staleness) is the
 *     single source of truth — the mini-service console and manual triggers
 *     all funnel through the same guard
 *
 * The trigger spawns `bun scripts/auto-iterate/iterate.ts` DETACHED (stdout
 * → iteration-state/round-console.log) so a dev-server restart mid-round
 * never kills an in-flight round.
 */

const ITERATE_SCRIPT = "/home/z/my-project/scripts/auto-iterate/iterate.ts";
const STATE_DIR = "/home/z/my-project/iteration-state";
const SCHED_STATE_FILE = `${STATE_DIR}/scheduler.json`;
const TICK_MS = 60_000;
const REGULAR_MS = 6 * 60 * 60_000;
const RETRY_MS = 45 * 60_000;
const CATCHUP_STALE_MS = 7 * 60 * 60_000;
const BOOT_GRACE_MS = 5 * 60_000;

// eslint-disable-next-line @typescript-eslint/no-namespace
declare global {
  // eslint-disable-next-line no-var
  var __autoIterateScheduler: boolean | undefined;
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (globalThis.__autoIterateScheduler) return;
  globalThis.__autoIterateScheduler = true;

  const fs = await import("fs");
  const path = await import("path");

  const readJson = (p: string): any => {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
  };
  const writeJson = (p: string, v: any) => {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(v, null, 2));
    } catch {}
  };
  const log = (msg: string) => {
    const line = `[instrumentation-scheduler ${new Date().toISOString()}] ${msg}`;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.appendFileSync(`${STATE_DIR}/scheduler-console.log`, line + "\n");
    } catch {}
    console.log(line);
  };

  const lockHeld = (): boolean => {
    const lock = readJson(`${STATE_DIR}/round.lock`);
    if (!lock?.pid) return false;
    try { process.kill(lock.pid, 0); return true; } catch { return false; }
  };

  const schedState = readJson(SCHED_STATE_FILE) || { nextRunAt: 0, roundsTriggered: 0 };
  if (!schedState.nextRunAt) {
    // First boot (or state loss): catch-up check — a stale last-round means
    // the environment was down; fire soon. Otherwise regular cadence.
    const lastRound = readJson(`${STATE_DIR}/last-round.json`);
    const stale = !lastRound?.endedAt || Date.now() - new Date(lastRound.endedAt).getTime() > CATCHUP_STALE_MS;
    schedState.nextRunAt = Date.now() + (stale ? BOOT_GRACE_MS : REGULAR_MS);
    log(`boot: next round at ${new Date(schedState.nextRunAt).toISOString()}${stale ? " (catch-up: last round stale)" : ""}`);
  }

  const triggerRound = (reason: string) => {
    if (lockHeld()) { log(`trigger skipped (${reason}): round already running`); return; }
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const out = fs.openSync(`${STATE_DIR}/round-console.log`, "a");
      // child_process (not Bun.spawn) — the hook must work under any Node
      // runtime, and `detached` keeps an in-flight round alive across dev-
      // server restarts.
      const { spawn } = nodeChildProcess();
      const child = spawn("bun", [ITERATE_SCRIPT], {
        cwd: "/home/z/my-project",
        stdio: ["ignore", out, out],
        detached: true,
      });
      child.unref();
      schedState.roundsTriggered += 1;
      log(`round triggered (${reason}, pid ${child.pid})`);
    } catch (e: any) {
      log(`trigger FAILED: ${String(e?.message ?? e).slice(0, 100)}`);
    }
  };

  const tick = () => {
    const lastRound = readJson(`${STATE_DIR}/last-round.json`);
    if (Date.now() >= (schedState.nextRunAt || 0)) {
      if (lockHeld()) {
        schedState.nextRunAt = Date.now() + 15 * 60_000;
      } else {
        triggerRound("scheduled");
        const throttled = lastRound?.outcome === "degraded-provider";
        schedState.nextRunAt = Date.now() + (throttled ? RETRY_MS : REGULAR_MS);
      }
    }
    writeJson(SCHED_STATE_FILE, { ...schedState, lastTickAt: new Date().toISOString(), aliveSince: schedState.aliveSince || new Date().toISOString() });
    writeJson(`${STATE_DIR}/scheduler-heartbeat.json`, {
      alive: true,
      source: "instrumentation",
      lastTickAt: new Date().toISOString(),
      nextRunAt: new Date(schedState.nextRunAt).toISOString(),
      roundsTriggered: schedState.roundsTriggered,
    });
  };

  setInterval(tick, TICK_MS);
  tick();
}
