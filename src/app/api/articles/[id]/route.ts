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
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await db.article.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
