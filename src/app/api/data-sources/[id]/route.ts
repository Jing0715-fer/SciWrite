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
  if (body.pinned !== undefined) data.pinned = Boolean(body.pinned);
  if (body.summary !== undefined) data.summary = String(body.summary);
  const source = await db.dataSource.update({ where: { id }, data });
  return NextResponse.json({ dataSource: source });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await db.dataSource.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
