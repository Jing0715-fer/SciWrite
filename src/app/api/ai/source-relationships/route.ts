import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";

export const runtime = "nodejs";
export const maxDuration = 120;

// Analyze relationships between data sources using LLM.
// Returns a network graph: nodes (sources) + edges (relationships) + summary.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const projectId = body.projectId as string;
    if (!projectId) {
      return NextResponse.json({ error: "Missing 'projectId'." }, { status: 400 });
    }

    const project = await db.project.findUnique({
      where: { id: projectId },
      include: {
        dataSources: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    const sources = project.dataSources;
    if (sources.length < 2) {
      return NextResponse.json({
        error: "Need at least 2 data sources to analyze relationships.",
      }, { status: 422 });
    }

    // Build source summaries for LLM context
    const sourceList = sources.map((s, i) => {
      const parts = [`[S${i + 1}] (${s.source}) ${s.title || s.query}`];
      if (s.authors) parts.push(`Authors: ${s.authors}`);
      if (s.journal) parts.push(`Journal: ${s.journal}`);
      if (s.year) parts.push(`Year: ${s.year}`);
      if (s.abstract) parts.push(`Abstract: ${s.abstract.slice(0, 200)}`);
      return parts.join("\n");
    }).join("\n\n");

    const system =
      "You are a scientific knowledge graph analyst. Given a set of research data sources, " +
      "analyze the relationships between them — which sources support the same finding, " +
      "which contradict each other, which build on prior work, which share methods or " +
      "structural data. Produce a relationship network + thematic summary.";

    const prompt = `RESEARCH TOPIC: ${project.topic}

DATA SOURCES (${sources.length}):
${sourceList}

Analyze the relationships between these sources. Respond as STRICT JSON:
{
  "summary": "2-3 sentence overview of how these sources relate to each other",
  "themes": [
    {
      "name": "Theme name (e.g. 'TMC1 structure', 'Mechanotransduction mechanism')",
      "sourceIds": ["S1", "S3", "S5"],
      "description": "How these sources connect on this theme"
    }
  ],
  "edges": [
    {
      "from": "S1",
      "to": "S3",
      "type": "supports|contradicts|extends|shares-data|cites|complementary",
      "label": "Brief description of the relationship"
    }
  ],
  "keyInsights": [
    "Key insight 1 about source relationships",
    "Key insight 2"
  ],
  "contradictions": [
    {
      "sourceIds": ["S2", "S7"],
      "description": "What they disagree on"
    }
  ]
}
Output JSON only. Focus on scientific substance, not metadata similarity.`;

    const raw = await chat(prompt, { system, temperature: 0.4 });
    const parsed = safeParseJSON(raw, {
      summary: "Could not analyze relationships.",
      themes: [],
      edges: [],
      keyInsights: [],
      contradictions: [],
    });

    // Map S1, S2, etc. back to actual source IDs
    const nodeMap: Record<string, string> = {};
    sources.forEach((s, i) => {
      nodeMap[`S${i + 1}`] = s.id;
    });

    const nodes = sources.map((s, i) => ({
      id: s.id,
      label: `S${i + 1}`,
      title: s.title || s.query,
      source: s.source,
      externalId: s.externalId,
      year: s.year,
    }));

    const edges = (parsed.edges || []).map((e: any) => ({
      ...e,
      fromId: nodeMap[e.from] || e.from,
      toId: nodeMap[e.to] || e.to,
    }));

    const themes = (parsed.themes || []).map((t: any) => ({
      ...t,
      sourceIdsResolved: (t.sourceIds || []).map((s: string) => nodeMap[s] || s),
    }));

    return NextResponse.json({
      summary: parsed.summary || "",
      themes,
      edges,
      nodes,
      keyInsights: parsed.keyInsights || [],
      contradictions: parsed.contradictions || [],
    });
  } catch (err: any) {
    console.error("[/api/ai/source-relationships] error:", err);
    return NextResponse.json(
      { error: err?.message || "Relationship analysis failed." },
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
