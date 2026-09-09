/**
 * round-59 post-production verifier — run AFTER the pipeline completes.
 * Checks: article existence, citation integrity (no OOR/orphans), repair-loop
 * Review rows (rounds, verdicts, FACT-CHECK weaknesses, revisedContent),
 * bilingual parity, paragraph/article consistency.
 */
import { db } from "@/lib/db";

const PROJECT_ID = "cmts0llwl000mllubkabybbly";

function expandCite(inner: string): number[] {
  return inner
    .split(/[,;]\s*/)
    .flatMap((s: string) => {
      const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) {
        const arr: number[] = [];
        for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) arr.push(n);
        return arr;
      }
      const n = parseInt(s);
      return isNaN(n) ? [] : [n];
    });
}

function citedNums(body: string): Set<number> {
  const set = new Set<number>();
  const re = /\[(\d+(?:[,\-–\s]\d+)*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) for (const n of expandCite(m[1])) set.add(n);
  return set;
}

const article = await db.article.findFirst({
  where: { projectId: PROJECT_ID, deletedAt: null },
  orderBy: { createdAt: "desc" },
  include: { reviews: { orderBy: { round: "asc" } } },
});
if (!article) {
  console.log("NO ARTICLE YET");
  process.exit(0);
}
console.log("=== ARTICLE:", article.id, "===");
console.log("title:", article.title);
const refMatch = article.content.match(/\n## References\n\n([\s\S]*)$/);
const refLines = (refMatch ? refMatch[1] : "")
  .split("\n")
  .filter((l: string) => /^\[\d+\]/.test(l.trim()));
const body = refMatch ? article.content.slice(0, refMatch.index) : article.content;
const cited = citedNums(body);
const refCount = refLines.length;
const oor = [...cited].filter((n) => n < 1 || n > refCount);
const orphans: number[] = [];
for (let i = 1; i <= refCount; i++) if (!cited.has(i)) orphans.push(i);
const words = body.split(/\s+/).filter(Boolean).length;
console.log(`body words: ${words} | refs: ${refCount} | distinct cited: ${cited.size}`);
console.log(`out-of-range citations: ${oor.length === 0 ? 0 : oor.join(",")}`);
console.log(`orphan refs (uncited): ${orphans.length === 0 ? 0 : orphans.join(",")}`);
console.log(`contentZh: ${article.contentZh ? article.contentZh.length + " chars" : "MISSING"}`);

// ref list domains (non-primary spot check)
const urls = refLines.map((l: string) => (l.match(/—\s*(https?:\/\/\S+)/) || [])[1] || "");
const domains = urls.map((u: string) => {
  try { return new URL(u).hostname; } catch { return "(none)"; }
});
console.log("ref domains:", JSON.stringify(domains));

// ===== repair-loop review rows =====
console.log(`\n=== REVIEW ROWS (${article.reviews.length}) ===`);
for (const r of article.reviews) {
  const w = JSON.parse(r.weaknesses || "[]") as string[];
  const fact = w.filter((x) => x.startsWith("FACT-CHECK"));
  console.log(
    `round ${r.round}: ${r.verdict} overall=${r.scoreOverall ?? "?"} ` +
    `weaknesses=${w.length} (fact=${fact.length}) ${r.revisedContent ? "→ REVISED" : ""}`,
  );
  for (const f of fact) console.log(`    · ${f.slice(0, 150)}`);
}

// ===== bilingual parity =====
if (article.contentZh) {
  const zhBody = article.contentZh.replace(/\n## 参考文献\n\n[\s\S]*$/, "");
  const enHeads = (body.match(/^##\s/gm) || []).length;
  const zhHeads = (zhBody.match(/^##\s/gm) || []).length;
  const zhRefMatch = article.contentZh.match(/\n## 参考文献\n\n([\s\S]*)$/);
  const zhRefCount = zhRefMatch ? (zhRefMatch[1].match(/^\[\d+\]/gm) || []).length : 0;
  console.log(`\n=== BILINGUAL ===`);
  console.log(`EN headings: ${enHeads} | ZH headings: ${zhHeads} | ZH refs: ${zhRefCount} (EN: ${refCount})`);
  const zhCited = citedNums(zhBody);
  const zhOor = [...zhCited].filter((n) => n < 1 || n > refCount);
  const missingInZh = [...cited].filter((n) => !zhCited.has(n));
  console.log(`ZH out-of-range: ${zhOor.length} | EN-cited-but-not-ZH: ${missingInZh.length}${missingInZh.length ? " → " + missingInZh.join(",") : ""}`);
}

// ===== paragraph ↔ article consistency =====
const ap = await db.articleParagraph.findMany({
  where: { articleId: article.id },
  orderBy: { order: "asc" },
  include: { paragraph: true },
});
let mismatches = 0;
const sectionBodies = body
  .split(/^##\s.*$/m)
  .map((s: string) => s.trim())
  .filter((s: string) => s.length > 0);
for (let i = 0; i < ap.length; i++) {
  const pc = (ap[i].paragraph?.content || "").replace(/\n### Citations[\s\S]*$/, "").trim();
  const ac = sectionBodies[i] || "";
  if (pc.slice(0, 120) !== ac.slice(0, 120)) {
    mismatches++;
    console.log(`paragraph ${i + 1} MISMATCH:\n  para: ${pc.slice(0, 80)}\n  art:  ${ac.slice(0, 80)}`);
  }
}
console.log(`\n=== PARAGRAPH SYNC: ${ap.length} linked, ${mismatches} mismatch(es) ===`);
process.exit(0);
