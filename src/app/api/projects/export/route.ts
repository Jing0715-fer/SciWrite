import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 30;

// Export an entire project (with paragraphs, annotations, references, dataSources,
// articles) as a portable JSON blob.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
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
      references: { where: { paragraphId: null } },
      articles: {
        include: { articleParagraph: true },
      },
    },
  });

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const exportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    project: {
      title: project.title,
      topic: project.topic,
      description: project.description,
      field: project.field,
      status: project.status,
    },
    paragraphs: project.paragraphs.map((p) => ({
      title: p.title,
      content: p.content,
      format: p.format,
      scenario: p.scenario,
      status: p.status,
      order: p.order,
      wordCount: p.wordCount,
      annotations: p.annotations.map((a) => ({
        startOffset: a.startOffset,
        endOffset: a.endOffset,
        selectedText: a.selectedText,
        comment: a.comment,
        type: a.type,
        severity: a.severity,
        resolved: a.resolved,
        aiResponse: a.aiResponse,
      })),
      references: p.references.map((r) => ({
        type: r.type,
        externalId: r.externalId,
        title: r.title,
        authors: r.authors,
        journal: r.journal,
        year: r.year,
        url: r.url,
        doi: r.doi,
        abstract: r.abstract,
        citationKey: r.citationKey,
      })),
    })),
    dataSources: project.dataSources.map((d) => ({
      source: d.source,
      query: d.query,
      rawJson: d.rawJson,
      summary: d.summary,
      title: d.title,
      externalId: d.externalId,
      url: d.url,
      pinned: d.pinned,
    })),
    projectReferences: project.references.map((r) => ({
      type: r.type,
      externalId: r.externalId,
      title: r.title,
      authors: r.authors,
      journal: r.journal,
      year: r.year,
      url: r.url,
      doi: r.doi,
      abstract: r.abstract,
      citationKey: r.citationKey,
    })),
    articles: project.articles.map((a) => ({
      title: a.title,
      abstract: a.abstract,
      content: a.content,
      paragraphOrders: a.articleParagraph.map((ap) => ({
        paragraphOrder: ap.order,
        section: ap.section,
      })),
    })),
  };

  return NextResponse.json(exportData, {
    headers: {
      "Content-Disposition": `attachment; filename="${slug(project.title)}.sciwrite.json"`,
    },
  });
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "project"
  );
}
