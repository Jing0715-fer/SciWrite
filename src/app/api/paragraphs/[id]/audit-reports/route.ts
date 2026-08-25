import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const reports = await db.citationAuditReport.findMany({
    where: { paragraphId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return NextResponse.json({
    paragraphId: id,
    reports: reports.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      checkedCount: r.checkedCount,
      issueCount: r.issueCount,
      fixedCount: r.fixedCount,
      bodyUpdated: r.bodyUpdated,
      contentHash: r.contentHash,
      createdAt: r.createdAt,
      report: JSON.parse(r.reportJson),
    })),
  });
}
