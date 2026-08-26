import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/shared/[token]
 *
 * Returns the project's articles + paragraphs in read-only mode. This is
 * the public-facing endpoint accessed via the share link. No editing
 * capabilities — just the composed articles and their paragraphs.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const project = await db.project.findUnique({
    where: { shareToken: token },
    select: {
      id: true,
      title: true,
      topic: true,
      description: true,
      field: true,
      shareTokenExpiresAt: true,
    },
  });

  if (!project) {
    return NextResponse.json({ error: "Shared project not found or link has been revoked." }, { status: 404 });
  }

  // Enforce the 30-day share-link TTL (legacy tokens without an expiry are
  // grandfathered until the owner re-opens the share dialog).
  if (
    project.shareTokenExpiresAt &&
    project.shareTokenExpiresAt.getTime() <= Date.now()
  ) {
    return NextResponse.json(
      { error: "This share link has expired. Ask the project owner to generate a new one." },
      { status: 410 },
    );
  }

  // Return articles (non-trashed) with their paragraphs
  const articles = await db.article.findMany({
    where: { projectId: project.id, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    include: {
      articleParagraph: {
        orderBy: { order: "asc" },
        include: { paragraph: { select: { title: true, wordCount: true } } },
      },
      _count: { select: { articleParagraph: true } },
    },
  });

  return NextResponse.json({
    project,
    articles: articles.map((a) => ({
      id: a.id,
      title: a.title,
      titleZh: a.titleZh,
      abstract: a.abstract,
      content: a.content,
      contentZh: a.contentZh,
      wordCount: a.content.split(/\s+/).filter(Boolean).length,
      sectionCount: a._count.articleParagraph,
      updatedAt: a.updatedAt,
    })),
  });
}
