/**
 * RT8 night-runner: standalone adversarial re-review leg.
 *
 * The RT8 E2E main run (34.7min, PASS) had its [4/4] standalone
 * adversarial re-review leg swallowed by an in-run rate-limit abort flag;
 * the manual re-run at 13:33 hit a FRESH account-level 429 storm
 * (storm #4 → 1h TTL). The route's non-LLM mechanics (DB projection,
 * batch-20 prompt assembly, stateless session skip) were verified in that
 * run — this script completes the picture with a clean-window verdict
 * pass as soon as the storm clears.
 *
 * Polls /api/quota-status every 180s; when aborted=false AND
 * windowCount <= 2, fires the re-review POST once and writes the result
 * to tool-results/adv-rereview-rt8.json. Exits after ~40 probes (~2h).
 */
const BASE = "http://localhost:3001";
const ARTICLE_ID = process.argv[2] || "cmv5924oj00rfn125wpchdt9l";
const OUT = "tool-results/adv-rereview-rt8.json";
const MAX_PROBES = 40;

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

async function runReview(): Promise<void> {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/articles/${ARTICLE_ID}/adversarial-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoFix: false }),
    signal: AbortSignal.timeout(900_000),
  });
  const body = await r.json();
  const rep = body?.report || body || {};
  const summary = {
    at: new Date().toISOString(),
    httpStatus: r.status,
    totalMs: Date.now() - t0,
    checked: rep.checked,
    supported: rep.supported,
    partial: rep.partial,
    unsupported: rep.unsupported,
    removed: rep.removed,
    refCountBefore: rep.refCountBefore,
    refCountAfter: rep.refCountAfter,
    audit: rep.audit,
    flaggedCount: Array.isArray(rep.flagged) ? rep.flagged.length : undefined,
  };
  await Bun.write(OUT, JSON.stringify(summary, null, 2));
  console.log(
    `[rt8-adv] DONE http=${r.status} in ${Math.round(summary.totalMs / 1000)}s — ` +
      `checked=${summary.checked} supported=${summary.supported} partial=${summary.partial} ` +
      `unsupported=${summary.unsupported} removed=${summary.removed} → ${OUT}`,
  );
}

for (let i = 1; i <= MAX_PROBES; i++) {
  const st = await probe();
  console.log(
    `[rt8-adv] probe ${i}/${MAX_PROBES} aborted=${st.aborted} window=${st.windowCount} @ ${new Date().toISOString()}`,
  );
  if (!st.aborted && st.windowCount <= 2) {
    console.log(`[rt8-adv] clean window — firing the re-review leg`);
    try {
      await runReview();
      process.exit(0);
    } catch (err: any) {
      console.log(`[rt8-adv] review attempt failed: ${String(err?.message ?? err).slice(0, 120)} — keep polling`);
    }
  }
  await sleep(180_000);
}
console.log(`[rt8-adv] gave up after ${MAX_PROBES} probes — storm never cleared`);
process.exit(1);
