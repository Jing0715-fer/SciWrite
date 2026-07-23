import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

interface ImportData {
  version: number;
  project: {
    title: string;
    topic: string;
    description?: string | null;
    field?: string | null;
    status?: string;
  };
  paragraphs: Array<{
    title: string;
    content: string;
    format: string;
    scenario: string;
    status: string;
    order: number;
    wordCount: number;
    annotations: Array<{
      startOffset: number;
      endOffset: number;
      selectedText: string;
      comment: string;
      type: string;
      severity: string;
      resolved: boolean;
      aiResponse?: string | null;
    }>;
    references: Array<{
      type: string;
      externalId?: string | null;
      title: string;
      authors?: string | null;
      journal?: string | null;
      year?: string | null;
      url?: string | null;
      doi?: string | null;
      abstract?: string | null;
      citationKey?: string | null;
    }>;
  }>;
  dataSources: Array<{
    source: string;
    query: string;
    rawJson: string;
    summary?: string | null;
    title?: string | null;
    externalId?: string | null;
    url?: string | null;
    pinned: boolean;
  }>;
  projectReferences: Array<{
    type: string;
    externalId?: string | null;
    title: string;
    authors?: string | null;
    journal?: string | null;
    year?: string | null;
    url?: string | null;
    doi?: string | null;
    abstract?: string | null;
    citationKey?: string | null;
  }>;
  articles: Array<{
    title: string;
    abstract?: string | null;
    content: string;
    paragraphOrders: Array<{ paragraphOrder: number; section?: string | null }>;
  }>;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ImportData;
    if (!body.version || !body.project || !body.project.title || !body.project.topic) {
      return NextResponse.json(
        { error: "Invalid SciWrite export file: missing required fields." },
        { status: 400 }
      );
    }

    // Create the project
    const project = await db.project.create({
      data: {
        title: `${body.project.title} (imported)`,
        topic: body.project.topic,
        description: body.project.description || null,
        field: body.project.field || null,
        status: body.project.status || "active",
      },
    });

    // Import paragraphs (with annotations + references)
    const paragraphIdMap: Record<number, string> = {};
    for (const p of body.paragraphs || []) {
      const created = await db.paragraph.create({
        data: {
          projectId: project.id,
          title: p.title,
          content: p.content,
          format: p.format,
          scenario: p.scenario,
          status: p.status,
          order: p.order,
          wordCount: p.wordCount,
          annotations: {
            create: (p.annotations || []).map((a) => ({
              startOffset: a.startOffset,
              endOffset: a.endOffset,
              selectedText: a.selectedText,
              comment: a.comment,
              type: a.type,
              severity: a.severity,
              resolved: a.resolved,
              aiResponse: a.aiResponse,
            })),
          },
          references: {
            create: (p.references || []).map((r) => ({
              type: r.type,
              externalId: r.externalId || null,
              title: r.title,
              authors: r.authors || null,
              journal: r.journal || null,
              year: r.year || null,
              url: r.url || null,
              doi: r.doi || null,
              abstract: r.abstract || null,
              citationKey: r.citationKey || null,
            })),
          },
        },
      });
      paragraphIdMap[p.order] = created.id;
    }

    // Import project-level references
    if (body.projectReferences?.length) {
      await db.reference.createMany({
        data: body.projectReferences.map((r) => ({
          projectId: project.id,
          type: r.type,
          externalId: r.externalId || null,
          title: r.title,
          authors: r.authors || null,
          journal: r.journal || null,
          year: r.year || null,
          url: r.url || null,
          doi: r.doi || null,
          abstract: r.abstract || null,
          citationKey: r.citationKey || null,
        })),
      });
    }

    // Import data sources
    if (body.dataSources?.length) {
      await db.dataSource.createMany({
        data: body.dataSources.map((d) => ({
          projectId: project.id,
          source: d.source,
          query: d.query,
          rawJson: d.rawJson,
          summary: d.summary || null,
          title: d.title || null,
          externalId: d.externalId || null,
          url: d.url || null,
          pinned: d.pinned,
        })),
      });
    }

    // Import articles
    for (const a of body.articles || []) {
      const article = await db.article.create({
        data: {
          projectId: project.id,
          title: a.title,
          abstract: a.abstract || null,
          content: a.content,
        },
      });
      // link paragraphs via ArticleParagraph
      for (const po of a.paragraphOrders || []) {
        const pid = paragraphIdMap[po.paragraphOrder];
        if (pid) {
          await db.articleParagraph.create({
            data: {
              articleId: article.id,
              paragraphId: pid,
              order: po.paragraphOrder,
              section: po.section || null,
            },
          });
        }
      }
    }

    return NextResponse.json({
      project,
      stats: {
        paragraphs: body.paragraphs?.length || 0,
        dataSources: body.dataSources?.length || 0,
        references: body.projectReferences?.length || 0,
        articles: body.articles?.length || 0,
      },
    });
  } catch (err: any) {
    console.error("[/api/projects/import] error:", err);
    return NextResponse.json(
      { error: err?.message || "Import failed." },
      { status: 500 }
    );
  }
}
