/**
 * iterate-scheduler console — STATUS + MANUAL TRIGGER only.
 *
 * round-63 revision: the SCHEDULING role moved into the Next.js dev server
 * itself (src/instrumentation.ts — the sandbox reaps standalone background
 * processes after ~2h, but the dev server outlives them and every revival
 * of the app auto-revives the schedule). This service remains as the
 * human/agent console:
 *
 *   GET  /healthz → 200 {ok:true}
 *   GET  /status  → scheduler state, last round, lock, heartbeat
 *   POST /trigger → spawn a round NOW (the round script's lockfile is the
 *                   concurrency guard — a running round is never duplicated)
 *
 * Port 3040. Kept alive with a 60s heartbeat tick (also mirrors its liveness
 * into iteration-state/console-heartbeat.json).
 */

const PORT = 3040;
const STATE_DIR = "/home/z/my-project/iteration-state";
const ITERATE_SCRIPT = "/home/z/my-project/scripts/auto-iterate/iterate.ts";

function readJson(path: string): any | null {
  try { return JSON.parse(require("fs").readFileSync(path, "utf8")); } catch { return null; }
}

function lockHeld(): boolean {
  const lock = readJson(`${STATE_DIR}/round.lock`);
  if (!lock?.pid) return false;
  try { process.kill(lock.pid, 0); return true; } catch { return false; }
}

function triggerRound(): { triggered: boolean; note: string } {
  if (lockHeld()) return { triggered: false, note: "a round is already running (lock held)" };
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
    return { triggered: true, note: `round spawned (pid ${child.pid})` };
  } catch (e: any) {
    return { triggered: false, note: `spawn failed: ${String(e?.message ?? e).slice(0, 100)}` };
  }
}

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true, port: PORT });
    if (url.pathname === "/status") {
      return Response.json({
        ok: true,
        port: PORT,
        role: "console (scheduling lives in src/instrumentation.ts inside the dev server)",
        scheduler: readJson(`${STATE_DIR}/scheduler.json`),
        schedulerHeartbeat: readJson(`${STATE_DIR}/scheduler-heartbeat.json`),
        lastRound: readJson(`${STATE_DIR}/last-round.json`),
        lockHeld: lockHeld(),
        consoleHeartbeat: readJson(`${STATE_DIR}/console-heartbeat.json`),
      });
    }
    if (url.pathname === "/trigger" && req.method === "POST") {
      return Response.json({ ok: true, ...triggerRound() });
    }
    return new Response("iterate console — GET /status | GET /healthz | POST /trigger", { status: 200 });
  },
});

setInterval(() => {
  try {
    const fs = require("fs");
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(`${STATE_DIR}/console-heartbeat.json`, JSON.stringify({
      alive: true, lastTickAt: new Date().toISOString(), port: PORT,
    }));
  } catch {}
}, 60_000);

console.log(`[${new Date().toISOString()}] iterate console on :${PORT} (status/trigger only — scheduling is in-app via instrumentation.ts)`);
