import { db } from "@/lib/db";
async function main() {
  const run = await db.taskRun.findFirst({
    where: { projectId: "cmum243sh0000msqsp4aeh31v" },
    orderBy: { startedAt: "desc" },
  });
  if (!run) return;
  const steps: any[] = JSON.parse(run.stepsJson || "[]");
  // Key transitions only: started/done per stage + first/last of each
  const seen = new Set<string>();
  for (const s of steps) {
    const stage = String(s.step || "?");
    const status = String(s.status || "");
    const key = `${stage}:${status}`;
    const isBoundary = (status === "started" || status === "done" || status === "skipped") && stage !== "generate" && stage !== "knowledge" && stage !== "verify" && stage !== "translate";
    if (isBoundary && !seen.has(key)) {
      seen.add(key);
      console.log(`${new Date(s.ts).toISOString().slice(11, 19)} ${stage}/${status} :: ${String(s.message || "").slice(0, 70)}`);
    }
    // translate + repair boundaries always
    if (stage === "translate" && (status === "started" || status === "done") || stage === "repair" && status === "started") {
      const k2 = `${stage}:${status}:${s.section || ""}`;
      if (!seen.has(k2)) { seen.add(k2); console.log(`${new Date(s.ts).toISOString().slice(11, 19)} ${stage}/${status} §${s.section || "-"} :: ${String(s.message || "").slice(0, 60)}`); }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
