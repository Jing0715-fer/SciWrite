import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { countWords } from "@/lib/writing";

export const runtime = "nodejs";

/**
 * GET /api/articles/[id]/versions/[versionId]
 *
 * Returns the full content of a specific version snapshot. Used by the
 * diff viewer to fetch two versions for comparison.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> }
) {
  const { id, versionId } = await params;
  const version = await db.articleVersion.findFirst({
    where: { id: versionId, articleId: id },
  });
  if (!version) {
    return NextResponse.json({ error: "Version not found." }, { status: 404 });
  }
  return NextResponse.json({ version });
}

/**
 * POST /api/articles/[id]/versions/[versionId]/restore
 *
 * Restores the article to a previous version: copies the version's content
 * back to the article AND creates a new version snapshot of the current
 * content first (so the user can undo the restore).
 *
 * We handle this via a query param `?restore=true` on POST to avoid
 * creating another route file.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> }
) {
  const { id, versionId } = await params;
  const url = new URL(req.url);
  const isRestore = url.searchParams.get("restore") === "true";

  if (!isRestore) {
    return NextResponse.json(
      { error: "Use ?restore=true to restore a version." },
      { status: 400 }
    );
  }

  const article = await db.article.findUnique({ where: { id } });
  if (!article) {
    return NextResponse.json({ error: "Article not found." }, { status: 404 });
  }

  const version = await db.articleVersion.findFirst({
    where: { id: versionId, articleId: id },
  });
  if (!version) {
    return NextResponse.json({ error: "Version not found." }, { status: 404 });
  }

  // 1. Save the CURRENT content as a new version (undo safety net)
  await db.articleVersion.create({
    data: {
      articleId: id,
      content: article.content,
      contentZh: article.contentZh,
      title: article.title,
      label: `Before restore of ${version.label || "v" + versionId.slice(-4)}`,
      wordCount: countWords(article.content),
    },
  });

  // 2. Copy the old version's content back to the article
  const updated = await db.article.update({
    where: { id },
    data: {
      content: version.content,
      contentZh: version.contentZh,
      title: version.title,
    },
  });

  return NextResponse.json({ ok: true, article: updated });
}
