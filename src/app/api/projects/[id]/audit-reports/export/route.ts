import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const reports = await db.citationAuditReport.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  // Fetch paragraph titles separately (CitationAuditReport has no Prisma
  // relation to Paragraph — just a paragraphId string field).
  const paragraphIds = [...new Set(reports.map((r) => r.paragraphId))];
  const paragraphs = await db.paragraph.findMany({
    where: { id: { in: paragraphIds } },
    select: { id: true, title: true, order: true },
  });
  const paraMap = new Map(paragraphs.map((p) => [p.id, p]));

  const header = [
    "Date", "Paragraph", "Trigger", "Checked", "Issues", "Fixed",
    "Body Updated", "Citation N", "Verdict", "Mismatch Reason",
    "Correction Old", "Correction New", "Correction Reason",
  ];

  const rows: string[][] = [header];

  for (const r of reports) {
    const date = new Date(r.createdAt).toISOString();
    const paraTitle = (paraMap.get(r.paragraphId)?.title || `§${(paraMap.get(r.paragraphId)?.order ?? 0) + 1}`).replace(/"/g, "'").replace(/[\r\n]+/g, " ");
    let report: any = {};
    try { report = JSON.parse(r.reportJson); } catch {}

    const mismatches = report.mismatches || [];
    const corrections = report.corrections || [];

    if (mismatches.length === 0 && corrections.length === 0) {
      rows.push([date, paraTitle, r.trigger, String(r.checkedCount), String(r.issueCount), String(r.fixedCount), r.bodyUpdated ? "yes" : "no", "", "", "", "", "", ""]);
    } else {
      const maxLen = Math.max(mismatches.length, corrections.length);
      for (let i = 0; i < maxLen; i++) {
        const mm = mismatches[i];
        const corr = corrections[i];
        rows.push([
          date, paraTitle, r.trigger,
          String(r.checkedCount), String(r.issueCount), String(r.fixedCount),
          r.bodyUpdated ? "yes" : "no",
          mm ? String(mm.n) : "",
          mm ? mm.verdict : "",
          mm ? (mm.reason || "").replace(/"/g, "'").replace(/[\r\n]+/g, " ") : "",
          corr ? String(corr.oldN) : "",
          corr ? String(corr.newN) : "",
          corr ? (corr.reason || "").replace(/"/g, "'").replace(/[\r\n]+/g, " ") : "",
        ]);
      }
    }
  }

  const csv = rows.map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\r\n");
  const buffer = Buffer.from("\uFEFF" + csv, "utf-8");

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "text/csv;charset=utf-8;",
      "Content-Disposition": `attachment; filename="citation_audit_reports.csv"`,
    },
  });
}
