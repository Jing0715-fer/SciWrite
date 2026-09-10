/**
 * round-64 part 2: propagate the fixed article content back into the
 * paragraph rows (title / content / contentZh / wordCount) and rebuild each
 * paragraph's global-numbered reference rows — mirroring exactly what the
 * v2 compose stage does (route.ts ~L2555-2581: deleteMany + createMany with
 * citationOrder = globalNum-1, 1..maxCitedNum).
 *
 * Why: the Full Article viewer reads article.content (already fixed), but
 * the section navigation, per-section word counts, and the paragraph-editing
 * view read the paragraph rows — those still carried the pre-fix text
 * (e.g. "06 Lid Peroxide Repair Enzymes" and the raw RCSB entry).
 */
import { db } from "@/lib/db";
import { countWords } from "@/lib/writing";
import { splitBodyAndReferences, parseReferenceList } from "@/lib/citation-audit";

const AID = "cmtuye5p601atmapbstwzf6v9";
const APPLY = process.argv.includes("--apply");

const article = await db.article.findUnique({ where: { id: AID } });
if (!article) throw new Error("article not found");

/* --- reference metadata: parse the (fixed) ## References list --- */
const { body, referencesText } = splitBodyAndReferences(article.content);
const refMeta = parseReferenceList(referencesText);
console.log("parsed refs:", refMeta.size);

/* extra fields (doi/abstract) from project-level DB rows, keyed by PMID */
const projRefs = await db.reference.findMany({ where: { projectId: article.projectId } });
const byPmid = new Map<string, any>();
for (const r of projRefs) if (r.externalId) byPmid.set(r.externalId, r);
function pmidFromUrl(url?: string | null): string | null {
  const m = (url || "").match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
  return m ? m[1] : null;
}

/* --- split body into sections --- */
function splitSections(text: string): { title: string; body: string }[] {
  const secRe = /^##\s+(.+)$/gm;
  const marks: { title: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = secRe.exec(text))) {
    marks.push({ title: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }
  const out: { title: string; body: string }[] = [];
  for (let i = 0; i < marks.length; i++) {
    const contentEnd = i + 1 < marks.length ? marks[i + 1].start : text.length;
    out.push({ title: marks[i].title, body: text.slice(marks[i].end, contentEnd).trim() });
  }
  return out;
}
const enSecs = splitSections(body);
const zhSecs = splitSections(splitBodyAndReferences(article.contentZh || "").body);
console.log("EN sections:", enSecs.length, "| ZH sections:", zhSecs.length);

/* --- load the article's paragraph links in order --- */
const links = await db.articleParagraph.findMany({ where: { articleId: AID }, orderBy: { order: "asc" } });
if (links.length !== enSecs.length) {
  console.error(`!! link/section count mismatch: ${links.length} vs ${enSecs.length} — abort`);
  process.exit(1);
}

/* --- per-section: citations used (global numbering) --- */
function citedMax(secBody: string): number {
  let max = 0;
  const re = /\[(\d{1,3}(?:[,\-–]\s*\d{1,3})*)\]/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(secBody))) {
    for (const part of mm[1].split(/[,;]\s*/)) {
      const rm = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) {
        for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) if (n > max) max = n;
      } else {
        const n = parseInt(part);
        if (!isNaN(n) && n > max) max = n;
      }
    }
  }
  return max;
}

for (let i = 0; i < links.length; i++) {
  const link = links[i];
  const para = await db.paragraph.findUnique({ where: { id: link.paragraphId } });
  if (!para) continue;
  const en = enSecs[i];
  const zh = zhSecs[i];
  const maxCited = citedMax(en.body);
  const refsToCreate: any[] = [];
  for (let g = 1; g <= maxCited; g++) {
    const meta = refMeta.get(g);
    if (!meta) continue;
    const pmid = pmidFromUrl(meta.url);
    const dbRow = pmid ? byPmid.get(pmid) : undefined;
    refsToCreate.push({
      type: dbRow?.type || (meta.url?.includes("pubmed") ? "pubmed" : "web"),
      externalId: pmid ?? dbRow?.externalId ?? null,
      title: meta.title,
      authors: meta.authors ?? null,
      journal: meta.journal ?? null,
      year: meta.year ?? null,
      url: meta.url ?? null,
      doi: dbRow?.doi ?? null,
      abstract: dbRow?.abstract ?? null,
      projectId: article.projectId,
      paragraphId: para.id,
      citationOrder: g - 1,
    });
  }
  const titleChanged = para.title !== en.title;
  const contentChanged = para.content.trim() !== en.body;
  console.log(
    `§${i + 1} ${en.title.slice(0, 40)} | titleChanged=${titleChanged} contentChanged=${contentChanged} maxCited=${maxCited} refs=${refsToCreate.length} zhLen=${zh?.body.length ?? 0}`,
  );
  if (APPLY) {
    await db.$transaction([
      db.paragraph.update({
        where: { id: para.id },
        data: {
          title: en.title,
          content: en.body,
          ...(zh ? { contentZh: zh.body, wordCountZh: countWords(zh.body) } : {}),
          wordCount: countWords(en.body),
        },
      }),
      db.reference.deleteMany({ where: { paragraphId: para.id } }),
      ...(refsToCreate.length > 0 ? [db.reference.createMany({ data: refsToCreate })] : []),
    ]);
  }
}

if (APPLY) {
  // §6 paragraph title in articleParagraph.section stays as inferred format — fine.
  console.log("\nAPPLIED: paragraph rows + per-section references rebuilt (global numbering).");
} else {
  console.log("\nDry-run only (pass --apply).");
}
process.exit(0);
