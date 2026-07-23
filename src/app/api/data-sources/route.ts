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
    const source = await db.dataSource.create({
      data: {
        source: String(body.source || "web"),
        query: String(body.query || ""),
        rawJson: typeof body.rawJson === "string" ? body.rawJson : JSON.stringify(body.rawJson ?? {}),
        summary: body.summary ? String(body.summary) : null,
        title: body.title ? String(body.title) : null,
        externalId: body.externalId ? String(body.externalId) : null,
        url: body.url ? String(body.url) : null,
        projectId: body.projectId || null,
        pinned: Boolean(body.pinned ?? false),
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
