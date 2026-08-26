import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/articles/[id]/generate-diagram
 *
 * Uses the LLM to generate visual representations of the article's content:
 *  - A summary comparison table (Markdown table format)
 *  - A text-based flow diagram (Mermaid syntax)
 *  - A key findings list (bulleted)
 *
 * These are returned as structured data that the frontend can render.
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

  const content = article.content;
  const refIdx = content.indexOf("## References");
  const body = refIdx >= 0 ? content.slice(0, refIdx) : content;

  if (body.length < 200) {
    return NextResponse.json({
      error: "Article is too short to generate a diagram.",
    }, { status: 400 });
  }

  const prompt = `You are a scientific visualization expert. Read the following article and generate visual representations.

ARTICLE CONTENT (first 10000 chars):
${body.slice(0, 10000)}

Generate THREE outputs:

1. A comparison table in Markdown format that summarizes the key entities/proteins/methods discussed in the article. Use | column | format.

2. A flow diagram in Mermaid.js syntax (graph TD or graph LR) showing the key relationships/processes described in the article.

3. A list of 3-5 key findings as bullet points.

Respond as STRICT JSON:
{
  "table": "| Column1 | Column2 |\\n|---|---|\\n| ... | ... |",
  "flowchart": "graph TD\\n  A[Node1] --> B[Node2]\\n  B --> C[Node3]",
  "keyFindings": ["Finding 1", "Finding 2", "Finding 3"]
}

Output JSON only.`;

  try {
    const raw = await chat(prompt, {
      system: "You are a scientific visualization expert. Output strict JSON only.",
      temperature: 0.4,
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "Failed to parse LLM response." }, { status: 500 });
    }
    const parsed = JSON.parse(jsonMatch[0]);

    return NextResponse.json({
      table: parsed.table || "",
      flowchart: parsed.flowchart || "",
      keyFindings: parsed.keyFindings || [],
    });
  } catch (err: any) {
    console.error("[generate-diagram] error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Diagram generation failed.") },
      { status: 500 }
    );
  }
}
