import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { countWords } from "@/lib/writing";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const paragraph = await db.paragraph.findUnique({
    where: { id },
    include: {
      annotations: { orderBy: { createdAt: "desc" } },
      references: true,
    },
  });
  if (!paragraph) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json({ paragraph });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const data: Record<string, unknown> = {};
  if (body.title !== undefined) data.title = String(body.title);
  if (body.content !== undefined) {
    data.content = String(body.content);
    data.wordCount = countWords(String(body.content));
  }
  if (body.format !== undefined) data.format = String(body.format);
  if (body.scenario !== undefined) data.scenario = String(body.scenario);
  if (body.status !== undefined) data.status = String(body.status);
  if (body.order !== undefined) data.order = Number(body.order);

  const paragraph = await db.paragraph.update({ where: { id }, data });
  return NextResponse.json({ paragraph });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await db.paragraph.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
