/**
 * RT-2 recovery orchestrator — the unattended real-generation test driver.
 *
 *   1. Probe the provider every 2 min; 2 consecutive healthy = recovered.
 *   2. Take the auto-iterate round lock (the scheduler's concurrency guard —
 *      while held, no scheduled canary round can double-run a pipeline
 *      against our test on this 3.9GB box).
 *   3. POST the TMC v2 pipeline (user's original scenario: bilingual 2500
 *      words, per-member coverage), consume the SSE stream to a terminal
 *      event (hard cap 150 min).
 *   4. Release the lock; write iteration-state/rt2-test-report.json with
 *      the complete-event stats (or the error).
 *   5. Exit. The auto-iterate scheduler resumes its normal cadence and its
 *      next canary round provides the standardized regression metrics.
 */
import fs from "fs";

const ROOT = "/home/z/my-project";
const STATE = `${ROOT}/iteration-state`;
const LOG = `${STATE}/rt2-orchestrator.log`;
const LOCK = `${STATE}/round.lock`;
const SSE_OUT = `${STATE}/tmc-test-sse.log`;
const REPORT = `${STATE}/rt2-test-report.json`;
const BODY = {
  projectId: "cmumrsvtu0000qwcd93kq8atz",
  language: "both",
  targetWords: 2500,
  maxTokens: 20480,
  promptInstruction:
    "Structure: introduction, then dedicated coverage for each TMC family member (TMC1 through TMC8, each member with at least one dedicated paragraph covering its structure and function), then a concluding synthesis. Emphasize cryo-EM structural findings, mechanotransduction roles (hair-cell MET channel), and disease links (DFNB7/11 deafness, hearing loss).",
};
const TEST_CAP_MS = 150 * 60_000;

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

function takeLock() {
  // Same format iterate.ts uses; PID liveness is the guard's source of truth
  // (fixed this session: a live PID is never reclaimed).
  fs.writeFileSync(LOCK, JSON.stringify({
    pid: process.pid,
    started: new Date().toISOString(),
    note: "RT-2 real-generation test (recovery orchestrator)",
  }));
}
function releaseLock() {
  try { fs.unlinkSync(LOCK); } catch {}
}

async function runTest(): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const controller = new AbortController();
  const kill = setTimeout(() => controller.abort(), TEST_CAP_MS);
  let complete: any = null;
  let errEvent: string | null = null;
  let eventCount = 0;
  let lastProgress = 0;
  try {
    const res = await fetch("http://localhost:3000/api/ai/generate-full-v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(BODY),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      return { outcome: "rejected", http: res.status, error: text.slice(0, 300), ms: Date.now() - t0 };
    }
    // Tee the stream to the SSE file while parsing terminal events.
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    const out = fs.openSync(SSE_OUT, "w");
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      fs.writeSync(out, text);
      buf += text;
      const frames = buf.split("\n\n");
      buf = frames.pop() || "";
      for (const f of frames) {
        const line = f.trim();
        if (!line.startsWith("data:")) continue;
        eventCount++;
        try {
          const d = JSON.parse(line.slice(5).trim());
          if (d.event === "complete") { complete = d; lastProgress = 100; }
          if (d.event === "error" || d.event === "fatal") errEvent = String(d.error || d.message || "pipeline error");
          if (typeof d.progress === "number") lastProgress = Math.max(lastProgress, d.progress);
        } catch {}
      }
    }
    fs.closeSync(out);
  } catch (e: any) {
    return {
      outcome: complete ? "complete" : "stream-error",
      error: String(e?.message ?? e).slice(0, 300),
      ms: Date.now() - t0,
      articleId: complete?.articleId ?? null,
      events: eventCount,
      lastProgress,
    };
  } finally {
    clearTimeout(kill);
  }
  const ms = Date.now() - t0;
  if (complete) {
    return {
      outcome: "complete",
      ms,
      articleId: complete.articleId ?? null,
      events: eventCount,
      lastProgress,
      stats: complete.stats ?? null,
      references: complete.references ?? null,
      words: complete.words ?? null,
    };
  }
  return {
    outcome: errEvent ? "error" : "stream-ended-no-complete",
    error: errEvent,
    ms,
    events: eventCount,
    lastProgress,
  };
}

async function main() {
  log("orchestrator started — waiting for provider recovery (2-min cadence, 2-consecutive gate)");
  let healthy = 0;
  for (;;) {
    const ok = await probe();
    healthy = ok ? healthy + 1 : 0;
    log(ok ? `HEALTHY (${healthy}/2)` : "throttled");
    if (healthy >= 2) break;
    await sleep(2 * 60_000);
  }
  log("provider RECOVERED — taking round lock and launching the TMC real test");
  takeLock();
  try {
    const report = await runTest();
    log(`test terminal: outcome=${report.outcome} ms=${report.ms} events=${report.events} articleId=${report.articleId ?? "-"}`);
    fs.writeFileSync(REPORT, JSON.stringify({ launchedAt: new Date().toISOString(), ...report }, null, 2));
  } finally {
    releaseLock();
    log("round lock released — auto-iterate cadence resumes");
  }
  log("orchestrator done");
}

main().catch((e) => {
  log(`FATAL: ${String((e as any)?.stack || e).slice(0, 400)}`);
  releaseLock();
  process.exit(1);
});
