import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { topicalityScore } from "@/lib/citation-audit";

export const runtime = "nodejs";

// Batch-validate citations across ALL paragraphs in a project.
// Returns a per-paragraph summary + an aggregate report.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await db.project.findUnique({
    where: { id },
    include: {
      paragraphs: {
        orderBy: { order: "asc" },
        include: { references: true },
      },
    },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  const normalizeType = (t: string) => {
    const lt = t.toLowerCase();
    if (lt === "pmid") return "pubmed";
    if (lt === "pdb") return "rcsb";
    return lt;
  };

  const expandRange = (inner: string): number[] => {
    const trimmed = inner.trim();
    const nums: number[] = [];
    const parts = trimmed.split(/[,;]\s*/);
    for (const p of parts) {
      const rangeMatch = p.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rangeMatch) {
        const a = parseInt(rangeMatch[1], 10);
        const b = parseInt(rangeMatch[2], 10);
        for (let n = a; n <= b; n++) nums.push(n);
      } else {
        const n = parseInt(p, 10);
        if (!isNaN(n)) nums.push(n);
      }
    }
    return nums;
  };

  const paragraphReports = project.paragraphs.map((p) => {
    const content = p.content;
    const references = p.references;
    const citeHeaderIdx = content.indexOf("### Citations");
    const body = citeHeaderIdx >= 0 ? content.slice(0, citeHeaderIdx) : content;
    const citationsBlock = citeHeaderIdx >= 0 ? content.slice(citeHeaderIdx) : "";

    const markerRe = /\[(\d{1,3}(?:[,\-–]\s*\d{1,3})*|[A-Z]{2,12}:\s?[^\]\n]{1,60})\]/g;
    const markers: { full: string; inner: string; index: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(body))) {
      markers.push({ full: m[0], inner: m[1].trim(), index: m.index });
    }

    // Parse AI citations block
    const aiCitationMap: Record<number, string> = {};
    for (const line of citationsBlock.split("\n")) {
      const lm = line.match(/^\s*\[(\d+)\]\s*(.+)$/);
      if (lm) aiCitationMap[parseInt(lm[1], 10)] = lm[2].trim();
    }

    let validCount = 0;
    let missingCount = 0;
    let suspectCount = 0;
    const missing: string[] = [];

    // Bug #5 fix — extract the sentence around each citation so we can run a
    // topicality check, not just a range check. A citation that is merely in
    // range may still point to an unrelated reference.
    const sentenceAt = (text: string, offset: number): string => {
      let start = offset;
      while (start > 0) {
        const ch = text[start - 1];
        if (ch === "." || ch === "!" || ch === "?" || ch === "\n") break;
        start--;
      }
      let end = offset;
      while (end < text.length) {
        const ch = text[end];
        if (ch === "." || ch === "!" || ch === "?" || ch === "\n") {
          end++;
          break;
        }
        end++;
      }
      return text.slice(start, end).trim();
    };

    for (const marker of markers) {
      const inner = marker.inner;
      const srcMatch = inner.match(/^([A-Z]{2,12}):\s?(.+)$/);
      if (srcMatch) {
        const type = normalizeType(srcMatch[1].toLowerCase());
        const idVal = srcMatch[2].trim();
        const found = references.find((r) => {
          const rType = normalizeType(r.type);
          return (
            rType === type &&
            (r.externalId?.toLowerCase() === idVal.toLowerCase() ||
              r.externalId?.toLowerCase().includes(idVal.toLowerCase()) ||
              idVal.toLowerCase().includes(r.externalId?.toLowerCase() || "___"))
          );
        });
        if (found) validCount++;
        else {
          missingCount++;
          missing.push(marker.full);
        }
      } else {
        const nums = expandRange(inner);
        const sentence = sentenceAt(body, (marker as any).index ?? 0);
        for (const n of nums) {
          const ref = references[n - 1];
          if (!ref && !aiCitationMap[n]) {
            missingCount++;
            missing.push(`[${n}]`);
          } else if (ref) {
            // Bug #5 fix: topicality check on in-range citations.
            const refText = `${ref.title || ""} ${ref.abstract || ""}`;
            const score = topicalityScore(sentence, refText);
            if (score < 0.05) {
              suspectCount++;
            } else {
              validCount++;
            }
          } else {
            validCount++;
          }
        }
      }
    }

    return {
      paragraphId: p.id,
      title: p.title,
      format: p.format,
      status: p.status,
      totalMarkers: markers.length,
      validCount,
      missingCount,
      suspectCount,
      missing,
      hasCitationsBlock: citeHeaderIdx >= 0,
      savedReferenceCount: references.length,
    };
  });

  const aggregate = {
    totalParagraphs: paragraphReports.length,
    totalMarkers: paragraphReports.reduce((s, r) => s + r.totalMarkers, 0),
    totalValid: paragraphReports.reduce((s, r) => s + r.validCount, 0),
    totalMissing: paragraphReports.reduce((s, r) => s + r.missingCount, 0),
    totalSuspect: paragraphReports.reduce((s, r) => s + r.suspectCount, 0),
    paragraphsClean: paragraphReports.filter(
      (r) => r.missingCount === 0 && r.suspectCount === 0
    ).length,
    paragraphsIssues: paragraphReports.filter(
      (r) => r.missingCount > 0 || r.suspectCount > 0
    ).length,
  };

  return NextResponse.json({
    projectId: project.id,
    aggregate,
    paragraphs: paragraphReports,
  });
}
