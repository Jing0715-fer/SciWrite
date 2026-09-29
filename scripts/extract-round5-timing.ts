import { db } from "@/lib/db";

async function main() {
  // round 5 canary project = cmum243sh (02:28 creation, article cmum5hyqt)
  const runs = await db.taskRun.findMany({
    where: { projectId: "cmum243sh0000msqsp4aeh31v" },
    orderBy: { startedAt: "desc" },
    take: 3,
  });
  for (const run of runs) {
    let steps: any[] = [];
    try { steps = JSON.parse(run.stepsJson || "[]"); } catch {}
    console.log(`\n=== RUN ${run.id.slice(-6)} status=${run.status} started=${run.startedAt.toISOString()} steps=${steps.length} ===`);
    if (steps.length === 0) continue;
    // stage timing: group by step name, sum durations between events
    const stageSpans: Record<string, { start: number; total: number; events: number }> = {};
    let lastTs = new Date(steps[0].ts).getTime();
    let lastStage = "init";
    for (const s of steps.slice(1)) {
      const ts = new Date(s.ts).getTime();
      const stage = String(s.step || "other");
      if (!stageSpans[stage]) stageSpans[stage] = { start: 0, total: 0, events: 0 };
      // attribute elapsed time to the stage of the PREVIOUS event (the stage that was "in flight")
      if (!stageSpans[lastStage]) stageSpans[lastStage] = { start: 0, total: 0, events: 0 };
      stageSpans[lastStage].total += ts - lastTs;
      stageSpans[lastStage].events++;
      lastTs = ts; lastStage = stage;
    }
    const total = Date.now() - new Date(steps[0].ts).getTime();
    const sorted = Object.entries(stageSpans).sort((a, b) => b[1].total - a[1].total);
    console.log(`wall: ${(total / 60000).toFixed(1)}min (run may have been aborted)`);
    for (const [stage, sp] of sorted) {
      if (sp.total > 5000) console.log(`  ${stage.padEnd(12)} ${Math.round(sp.total / 1000)}s (${(sp.total / 60000).toFixed(1)}min) · ${sp.events} events`);
    }
    // knowledge batch timing
    const kb = steps.filter((s) => /batch (\d+)\/(\d+)/.test(String(s.message || "")));
    if (kb.length > 1) {
      const spans: number[] = [];
      for (let i = 1; i < kb.length; i++) spans.push(new Date(kb[i].ts).getTime() - new Date(kb[i - 1].ts).getTime());
      console.log(`knowledge batches: ${kb.length} events, inter-batch spans: [${spans.map((s) => Math.round(s / 1000) + "s").join(", ")}]`);
    }
    // generate section timing
    const gs = steps.filter((s) => s.step === "generate" && s.status === "started" && s.section);
    if (gs.length > 1) {
      const spans: number[] = [];
      for (let i = 1; i < gs.length; i++) spans.push(new Date(gs[i].ts).getTime() - new Date(gs[i - 1].ts).getTime());
      console.log(`generate sections: ${gs.length} started, spans: [${spans.map((s) => Math.round(s / 1000) + "s").join(", ")}]`);
    }
    const first = steps[0], last = steps[steps.length - 1];
    console.log(`first: ${new Date(first.ts).toISOString().slice(11, 19)} ${String(first.message || "").slice(0, 60)}`);
    console.log(`last:  ${new Date(last.ts).toISOString().slice(11, 19)} ${String(last.message || "").slice(0, 60)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
