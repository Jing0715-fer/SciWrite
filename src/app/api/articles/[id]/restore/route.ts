import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/articles/[id]/restore
 *
 * Restore a soft-deleted article from the trash. Sets deletedAt back to null
 * so the article reappears in the active articles list. If the article was
 * hard-deleted (not in the database), returns 404.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const article = await db.article.update({
      where: { id },
      data: { deletedAt: null },
    });
    return NextResponse.json({ ok: true, article });
  } catch {
    return NextResponse.json(
      { error: "Article not found or already restored." },
      { status: 404 }
    );
  }
}
