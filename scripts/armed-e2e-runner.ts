/**
 * armed-e2e-runner.ts (RT16) — wait-storm armed runner.
 *
 * When the E2E launch hits the pre-flight 429 guard (provider throttled),
 * this runner probes the account every PROBE_INTERVAL_MS. The FIRST clean
 * probe triggers the full-generation E2E immediately (reaper-proof spawn —
 * see dev-daemon.ts). Probe exhaustion = honest give-up, non-zero exit.
 *
 * Log: tool-results/rt16-armed-runner.log (one line per probe).
 * E2E log: tool-results/rt16-e2e.log (overwritten per attempt).
 */
import { spawn } from "child_process";
import { openSync, writeSync } from "fs";

const CWD = "/home/z/SciWrite";
const PROBE_INTERVAL_MS = 180_000;
const MAX_PROBES = 60; // ~3h coverage

const LOG = openSync(`${CWD}/tool-results/rt16-armed-runner.log`, "a");
function log(line: string): void {
  const ts = new Date().toISOString();
  writeSync(LOG, `[${ts}] ${line}\n`);
}

function probe(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("bun", ["run", "scripts/quota-probe.ts"], {
      cwd: CWD,
      env: { ...process.env, DATABASE_URL: "file:/home/z/SciWrite/db/custom.db" },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.stderr.on("data", (d) => (out += String(d)));
    p.on("close", (code) => {
      log(`probe → exit=${code} ${out.trim().slice(0, 120)}`);
      resolve(code === 0);
    });
    p.on("error", (err) => {
      log(`probe spawn error: ${String(err)}`);
      resolve(false);
    });
  });
}

function fireE2E(): number {
  const OUT = openSync(`${CWD}/tool-results/rt16-e2e.log`, "w");
  const child = spawn(
    "bun",
    ["run", "scripts/full-generation-test.ts", "--words", "1500"],
    {
      cwd: CWD,
      env: { ...process.env, DATABASE_URL: "file:/home/z/SciWrite/db/custom.db" },
      detached: true,
      stdio: ["ignore", OUT, OUT],
    },
  );
  child.unref();
  log(`E2E FIRED pid=${child.pid} (clean probe observed)`);
  return child.pid ?? -1;
}

async function main(): Promise<void> {
  log(`armed runner start — ${MAX_PROBES} probes × ${PROBE_INTERVAL_MS / 1000}s`);
  for (let i = 1; i <= MAX_PROBES; i++) {
    if (await probe()) {
      fireE2E();
      process.exit(0);
    }
    if (i < MAX_PROBES) {
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
    }
  }
  log(`storm never cleared after ${MAX_PROBES} probes — honest give-up`);
  process.exit(2);
}

main();
