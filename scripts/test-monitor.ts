/**
 * Real-generation test monitor — samples every 15s:
 *   - latest TaskRun for the canary project (steps count, progress, stage)
 *   - next-server RSS (OOM early warning)
 *   - round console tail
 * Usage: bun run scripts/test-monitor.ts [projectIdFile]
 * where projectIdFile contains the canary project id (written by the watcher
 * trigger flow). Falls back to the newest "Auto-Iterate Canary" project.
 */
import fs from "fs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOG = "/home/z/my-project/iteration-state/test-monitor.log";

function log(msg: string) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  try { fs.appendFileSync(LOG, line + "\n"); } catch {}
  console.log(line);
}

async function nextRss(): Promise<number | null> {
  try {
    const r = await Bun.spawnSync(["bash", "-c", "ps -o rss= -p $(pgrep -f 'next-server' | head -1) 2>/dev/null"]);
    const kb = parseInt(r.stdout?.toString().trim() || "", 10);
    return isNaN(kb) ? null : kb;
  } catch { return null; }
}

async function main() {
  log("monitor started");
  let lastStepCount = -1;
  let lastMsg = "";
  for (;;) {
    try {
      const res = await fetch("http://localhost:3000/api/task-runs?projectId=cmumrsvtu0000qwcd93kq8atz&limit=1", {
        signal: AbortSignal.timeout(10_000),
      });
      const j: any = await res.json();
      const run = (j?.runs || [])[0];
      if (run) {
        let steps: any[] = [];
        try { steps = JSON.parse(run.stepsJson || "[]"); } catch {}
        const last = steps[steps.length - 1];
        if (steps.length !== lastStepCount || (last?.message || "") !== lastMsg) {
          const prog = last?.progress != null ? ` ${last.progress}%` : "";
          log(
            `RUN ${run.id.slice(-6)} [${run.status}] steps=${steps.length}${prog} ` +
              `${last ? `${last.step || "?"}/${last.status || "?"}: ${String(last.message || "").slice(0, 90)}` : ""}`
          );
          lastStepCount = steps.length;
          lastMsg = last?.message || "";
        }
        if (run.status === "completed" || run.status === "failed" || run.status === "aborted") {
          const rss = await nextRss();
          log(`TERMINAL ${run.status} — steps=${steps.length} — rss=${rss ? Math.round(rss / 1024) + "MB" : "?"} — monitor exiting`);
          return;
        }
      }
      const rss = await nextRss();
      if (rss && rss > 1_800_000) log(`WARNING: next-server RSS ${Math.round(rss / 1024)}MB (OOM risk >1.8GB)`);
    } catch (e: any) {
      log(`probe error: ${String(e?.message ?? e).slice(0, 80)}`);
    }
    await sleep(15_000);
  }
}

main().catch((e) => log(`FATAL: ${String(e).slice(0, 160)}`));
