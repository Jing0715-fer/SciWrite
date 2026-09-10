/**
 * round-62/63 ferroptosis production verification.
 */
import { db } from "@/lib/db";

const PROJECT_ID = "cmtuv3j2y0001mapb5g6jvs1a";

async function main() {
  const article = await db.article.findFirst({
    where: { projectId: PROJECT_ID },
    orderBy: { createdAt: "desc" },
  });
  if (!article) { console.log("FAIL: no article"); return; }
  console.log(`article: ${article.id}`);
  console.log(`title: ${article.title}`);
  console.log(`titleZh: ${article.titleZh}`);
  console.log(`hasZh: ${!!article.contentZh}`);

  // citation integrity (mechanical, same as the audit API)
  const content = article.content || "";
  const refIdx = content.indexOf("## References");
  const body = refIdx >= 0 ? content.slice(0, refIdx) : content;
  const refSection = refIdx >= 0 ? content.slice(refIdx) : "";
  const citeNums = new Set<number>();
  const re = /\[(\d+(?:[,\-–]\s*\d+)*)\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    for (const part of m[1].split(/[,;]\s*/)) {
      const rm = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) citeNums.add(n);
      else { const n = parseInt(part); if (!isNaN(n)) citeNums.add(n); }
    }
  }
  const refLines = refSection.split("\n").filter((l) => /^\[\d+\]/.test(l.trim()));
  const refNums = new Set(refLines.map((l) => parseInt(l.trim().replace(/^\[(\d+)\].*/, "$1"))));
  const oor: number[] = [...citeNums].filter((n) => !refNums.has(n)).sort((a, b) => a - b);
  const orphans: number[] = [...refNums].filter((n) => !citeNums.has(n)).sort((a, b) => a - b);
  console.log(`citations: ${citeNums.size} distinct cited / ${refNums.size} refs listed`);
  console.log(`out-of-range: ${oor.length ? oor.join(",") : "NONE"}`);
  console.log(`orphans: ${orphans.length ? orphans.join(",") : "NONE"}`);

  // ref domains
  const paragraphs = await db.paragraph.findMany({ where: { projectId: PROJECT_ID }, include: { references: true } });
  const refMap = new Map<string, string>();
  for (const p of paragraphs) for (const r of p.references) {
    const key = `${(r.type || "").toLowerCase()}:${r.externalId || r.title}`;
    if (!refMap.has(key)) refMap.set(key, r.url || "");
  }
  const domains = new Map<string, number>();
  for (const url of refMap.values()) {
    try {
      const d = url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
      domains.set(d, (domains.get(d) || 0) + 1);
    } catch {}
  }
  console.log(`DB refs: ${refMap.size}; domains: ${JSON.stringify([...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))}`);

  // bilingual parity
  const zh = article.contentZh || "";
  const zhCiteNums = new Set<number>();
  const zhBody = zh.indexOf("## 参考文献") >= 0 ? zh.slice(0, zh.indexOf("## 参考文献")) : zh;
  while ((m = re.exec(zhBody)) !== null) {
    for (const part of m[1].split(/[,;]\s*/)) {
      const rm2 = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm2) for (let n = parseInt(rm2[1]); n <= parseInt(rm2[2]); n++) zhCiteNums.add(n);
      else { const n = parseInt(part); if (!isNaN(n)) zhCiteNums.add(n); }
    }
  }
  const enMiss = [...citeNums].filter((n) => !zhCiteNums.has(n));
  const zhMiss = [...zhCiteNums].filter((n) => !citeNums.has(n));
  console.log(`bilingual citations: EN=${citeNums.size} ZH=${zhCiteNums.size} EN-only=[${enMiss.join(",")}] ZH-only=[${zhMiss.join(",")}]`);
  const enHeads = (body.match(/^##\s+/gm) || []).length;
  const zhHeads = (zhBody.match(/^##\s+/gm) || []).length;
  console.log(`headings: EN=${enHeads} ZH=${zhHeads}`);

  // zh heading titles
  const zhHeadTitles = (zhBody.match(/^##\s+(.+)$/gm) || []).map((s) => s.replace(/^##\s+/, "")).slice(0, 10);
  console.log(`zh headings: ${zhHeadTitles.map((t) => t.slice(0, 22)).join(" | ")}`);

  // terminology check
  const has铁死亡 = zh.includes("铁死亡");
  const hasBadTranslate = /初级编辑|Prime编辑/.test(zh);
  console.log(`terminology: 铁死亡=${has铁死亡} badTerms=${hasBadTranslate}`);

  // review rows
  const reviews = await db.review.findMany({ where: { articleId: article.id }, orderBy: { round: "asc" } });
  console.log(`review rows: ${reviews.length}`);
  for (const r of reviews) {
    const ws = JSON.parse(r.weaknesses || "[]");
    const fc = (Array.isArray(ws) ? ws : []).filter((w: any) => String(w).includes("FACT-CHECK"));
    console.log(`  round ${r.round}: verdict=${r.verdict} overall=${r.scoreOverall} weaknesses=${(Array.isArray(ws) ? ws : []).length} factCheck=${fc.length}${r.revisedContent ? " revised" : ""}`);
    for (const f of fc.slice(0, 2)) console.log(`    ${String(f).slice(0, 130)}`);
  }
  const wc = (content.match(/[A-Za-z]+/g) || []).length;
  console.log(`EN word estimate: ${wc}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
