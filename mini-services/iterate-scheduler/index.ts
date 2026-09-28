/**
 * iterate-scheduler console — STATUS + MANUAL TRIGGER + DEV-SERVER KEEPALIVE.
 *
 * round-63 revision: the SCHEDULING role moved into the Next.js dev server
 * itself (src/instrumentation.ts — the sandbox reaps standalone background
 * processes after ~2h, but the dev server outlives them and every revival
 * of the app auto-revives the schedule). This service remains as the
 * human/agent console:
 *
 *   GET  /healthz → 200 {ok:true}
 *   GET  /status  → scheduler state, last round, lock, heartbeat, keepalive
 *   POST /trigger → spawn a round NOW (the round script's lockfile is the
 *                   concurrency guard — a running round is never duplicated)
 *
 * round-cs-4 (dev-server keepalive): the kernel OOM-killer murdered
 * next-server twice in one day mid-pipeline (anon-rss ~2GB on a 3.9GB box),
 * leaving the preview dead until a human restarted it. This console now
 * probes port 3000 with a raw TCP connect every 30s (no HTTP → no route
 * compile cost); after 2 consecutive failed probes it relaunches
 * `bun run dev` detached, with a 60s restart backoff and a 5-per-rolling-hour
 * cap so a broken state can never fork-loop. Every event is mirrored into
 * iteration-state/keepalive.json and dev-keepalive.log.
 *
 * Port 3040. Kept alive with a 60s heartbeat tick (also mirrors its liveness
 * into iteration-state/console-heartbeat.json).
 */

import fs from "fs";
import net from "node:net";

const PORT = 3040;
const STATE_DIR = "/home/z/my-project/iteration-state";
const ITERATE_SCRIPT = "/home/z/my-project/scripts/auto-iterate/iterate.ts";
const DEV_DIR = "/home/z/my-project";
const DEV_PORT = 3000;
const KEEPALIVE_LOG = `${STATE_DIR}/dev-keepalive.log`;
const KEEPALIVE_STATE = `${STATE_DIR}/keepalive.json`;

function readJson(path: string): any | null {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return null; }
}

function logKeepalive(msg: string) {
  const line = `[${new Date().toISOString()}] dev-keepalive] ${msg}\n`;
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(KEEPALIVE_LOG, line); } catch {}
  try { console.log(line.trim()); } catch {}
}

/** Raw TCP connect probe — distinguishes "port listening" from "process
 * dead" without issuing an HTTP request (which would trigger route
 * compilation costs on a cold dev server). */
function probePort(port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.once("close", () => finish(false));
  });
}

// ---- keepalive state (in-memory + mirrored for /status) ----
const keepalive = {
  lastProbeAt: null as string | null,
  lastProbeOk: null as boolean | null,
  consecutiveFailures: 0,
  restarts: [] as string[], // ISO timestamps of restarts (rolling 1h window)
  lastRestartAt: null as string | null,
  lastError: null as string | null,
};

function mirrorKeepalive() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const cutoff = Date.now() - 3_600_000;
    keepalive.restarts = keepalive.restarts.filter((t) => new Date(t).getTime() > cutoff);
    fs.writeFileSync(KEEPALIVE_STATE, JSON.stringify(keepalive, null, 2));
  } catch {}
}

async function restartDevServer(reason: string) {
  const cutoff = Date.now() - 3_600_000;
  keepalive.restarts = keepalive.restarts.filter((t) => new Date(t).getTime() > cutoff);
  if (keepalive.restarts.length >= 5) {
    keepalive.lastError = "restart cap reached (5/hour) — not relaunching";
    logKeepalive(`NOT relaunching (${reason}): hourly cap of 5 restarts reached`);
    mirrorKeepalive();
    return;
  }
  // Double-check: something may have bound the port between probe and now.
  if (await probePort(DEV_PORT)) {
    keepalive.consecutiveFailures = 0;
    logKeepalive(`port ${DEV_PORT} came back before relaunch — skipping (was: ${reason})`);
    mirrorKeepalive();
    return;
  }
  logKeepalive(`dev server down (${reason}) — relaunching \`bun run dev\``);
  try {
    const out = fs.openSync(KEEPALIVE_LOG, "a");
    Bun.spawn(["bun", "run", "dev"], {
      cwd: DEV_DIR,
      stdout: out,
      stderr: out,
      stdin: "ignore",
    });
    keepalive.restarts.push(new Date().toISOString());
    keepalive.lastRestartAt = new Date().toISOString();
    keepalive.lastError = null;
    keepalive.consecutiveFailures = 0;
  } catch (e: any) {
    keepalive.lastError = String(e?.message ?? e).slice(0, 120);
    logKeepalive(`relaunch FAILED: ${keepalive.lastError}`);
  }
  mirrorKeepalive();
}

// Probe loop: every 30s; relaunch after 2 consecutive failures with a 60s
// backoff between attempts.
let lastRestartAttempt = 0;
setInterval(async () => {
  const ok = await probePort(DEV_PORT);
  keepalive.lastProbeAt = new Date().toISOString();
  keepalive.lastProbeOk = ok;
  if (ok) {
    if (keepalive.consecutiveFailures > 0) {
      logKeepalive(`port ${DEV_PORT} healthy again after ${keepalive.consecutiveFailures} failed probe(s)`);
    }
    keepalive.consecutiveFailures = 0;
    keepalive.lastError = null;
    mirrorKeepalive();
    return;
  }
  keepalive.consecutiveFailures++;
  logKeepalive(`probe failed (${keepalive.consecutiveFailures} consecutive)`);
  if (keepalive.consecutiveFailures >= 2) {
    if (Date.now() - lastRestartAttempt < 60_000) {
      logKeepalive("backoff active (<60s since last attempt) — waiting next tick");
    } else {
      lastRestartAttempt = Date.now();
      await restartDevServer(`probe failures=${keepalive.consecutiveFailures}`);
    }
  }
  mirrorKeepalive();
}, 30_000);

function lockHeld(): boolean {
  const lock = readJson(`${STATE_DIR}/round.lock`);
  if (!lock?.pid) return false;
  try { process.kill(lock.pid, 0); return true; } catch { return false; }
}

function triggerRound(): { triggered: boolean; note: string } {
  if (lockHeld()) return { triggered: false, note: "a round is already running (lock held)" };
  try {
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
        role: "console + dev-server keepalive (scheduling lives in src/instrumentation.ts inside the dev server)",
        scheduler: readJson(`${STATE_DIR}/scheduler.json`),
        schedulerHeartbeat: readJson(`${STATE_DIR}/scheduler-heartbeat.json`),
        lastRound: readJson(`${STATE_DIR}/last-round.json`),
        lockHeld: lockHeld(),
        consoleHeartbeat: readJson(`${STATE_DIR}/console-heartbeat.json`),
        keepalive: readJson(KEEPALIVE_STATE),
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
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(`${STATE_DIR}/console-heartbeat.json`, JSON.stringify({
      alive: true, lastTickAt: new Date().toISOString(), port: PORT,
    }));
  } catch {}
}, 60_000);

// Persist initial keepalive state so /status shows the feature immediately.
mirrorKeepalive();

console.log(`[${new Date().toISOString()}] iterate console on :${PORT} (status/trigger + dev-server keepalive on :${DEV_PORT})`);
