import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatWithSession } from "@/lib/llm-session";
import type { ParagraphFormat, ParagraphScenario } from "@/lib/types";
import { formatLabel, scenarioLabel } from "@/lib/writing";

export const runtime = "nodejs";
export const maxDuration = 120;

interface OutlineItem {
  format: ParagraphFormat;
  scenario: ParagraphScenario;
  title: string;
  focus: string;
  suggestedQueries: { database: string; query: string }[];
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const projectId = body.projectId as string;
    if (!projectId) {
      return NextResponse.json({ error: "Missing 'projectId'." }, { status: 400 });
    }

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    const system =
      "You are a senior research advisor who designs publication-ready paragraph outlines. " +
      "Given a research topic, purpose, and field, produce a structured paragraph plan that " +
      "covers the topic comprehensively. Each paragraph should have a clear format, scenario, " +
      "a specific focus, and 1-2 database search queries to gather evidence.";

    const validFormats = [
      "abstract",
      "intro",
      "background",
      "methods",
      "results",
      "discussion",
      "conclusion",
    ];
    const validScenarios = [
      "literature-review",
      "protein-structure",
      "sequence-analysis",
      "mechanism",
      "comparative",
      "clinical",
      "custom",
    ];

    const prompt = `RESEARCH TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}
PURPOSE: ${body.purpose || project.topic}

Design a paragraph outline with 4-7 paragraphs. Valid formats: ${validFormats.join(", ")}.
Valid scenarios: ${validScenarios.join(", ")}.
Valid databases: pubmed, uniprot, rcsb, ncbi, blast.

Respond as STRICT JSON:
{
  "summary": "1-2 sentence overview of the writing strategy",
  "outline": [
    {
      "format": "intro|background|methods|results|discussion|conclusion|abstract",
      "scenario": "literature-review|protein-structure|sequence-analysis|mechanism|comparative|clinical|custom",
      "title": "A concise paragraph title (3-7 words)",
      "focus": "What this paragraph should cover (1 sentence)",
      "suggestedQueries": [
        { "database": "pubmed", "query": "concrete search string" }
      ]
    }
  ]
}
Output JSON only. Ensure each paragraph builds logically on the previous.`;

    const raw = await chatWithSession(projectId, prompt, {
      system,
      temperature: 0.5,
      taskType: "outline",
      metadata: { topic: project.topic },
    });
    const parsed = safeParseJSON(raw, { summary: "", outline: [] });

    const outline: OutlineItem[] = (Array.isArray(parsed.outline) ? parsed.outline : [])
      .filter(
        (o: any) =>
          validFormats.includes(o.format) && validScenarios.includes(o.scenario)
      )
      .map((o: any) => ({
        format: o.format as ParagraphFormat,
        scenario: o.scenario as ParagraphScenario,
        title: String(o.title || "Untitled paragraph"),
        focus: String(o.focus || ""),
        suggestedQueries: Array.isArray(o.suggestedQueries)
          ? o.suggestedQueries
              .filter((q: any) => q.database && q.query)
              .slice(0, 3)
              .map((q: any) => ({
                database: String(q.database).toLowerCase(),
                query: String(q.query),
              }))
          : [],
      }));

    return NextResponse.json({
      summary: String(parsed.summary || ""),
      outline,
    });
  } catch (err: any) {
    console.error("[/api/ai/outline] error:", err);
    return NextResponse.json(
      { error: err?.message || "Outline generation failed." },
      { status: 500 }
    );
  }
}

function safeParseJSON(raw: string, fallback: any): any {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]);
  } catch {
    return fallback;
  }
}

export { formatLabel, scenarioLabel };
