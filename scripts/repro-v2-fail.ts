import { db } from "@/lib/db";
import { writeFileSync } from "node:fs";

const OUT = "/home/z/my-project/tool-results/v2-fail-repro.log";

async function main() {
  // Create project via API
  const createRes = await fetch("http://localhost:3000/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Repro V2 Test",
      topic: "CRISPR-Cas9 genome editing: molecular mechanisms, off-target effects, and clinical applications",
      field: "molecular biology",
      journalTemplate: "generic",
    }),
  });
  if (!createRes.ok) {
    console.error("CREATE FAILED:", createRes.status, await createRes.text());
    return;
  }
  const created = await createRes.json();
  const projectId = created.project?.id ?? created.id;
  console.log("PROJECT_ID=", projectId);

  const res = await fetch("http://localhost:3000/api/ai/generate-full-v2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      journalTemplate: "generic",
      targetWords: 600,
      maxDbQueries: 5,
      maxWebSearchQueries: 2,
      maxTokens: 8192,
    }),
  });
  console.log("HTTP_STATUS=", res.status);

  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  const events: any[] = [];
  const startedAt = Date.now();
  const summary: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.startsWith("data: ") ? chunk.slice(6) : chunk;
      try {
        const obj = JSON.parse(line);
        events.push(obj);
        const elapsed = String(Date.now() - startedAt).padStart(6);
        summary.push(`[+${elapsed}ms] event=${obj.event}${obj.step?" step="+obj.step:""}${obj.status?" status="+obj.status:""}${obj.message?" msg="+String(obj.message).slice(0,160):""}${obj.error?" ERROR="+obj.error:""}`);
      } catch {}
    }
  }
  // Only print last 40 + terminal event to console; write all to file
  writeFileSync(OUT, events.map(e => JSON.stringify(e)).join("\n"));
  console.log("Total events:", events.length);
  console.log("--- Last 30 events ---");
  for (const s of summary.slice(-30)) console.log(s);
  const terminal = events.find(e => e.event === "error" || e.event === "complete");
  console.log("--- Terminal event (full) ---");
  console.log(JSON.stringify(terminal).slice(0, 1500));

  // cleanup
  if (projectId) {
    try { await fetch(`http://localhost:3000/api/projects/${projectId}`, { method: "DELETE" }); } catch {}
  }
}
main().catch(e => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
