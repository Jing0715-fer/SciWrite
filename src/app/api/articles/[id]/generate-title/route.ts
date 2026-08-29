import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateArticleTitle } from "@/lib/article-title";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/articles/[id]/generate-title
 *
 * Regenerates the article's title from what was actually written. Existing
 * articles composed before the v121 fix stored `project.topic` (the user's
 * project-creation brief — often an instruction like "按照总分总的方式进行生成…")
 * as the Article title, so every export named the file after the brief
 * instead of the article. This endpoint lets users fix such articles with
 * one click: it feeds the outline + opening excerpt to the LLM and stores a
 * journal-grade title (plus a Chinese title when the article has contentZh).
 *
 * Returns { ok, article } — the updated article record.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const article = await db.article.findUnique({
    where: { id },
    include: {
      project: { select: { topic: true } },
      articleParagraph: {
        select: { paragraph: { select: { title: true } } },
        orderBy: { order: "asc" },
      },
    },
  });
  if (!article) {
    return NextResponse.json({ error: "Article not found." }, { status: 404 });
  }

  // Body before the References section; the opening is the title's context.
  const refIdx = (article.content || "").indexOf("## References");
  const body = refIdx >= 0 ? article.content.slice(0, refIdx) : article.content || "";

  if (body.trim().length < 100) {
    return NextResponse.json(
      { error: "Article is too short to generate a meaningful title." },
      { status: 400 },
    );
  }

  // Section titles from the linked paragraphs (fall back to ## headings).
  let sectionTitles = article.articleParagraph
    .map((ap) => ap.paragraph?.title)
    .filter(Boolean) as string[];
  if (sectionTitles.length === 0) {
    sectionTitles = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]);
  }

  try {
    const result = await generateArticleTitle({
      topic: article.project?.topic || article.title,
      sectionTitles,
      excerpt: body.slice(0, 800),
      // A Chinese article (contentZh exists) deserves a Chinese title too.
      wantZh: Boolean(article.contentZh),
    });

    if (!result.generated) {
      return NextResponse.json(
        { error: "Title generation failed — the model returned no usable title. Try again or set the title manually." },
        { status: 502 },
      );
    }

    const updated = await db.article.update({
      where: { id },
      data: {
        title: result.title,
        ...(result.titleZh ? { titleZh: result.titleZh } : {}),
      },
    });

    return NextResponse.json({ ok: true, article: updated });
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err, "Title generation failed.") },
      { status: 500 },
    );
  }
}
