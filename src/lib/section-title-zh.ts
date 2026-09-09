import { chat } from "@/lib/ai";

/**
 * Batch-translate academic section headings from English to Chinese.
 *
 * Round-28: the bilingual pipelines used to compose the Chinese article with
 * the ORIGINAL ENGLISH section titles (`## ${para.title}`), so the exported
 * Chinese docx carried headings like "1. Introduction: The TMC Family…"
 * between fully-Chinese paragraphs. This helper translates all section
 * titles of an article in ONE small LLM call (instead of one call per
 * section), returning a parallel array.
 *
 * Contract:
 *  - Returns an array of exactly `titles.length` entries.
 *  - Entry value: the Chinese title on success; `null` when that title could
 *    not be translated (callers fall back to the English title).
 *  - Titles that already contain CJK are passed through unchanged.
 *  - Total failure (LLM error) → all-null array (never throws — heading
 *    translation must not break generation).
 *
 * round-62: optional `glossary` — the v2 pipeline's domain terminology anchor
 * ("prime editing → 先导编辑" etc.) is injected into the batch prompt so the
 * HEADINGS obey the same standard translations as the body text. Round-61
 * observed the heading batch running before the glossary existed, so titles
 * could drift from the anchored body terminology.
 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function hasCJKText(text: string): boolean {
  return CJK_RE.test(text || "");
}

export async function translateSectionTitles(
  titles: string[],
  opts: { temperature?: number; glossary?: string } = {},
): Promise<(string | null)[]> {
  const result: (string | null)[] = titles.map(() => null);
  if (!titles.length) return result;

  // Titles that are already Chinese pass through as-is.
  titles.forEach((t, i) => {
    if (t && hasCJKText(t)) result[i] = t;
  });

  const toTranslate = titles
    .map((t, i) => ({ t: (t || "").trim(), i }))
    .filter(({ t, i }) => t && !result[i]);

  if (!toTranslate.length) return result;

  const list = toTranslate.map(({ t }, k) => `${k + 1}. ${t}`).join("\n");
  const system =
    "You are a professional scientific translator specializing in academic paper section headings. " +
    "You translate English academic headings into concise, formal Chinese academic headings.";

  const prompt = `Translate the following academic section headings from English into Chinese.

REQUIREMENTS:
1. Use standard Chinese academic section terminology (e.g. Introduction → 引言, Methods → 方法, Results → 结果, Discussion → 讨论, Conclusion → 结论, References → 参考文献).
2. Keep gene/protein names, technical abbreviations (e.g. TMC1, EVER2, ER, pH), numerals, and punctuation like colons unchanged.
3. Keep each heading concise — a faithful academic rendering, never a literal word-by-word expansion (≤ 40 Chinese characters when possible).
4. Where a heading contains a domain term listed in the DOMAIN TERM GLOSSARY below, you MUST use the glossary's exact Chinese translation for that term — never a literal or invented alternative.
5. Do NOT add any preamble or commentary. Output ONLY the numbered translations, one per line, in the SAME order, each on its own line in the exact format:
<number>. <Chinese heading>
${opts.glossary ? "\n" + opts.glossary + "\n" : ""}
HEADINGS:

${list}`;

  let out = "";
  try {
    out = await chat(prompt, { system, temperature: opts.temperature ?? 0.2 });
  } catch {
    return result; // all-null → callers keep English headings
  }

  // Parse numbered lines: "3. 中文标题" / "3、中文标题" / "3: 中文标题"
  const lines = (out || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(\d{1,3})\s*[.、:：)]\s*(.+)$/);
    if (!m) continue;
    const k = parseInt(m[1], 10) - 1;
    if (k < 0 || k >= toTranslate.length) continue;
    let zh = m[2].trim().replace(/\s*[.。]\s*$/, "").trim();
    // Sanity: must actually be Chinese and reasonably heading-sized.
    if (!zh || !hasCJKText(zh) || zh.length > 120) continue;
    result[toTranslate[k].i] = zh;
  }
  return result;
}
