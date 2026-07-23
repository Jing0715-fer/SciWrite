import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json(
      { error: "projectId is required." },
      { status: 400 }
    );
  }

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: {
      paragraphs: {
        orderBy: { order: "asc" },
        include: {
          annotations: true,
          references: true,
        },
      },
      dataSources: true,
      articles: { include: { _count: { select: { articleParagraph: true } } } },
      references: { where: { paragraphId: null } },
    },
  });

  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  // Compute stats
  const totalWords = project.paragraphs.reduce(
    (sum, p) => sum + (p.wordCount || 0),
    0
  );
  const totalCitations = project.paragraphs.reduce((sum, p) => {
    const matches = p.content.match(/\[(\d{1,3}(?:[,\-–\s]\d{1,3})*|[A-Z]{2,12}:\s?[^\]\n]{1,60})\]/g);
    return sum + (matches?.length || 0);
  }, 0);

  const annotationsByStatus = {
    unresolved: project.paragraphs.reduce(
      (s, p) => s + p.annotations.filter((a) => !a.resolved).length,
      0
    ),
    resolved: project.paragraphs.reduce(
      (s, p) => s + p.annotations.filter((a) => a.resolved).length,
      0
    ),
  };

  // Paragraph status distribution
  const statusDist: Record<string, number> = {};
  for (const p of project.paragraphs) {
    statusDist[p.status] = (statusDist[p.status] || 0) + 1;
  }

  // Format distribution
  const formatDist: Record<string, number> = {};
  for (const p of project.paragraphs) {
    formatDist[p.format] = (formatDist[p.format] || 0) + 1;
  }

  // Source distribution
  const sourceDist: Record<string, number> = {};
  for (const d of project.dataSources) {
    sourceDist[d.source] = (sourceDist[d.source] || 0) + 1;
  }
  const allRefs = [
    ...project.references,
    ...project.paragraphs.flatMap((p) => p.references),
  ];
  const refTypeDist: Record<string, number> = {};
  for (const r of allRefs) {
    refTypeDist[r.type] = (refTypeDist[r.type] || 0) + 1;
  }

  // Progress timeline (paragraphs by creation)
  const timeline = project.paragraphs.map((p) => ({
    id: p.id,
    title: p.title,
    format: p.format,
    status: p.status,
    wordCount: p.wordCount,
    citations: (p.content.match(/\[(\d{1,3}(?:[,\-–\s]\d{1,3})*|[A-Z]{2,12}:\s?[^\]\n]{1,60})\]/g) || []).length,
    createdAt: p.createdAt,
  }));

  // Citation coverage: % of paragraphs with at least 1 citation
  const paragraphsCited = project.paragraphs.filter(
    (p) => /\[\d{1,3}/.test(p.content) || /\[[A-Z]{2,12}:/i.test(p.content)
  ).length;
  const citationCoverage =
    project.paragraphs.length > 0
      ? Math.round((paragraphsCited / project.paragraphs.length) * 100)
      : 0;

  // Avg words per paragraph
  const avgWords =
    project.paragraphs.length > 0
      ? Math.round(totalWords / project.paragraphs.length)
      : 0;

  return NextResponse.json({
    projectId: project.id,
    projectTitle: project.title,
    stats: {
      totalParagraphs: project.paragraphs.length,
      totalArticles: project.articles.length,
      totalDataSources: project.dataSources.length,
      totalReferences: allRefs.length,
      totalWords,
      avgWordsPerParagraph: avgWords,
      totalCitations,
      citationCoverage,
      annotations: annotationsByStatus,
    },
    distributions: {
      status: statusDist,
      format: formatDist,
      source: sourceDist,
      referenceType: refTypeDist,
    },
    timeline,
    articles: project.articles.map((a) => ({
      id: a.id,
      title: a.title,
      updatedAt: a.updatedAt,
      paragraphCount: a._count?.articleParagraph || 0,
    })),
  });
}
