import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const trigger = url.searchParams.get("trigger");
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);

  const where: any = { projectId: id };
  if (trigger === "auto" || trigger === "manual") {
    where.trigger = trigger;
  }

  const reports = await db.citationAuditReport.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 200),
  });

  // Fetch paragraph titles separately (no Prisma relation).
  const paragraphIds = [...new Set(reports.map((r) => r.paragraphId))];
  const paragraphs = await db.paragraph.findMany({
    where: { id: { in: paragraphIds } },
    select: { id: true, title: true, order: true },
  });
  const paraMap = new Map(paragraphs.map((p) => [p.id, p]));

  return NextResponse.json({
    projectId: id,
    reports: reports.map((r) => {
      const para = paraMap.get(r.paragraphId);
      return {
      id: r.id,
      paragraphId: r.paragraphId,
      paragraphTitle: para?.title || "(deleted)",
      paragraphOrder: para?.order ?? 0,
      trigger: r.trigger,
      checkedCount: r.checkedCount,
      issueCount: r.issueCount,
      fixedCount: r.fixedCount,
      bodyUpdated: r.bodyUpdated,
      contentHash: r.contentHash,
      createdAt: r.createdAt,
      report: JSON.parse(r.reportJson),
      };
    }),
  });
}
