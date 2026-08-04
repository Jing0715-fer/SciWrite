import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const data: Record<string, unknown> = {};
  if (body.resolved !== undefined) data.resolved = Boolean(body.resolved);
  if (body.aiResponse !== undefined) data.aiResponse = String(body.aiResponse);
  if (body.severity !== undefined) data.severity = String(body.severity);
  if (body.type !== undefined) data.type = String(body.type);
  if (body.comment !== undefined) data.comment = String(body.comment);
  const annotation = await db.annotation.update({ where: { id }, data });
  return NextResponse.json({ annotation });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await db.annotation.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
