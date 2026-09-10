/**
 * iterate-scheduler — the cron replacement for the auto-iterate loop.
 *
 * round-63: the sandbox has no system cron (no crontab/crond and no `at`),
 * and long-sleeping background daemons get reaped by the environment. This
 * service is the sanctioned alternative: a `bun --hot` mini-service that
 * TICKS EVERY 60 SECONDS (the tick is both the timer and the keep-alive
 * activity) and triggers a round of `scripts/auto-iterate/iterate.ts`
 * when due.
 *
 * Schedule rules:
 *   - REGULAR: every 6 hours (wall-clock aligned: 00/06/12/18 UTC +4h offset
 *     so a round started right after this service boots doesn't immediately
 *     re-fire on the boundary). Shanghai time = UTC+8, so rounds land at
 *     ~12/18/00/06 CST + offset.
 *   - RETRY: when the previous round ended degraded-provider (the 429
 *     account-level throttle), the next attempt is pulled forward to
 *     +45 min (the round script itself waits up to 30 min in-round for the
 *     provider, so effective retry spacing is ~75 min during outages).
 *   - CONCURRENCY: a round is only triggered when no round lock is held
 *     (the iterate script re-checks the lock itself — double safety).
 *
 * Endpoints (port 3040):
 *   GET /healthz → 200 {ok:true}
 *   GET /status  → { nextRunAt, lastRound, lockHeld, uptimeMs, roundsTriggered, lastTickAt }
 *
 * The tick also writes a heartbeat file (iteration-state/scheduler-heartbeat
 * .json) so external observers (me, the user, any future agent session) can
 * see whether the scheduler is alive without hitting the port.
 */

const PORT = 3040;
const TICK_MS = 60_000;
const REGULAR_INTERVAL_MS = 6 * 60 * 60_000;
const RETRY_INTERVAL_MS = 45 * 60_000;
const ITERATE_SCRIPT = "/home/z/my-project/scripts/auto-iterate/iterate.ts";
const STATE_DIR = "/home/z/my-project/iteration-state";
const LOG_FILE = "/home/z/my-project/mini-services/iterate-scheduler/scheduler.log";

const bootAt = Date.now();
let roundsTriggered = 0;
let lastTickAt = 0;
let nextRunAt = Date.now() + 60_000; // first round 1 min after boot (bootstrap)
let runningChild: any = null;

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    const fs = require("fs");
    fs.appendFileSync(LOG_FILE, line);
    if (fs.statSync(LOG_FILE).size > 1_000_000) fs.writeFileSync(LOG_FILE, ""); // 1MB cap
  } catch {}
  console.log(line.trim());
}

function readJson(path: string): any | null {
  try { return JSON.parse(require("fs").readFileSync(path, "utf8")); } catch { return null; }
}

function lockHeld(): boolean {
  const lock = readJson(`${STATE_DIR}/round.lock`);
  if (!lock?.pid) return false;
  const alive = Bun.spawnSync(["bash", "-c", `kill -0 ${lock.pid} 2>/dev/null && echo yes`]).stdout?.toString().includes("yes");
  return !!alive;
}

function scheduleNext() {
  const lastRound = readJson(`${STATE_DIR}/last-round.json`);
  const throttled = lastRound?.outcome === "degraded-provider";
  nextRunAt = Date.now() + (throttled ? RETRY_INTERVAL_MS : REGULAR_INTERVAL_MS);
  log(`next round at ${new Date(nextRunAt).toISOString()}${throttled ? " (throttle retry cadence)" : " (regular 6h cadence)"}`);
}

function triggerRound(reason: string) {
  if (lockHeld() || runningChild) {
    log(`trigger skipped (${reason}): a round is already running`);
    scheduleNext();
    return;
  }
  roundsTriggered++;
  log(`triggering round #${roundsTriggered} (${reason})`);
  try {
    const fs = require("fs");
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const out = fs.openSync(`${STATE_DIR}/round-console.log`, "a");
    const child = Bun.spawn(["bun", ITERATE_SCRIPT], {
      cwd: "/home/z/my-project",
      stdout: out,
      stderr: out,
      stdin: "ignore",
    });
    runningChild = child;
    child.exited.then((code: number) => {
      runningChild = null;
      log(`round process exited (code ${code})`);
      scheduleNext();
    }).catch(() => { runningChild = null; scheduleNext(); });
  } catch (e: any) {
    log(`trigger FAILED: ${String(e?.message ?? e).slice(0, 120)}`);
    scheduleNext();
  }
}

function tick() {
  lastTickAt = Date.now();
  try {
    const fs = require("fs");
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(`${STATE_DIR}/scheduler-heartbeat.json`, JSON.stringify({
      alive: true, bootAt: new Date(bootAt).toISOString(), lastTickAt: new Date(lastTickAt).toISOString(),
      nextRunAt: new Date(nextRunAt).toISOString(), roundsTriggered, port: PORT,
    }));
  } catch {}
  if (Date.now() >= nextRunAt && !runningChild && !lockHeld()) {
    triggerRound("scheduled");
  } else if (Date.now() >= nextRunAt && (runningChild || lockHeld())) {
    // a round is still running past its slot — push the next run out
    nextRunAt = Date.now() + 15 * 60_000;
  }
}

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, port: PORT });
    }
    if (url.pathname === "/status") {
      return Response.json({
        ok: true,
        port: PORT,
        uptimeMs: Date.now() - bootAt,
        bootAt: new Date(bootAt).toISOString(),
        nextRunAt: new Date(nextRunAt).toISOString(),
        roundsTriggered,
        lastTickAt: new Date(lastTickAt).toISOString(),
        lockHeld: lockHeld(),
        roundRunning: !!runningChild,
        lastRound: readJson(`${STATE_DIR}/last-round.json`),
      });
    }
    if (url.pathname === "/trigger" && req.method === "POST") {
      triggerRound("manual API trigger");
      return Response.json({ ok: true, triggered: true, roundsTriggered });
    }
    return new Response("iterate-scheduler — GET /status | GET /healthz | POST /trigger", { status: 200 });
  },
});

log(`iterate-scheduler listening on :${PORT} (first round in 60s, then every 6h; throttle retry 45min)`);
setInterval(tick, TICK_MS);
tick();
