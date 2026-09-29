import { db } from "@/lib/db";

async function main() {
  const projects = await db.project.findMany({
    where: { title: { startsWith: "Auto-Iterate Canary" } },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, createdAt: true },
  });
  for (const p of projects) console.log(`PROJECT ${p.id} | ${p.title} | ${p.createdAt.toISOString()}`);
  const latest = projects[0];
  if (!latest) { console.log("no canary projects"); return; }
  const article = await db.article.findFirst({ where: { projectId: latest.id } });
  if (!article) { console.log("no article"); return; }
  console.log(`ARTICLE ${article.id} | title: ${article.title}`);
  console.log(`EN words: ${(article.content || "").split(/\s+/).length} | ZH chars: ${(article.contentZh || "").length}`);
  const content = article.content || "";
  // Format audit
  const heads = content.match(/^##\s+(.+)$/gm) || [];
  console.log(`\n== ${heads.length} section headings ==`);
  heads.forEach((h, i) => console.log(`  ${i + 1}. ${h.replace(/^##\s+/, "").slice(0, 70)}`));
  const cjkInEn = (content.match(/[\u4e00-\u9fff]/g) || []).length;
  console.log(`\nCJK chars in EN half: ${cjkInEn}`);
  const listLines = content.split("\n").filter((l) => /^\s*[-*+]\s|^\s*\d+\.\s/.test(l)).length;
  console.log(`List-style lines: ${listLines}`);
  const boldCount = (content.match(/\*\*/g) || []).length;
  console.log(`Bold markers: ${boldCount} (${boldCount % 2 === 0 ? "balanced" : "UNBALANCED"})`);
  const refIdx = content.lastIndexOf("## References");
  console.log(`Global References at: ${refIdx >= 0 ? "present" : "MISSING"}`);
  if (refIdx >= 0) {
    const refLines = content.slice(refIdx).split("\n").filter((l) => /^\[\d+\]/.test(l.trim()));
    console.log(`Reference entries: ${refLines.length}`);
  }
  // per-section format uniformity: paragraphs per section
  const secBlocks = content.split(/^##\s+/m).slice(1);
  const parasPerSec = secBlocks.map((b) => b.replace(/^.*\n/, "").trim().split(/\n\s*\n/).filter((p) => p.trim()).length);
  console.log(`Paragraphs per section: [${parasPerSec.join(", ")}]`);
  // citation density + range
  const body = refIdx >= 0 ? content.slice(0, refIdx) : content;
  const cites = new Set<number>();
  for (const m of body.matchAll(/\[(\d+(?:,\d+)*)\]/g)) {
    m[1].split(",").forEach((n) => cites.add(parseInt(n)));
  }
  console.log(`Distinct cited: ${cites.size} | max: ${Math.max(...cites, 0)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
