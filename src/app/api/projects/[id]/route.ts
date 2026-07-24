import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await db.project.findUnique({
    where: { id },
    include: {
      paragraphs: {
        orderBy: { order: "asc" },
        include: {
          annotations: { orderBy: { createdAt: "desc" } },
          references: { orderBy: [{ citationOrder: "asc" }, { createdAt: "asc" }] },
          _count: { select: { annotations: true, references: true } },
        },
      },
      dataSources: { orderBy: { createdAt: "desc" } },
      articles: { orderBy: { updatedAt: "desc" }, include: { _count: { select: { articleParagraph: true } } } },
      references: { where: { paragraphId: null }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!project) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Deduplicate references WITHIN each paragraph (same type+externalId = same ref)
  // but allow the same reference to appear in multiple paragraphs
  for (const p of project.paragraphs) {
    const seenInPara = new Set<string>();
    const uniqueRefs = [];
    for (const r of p.references) {
      const key = `${r.type}:${r.externalId || r.title}`;
      if (!seenInPara.has(key)) {
        seenInPara.add(key);
        uniqueRefs.push(r);
      }
    }
    (p as any).references = uniqueRefs;
  }

  return NextResponse.json({ project });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const project = await db.project.update({
    where: { id },
    data: {
      ...(body.title !== undefined ? { title: String(body.title) } : {}),
      ...(body.topic !== undefined ? { topic: String(body.topic) } : {}),
      ...(body.description !== undefined
        ? { description: String(body.description) }
        : {}),
      ...(body.field !== undefined ? { field: String(body.field) } : {}),
      ...(body.status !== undefined ? { status: String(body.status) } : {}),
    },
  });
  return NextResponse.json({ project });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await db.project.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
