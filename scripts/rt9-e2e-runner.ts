/**
 * RT9 armed E2E runner — fires the full-generation test in the first clean
 * quota window.
 *
 * Context: the RT9 manual E2E launch at 14:26Z hit storm #5 (the local
 * abort flag had expired 10s earlier, but the provider-side quota was
 * still exhausted — the pre-flight 503'd and re-armed a 1h abort). This
 * runner polls /api/quota-status every 180s; on aborted=false it launches
 * scripts/full-generation-test.ts (1500 words). If THAT run pre-flight
 * 503s (storm re-detected — the abort=false/provider-down race), it keeps
 * polling instead of giving up. A real run (report with stage events) is
 * the exit condition.
 *
 * Output: the E2E itself writes tool-results/full-gen-test-report.json
 * (script-relative, pinned per RT3 O2); this runner logs to stdout.
 */
const BASE = "http://localhost:3001";
const MAX_PROBES = 50; // 50 × 180s ≈ 2.5h coverage + ~35min run
const REPORT = "tool-results/full-gen-test-report.json";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(): Promise<{ aborted: boolean; windowCount: number }> {
  try {
    const r = await fetch(`${BASE}/api/quota-status`, {
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json();
    return { aborted: !!j.aborted, windowCount: Number(j.windowCount ?? 99) };
  } catch {
    return { aborted: true, windowCount: 99 };
  }
}

async function fireE2E(): Promise<{ ran: boolean; summary: string }> {
  const t0 = Date.now();
  const proc = Bun.spawnSync({
    cmd: [
      "bun", "run", "scripts/full-generation-test.ts",
      "--base", BASE, "--words", "1500",
    ],
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = proc.stdout.toString();
  const ms = Date.now() - t0;
  const ran = !out.includes("provider throttled (429 storm)") && !out.includes("PIPELINE ERROR");
  let summary = `http done in ${Math.round(ms / 1000)}s`;
  const mWords = out.match(/words=(\d+)/);
  const mRefs = out.match(/uniqueRefs=(\d+)/);
  if (mWords) summary += ` words=${mWords[1]}`;
  if (mRefs) summary += ` refs=${mRefs[1]}`;
  return { ran, summary };
}

for (let i = 1; i <= MAX_PROBES; i++) {
  const st = await probe();
  console.log(
    `[rt9-e2e] probe ${i}/${MAX_PROBES} aborted=${st.aborted} window=${st.windowCount} @ ${new Date().toISOString()}`,
  );
  if (!st.aborted && st.windowCount <= 2) {
    console.log(`[rt9-e2e] clean window — firing the full-generation E2E (1500 words)`);
    try {
      const { ran, summary } = await fireE2E();
      console.log(`[rt9-e2e] E2E attempt: ran=${ran} ${summary}`);
      if (ran) {
        console.log(`[rt9-e2e] report → ${REPORT} — exiting`);
        process.exit(0);
      }
      // pre-flight 503 re-armed the abort — back to polling
    } catch (err: any) {
      console.log(`[rt9-e2e] E2E attempt failed: ${String(err?.message ?? err).slice(0, 120)} — keep polling`);
    }
  }
  await sleep(180_000);
}
console.log(`[rt9-e2e] gave up after ${MAX_PROBES} probes — storm never cleared`);
process.exit(1);
