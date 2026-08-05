import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

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
  const body = await req.json();
  const { articleId, paragraphId, parentId, content } = body;

  if (!content || typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: "Content is required." }, { status: 400 });
  }
  if (!articleId && !paragraphId) {
    return NextResponse.json({ error: "Provide articleId or paragraphId." }, { status: 400 });
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
}
