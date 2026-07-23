import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  const where = projectId ? { projectId } : {};
  const sources = await db.dataSource.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ dataSources: sources });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    // Extract enhanced metadata from the rawJson items if present
    const rawJson = typeof body.rawJson === "string" ? body.rawJson : JSON.stringify(body.rawJson ?? {});
    let item: any = null;
    try {
      const parsed = JSON.parse(rawJson);
      item = parsed.items?.[0] || parsed;
    } catch {}

    const source = await db.dataSource.create({
      data: {
        source: String(body.source || "web"),
        query: String(body.query || ""),
        rawJson,
        summary: body.summary ? String(body.summary) : null,
        title: body.title ? String(body.title) : item?.title || null,
        externalId: body.externalId ? String(body.externalId) : item?.externalId || null,
        url: body.url ? String(body.url) : item?.url || null,
        projectId: body.projectId || null,
        pinned: Boolean(body.pinned ?? false),
        // Enhanced metadata
        authors: body.authors || item?.authors || null,
        journal: body.journal || item?.journal || null,
        year: body.year || item?.year || null,
        doi: body.doi || item?.doi || null,
        abstract: body.abstract || item?.abstract || null,
        keywords: body.keywords
          ? (typeof body.keywords === "string" ? body.keywords : JSON.stringify(body.keywords))
          : item?.keywords
          ? JSON.stringify(item.keywords)
          : null,
        extra: body.extra
          ? (typeof body.extra === "string" ? body.extra : JSON.stringify(body.extra))
          : item?.extra
          ? JSON.stringify(item.extra)
          : null,
      },
    });
    return NextResponse.json({ dataSource: source });
  } catch (err: any) {
    console.error("[/api/data-sources POST] error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to save data source." },
      { status: 500 }
    );
  }
}
