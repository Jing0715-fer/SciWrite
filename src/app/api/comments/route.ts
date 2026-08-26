import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";

/** Max comment length — guards against multi-MB payloads bloating the SQLite DB. */
const MAX_COMMENT_LEN = 10_000;

/**
 * GET /api/comments?articleId=...&paragraphId=...
 *
 * Lists comments for an article or paragraph, including replies (threaded
 * via parentId). Ordered oldest-first within each thread.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const articleId = searchParams.get("articleId");
  const paragraphId = searchParams.get("paragraphId");

  if (!articleId && !paragraphId) {
    return NextResponse.json({ error: "Provide articleId or paragraphId." }, { status: 400 });
  }

  const where: any = {};
  if (articleId) where.articleId = articleId;
  if (paragraphId) where.paragraphId = paragraphId;

  const comments = await db.comment.findMany({
    where,
    orderBy: [{ createdAt: "asc" }],
  });

  return NextResponse.json({ comments });
}

/**
 * POST /api/comments
 *
 * Creates a new comment. Body:
 *   { articleId?, paragraphId?, parentId?, content }
 *
 * Either articleId or paragraphId must be provided (the comment is attached
 * to one or the other). parentId links a reply to its parent comment.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { articleId, paragraphId, parentId, content } = body;

  if (!content || typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: "Content is required." }, { status: 400 });
  }
  // FIX (code review): content had no length cap — a buggy client could post
  // a 10MB comment and bloat the SQLite database.
  if (content.length > MAX_COMMENT_LEN) {
    return NextResponse.json(
      { error: `Comment exceeds the ${MAX_COMMENT_LEN.toLocaleString()}-character limit.` },
      { status: 400 }
    );
  }
  if (!articleId && !paragraphId) {
    return NextResponse.json({ error: "Provide articleId or paragraphId." }, { status: 400 });
  }

  try {
    // FIX (code review): FK existence checks. Previously arbitrary IDs were
    // persisted — orphan comments and cross-article reply threads that broke
    // the threaded display.
    if (articleId) {
      const article = await db.article.findUnique({ where: { id: articleId }, select: { id: true } });
      if (!article) {
        return NextResponse.json({ error: "Article not found." }, { status: 404 });
      }
    }
    if (paragraphId) {
      const paragraph = await db.paragraph.findUnique({ where: { id: paragraphId }, select: { id: true } });
      if (!paragraph) {
        return NextResponse.json({ error: "Paragraph not found." }, { status: 404 });
      }
    }
    if (parentId) {
      const parent = await db.comment.findUnique({ where: { id: parentId }, select: { articleId: true, paragraphId: true } });
      if (!parent) {
        return NextResponse.json({ error: "Parent comment not found." }, { status: 404 });
      }
      // A reply must belong to the same article/paragraph as its parent —
      // otherwise cross-article threads corrupt the threaded display.
      const sameArticle = articleId ? parent.articleId === articleId : !parent.articleId;
      const sameParagraph = paragraphId ? parent.paragraphId === paragraphId : !parent.paragraphId;
      if (!sameArticle || !sameParagraph) {
        return NextResponse.json(
          { error: "Reply must belong to the same article/paragraph as its parent comment." },
          { status: 400 }
        );
      }
    }

    const comment = await db.comment.create({
      data: {
        articleId: articleId || null,
        paragraphId: paragraphId || null,
        parentId: parentId || null,
        content: content.trim(),
      },
    });

    return NextResponse.json({ comment }, { status: 201 });
  } catch (err) {
    console.error("[api/comments POST]", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to create comment.") },
      { status: 500 }
    );
  }
}
