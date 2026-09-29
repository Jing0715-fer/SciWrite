/**
 * RT-2 post-test audit — run after the orchestrator writes rt2-test-report.json.
 * Pulls the produced article, audits EN/ZH format quality, citation parity,
 * TMC-member coverage (the user's per-member requirement), and exports
 * markdown for manual inspection.
 */
import fs from "fs";
import { db } from "@/lib/db";
import { countWords } from "@/lib/writing";

function auditHalf(name: string, content: string, isZh: boolean) {
  const heads = content.match(/^##\s+(.+)$/gm) || [];
  const refIdx = content.lastIndexOf("## References");
  const body = refIdx >= 0 ? content.slice(0, refIdx) : content;
  const cjk = (body.match(/[\u4e00-\u9fff]/g) || []).length;
  const listLines = body.split("\n").filter((l) => /^\s*[-*+]\s|^\s*\d+\.\s/.test(l)).length;
  const bold = (content.match(/\*\*/g) || []).length;
  const refLines = refIdx >= 0 ? content.slice(refIdx).split("\n").filter((l) => /^\[\d+\]/.test(l.trim())).length : 0;
  const cites = new Set<number>();
  for (const m of body.matchAll(/\[(\d+(?:,\d+)*)\]/g)) m[1].split(",").forEach((n) => cites.add(parseInt(n)));
  const secBlocks = content.split(/^##\s+/m).slice(1, refIdx >= 0 ? undefined : undefined);
  const paras = secBlocks.map((b) => b.replace(/^.*\n/, "").trim().split(/\n\s*\n/).filter((p) => p.trim()).length);
  console.log(`\n===== ${name} =====`);
  console.log(`words: ${isZh ? content.length + " chars" : countWords(content)} | sections: ${heads.length - (refIdx >= 0 ? 1 : 0)}`);
  console.log(`headings: ${heads.slice(0, 14).map((h) => h.replace(/^##\s+/, "")).join(" | ").slice(0, 220)}`);
  console.log(`refs: ${refLines} entries | distinct cited: ${cites.size} | max: ${Math.max(...cites, 0)}`);
  console.log(`${isZh ? "latin-in-ZH check (info)" : "CJK in EN"}: ${cjk} | list-lines: ${listLines} | bold ${bold % 2 === 0 ? "balanced" : "UNBALANCED"} | paras/section: [${paras.join(",")}]`);
  return { cites, heads };
}

async function main() {
  const report = JSON.parse(fs.readFileSync("/home/z/my-project/iteration-state/rt2-test-report.json", "utf8"));
  console.log(`outcome: ${report.outcome} | duration: ${Math.round((report.ms || 0) / 60000)} min | events: ${report.events}`);
  if (!report.articleId) { console.log("no article produced — abort audit"); return; }
  const article = await db.article.findUnique({ where: { id: report.articleId } });
  if (!article) { console.log("article not found:", report.articleId); return; }
  console.log(`title: ${article.title}`);
  console.log(`titleZh: ${article.titleZh || "(none)"}`);
  const en = article.content || "";
  const zh = article.contentZh || "";
  const enRes = auditHalf("EN half", en, false);
  const zhRes = zh ? auditHalf("ZH half", zh, true) : null;
  if (zhRes) {
    // citation parity
    const missingInZh = [...enRes.cites].filter((n) => !zhRes.cites.has(n));
    const extraInZh = [...zhRes.cites].filter((n) => !enRes.cites.has(n));
    console.log(`\ncitation parity: EN ${enRes.cites.size} vs ZH ${zhRes.cites.size} | missing-in-ZH: [${missingInZh.join(",")}] | hallucinated-in-ZH: [${extraInZh.join(",")}]`);
    const enHeads = enRes.heads.length, zhHeads = zhRes.heads.length;
    console.log(`structural parity: EN ${enHeads} vs ZH ${zhHeads} sections ${enHeads === zhHeads ? "✓" : "✗ MISMATCH"}`);
  } else {
    console.log("\n!! ZH half MISSING — translate stage failed/skipped");
  }
  // TMC member coverage (user requirement: each member dedicated coverage)
  const full = en + "\n" + zh;
  console.log("\n===== TMC member coverage =====");
  for (let n = 1; n <= 8; n++) {
    const re = new RegExp(`TMC${n}[^0-9]`, "g");
    const mentions = (full.match(re) || []).length;
    console.log(`  TMC${n}: ${mentions} mentions ${mentions >= 3 ? "✓" : mentions >= 1 ? "~" : "✗ MISSING"}`);
  }
  // fetch DB refs for a sample of citation correctness
  const refs = await db.reference.findMany({
    where: { articleId: report.articleId },
    orderBy: { citationOrder: "asc" },
    take: 30,
  });
  console.log(`\nDB reference rows: ${refs.length}`);
  refs.slice(0, 8).forEach((r, i) => console.log(`  [${i + 1}] ${String(r.authors || "?").slice(0, 30)} (${r.year || "?"}) ${String(r.title || "").slice(0, 60)}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
