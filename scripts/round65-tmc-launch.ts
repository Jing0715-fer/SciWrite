/**
 * Round-65: independent TMC1/TMC2 regeneration test.
 *
 * Purpose: user asked to regenerate the TMC1/TMC2 structural-biology article
 * from scratch on the CURRENT pipeline (post round-64 structural citation
 * hygiene engine) and check whether the 9 defect classes found in the
 * manual ferroptosis review still occur.
 *
 *   1. Creates (or reuses) a dedicated project — same topic wording as the
 *      round-59 TMC production for comparability.
 *   2. Consumes the v2 SSE stream to the `complete` event, logging progress.
 *   3. On stream drop / FATAL without completion, retries via the checkpoint
 *      resume path (up to 4 attempts; 429-ish errors wait 5 min first).
 *   4. Writes the result marker to /tmp/round65-tmc-result.json.
 *
 * Usage: setsid nohup bun scripts/round65-tmc-launch.ts >> /tmp/round65-tmc-run.log 2>&1 &
 */
const BASE = "http://localhost:3000";
const PROJECT_TITLE = "TMC1/TMC2 Structural Biology Round-65 Regeneration";
const TOPIC =
  "TMC1 and TMC2 proteins as components of the hair cell mechanotransduction channel: structure, function, and disease";
const FIELD = "structural biology";
// Ride out multi-wave account-level 429 storms (each abort keeps its
// checkpoint; the probe gate avoids burning attempts while throttled).
// Global cap ~10h so a truly wedged run still terminates.
const ATTEMPTS = 40;
const ROUND_TIMEOUT_MS = 100 * 60_000; // 100 min hard cap per attempt

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function jfetch(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}

// ---------- 1. project ----------
let projectId: string | null = null;
try {
  const list = await jfetch(`${BASE}/api/projects`);
  const found = (list?.projects || []).find((p: any) => p.title === PROJECT_TITLE);
  if (found) {
    projectId = found.id;
    log(`reusing project ${projectId} (${PROJECT_TITLE})`);
  }
} catch {}
if (!projectId) {
  const j = await jfetch(`${BASE}/api/projects`, {
    method: "POST",
    body: JSON.stringify({ title: PROJECT_TITLE, topic: TOPIC, field: FIELD }),
  });
  projectId = j?.project?.id || null;
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(j).slice(0, 160)}`);
  log(`created project ${projectId} (topic: ${TOPIC.slice(0, 60)}…)`);
}

// ---------- 2. pipeline with checkpoint-resume retries ----------
const t0 = Date.now();
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  log(`attempt ${attempt}/${ATTEMPTS}: POST /api/ai/generate-full-v2`);
  let articleId: string | null = null;
  let completeData: any = null;
  let streamError: string | null = null;
  let lastEventAt = Date.now();
  try {
    const controller = new AbortController();
    const killTimer = setTimeout(() => controller.abort(), ROUND_TIMEOUT_MS);
    const res = await fetch(`${BASE}/api/ai/generate-full-v2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, language: "both", targetWords: 3000, maxTokens: 20480 }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`pipeline POST ${res.status}`);
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() || "";
      for (const ev of events) {
        const line = ev.trim();
        if (!line.startsWith("data:")) continue;
        try {
          const data = JSON.parse(line.slice(5).trim());
          lastEventAt = Date.now();
          if (data.event === "step") {
            const pct = data.progress != null ? ` ${Math.round(data.progress * 100)}%` : "";
            log(`  ${data.step}${pct} ${data.status || ""} ${(data.message || "").slice(0, 150)}`);
          } else if (data.event === "complete") {
            completeData = data;
            articleId = data.articleId || null;
          } else if (data.event === "error" || data.event === "fatal") {
            streamError = String(data.error || data.message || "pipeline error");
            log(`  ⚠ ${data.event}: ${streamError.slice(0, 220)}`);
          }
        } catch {}
      }
    }
    clearTimeout(killTimer);
  } catch (e: any) {
    streamError = String(e?.message ?? e);
  }
  const durationMs = Date.now() - t0;
  log(
    `attempt ${attempt} stream ended after ${(durationMs / 60_000).toFixed(1)} min — ` +
      `complete=${!!completeData} articleId=${articleId} err=${streamError ? streamError.slice(0, 140) : "none"}`,
  );

  if (completeData && articleId) {
    await Bun.write(
      "/tmp/round65-tmc-result.json",
      JSON.stringify({ projectId, articleId, durationMs, complete: completeData }, null, 2),
    );
    log(`SUCCESS — article ${articleId}; marker at /tmp/round65-tmc-result.json`);
    process.exit(0);
  }

  // No completion. Inspect the checkpoint to decide how to wait.
  let cpInfo = "";
  try {
    const cp = await jfetch(`${BASE}/api/projects/${projectId}/pipeline-checkpoint`);
    cpInfo = cp?.resumable
      ? `checkpoint resumable (${cp?.sectionsDone}/${cp?.sectionsTotal} sections, ${cp?.refsCount} refs)`
      : "no resumable checkpoint";
  } catch {}
  const throttled = /429|rate|throttl|storm/i.test(streamError || "");
  if (throttled) {
    // Wait for the provider to actually recover before burning an attempt —
    // probe every 60s for up to 15 min, then fire regardless.
    log(`throttled — probing provider recovery before next attempt (${cpInfo})`);
    const deadline = Date.now() + 15 * 60_000;
    let healthy = false;
    while (Date.now() < deadline) {
      await sleep(60_000);
      try {
        const r = await fetch(`${BASE}/api/health/llm-probe`, { signal: AbortSignal.timeout(15_000) });
        if (r.ok) {
          const j: any = await r.json().catch(() => null);
          if (j?.healthy) { healthy = true; break; }
        }
      } catch {}
    }
    log(healthy ? "provider recovered — firing next attempt" : "probe window expired — firing attempt anyway");
  } else {
    log(`retry in 30s (${cpInfo}; stream-drop-ish)`);
    await sleep(30_000);
  }
}
log("FAILED after all attempts — inspect dev.log + checkpoint manually");
process.exit(1);
