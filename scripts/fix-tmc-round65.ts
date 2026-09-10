/**
 * Round-65 data fix: repair the 3 defect instances found in the TMC
 * regeneration article (article cmtvq6p5k01dwqpvcdw1q8woi).
 *
 *   F1  ref [4] is a Google-Scholar-scraped duplicate of ref [5]
 *       (confabulated authors "Zhang X, Nam J, Woo J", year 2021, bare
 *       nature.com URL, no PMID/DOI; abstract is a Scholar snippet).
 *       → merge: [4]-citations point at the real Jeong 2022 paper, drop the
 *       fake entry, renumber refs [5]-[20] → [4]-[19] everywhere
 *       (article EN/ZH + 9 paragraphs EN/ZH + §2's paragraph reference rows).
 *   F2  §2 calls the third component of the C. elegans TMC-1 complex "an
 *       unidentified transmembrane protein" — the Jeong 2022 abstract names
 *       it as TMIE. → fix wording (verbatim-faithful), EN + ZH.
 *   F3  §4 cites the TMC1-mature/TMC2-immature expression claim to [9]
 *       (Jiang 2024, nematode TMC adaptation — does not support it).
 *       → re-anchor to [2,3] (the comprehensive reviews covering TMC
 *       expression patterns), EN + ZH.
 *
 * Run: bun scripts/fix-tmc-round65.ts
 */
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const ARTICLE_ID = "cmtvq6p5k01dwqpvcdw1q8woi";
const FAKE_URL = "https://www.nature.com";
const REFS_HEADING_EN = "## References";
const REFS_HEADING_ZH = "## 参考文献";

// --- F2: TMIE wording (marker [5] gets remapped to [4] later) ---
const F2_EN_OLD =
  "The cryo-electron microscopy structure of the TMC-1 complex from *C. elegans* reveals a two-fold symmetric arrangement composed of two copies each of TMC-1, CALM-1, and an unidentified transmembrane protein [5].";
const F2_EN_NEW =
  "The cryo-electron microscopy structure of the TMC-1 complex from *C. elegans* reveals a two-fold symmetric arrangement composed of two copies each of the pore-forming TMC-1 subunit, the calcium-binding protein CALM-1, and the transmembrane inner ear protein TMIE [5].";
const F2_ZH_OLD = "由两个TMC-1、CALM-1和一个未知的跨膜蛋白组成[5]。";
const F2_ZH_NEW = "由成孔亚基TMC-1、钙结合蛋白CALM-1和跨膜内耳蛋白TMIE各两个拷贝组成[5]。";

// --- F3: §4 re-anchor ([9] → [2,3]; numbers unaffected by the merge) ---
const F3_EN_OLD =
  "While TMC1 is predominantly expressed in mature auditory hair cells, TMC2 exhibits a complementary expression pattern, being more abundant in immature hair cells and vestibular systems, suggesting specialized roles in different developmental stages and sensory modalities [9].";
const F3_EN_NEW =
  "While TMC1 carries transduction in mature auditory hair cells, TMC2 exhibits a complementary expression pattern across development and sensory organs, contributing to mechanotransduction in immature hair cells and vestibular systems [2,3].";
const F3_ZH_OLD =
  "虽然TMC1主要在成熟的听觉毛细胞中表达，但TMC2表现出互补的表达模式，在不成熟的毛细胞和前庭系统中更为丰富，这表明它们在不同发育阶段和感觉模式中具有专门的作用[9]。";
const F3_ZH_NEW =
  "TMC1在成熟的听觉毛细胞中承担转导功能，而TMC2在发育过程和感觉器官中呈现互补的表达模式，在不成熟的毛细胞和前庭系统中参与机械转导[2,3]。";

/** Remap citation markers: fake [4] → real paper (old 5), then old ≥5 → n-1. */
function remapMarkers(text: string): string {
  if (!text) return text;
  return text.replace(/\[(\d+(?:[,\s–-]+\d+)*)\]/g, (_m, inner: string) => {
    const parts = inner.split(/([,\s–-]+)/).filter((p: string) => p !== "");
    const out: string[] = [];
    for (const part of parts) {
      if (/^\d+$/.test(part)) {
        let n = parseInt(part);
        if (n === 4) n = 5; // fake [4] merges into the real Jeong entry (old 5)
        if (n >= 5) n -= 1; // old [5..20] → new [4..19]
        out.push(String(n));
      } else out.push(part);
    }
    return `[${out.join("")}]`;
  });
}

/** Sort + dedupe compound markers: "[6,4]" → "[4,6]". */
function tidyMarkers(text: string): string {
  return text.replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (_m, inner: string) => {
    const nums = [...new Set(inner.split(/\s*,\s*/).map((n: string) => parseInt(n)))].sort((a, b) => a - b);
    return `[${nums.join(",")}]`;
  });
}

/** Drop the fake entry + renumber the rest in a references block. */
function rebuildRefsBlock(refsBlock: string, heading: string): string {
  const lines = refsBlock.replace(new RegExp(`^${heading}\\s*`, "i"), "").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\[(\d+)\]\s*(.*)$/);
    if (!m) { if (line.trim()) kept.push(line); continue; }
    const n = parseInt(m[1]);
    const rest = m[2];
    if (rest.includes(FAKE_URL) && /Zhang X/.test(rest)) continue; // drop the fake
    kept.push(`[${n >= 5 ? n - 1 : n}] ${rest}`);
  }
  return heading + "\n\n" + kept.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

async function main() {
  const article = await db.article.findUnique({ where: { id: ARTICLE_ID } });
  if (!article) throw new Error("article not found");
  let content = article.content || "";
  let contentZh = article.contentZh || "";
  const applied: string[] = [];

  // ---- F2 + F3 wording (before marker remap) ----
  for (const [name, oldS, newS, target] of [
    ["F2-EN", F2_EN_OLD, F2_EN_NEW, "en"],
    ["F3-EN", F3_EN_OLD, F3_EN_NEW, "en"],
    ["F2-ZH", F2_ZH_OLD, F2_ZH_NEW, "zh"],
    ["F3-ZH", F3_ZH_OLD, F3_ZH_NEW, "zh"],
  ] as const) {
    const t = target === "en" ? content : contentZh;
    if (!t.includes(oldS)) throw new Error(`${name} anchor not found`);
    if (target === "en") content = content.replace(oldS, newS);
    else contentZh = contentZh.replace(oldS, newS);
    applied.push(name);
  }

  // ---- F1: marker remap + references rebuild (EN) ----
  const refIdx = content.indexOf(REFS_HEADING_EN);
  if (refIdx < 0) throw new Error("EN references block not found");
  const body = tidyMarkers(remapMarkers(content.slice(0, refIdx)));
  content = body + rebuildRefsBlock(content.slice(refIdx), REFS_HEADING_EN);

  // ---- F1 (ZH) ----
  const zhRefIdx = contentZh.indexOf(REFS_HEADING_ZH);
  if (zhRefIdx < 0) throw new Error("ZH references block not found");
  const zhBody = tidyMarkers(remapMarkers(contentZh.slice(0, zhRefIdx)));
  contentZh = zhBody + rebuildRefsBlock(contentZh.slice(zhRefIdx), REFS_HEADING_ZH);

  // ---- paragraphs: marker remap EN+ZH, drop fake ref rows, normalize orders ----
  const aps = await db.articleParagraph.findMany({
    where: { articleId: ARTICLE_ID },
    orderBy: { order: "asc" },
    include: { paragraph: { include: { references: true } } },
  });
  let droppedRows = 0, updatedParas = 0;
  for (const ap of aps) {
    const p = ap.paragraph;
    const newC = tidyMarkers(remapMarkers(p.content || ""));
    const newCZh = tidyMarkers(remapMarkers(p.contentZh || ""));
    if (newC !== p.content || newCZh !== p.contentZh) {
      await db.paragraph.update({ where: { id: p.id }, data: { content: newC, contentZh: newCZh } });
      updatedParas++;
    }
    const fakeRows = p.references.filter((r) => (r.url || "") === FAKE_URL && /Zhang X/.test(r.authors || ""));
    if (fakeRows.length > 0) {
      for (const fr of fakeRows) { await db.reference.delete({ where: { id: fr.id } }); droppedRows++; }
      const remaining = p.references.filter((r) => !fakeRows.includes(r));
      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i].citationOrder !== i) {
          await db.reference.update({ where: { id: remaining[i].id }, data: { citationOrder: i } });
        }
      }
    }
  }

  await db.article.update({ where: { id: ARTICLE_ID }, data: { content, contentZh } });

  // ---- verification ----
  const refCount = (content.match(/^\[\d+\]/gm) || []).length;
  const zhRefCount = (contentZh.match(/^\[\d+\]/gm) || []).length;
  const bodyNums = [...new Set(
    (body.match(/\[(\d+(?:,\d+)*)\]/g) || []).flatMap((m: string) => m.slice(1, -1).split(",").map(Number)),
  )];
  const outOfRange = bodyNums.filter((n) => n < 1 || n > refCount);
  console.log(`applied: ${applied.join(", ")}`);
  console.log(`EN refs: ${refCount} (was 20) | ZH refs: ${zhRefCount} | distinct cited: ${bodyNums.length} | out-of-range: ${outOfRange.length ? outOfRange.join(",") : "none"}`);
  console.log(`paragraphs updated: ${updatedParas} | fake ref rows deleted: ${droppedRows}`);
  console.log(`fake-entry residue: ${content.includes(FAKE_URL) ? "STILL PRESENT" : "gone"}`);
  console.log(`unidentified-TMIE residue: ${content.includes("unidentified transmembrane") ? "STILL PRESENT" : "gone"}`);
  console.log(`[9]-expression-claim residue: ${content.includes(F3_EN_OLD.slice(0, 60)) ? "STILL PRESENT" : "gone"}`);
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
