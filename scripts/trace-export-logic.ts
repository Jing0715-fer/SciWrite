import { db } from "@/lib/db";

async function main() {
  const articleId = "cmt9irxdu00o8rertvgdk79u3";
  const a = await db.article.findUnique({
    where: { id: articleId },
    include: {
      articleParagraph: {
        include: { paragraph: { include: { references: true, annotations: true } } },
      },
    },
  });
  if (!a) { console.log("article not found"); return; }

  // Replicate the export route's reference loading logic
  const citedRefKeys = new Set<string>();
  const refMap = new Map<string, any>();
  for (const ap of a.articleParagraph) {
    for (const r of ap.paragraph.references) {
      const key = `${r.type}:${r.externalId || r.title}`;
      if (!refMap.has(key)) refMap.set(key, r);
      citedRefKeys.add(key);
    }
  }
  const references = [...refMap.values()];
  console.log(`=== REFERENCES LOADED ===`);
  console.log(`paragraph-derived references count: ${references.length}`);
  for (let i = 0; i < references.length; i++) {
    const r = references[i];
    console.log(`  [${i+1}] ${r.type}:${r.externalId||r.title} — ${r.authors?.slice(0,30)} ${r.year} "${r.title?.slice(0,60)}"`);
  }

  // Build bodyRefPmids from article's "## References" section
  const bodyRefPmids = new Set<string>();
  const refStart = (a.content || "").indexOf("## References");
  if (refStart >= 0) {
    const refSection = a.content.substring(refStart);
    const pmidMatches = [...refSection.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/g)];
    for (const m of pmidMatches) bodyRefPmids.add(m[1]);
  }
  console.log(`\n=== BODY PMIDS (from ## References) ===`);
  console.log(`count: ${bodyRefPmids.size}, list: ${[...bodyRefPmids].join(",")}`);

  // Strip references from content (replicate stripRefsSingle)
  const refHeaderRe = /^#{0,6}\s*\*{0,2}(References|REFERENCES|Citations|Bibliography|文献|参考文献|引用文献|参考资料)\*{0,2}\s*:?\s*$/m;
  const refMatch = a.content.match(refHeaderRe);
  let cleanEnd = a.content.length;
  if (refMatch && refMatch.index !== undefined) cleanEnd = Math.min(cleanEnd, refMatch.index);
  const cleanContent = a.content.slice(0, cleanEnd).trim();

  // maxRefN from paragraph references
  const maxRefN = references.length;
  console.log(`\n=== MAX REF N (paragraph-derived) ===`);
  console.log(`maxRefN = ${maxRefN}`);

  // Scan cleanContent for [n] markers
  const citeMarkerRe2 = /\[(\d{1,3}(?:[,\-–\s]\d{1,3})*)\]/g;
  const citedIndices = new Set<number>();
  let cm2;
  let totalMatches = 0;
  while ((cm2 = citeMarkerRe2.exec(cleanContent))) {
    totalMatches++;
    const nums = cm2[1].split(/[,;]\s*/).flatMap((s: string) => {
      const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) {
        const arr: number[] = [];
        for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) arr.push(n);
        return arr;
      }
      const n = parseInt(s);
      return isNaN(n) ? [] : [n];
    });
    for (const n of nums) {
      if (n >= 1 && n <= maxRefN) citedIndices.add(n);
    }
  }
  console.log(`\n=== CITED INDICES IN CLEAN CONTENT ===`);
  console.log(`total regex matches: ${totalMatches}`);
  console.log(`citedIndices: ${[...citedIndices].sort((a,b)=>a-b).join(",")}`);

  // Compute uncited
  const uncitedRefIndices: number[] = [];
  for (let i = 1; i <= maxRefN; i++) {
    if (!citedIndices.has(i)) uncitedRefIndices.push(i);
  }
  console.log(`\n=== UNCITED ===`);
  console.log(`uncitedRefIndices: [${uncitedRefIndices.join(",")}]`);

  // Also check orphans
  const orphanCitations = new Set<number>();
  const citeMarkerRe = /\[(\d{1,3}(?:[,\-–\s]\d{1,3})*)\]/g;
  let cm;
  while ((cm = citeMarkerRe.exec(cleanContent))) {
    const nums = cm[1].split(/[,;]\s*/).flatMap((s: string) => {
      const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) {
        const arr: number[] = [];
        for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) arr.push(n);
        return arr;
      }
      const n = parseInt(s);
      return isNaN(n) ? [] : [n];
    });
    for (const n of nums) {
      if (n > maxRefN) orphanCitations.add(n);
    }
  }
  console.log(`orphanCitations: [${[...orphanCitations].join(",")}]`);
}
main().catch(e=>console.error(e?.message ?? e)).finally(()=>db.$disconnect());
