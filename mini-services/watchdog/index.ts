/**
 * round-58 watchdog mini-service (port 3005).
 * Probes the z.ai chat endpoint every 3 min; on recovery, launches the full
 * v2 pipeline for the PCSK9 regression project and drains the SSE stream.
 * Survives sandbox tool-session reaping as a detached mini-service.
 */
import http from "node:http";
import { appendFileSync } from "node:fs";

const LOG = "/tmp/r58-relaunch.log";
const log = (m: string) => {
  try { appendFileSync(LOG, `${new Date().toISOString().slice(11, 19)} [mini-watchdog] ${m}\n`); } catch {}
};

const PIPELINE_BODY = JSON.stringify({
  projectId: "cmtqy35wn002iowu8g1gn16x3",
  targetWords: 3000, journalTemplate: "generic",
  maxDbQueries: 0, maxWebSearchQueries: 0, maxTokens: 20480,
  language: "both", promptInstruction: "",
});

let launched = false;
let probes = 0;

async function probe(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const r = await zai.chat.completions.create({
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 10,
    } as any);
    return { ok: true, detail: String((r as any)?.choices?.[0]?.message?.content ?? "").slice(0, 30) };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 80) };
  }
}

async function launch() {
  launched = true;
  log("LLM RECOVERED → launching v2 pipeline");
  try {
    const res = await fetch("http://localhost:3000/api/ai/generate-full-v2", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: PIPELINE_BODY,
    });
    log(`pipeline launched HTTP ${res.status}`);
    const reader = (res as any).body?.getReader?.();
    if (reader) {
      (async () => {
        try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch {}
        log("pipeline stream closed");
      })();
    }
  } catch (e: any) { log(`launch FAILED: ${String(e?.message).slice(0, 80)}`); }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ service: "watchdog", probes, launched, port: 3005 }));
});
server.listen(3005, () => log("mini-watchdog listening on 3005"));

setInterval(async () => {
  if (launched) return;
  probes++;
  const p = await probe();
  if (p.ok) await launch();
  else if (probes % 10 === 1) log(`probe #${probes}: ${p.detail}`);
}, 180_000);

// immediate first probe
(async () => { probes++; const p = await probe(); if (p.ok) await launch(); else log(`first probe: ${p.detail}`); })();
