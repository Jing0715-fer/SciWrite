import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { countWords } from "@/lib/writing";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const article = await db.article.findUnique({
    where: { id },
    include: {
      articleParagraph: {
        orderBy: { order: "asc" },
        include: { paragraph: true },
      },
    },
  });
  if (!article) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json({ article });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const data: Record<string, unknown> = {};
  if (body.title !== undefined) data.title = String(body.title);
  if (body.abstract !== undefined) data.abstract = String(body.abstract);
  if (body.content !== undefined) {
    data.content = String(body.content);
  }
  const article = await db.article.update({ where: { id }, data });
  return NextResponse.json({ article });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const permanent = url.searchParams.get("permanent") === "true";

  if (permanent) {
    // Hard delete — permanently remove the article and all cascaded records.
    // Used by the trash panel when the user clicks "Delete forever".
    try {
      await db.article.delete({ where: { id } });
      return NextResponse.json({ ok: true, permanent: true });
    } catch {
      // Article not found — return 404 instead of 500
      return NextResponse.json(
        { error: "Article not found." },
        { status: 404 }
      );
    }
  }

  // Soft delete — mark the article as trashed by setting deletedAt. The
  // article stays in the database and can be restored from the trash panel
  // within 30 days. Queries that list active articles filter on
  // deletedAt = null so trashed articles don't clutter the UI.
  await db.article.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return NextResponse.json({ ok: true, permanent: false });
}
