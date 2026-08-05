import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/articles/[id]/suggest-citations
 *
 * AI-powered citation suggestions. Analyzes:
 *  1. Which references are already cited inline in the article
 *  2. Which data sources / references exist in the project but are NOT cited
 *  3. The article's topic and section themes
 *
 * The LLM then recommends the top 3-5 uncited sources that are most
 * relevant to the article's content, with a brief reason for each.
 *
 * Returns { suggestions: [{ refId, title, reason, relevance }] }
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const article = await db.article.findUnique({
    where: { id },
    include: {
      articleParagraph: {
        include: {
          paragraph: {
            include: { references: true },
          },
        },
      },
    },
  });

  if (!article) {
    return NextResponse.json({ error: "Article not found." }, { status: 404 });
  }

  // Collect all cited reference IDs (from paragraphs linked to this article)
  const citedRefIds = new Set<string>();
  for (const ap of article.articleParagraph) {
    for (const ref of ap.paragraph.references) {
      citedRefIds.add(ref.id);
    }
  }

  // Get ALL references in the project (cited + uncited)
  const project = await db.project.findUnique({
    where: { id: article.projectId },
    include: {
      references: {
        where: { paragraphId: null }, // Project-level references
        take: 100,
      },
      dataSources: {
        take: 50,
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  // Build list of uncited sources (references not linked to any paragraph
  // in this article + data sources with publication info)
  const uncitedSources: { id: string; title: string; authors?: string; journal?: string; year?: string; abstract?: string; source: string }[] = [];

  for (const ref of project.references) {
    if (!citedRefIds.has(ref.id)) {
      uncitedSources.push({
        id: ref.id,
        title: ref.title,
        authors: ref.authors || undefined,
        journal: ref.journal || undefined,
        year: ref.year || undefined,
        abstract: ref.abstract || undefined,
        source: "reference",
      });
    }
  }

  // Also check data sources that have publication metadata
  for (const ds of project.dataSources) {
    if (ds.title && ds.authors) {
      uncitedSources.push({
        id: ds.id,
        title: ds.title,
        authors: ds.authors || undefined,
        journal: ds.journal || undefined,
        year: ds.year || undefined,
        abstract: ds.abstract?.slice(0, 200) || undefined,
        source: "datasource",
      });
    }
  }

  if (uncitedSources.length === 0) {
    return NextResponse.json({
      suggestions: [],
      message: "All available sources are already cited in this article.",
    });
  }

  // Extract article body (first 5000 chars for context)
  const body = article.content.slice(0, 5000);

  // Build the prompt
  const sourceList = uncitedSources
    .slice(0, 30) // Cap at 30 to fit context window
    .map((s, i) => `[${i + 1}] ${s.authors || "Anon"} (${s.year || "n.d."}) ${s.title?.slice(0, 80)}${s.abstract ? `\n  Abstract: ${s.abstract.slice(0, 150)}` : ""}`)
    .join("\n");

  const prompt = `You are a scientific citation advisor. Given an article's content and a list of UNCITED sources, recommend the 3-5 most relevant sources that should be cited in the article.

ARTICLE CONTENT (first 5000 chars):
${body}

UNCITED SOURCES (${uncitedSources.length} total, showing top 30):
${sourceList}

For each recommended source, provide:
1. The source number (from the list above)
2. A one-sentence reason why it should be cited
3. A relevance score (0-100)

Respond as STRICT JSON:
{
  "suggestions": [
    { "index": 1, "reason": "This source provides...", "relevance": 85 },
    ...
  ]
}

Only recommend sources that are genuinely relevant. If fewer than 3 are relevant, return fewer.`;

  try {
    const raw = await chat(prompt, {
      system: "You are a scientific citation advisor. Output strict JSON only.",
      temperature: 0.3,
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "Failed to parse LLM response." }, { status: 500 });
    }
    const parsed = JSON.parse(jsonMatch[0]);

    // Map suggestions back to source objects
    const suggestions = (parsed.suggestions || [])
      .filter((s: any) => s.index >= 1 && s.index <= uncitedSources.length)
      .map((s: any) => {
        const source = uncitedSources[s.index - 1];
        return {
          id: source.id,
          title: source.title,
          authors: source.authors,
          journal: source.journal,
          year: source.year,
          source: source.source,
          reason: s.reason || "",
          relevance: s.relevance || 0,
        };
      })
      .sort((a: any, b: any) => b.relevance - a.relevance);

    return NextResponse.json({
      suggestions,
      totalUncited: uncitedSources.length,
    });
  } catch (err: any) {
    console.error("[suggest-citations] error:", err);
    return NextResponse.json(
      { error: err?.message || "Suggestion failed." },
      { status: 500 }
    );
  }
}
