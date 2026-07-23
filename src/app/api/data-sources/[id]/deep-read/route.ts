import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { readPage, chat } from "@/lib/ai";

export const runtime = "nodejs";
export const maxDuration = 90;

// Deep-read a data source: fetch full page content via page_reader, then have the
// AI produce a structured summary suitable for use as an enriched abstract.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const source = await db.dataSource.findUnique({ where: { id } });
    if (!source) {
      return NextResponse.json({ error: "Data source not found." }, { status: 404 });
    }
    if (!source.url) {
      return NextResponse.json(
        { error: "This data source has no URL to deep-read." },
        { status: 400 }
      );
    }

    // 1. Fetch the full page content
    const pageContent = await readPage(source.url);
    const text = (pageContent.text || "").slice(0, 8000); // cap for LLM context
    if (!text || text.length < 50) {
      return NextResponse.json(
        { error: "Could not extract meaningful content from the source URL." },
        { status: 422 }
      );
    }

    // 2. AI-summarize into a structured abstract
    const system =
      "You are a scientific research assistant. Given the full text of a web page " +
      "(which may be a journal article, database entry, or abstract page), produce a " +
      "concise structured summary suitable for enriching a reference record. Focus on " +
      "key findings, methods, and relevance for citation.";

    const prompt = `SOURCE URL: ${source.url}
SOURCE TYPE: ${source.source}
ORIGINAL TITLE: ${source.title || "(unknown)"}

PAGE TEXT (truncated to ${text.length} chars):
---
${text}
---

Produce a structured summary in this exact format:
KEY FINDINGS: <1-2 sentences of the main findings or content>
METHODS: <1 sentence on methodology or data type, if applicable>
RELEVANCE: <1 sentence on why this source is citable for a literature review>
ABSTRACT: <a 2-3 sentence enriched abstract combining the above>

Keep each field concise. If a field is not applicable, write "N/A".`;

    const summary = await chat(prompt, { system, temperature: 0.4 });

    // 3. Save the enriched summary
    const updated = await db.dataSource.update({
      where: { id },
      data: { summary },
    });

    return NextResponse.json({
      dataSource: updated,
      summary,
      contentLength: text.length,
    });
  } catch (err: any) {
    console.error("[/api/data-sources/[id]/deep-read] error:", err);
    return NextResponse.json(
      { error: err?.message || "Deep read failed." },
      { status: 500 }
    );
  }
}
