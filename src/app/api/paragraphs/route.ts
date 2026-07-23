import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { countWords } from "@/lib/writing";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  const where = projectId ? { projectId } : {};
  const paragraphs = await db.paragraph.findMany({
    where,
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    include: {
      annotations: { orderBy: { createdAt: "desc" } },
      references: true,
      _count: true,
    },
  });
  return NextResponse.json({ paragraphs });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const projectId = String(body.projectId || "");
    const title = String(body.title || "Untitled paragraph").trim();
    const content = String(body.content || "");
    const format = String(body.format || "background");
    const scenario = String(body.scenario || "literature-review");

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    const count = await db.paragraph.count({ where: { projectId } });
    const paragraph = await db.paragraph.create({
      data: {
        projectId,
        title,
        content,
        format,
        scenario,
        status: body.status ? String(body.status) : "draft",
        order: body.order ?? count,
        wordCount: countWords(content),
      },
    });
    return NextResponse.json({ paragraph });
  } catch (err: any) {
    console.error("[/api/paragraphs POST] error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to create paragraph." },
      { status: 500 }
    );
  }
}
