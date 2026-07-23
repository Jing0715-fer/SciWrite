import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json();
    const paragraph = await db.paragraph.findUnique({ where: { id } });
    if (!paragraph) {
      return NextResponse.json({ error: "Paragraph not found." }, { status: 404 });
    }
    const annotation = await db.annotation.create({
      data: {
        paragraphId: id,
        startOffset: Number(body.startOffset ?? 0),
        endOffset: Number(body.endOffset ?? 0),
        selectedText: String(body.selectedText || ""),
        comment: String(body.comment || ""),
        type: String(body.type || "comment"),
        severity: String(body.severity || "info"),
        resolved: false,
      },
    });
    // mark paragraph as annotated if it's still draft
    if (paragraph.status === "draft") {
      await db.paragraph.update({ where: { id }, data: { status: "annotated" } });
    }
    return NextResponse.json({ annotation });
  } catch (err: any) {
    console.error("[annotate] error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to add annotation." },
      { status: 500 }
    );
  }
}
