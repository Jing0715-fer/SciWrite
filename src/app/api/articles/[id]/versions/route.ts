import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { countWords } from "@/lib/writing";

export const runtime = "nodejs";

/**
 * GET /api/articles/[id]/versions
 *
 * Lists all version snapshots for an article, newest first.
 * Each version includes id, label, wordCount, createdAt — but NOT the
 * full content (that's fetched on demand by the diff viewer to keep the
 * list response small).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const versions = await db.articleVersion.findMany({
    where: { articleId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      wordCount: true,
      createdAt: true,
      title: true,
    },
  });
  return NextResponse.json({ versions });
}

/**
 * POST /api/articles/[id]/versions
 *
 * Creates a new version snapshot of the article's current content. The
 * user can optionally provide a label (e.g. "before AI revision"). If no
 * label is provided, one is auto-generated from the timestamp.
 *
 * Body: { label?: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const article = await db.article.findUnique({ where: { id } });
  if (!article) {
    return NextResponse.json({ error: "Article not found." }, { status: 404 });
  }

  const label = body.label?.trim() || null;
  const version = await db.articleVersion.create({
    data: {
      articleId: id,
      content: article.content,
      contentZh: article.contentZh,
      title: article.title,
      label,
      wordCount: countWords(article.content),
    },
  });

  return NextResponse.json({ version }, { status: 201 });
}
