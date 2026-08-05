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
  if (body.name !== undefined) data.name = String(body.name);
  if (body.systemPrompt !== undefined) data.systemPrompt = body.systemPrompt ? String(body.systemPrompt) : null;
  if (body.instruction !== undefined) data.instruction = body.instruction ? String(body.instruction) : null;
  try {
    const template = await db.promptTemplate.update({ where: { id }, data });
    return NextResponse.json({ template });
  } catch {
    return NextResponse.json({ error: "Template not found." }, { status: 404 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Prevent deleting default templates
  const template = await db.promptTemplate.findUnique({ where: { id } });
  if (!template) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (template.isDefault) {
    return NextResponse.json({ error: "Cannot delete a default template." }, { status: 400 });
  }
  await db.promptTemplate.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
