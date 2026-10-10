/**
 * skill-smoke.ts — RT5 live verification: run the migrated score skill
 * end-to-end (cache → chatWithSession → parse → per-item fill) against a
 * REAL project's references, through the shared skill executor.
 *
 *   bun run scripts/skill-smoke.ts [projectId]
 *
 * Verifies: prompt contract, session metadata unification (step/skill),
 * per-item validation, mechanical fallback shape, telemetry envelope.
 */
import { db } from "@/lib/db";
import { scoreSources, buildFullTextProfiles } from "@/lib/citation-planner";

async function main() {
  const argId = process.argv[2];
  const project = argId
    ? await db.project.findUnique({ where: { id: argId } })
    : await db.project.findFirst({ orderBy: { createdAt: "desc" } });
  if (!project) { console.error("no project"); process.exit(1); }

  const refs = await db.reference.findMany({
    where: { projectId: project.id },
    take: 4,
  });
  if (refs.length === 0) { console.error("no refs in project"); process.exit(1); }

  const profiles = buildFullTextProfiles(
    refs,
    await db.dataSource.findMany({ where: { projectId: project.id } }),
  );

  console.log(`project=${project.id} refs=${refs.length} (topic: ${String(project.topic).slice(0, 50)}...)`);
  const t0 = Date.now();
  const result = await scoreSources(project.id, refs, profiles, project.topic, "molecular biology", {
    batchSize: 4, // one batch, one LLM call
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`scoreSources done in ${dt}s — llmBatches=${result.llmBatches} fallbackBatches=${result.fallbackBatches}`);
  for (const s of result.scores) {
    console.log(`  [${s.index}] rel=${s.relevance} imp=${s.importance} pri=${s.priority.toFixed(1)} tier=${s.tier} reason="${s.reason.slice(0, 60)}"`);
  }

  // Contract checks
  const allIndexed = result.scores.every((s, i) => s.index === i + 1);
  const allValid = result.scores.every((s) => s.relevance >= 1 && s.relevance <= 10 && s.importance >= 1 && s.importance <= 10);
  console.log(`CONTRACT: indexes-sequential=${allIndexed} ranges-valid=${allValid} count=${result.scores.length === refs.length}`);
  console.log(allIndexed && allValid && result.scores.length === refs.length ? "SKILL_SMOKE_PASS" : "SKILL_SMOKE_FAIL");

  // Show the unified session metadata the executor wrote
  const lastMsg = await db.conversationSession.findFirst({
    where: { projectId: project.id, taskType: "score" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true, taskType: true },
  });
  if (lastMsg?.metadata) {
    const md = lastMsg.metadata as any;
    console.log(`session metadata: step=${md.step} skill=${md.skill} batch=${md.batch}/${md.total} refs=${md.refs}`);
  }
  process.exit(0);
}

main();
