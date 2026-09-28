import { db } from "/home/z/my-project/src/lib/db";
import fs from "fs";

async function main() {
  const iter = JSON.parse(fs.readFileSync("/home/z/my-project/scripts/tmc-iterate-result.json", "utf-8"));
  console.log(`rounds=${iter.rounds}`);
  for (const r of iter.results) {
    if (r.phase === "review") {
      console.log(`  [review round ${r.round}] verdict=${r.verdict} overall=${r.scores?.overall} novelty=${r.scores?.novelty} clarity=${r.scores?.clarity} methodology=${r.scores?.methodology}`);
    } else if (r.phase === "revise") {
      console.log(`  [revise round ${r.round}] revised length=${r.revised?.length ?? "?"} words≈${(r.revised?.match(/\S+/g) || []).length}`);
    }
  }
  // Verify DB state: article updated + version snapshot + review rows
  const article = await db.article.findUnique({ where: { id: "cmtbkit4s00wijmuc2huw7o0l" } });
  console.log(`\narticle.content: ${article?.content?.length} chars (pre-revision was 17941)`);
  const versions = await db.articleVersion.findMany({ where: { articleId: "cmtbkit4s00wijmuc2huw7o0l" }, orderBy: { createdAt: "desc" } });
  for (const v of versions.slice(0, 3)) {
    console.log(`version: label="${v.label}" ${v.content.length}ch created=${v.createdAt.toISOString()}`);
  }
  const reviews = await db.review.findMany({ where: { articleId: "cmtbkit4s00wijmuc2huw7o0l" }, orderBy: { createdAt: "asc" } });
  for (const r of reviews) {
    console.log(`review row: round=${r.round} verdict=${r.verdict} overall=${r.scoreOverall} created=${r.createdAt.toISOString()}`);
  }
  // Did the revision address the weaknesses? check methodology section + references preserved
  const c = article?.content || "";
  const hasMethodology = /methodolog/i.test(c);
  const nums = [...c.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  console.log(`\nrevised content: methodology-mention=${hasMethodology}, inline cites=${nums.length}, maxN=${nums.length ? Math.max(...nums) : 0}`);
  const refLines = (c.match(/^\[\d+\]/gm) || []).length;
  console.log(`reference list entries: ${refLines}`);
  const firstWords = (iter.results.find((r: any) => r.phase === "revise")?.revised || "").slice(0, 300);
  console.log(`\nrevised head: ${firstWords}`);
  await (db as any).$disconnect?.();
}
main().catch((e) => { console.error(e); process.exit(1); });
