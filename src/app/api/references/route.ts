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
    const type = String(body.type || "manual");
    const externalId = body.externalId ? String(body.externalId) : null;

    // Layer 4 — identity-based deduplication. Prevents the same reference
    // (same project + type + externalId, or same project + DOI) from being
    // saved multiple times. The compose step collapses duplicates at render
    // time, but the DB should not accumulate junk rows in the first place.
    if (body.projectId && externalId) {
      const existing = await db.reference.findFirst({
        where: {
          projectId: body.projectId,
          type,
          externalId,
          paragraphId: body.paragraphId || null,
        },
      });
      if (existing) {
        // Return the existing reference instead of creating a duplicate.
        return NextResponse.json({ reference: existing, deduplicated: true });
      }
    }
    // Also dedup by DOI when an externalId-based match was not found.
    if (body.projectId && body.doi) {
      const existingByDoi = await db.reference.findFirst({
        where: {
          projectId: body.projectId,
          doi: String(body.doi),
          paragraphId: body.paragraphId || null,
        },
      });
      if (existingByDoi) {
        return NextResponse.json({ reference: existingByDoi, deduplicated: true });
      }
    }

    const ref = await db.reference.create({
      data: {
        type,
        externalId,
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
    return NextResponse.json({ reference: ref, deduplicated: false });
  } catch (err: any) {
    console.error("[/api/references POST] error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to save reference." },
      { status: 500 }
    );
  }
}
