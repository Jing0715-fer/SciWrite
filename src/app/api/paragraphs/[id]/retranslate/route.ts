import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatStream } from "@/lib/ai";
import { saveSessionMessage } from "@/lib/llm-session";
import { countWords, sanitizeSectionContent } from "@/lib/writing";
import { safeErrorMessage } from "@/lib/api-helpers";
import { translateSectionTitles } from "@/lib/section-title-zh";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * POST /api/paragraphs/[id]/retranslate
 *
 * Re-translate a single paragraph's English content to Chinese.
 * This is useful when:
 *   - The initial translation was low-quality
 *   - The user has revised the English content and wants a fresh translation
 *   - A paragraph was missing its Chinese version
 *
 * The endpoint uses streaming LLM call to translate, preserves inline
 * citations [n] and markdown formatting, and updates the paragraph's
 * contentZh and wordCountZh fields.
 *
 * Returns a JSON response (not a stream) with the updated paragraph.
 * Streaming happens internally — the full translation is awaited before
 * the response is sent. (UI shows a spinner on the button while waiting.)
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const paragraph = await db.paragraph.findUnique({
      where: { id },
    });
    if (!paragraph) {
      return NextResponse.json({ error: "Paragraph not found." }, { status: 404 });
    }

    const enContent = paragraph.content;
    if (!enContent || enContent.trim().length === 0) {
      return NextResponse.json(
        { error: "No English content to translate." },
        { status: 400 }
      );
    }

    // Strip any "### Citations" block — we only translate the body text.
    const citIdx = enContent.indexOf("### Citations");
    const cleanEn = citIdx >= 0 ? enContent.slice(0, citIdx).trim() : enContent.trim();

    const translateSystem =
      "You are a professional scientific translator. Translate English academic text into formal, " +
      "precise Chinese (中文) academic prose. Preserve ALL inline citations [n] EXACTLY as they appear " +
      "(do NOT renumber, do NOT remove). Preserve ALL markdown formatting. Do NOT add any preamble, " +
      "commentary, or section headers — output ONLY the translated Chinese text.";

    const translatePrompt = `Translate the following English scientific section into formal Chinese academic prose.

REQUIREMENTS:
1. Preserve ALL inline citations [n] EXACTLY (e.g. [1], [2,3], [4-6] — keep the numbers unchanged).
2. Preserve ALL markdown formatting (## headings, **bold**, *italic*, lists, etc.).
3. Use formal, precise academic Chinese (书面语，第三人称，结果/方法部分使用过去时).
4. Use domain-correct terminology. Translate technical terms using standard Chinese scientific equivalents.
5. Do NOT add any preamble like "以下是翻译" or "翻译如下". Output ONLY the translated text.
6. Do NOT translate citation numbers, DOIs, URLs, or [SOURCE:ID] markers.
7. Maintain the same paragraph structure and flow.

ENGLISH SECTION:

${cleanEn}`;

    let zhContent = "";
    try {
      zhContent = await chatStream(translatePrompt, {
        system: translateSystem,
        temperature: 0.3,
        thinking: false,
      });
    } catch (err: any) {
      // Fall back to non-streaming chat if chatStream fails
      const { chat } = await import("@/lib/ai");
      zhContent = await chat(translatePrompt, { system: translateSystem, temperature: 0.3 });
    }

    // Sanitize: strip any preamble the LLM may have added despite instructions
    zhContent = zhContent
      .replace(/^(以下是|翻译如下|中文翻译：?|译文：?|Translation:?)\s*\n*/i, "")
      .trim();
    // Also apply general section sanitization to remove postscripts,
    // meta-commentary, horizontal rules, etc.
    zhContent = sanitizeSectionContent(zhContent);

    if (!zhContent) {
      return NextResponse.json(
        { error: "Translation produced empty output." },
        { status: 500 }
      );
    }

    const zhWordCount = countWords(zhContent);

    // round-28: also translate the section TITLE so the Chinese article's
    // headings are Chinese (they used to stay English, which made the zh
    // docx read like a patchwork). Best-effort — falls back to the English
    // title on failure.
    let titleZh: string | null = null;
    if (paragraph.title && paragraph.title.trim()) {
      try {
        const [t] = await translateSectionTitles([paragraph.title.trim()]);
        titleZh = t || null;
      } catch {
        titleZh = null;
      }
    }

    // Save session messages for context continuity
    try {
      await saveSessionMessage(paragraph.projectId, "translate", "user", translatePrompt, {
        step: "retranslate",
        paragraphId: id,
        sectionTitle: paragraph.title,
        sourceChars: cleanEn.length,
      });
      await saveSessionMessage(paragraph.projectId, "translate", "assistant", zhContent, {
        step: "retranslate",
        paragraphId: id,
        sectionTitle: paragraph.title,
        chars: zhContent.length,
      });
    } catch {}

    // Update the paragraph with the new Chinese translation
    const updated = await db.paragraph.update({
      where: { id },
      data: {
        contentZh: zhContent,
        wordCountZh: zhWordCount,
        ...(titleZh ? { titleZh } : {}),
      },
    });

    // Also update the article's contentZh if this paragraph belongs to an article.
    // We re-compose the Chinese article from all paragraphs' contentZh.
    try {
      const ap = await db.articleParagraph.findFirst({
        where: { paragraphId: id },
        include: {
          article: {
            include: {
              articleParagraph: {
                orderBy: { order: "asc" },
                include: { paragraph: { select: { contentZh: true, title: true, titleZh: true } } },
              },
            },
          },
        },
      });
      if (ap?.article) {
        const zhSections: string[] = [];
        for (const apItem of ap.article.articleParagraph) {
          if (apItem.paragraph?.contentZh) {
            // Prefer the Chinese title when present (round-28); fall back to
            // the English title for legacy paragraphs without titleZh.
            const zhTitle = apItem.paragraph.titleZh || apItem.paragraph.title;
            zhSections.push(`## ${zhTitle}\n\n${apItem.paragraph.contentZh}`);
          }
        }
        if (zhSections.length > 0) {
          const zhBody = zhSections.join("\n\n");
          // Append the existing Chinese references section if present
          let fullZh = zhBody;
          if (ap.article.contentZh) {
            const refsIdx = ap.article.contentZh.indexOf("## 参考文献");
            if (refsIdx >= 0) {
              fullZh = zhBody + "\n\n" + ap.article.contentZh.slice(refsIdx);
            }
          }
          await db.article.update({
            where: { id: ap.article.id },
            data: { contentZh: fullZh },
          });
        }
      }
    } catch (err: any) {
      // Non-fatal — paragraph contentZh is updated, article sync is best-effort
      console.warn("[retranslate] failed to sync article contentZh:", err?.message);
    }

    return NextResponse.json({
      paragraph: updated,
      contentZh: zhContent,
      wordCountZh: zhWordCount,
      titleZh,
    });
  } catch (err: any) {
    console.error("[retranslate] error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Re-translation failed.") },
      { status: 500 }
    );
  }
}
