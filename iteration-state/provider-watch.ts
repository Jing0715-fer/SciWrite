/**
 * Provider recovery watcher (task: real full-generation test orchestration).
 * Probes the z-ai SDK every 2 min; after 2 consecutive healthy probes it
 * triggers one auto-iterate round via the scheduler console (port 3040) —
 * the round's lockfile prevents duplication with the in-flight round 7 —
 * then EXITS (exactly one trigger per watcher lifetime).
 */
import fs from "fs";

const LOG = "/home/z/my-project/iteration-state/provider-watch.log";

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG, line + "\n"); } catch {}
  console.log(line);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(): Promise<boolean> {
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    await zai.chat.completions.create({
      messages: [{ role: "user", content: "Reply OK." }],
      max_tokens: 8,
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  log("watcher started (2-min cadence, 2-consecutive-healthy trigger)");
  let healthy = 0;
  for (;;) {
    const ok = await probe();
    healthy = ok ? healthy + 1 : 0;
    log(ok ? `HEALTHY (${healthy}/2)` : "throttled");
    if (healthy >= 2) break;
    await sleep(2 * 60_000);
  }
  log("RECOVERED — triggering auto-iterate round via :3040/trigger");
  try {
    const r = await fetch("http://localhost:3040/trigger", { method: "POST" });
    log(`trigger response: ${r.status} ${(await r.text()).slice(0, 200)}`);
  } catch (e: any) {
    log(`trigger FAILED: ${String(e?.message ?? e).slice(0, 160)}`);
  }
  log("watcher exiting (one-shot trigger complete)");
}

main().catch((e) => log(`FATAL: ${String((e as any)?.stack || e).slice(0, 300)}`));
