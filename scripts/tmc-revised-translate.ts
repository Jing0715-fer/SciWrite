/**
 * round-55 E2E: translate the REVISED TMC article into Chinese — same
 * chunking + [n]-preserving contract as the v2 pipeline's revised-translate
 * branch (split by ## headings, references stripped and re-attached under
 * "## 参考文献", title translated separately).
 */
import { db } from "/home/z/my-project/src/lib/db";
import { chatWithSession } from "/home/z/my-project/src/lib/llm-session";
import { countWords } from "/home/z/my-project/src/lib/writing";
import { translateSectionTitles } from "/home/z/my-project/src/lib/section-title-zh";

const ARTICLE_ID = "cmtbkit4s00wijmuc2huw7o0l";
const PROJECT_ID = "cmtbk7sjb00erjmucpfif977r";

function numsOf(s: string): Set<number> {
  const set = new Set<number>();
  const re = /\[(\d+(?:[,\-–]\s*\d+)*)\]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    for (const part of m[1].split(/[,;]\s*/)) {
      const rm = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) {
        for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) set.add(n);
      } else {
        const n = parseInt(part);
        if (!isNaN(n)) set.add(n);
      }
    }
  }
  return set;
}

async function main() {
  const article = await db.article.findUnique({ where: { id: ARTICLE_ID } });
  if (!article) throw new Error("article not found");
  const content = article.content!;

  // ---- Split: body before "## References", reference list after it ----
  const refMatch = content.match(/^##\s*References\s*$/m);
  if (!refMatch || refMatch.index === undefined) throw new Error("no References section");
  const refList = content.slice(refMatch.index + refMatch[0].length).trim();
  const body = content.slice(0, refMatch.index).trim();

  // ---- Chunks: split by ## headings (### subsections stay inside parent) ----
  const chunks = body
    .split(/\n(?=^##\s)/)
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`chunks: ${chunks.length} (refs: ${refList.split("\n").length} entries)`);

  // ---- Title translation ----
  let titleZh: string | null = null;
  try {
    const [t] = await translateSectionTitles([article.title]);
    titleZh = t || null;
  } catch {
    titleZh = null;
  }
  console.log(`titleZh: ${titleZh}`);

  const translateSystem =
    "You are a professional scientific translator. Translate English academic text into formal, " +
    "precise Chinese (中文) academic prose. Preserve ALL inline citations [n] EXACTLY as they appear " +
    "(do NOT renumber, do NOT remove). Preserve ALL markdown formatting. Do NOT add any preamble, " +
    "commentary, or section headers — output ONLY the translated Chinese text.";

  const translated: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const heading = (chunk.match(/^##\s+(.+)$/m) || [])[1] || "(section)";
    const t0 = Date.now();
    const prompt = `Translate the following English scientific article part into formal Chinese academic prose.

REQUIREMENTS:
1. Preserve ALL inline citations [n] EXACTLY (e.g. [1], [2,3], [4-6] — keep the numbers unchanged).
2. Preserve ALL markdown formatting (## headings, ### subsections, **bold**, lists) — translate the heading text but keep the heading level.
3. Use formal, precise academic Chinese (书面语，第三人称).
4. Use domain-correct terminology with standard Chinese scientific equivalents.
5. Do NOT add any preamble. Output ONLY the translated text.
6. Do NOT translate citation numbers, DOIs, or URLs.

ENGLISH PART ${i + 1} of ${chunks.length}:

${chunk}`;
    let zh = await chatWithSession(PROJECT_ID, prompt, {
      system: translateSystem,
      temperature: 0.3,
      taskType: "translate",
      metadata: { step: "translate", section: i + 1, revisedArticle: true, script: "tmc-revised-translate" },
    });
    zh = zh.replace(/^(以下是|翻译如下|中文翻译：?|译文：?|Translation:?)\s*\n*/i, "").trim();

    // Citation integrity: zh must carry the same [n] set as the en chunk
    const enNums = numsOf(chunk);
    const zhNums = numsOf(zh);
    const missing = [...enNums].filter((n) => !zhNums.has(n));
    console.log(`  chunk ${i + 1}/${chunks.length} "${heading.slice(0, 48)}": ${countWords(zh)} zh-words, ${enNums.size} en cites${missing.length ? `, MISSING ${missing.join(",")}` : " — cites OK"}`);
    translated.push(zh);
    await new Promise((r) => setTimeout(r, 1500));
  }

  const okCount = translated.filter((c) => c.trim().length > 0).length;
  if (okCount === 0) throw new Error("all chunk translations failed");

  const zhContent = translated.filter((c) => c.trim().length > 0).join("\n\n") + "\n\n## 参考文献\n\n" + refList;

  await db.article.update({
    where: { id: ARTICLE_ID },
    data: {
      contentZh: zhContent,
      ...(titleZh ? { titleZh } : {}),
    },
  });
  console.log(`\nDONE: contentZh=${zhContent.length} chars, titleZh=${titleZh}, refs carried=${refList.split("\n").length}`);
  await (db as any).$disconnect?.();
}
main().catch((e) => { console.error(e); process.exit(1); });
