import { chat } from "@/lib/ai";
import { stripReasoning } from "@/lib/writing";

/**
 * Article title generation.
 *
 * Historically the composed Article record stored `project.topic` — the text
 * the user typed when CREATING the project (often a generation instruction,
 * e.g. "按照总分总的方式进行生成，每个家族成员至少有一段单独的段落") — as its
 * title, and every export (docx/pdf/md/...) named the file after it. The fix:
 * after the sections are written, ask the LLM to synthesize a real journal-grade
 * title from what was ACTUALLY written. Falls back to the topic on any failure
 * (timeout, LLM error, unparsable output) so generation never breaks.
 */

export interface GeneratedArticleTitle {
  /** English (or manuscript-language) title. */
  title: string;
  /** Chinese title when requested (language="both"/"Chinese"), else null. */
  titleZh: string | null;
  /** True when the LLM produced the title (false = fell back to topic). */
  generated: boolean;
}

const TITLE_TIMEOUT_MS = 60_000;

/**
 * Ask the LLM for a concise academic title based on the working brief, the
 * section outline and an excerpt of the composed body.
 *
 * @returns never throws — always returns a usable title (fallback = topic).
 */
export async function generateArticleTitle(opts: {
  /** The project topic (user's working brief). Used as fallback and context. */
  topic: string;
  /** Section titles of the outline that was actually written. */
  sectionTitles: string[];
  /** Excerpt of the composed article body (first ~800 chars is enough). */
  excerpt?: string;
  /** Also produce a Chinese title (for bilingual/Chinese generation). */
  wantZh?: boolean;
}): Promise<GeneratedArticleTitle> {
  const { topic, sectionTitles, excerpt = "", wantZh = false } = opts;
  const fallback: GeneratedArticleTitle = { title: topic, titleZh: null, generated: false };

  if (!topic && sectionTitles.length === 0) return fallback;

  const outline = sectionTitles
    .slice(0, 20)
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");

  const system =
    "You are a senior academic journal editor. You write concise, precise, information-dense article titles.";

  const prompt = `Propose the title for a scientific review article that has been fully written.

Working brief the author started from (may be an instruction, NOT a title):
"""
${topic}
"""

Section outline of the finished manuscript:
${outline || "(no outline available)"}

Opening excerpt of the finished manuscript:
"""
${excerpt.slice(0, 800) || "(not available)"}
"""

Rules:
- Title in English, 8–20 words, specific to what the sections actually cover.
- Journal-grade: no clickbait, no quotes, no trailing period, no numbering.
- Do NOT copy the working brief verbatim — synthesize the actual content.
- If a standard domain phrasing exists (e.g. "A Review of ...", "...: A Comprehensive Review"), use it only when it fits naturally.${wantZh ? "\n- Also provide a faithful, natural Chinese translation of that title." : ""}

Output STRICTLY in this format with no extra text, no markdown, no explanation:
TITLE: <english title>${wantZh ? "\nTITLE_ZH: <中文标题>" : ""}`;

  try {
    const raw = await Promise.race([
      chat(prompt, { system, temperature: 0.3, maxTokens: 300 }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TITLE_TIMEOUT_MS)),
    ]);
    if (!raw) return fallback;

    // The title call can also hit a reasoning model — strip think blocks first.
    const cleaned = stripReasoning(raw).trim();
    const enMatch = cleaned.match(/^TITLE:\s*(.+)$/m);
    const zhMatch = cleaned.match(/^TITLE_ZH:\s*(.+)$/m);
    const en = enMatch?.[1]?.trim().replace(/^["“”'«]+|["“”'»]+$/g, "");
    const zh = zhMatch?.[1]?.trim().replace(/^["“”'«]+|["“”'»]+$/g, "");

    if (!en || en.length < 8 || en.length > 300) return fallback;
    return { title: en, titleZh: zh || null, generated: true };
  } catch {
    return fallback;
  }
}
