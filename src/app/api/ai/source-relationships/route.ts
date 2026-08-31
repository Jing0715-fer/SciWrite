import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatWithSession } from "@/lib/llm-session";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const maxDuration = 120;

// GET: Load saved relationship analysis from DB.
// round-39: also returns sourceCount so the Relationships tab can decide
// whether an auto-run on first open is possible (needs ≥2 sources).
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "Missing 'projectId'." }, { status: 400 });
  }
  const latest = await db.relationshipAnalysis.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
  if (!latest) {
    const sourceCount = await db.dataSource.count({ where: { projectId } });
    return NextResponse.json({ notFound: true, sourceCount });
  }
  return NextResponse.json({
    summary: latest.summary,
    themes: safeJson(latest.themes, []),
    edges: safeJson(latest.edges, []),
    nodes: safeJson(latest.nodes, []),
    keyInsights: safeJson(latest.keyInsights, []),
    contradictions: safeJson(latest.contradictions, []),
    createdAt: latest.createdAt,
  });
}

function safeJson(raw: string, fallback: any): any {
  try { return JSON.parse(raw); } catch { return fallback; }
}

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

    // round-39: cap the analysis list. Projects routinely hold 100+ sources
    // (V1 gather saves EVERYTHING with no cap), and the previous prompt
    // inlined ALL of them — token-limit failures or shallow results. Analyze
    // the 60 most recent; S-labels, nodeMap, nodes and the prompt count all
    // refer to this capped list so edges/themes resolve correctly.
    const MAX_ANALYZE_SOURCES = 60;
    const analysisSources = sources.slice(0, MAX_ANALYZE_SOURCES);

    // Build source summaries for LLM context
    const sourceList = analysisSources.map((s, i) => {
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

DATA SOURCES (${analysisSources.length}):
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

    const raw = await chatWithSession(projectId, prompt, {
      system,
      temperature: 0.4,
      taskType: "relationships",
      metadata: { sourceCount: sources.length },
    });
    const parsed = safeParseJSON(raw, {
      summary: "Could not analyze relationships.",
      themes: [],
      edges: [],
      keyInsights: [],
      contradictions: [],
    });

    // Map S1, S2, etc. back to actual source IDs
    const nodeMap: Record<string, string> = {};
    analysisSources.forEach((s, i) => {
      nodeMap[`S${i + 1}`] = s.id;
    });

    const nodes = analysisSources.map((s, i) => ({
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

    const result = {
      summary: parsed.summary || "",
      themes,
      edges,
      nodes,
      keyInsights: parsed.keyInsights || [],
      contradictions: parsed.contradictions || [],
    };

    // Save to database for persistence
    await db.relationshipAnalysis.create({
      data: {
        projectId,
        summary: result.summary,
        themes: JSON.stringify(result.themes),
        edges: JSON.stringify(result.edges),
        nodes: JSON.stringify(result.nodes),
        keyInsights: JSON.stringify(result.keyInsights),
        contradictions: JSON.stringify(result.contradictions),
      },
    });

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[/api/ai/source-relationships] error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Relationship analysis failed.") },
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
