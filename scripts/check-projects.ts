import { db } from "@/lib/db";

async function main() {
  const projects = await db.project.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, topic: true, field: true, journalTemplate: true, createdAt: true, _count: { select: { paragraphs: true, references: true, articles: true } } },
  });
  for (const p of projects) console.log(JSON.stringify(p));
  const c = await db.project.count();
  console.log(`\nTotal projects: ${c}`);
  const llmCfg = await db.llmConfig.findMany({ select: { id: true, provider: true, model: true, isActive: true } });
  console.log(`\nLLM configs (${llmCfg.length}):`);
  for (const c of llmCfg) console.log(`  ${JSON.stringify(c)}`);
  const llmSel = await db.llmSelection.findMany();
  console.log(`\nLLM selections (${llmSel.length}):`);
  for (const s of llmSel) console.log(`  ${JSON.stringify(s)}`);
}
main().catch(e => { console.error("ERR:", e?.message ?? e); process.exit(1); }).finally(() => db.$disconnect());
