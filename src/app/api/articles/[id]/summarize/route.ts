import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/articles/[id]/summarize
 *
 * Generates an AI-powered summary of the article. The LLM reads the full
 * article content and produces:
 *  - A 2-3 sentence overall summary (TL;DR)
 *  - A one-sentence summary per section (## heading)
 *
 * Returns { overall: string, sections: [{title, summary}] }
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const article = await db.article.findUnique({ where: { id } });
  if (!article) {
    return NextResponse.json({ error: "Article not found." }, { status: 404 });
  }

  // Extract body (before References section)
  const content = article.content;
  const refIdx = content.indexOf("## References");
  const body = refIdx >= 0 ? content.slice(0, refIdx) : content;

  if (body.length < 100) {
    return NextResponse.json({
      overall: "Article is too short to summarize.",
      sections: [],
    });
  }

  // Split into sections by ## headings
  const sections: { title: string; body: string }[] = [];
  const lines = body.split("\n");
  let currentTitle = "";
  let currentBody: string[] = [];

  for (const line of lines) {
    if (/^##\s+/.test(line) && !/^###\s/.test(line)) {
      if (currentTitle || currentBody.length > 0) {
        sections.push({ title: currentTitle, body: currentBody.join("\n") });
      }
      currentTitle = line.replace(/^##\s+/, "");
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentTitle || currentBody.length > 0) {
    sections.push({ title: currentTitle, body: currentBody.join("\n") });
  }

  // Build the summarization prompt
  const sectionTexts = sections
    .map((s, i) => `### Section ${i + 1}: ${s.title}\n${s.body.slice(0, 500)}`)
    .join("\n\n");

  const prompt = `You are a scientific research summarizer. Read the following article and produce a JSON summary.

ARTICLE CONTENT:
${sectionTexts.slice(0, 12000)}

Respond as STRICT JSON:
{
  "overall": "2-3 sentence overall summary of the entire article (TL;DR)",
  "sections": [
    { "title": "Section 1 title", "summary": "One-sentence summary of this section" },
    { "title": "Section 2 title", "summary": "One-sentence summary of this section" }
  ]
}

Output JSON only, no preamble.`;

  try {
    const raw = await chat(prompt, {
      system: "You are a scientific research summarizer. Output strict JSON only.",
      temperature: 0.3,
    });

    // Parse JSON
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "Failed to parse LLM response." }, { status: 500 });
    }
    const parsed = JSON.parse(jsonMatch[0]);

    return NextResponse.json({
      overall: parsed.overall || "",
      sections: parsed.sections || [],
    });
  } catch (err: any) {
    console.error("[summarize] error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Summarization failed.") },
      { status: 500 }
    );
  }
}
