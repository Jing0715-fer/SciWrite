import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  buildAuditReport,
  validateCitationsInline,
  refIdentity,
} from "@/lib/citation-audit";
import { countWords } from "@/lib/writing";

export const runtime = "nodejs";

/**
 * GET /api/projects/[id]/citation-health
 *
 * Aggregates citation-audit findings across an entire project into a single
 * "citation health" report. This powers the CitationHealthDashboard mounted in
 * the workspace header — giving the user an at-a-glance view of whether their
 * draft's citations are accurate, BEFORE they compose an article.
 *
 * Runs THREE layers of checks:
 *  1. Per-paragraph inline audit (range + topicality) using the saved
 *     paragraph.content + paragraph.references.
 *  2. Per-article post-compose audit (range + topicality + orphan + duplicate +
 *     numbering-integrity) using the article.content ## References section.
 *  3. A project-wide aggregate: total citations, total references, % clean,
 *     list of the worst-offending paragraphs (most blocking/warning findings).
 *
 * Returns:
 *   { project, paragraphs: [...], articles: [...], aggregate, worstOffenders }
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await db.project.findUnique({
    where: { id },
    select: { id: true, title: true, topic: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  // 1. Load all active paragraphs with their references (ordered for stability).
  const paragraphs = await db.paragraph.findMany({
    where: { projectId: id, deletedAt: null },
    orderBy: { order: "asc" },
    include: {
      references: { orderBy: { citationOrder: "asc" } },
    },
  });

  const paragraphReports = paragraphs.map((p) => {
    const findings = validateCitationsInline(p.content, p.references as any);
    const blocking = findings.filter(
      (f) => f.verdict === "out-of-range" || f.verdict === "missing"
    );
    const warnings = findings.filter(
      (f) => f.verdict === "suspect" || f.verdict === "unsupported"
    );
    // Count unique citation markers in the body.
    const citeRe = /\[(\d{1,3}(?:[,\-–]\s*\d{1,3})*)\]/g;
    let markerCount = 0;
    let m: RegExpExecArray | null;
    const citeHeaderIdx = p.content.indexOf("### Citations");
    const body = citeHeaderIdx >= 0 ? p.content.slice(0, citeHeaderIdx) : p.content;
    while ((m = citeRe.exec(body))) {
      markerCount++;
    }
    return {
      paragraphId: p.id,
      title: p.title,
      format: p.format,
      order: p.order,
      wordCount: p.wordCount,
      refCount: p.references.length,
      citationCount: markerCount,
      blockingCount: blocking.length,
      warningCount: warnings.length,
      // Top 3 findings (worst first: blocking > unsupported > suspect).
      topFindings: [...blocking, ...warnings]
        .sort((a, b) => {
          const prio: Record<string, number> = {
            "out-of-range": 0,
            missing: 1,
            unsupported: 2,
            suspect: 3,
          };
          return (prio[a.verdict] ?? 9) - (prio[b.verdict] ?? 9);
        })
        .slice(0, 3)
        .map((f) => ({
          n: f.n,
          verdict: f.verdict,
          reason: f.reason.slice(0, 120),
          score: f.score,
        })),
    };
  });

  // 2. Load articles and run the full post-compose audit on each.
  // NOTE: the Article model does not store wordCount — compute it from content.
  const articles = await db.article.findMany({
    where: { projectId: id, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, content: true, createdAt: true },
  });

  const articleReports = articles.map((a) => {
    const report = buildAuditReport(a.content);
    return {
      articleId: a.id,
      title: a.title,
      wordCount: countWords(a.content),
      createdAt: a.createdAt,
      totalCitations: report.totalCitations,
      totalReferences: report.totalReferences,
      summary: report.summary,
      numberingIntegrityOk: report.numberingIntegrityOk,
    };
  });

  // 3. Aggregate.
  const totalParagraphs = paragraphReports.length;
  const totalArticles = articleReports.length;
  const totalCitations =
    paragraphReports.reduce((s, r) => s + r.citationCount, 0) +
    articleReports.reduce((s, r) => s + r.totalCitations, 0);
  const totalReferences = paragraphReports.reduce((s, r) => s + r.refCount, 0);
  const totalBlocking =
    paragraphReports.reduce((s, r) => s + r.blockingCount, 0) +
    articleReports.reduce((s, r) => s + r.summary.blockingErrors, 0);
  const totalWarnings =
    paragraphReports.reduce((s, r) => s + r.warningCount, 0) +
    articleReports.reduce(
      (s, r) => s + r.summary.suspect + r.summary.unsupported,
      0
    );
  const paragraphsClean = paragraphReports.filter(
    (r) => r.blockingCount === 0 && r.warningCount === 0
  ).length;
  const paragraphsIssues = totalParagraphs - paragraphsClean;

  // Compute a 0-100 health score: 100 = no blocking, no warnings.
  // Blocking errors weigh 5×, warnings weigh 1×.
  const penalty = Math.min(100, totalBlocking * 5 + totalWarnings);
  const healthScore = Math.max(0, 100 - penalty);

  // Health grade: A (90+), B (70+), C (50+), D (30+), F (<30).
  const grade =
    healthScore >= 90 ? "A" :
    healthScore >= 70 ? "B" :
    healthScore >= 50 ? "C" :
    healthScore >= 30 ? "D" : "F";

  // Worst offenders: paragraphs with the most blocking+warning findings.
  const worstOffenders = [...paragraphReports]
    .filter((r) => r.blockingCount + r.warningCount > 0)
    .sort(
      (a, b) =>
        b.blockingCount * 5 + b.warningCount - (a.blockingCount * 5 + a.warningCount)
    )
    .slice(0, 5);

  return NextResponse.json({
    project: { id: project.id, title: project.title, topic: project.topic },
    paragraphs: paragraphReports,
    articles: articleReports,
    aggregate: {
      totalParagraphs,
      totalArticles,
      totalCitations,
      totalReferences,
      totalBlocking,
      totalWarnings,
      paragraphsClean,
      paragraphsIssues,
      healthScore,
      grade,
    },
    worstOffenders,
  });
}
