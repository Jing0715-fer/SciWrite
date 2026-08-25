import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  validateCitationsInline,
  type AuditRef,
} from "@/lib/citation-audit";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/projects/[id]/batch-auto-fix-citations
 *
 * Batch auto-fix: runs the paragraph-level auto-fix-citations flow on every
 * paragraph in the project that has blocking citation findings (out-of-range
 * or missing references). This is the "one-click fix" behind the
 * CitationHealthDashboard's batch button.
 *
 * Flow per paragraph:
 *   1. Re-validate inline (validateCitationsInline) to get the current
 *      blocking findings.
 *   2. If blocking > 0, call the existing /api/paragraphs/[id]/auto-fix-citations
 *      endpoint (internal sub-request) to resolve missing citations via the
 *      LLM + database query pipeline.
 *   3. After auto-fix, re-validate to confirm the fix worked.
 *
 * Returns a per-paragraph result + aggregate stats so the UI can show
 * "Fixed 12 of 18 blocking citations across 4 paragraphs".
 *
 * NOTE: this endpoint does NOT modify paragraph content — it only ADDS
 * references to fill missing/out-of-range slots. The actual content
 * sanitization (replacing [n] with [$REF]) happens at write/regenerate time.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await db.project.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  const paragraphs = await db.paragraph.findMany({
    where: { projectId: id, deletedAt: null },
    orderBy: { order: "asc" },
    include: { references: { orderBy: { citationOrder: "asc" } } },
  });

  const results: {
    paragraphId: string;
    title: string;
    beforeBlocking: number;
    afterBlocking: number;
    fixed: number;
    skipped: boolean;
    error?: string;
  }[] = [];

  let totalBeforeBlocking = 0;
  let totalAfterBlocking = 0;
  let totalFixed = 0;

  for (const p of paragraphs) {
    const beforeFindings = validateCitationsInline(
      p.content,
      p.references as AuditRef[]
    );
    const beforeBlocking = beforeFindings.filter(
      (f) => f.verdict === "out-of-range" || f.verdict === "missing"
    ).length;

    if (beforeBlocking === 0) {
      results.push({
        paragraphId: p.id,
        title: p.title,
        beforeBlocking: 0,
        afterBlocking: 0,
        fixed: 0,
        skipped: true,
      });
      continue;
    }

    totalBeforeBlocking += beforeBlocking;

    try {
      // Call the paragraph-level auto-fix endpoint (internal sub-request).
      // This uses the LLM to suggest database queries, executes them, and
      // saves found references to the paragraph.
      const fixRes = await fetch(
        `http://localhost:3000/api/paragraphs/${p.id}/auto-fix-citations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );
      if (!fixRes.ok) {
        const txt = await fixRes.text().catch(() => "");
        results.push({
          paragraphId: p.id,
          title: p.title,
          beforeBlocking,
          afterBlocking: beforeBlocking,
          fixed: 0,
          skipped: false,
          error: `auto-fix HTTP ${fixRes.status}: ${txt.slice(0, 120)}`,
        });
        totalAfterBlocking += beforeBlocking;
        continue;
      }
      const fixData = await fixRes.json();

      // Re-load the paragraph to get the updated references list.
      const refreshed = await db.paragraph.findUnique({
        where: { id: p.id },
        include: { references: { orderBy: { citationOrder: "asc" } } },
      });
      const afterFindings = validateCitationsInline(
        refreshed?.content || p.content,
        (refreshed?.references || []) as AuditRef[]
      );
      const afterBlocking = afterFindings.filter(
        (f) => f.verdict === "out-of-range" || f.verdict === "missing"
      ).length;
      const fixed = beforeBlocking - afterBlocking;
      totalAfterBlocking += afterBlocking;
      totalFixed += Math.max(0, fixed);

      results.push({
        paragraphId: p.id,
        title: p.title,
        beforeBlocking,
        afterBlocking,
        fixed: Math.max(0, fixed),
        skipped: false,
        error: fixData?.fixed === 0 ? "No references found by LLM" : undefined,
      });
    } catch (err: any) {
      results.push({
        paragraphId: p.id,
        title: p.title,
        beforeBlocking,
        afterBlocking: beforeBlocking,
        fixed: 0,
        skipped: false,
        error: err?.message || "auto-fix failed",
      });
      totalAfterBlocking += beforeBlocking;
    }
  }

  return NextResponse.json({
    projectId: id,
    results,
    aggregate: {
      totalParagraphs: paragraphs.length,
      paragraphsProcessed: results.filter((r) => !r.skipped).length,
      paragraphsSkipped: results.filter((r) => r.skipped).length,
      totalBeforeBlocking,
      totalAfterBlocking,
      totalFixed,
    },
  });
}
