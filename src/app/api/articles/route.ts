import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  const trash = searchParams.get("trash") === "true";

  // Build the where clause:
  // - trash=true  → list only soft-deleted articles (deletedAt != null)
  // - trash=false → list only active articles (deletedAt = null)
  // This keeps the active articles list clean while letting the trash panel
  // fetch trashed articles for restore / permanent-delete actions.
  const where: any = {};
  if (projectId) where.projectId = projectId;
  where.deletedAt = trash ? { not: null } : null;

  const articles = await db.article.findMany({
    where,
    orderBy: trash ? { deletedAt: "desc" } : { updatedAt: "desc" },
    include: { _count: { select: { articleParagraph: true } } },
  });
  return NextResponse.json({ articles });
}
