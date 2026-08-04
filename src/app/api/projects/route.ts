import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const projects = await db.project.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      _count: {
        select: { paragraphs: true, articles: true, dataSources: true },
      },
    },
  });
  return NextResponse.json({ projects });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const title = String(body.title || "").trim();
    const topic = String(body.topic || "").trim();
    if (!title || !topic) {
      return NextResponse.json(
        { error: "Title and topic are required." },
        { status: 400 }
      );
    }
    const project = await db.project.create({
      data: {
        title,
        topic,
        description: body.description ? String(body.description) : null,
        field: body.field ? String(body.field) : null,
        status: "active",
      },
    });
    return NextResponse.json({ project });
  } catch (err: any) {
    console.error("[/api/projects POST] error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to create project." },
      { status: 500 }
    );
  }
}
