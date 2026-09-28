/**
 * DEV-ONLY server-side watchdog (round-58).
 * Survives sandbox tool-session reaping because the timer lives inside the
 * persistent dev-server process. Probes the LLM every 3 min; on recovery,
 * launches the full v2 pipeline for the PCSK9 regression project.
 * GET  → status report. DELETE → stop the watchdog.
 */
import { NextRequest, NextResponse } from "next/server";
import { appendFileSync } from "node:fs";

const LOG = "/tmp/r58-relaunch.log";
const log = (m: string) => {
  try { appendFileSync(LOG, `${new Date().toISOString().slice(11, 19)} [srv-watchdog] ${m}\n`); } catch {}
};

// Module-level state — survives between requests within one server process.
const g = globalThis as any;
if (!g.__r58Watchdog) {
  g.__r58Watchdog = {
    timer: null as any,
    launched: false,
    startedAt: null as any,
    lastProbe: "never",
    probeCount: 0,
    pipelineStatus: "not-launched",
  };
}
const W = g.__r58Watchdog;

const PIPELINE_BODY = {
  projectId: "cmtqy35wn002iowu8g1gn16x3",
  targetWords: 3000,
  journalTemplate: "generic",
  maxDbQueries: 0,
  maxWebSearchQueries: 0,
  maxTokens: 20480,
  language: "both",
  promptInstruction: "",
};

async function probeLLM(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const t0 = Date.now();
    const r = await zai.chat.completions.create({
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 10,
    } as any);
    const txt = (r as any)?.choices?.[0]?.message?.content ?? "";
    return { ok: true, detail: `recovered in ${Date.now() - t0}ms → ${String(txt).slice(0, 20)}` };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 90) };
  }
}

async function launchPipeline() {
  W.launched = true;
  W.pipelineStatus = "launching";
  log("LLM recovered → launching v2 pipeline (POST /api/ai/generate-full-v2)");
  try {
    const res = await fetch("http://localhost:3000/api/ai/generate-full-v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PIPELINE_BODY),
    });
    // Drain the SSE stream so the pipeline never stalls on backpressure.
    const reader = (res as any).body?.getReader?.();
    if (reader) {
      (async () => {
        try {
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {}
        W.pipelineStatus = "finished";
        log("pipeline stream closed (finished or aborted)");
      })();
    }
    W.pipelineStatus = "running";
    log(`pipeline launched, HTTP ${res.status}, stream draining`);
  } catch (e: any) {
    W.pipelineStatus = `launch-failed: ${String(e?.message).slice(0, 80)}`;
    log(`pipeline launch FAILED: ${W.pipelineStatus}`);
  }
}

function start() {
  if (W.timer) return;
  W.startedAt = new Date().toISOString();
  log("server-side watchdog started");
  W.timer = setInterval(async () => {
    if (W.launched) {
      clearInterval(W.timer);
      W.timer = null;
      return;
    }
    W.probeCount++;
    const p = await probeLLM();
    W.lastProbe = `${new Date().toISOString().slice(11, 19)} ${p.ok ? "OK" : "FAIL"} ${p.detail}`;
    if (p.ok) {
      await launchPipeline();
      clearInterval(W.timer);
      W.timer = null;
    } else if (W.probeCount % 10 === 1) {
      log(`probe #${W.probeCount}: ${p.detail}`);
    }
  }, 180_000);
  // immediate first probe
  (async () => {
    W.probeCount++;
    const p = await probeLLM();
    W.lastProbe = `${new Date().toISOString().slice(11, 19)} ${p.ok ? "OK" : "FAIL"} ${p.detail}`;
    if (p.ok) await launchPipeline();
    else log(`first probe: ${p.detail}`);
  })();
}

export async function GET() {
  start();
  return NextResponse.json({
    active: !!W.timer || W.launched,
    startedAt: W.startedAt,
    probeCount: W.probeCount,
    lastProbe: W.lastProbe,
    launched: W.launched,
    pipelineStatus: W.pipelineStatus,
  });
}

export async function DELETE() {
  if (W.timer) { clearInterval(W.timer); W.timer = null; }
  log("watchdog stopped via DELETE");
  return NextResponse.json({ stopped: true });
}
