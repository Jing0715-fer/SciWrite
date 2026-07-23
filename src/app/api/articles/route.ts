import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  const where = projectId ? { projectId } : {};
  const articles = await db.article.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { articleParagraph: true } } },
  });
  return NextResponse.json({ articles });
}
