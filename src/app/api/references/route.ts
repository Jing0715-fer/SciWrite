import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  const paragraphId = searchParams.get("paragraphId");
  const where: Record<string, unknown> = {};
  if (projectId) where.projectId = projectId;
  if (paragraphId) where.paragraphId = paragraphId;
  const references = await db.reference.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ references });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ref = await db.reference.create({
      data: {
        type: String(body.type || "manual"),
        externalId: body.externalId ? String(body.externalId) : null,
        title: String(body.title || ""),
        authors: body.authors ? String(body.authors) : null,
        journal: body.journal ? String(body.journal) : null,
        year: body.year ? String(body.year) : null,
        url: body.url ? String(body.url) : null,
        doi: body.doi ? String(body.doi) : null,
        abstract: body.abstract ? String(body.abstract) : null,
        citationKey: body.citationKey ? String(body.citationKey) : null,
        paragraphId: body.paragraphId || null,
        projectId: body.projectId || null,
      },
    });
    return NextResponse.json({ reference: ref });
  } catch (err: any) {
    console.error("[/api/references POST] error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to save reference." },
      { status: 500 }
    );
  }
}
