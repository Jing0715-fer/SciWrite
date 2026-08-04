import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/paragraphs/[id]/restore
 *
 * Restore a soft-deleted paragraph from the trash. Sets deletedAt back to null.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const paragraph = await db.paragraph.update({
      where: { id },
      data: { deletedAt: null },
    });
    return NextResponse.json({ ok: true, paragraph });
  } catch {
    return NextResponse.json(
      { error: "Paragraph not found or already restored." },
      { status: 404 }
    );
  }
}
