import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * PATCH /api/comments/[id]
 *
 * Updates a comment's content or resolved status. Body:
 *   { content?: string, resolved?: boolean }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const data: Record<string, unknown> = {};
  if (body.content !== undefined) data.content = String(body.content).trim();
  if (body.resolved !== undefined) data.resolved = Boolean(body.resolved);

  try {
    const comment = await db.comment.update({ where: { id }, data });
    return NextResponse.json({ comment });
  } catch {
    return NextResponse.json({ error: "Comment not found." }, { status: 404 });
  }
}

/**
 * DELETE /api/comments/[id]
 *
 * Deletes a comment. If the comment has replies, they are also deleted
 * (cascade via parentId self-reference — we delete children first).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Delete child replies first (parentId = id)
  await db.comment.deleteMany({ where: { parentId: id } });

  try {
    await db.comment.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Comment not found." }, { status: 404 });
  }
}
