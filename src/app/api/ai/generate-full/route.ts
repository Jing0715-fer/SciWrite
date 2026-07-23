import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";
import { queryDatabase } from "@/lib/databases";
import { writingSystemPrompt, countWords, summarizeDataSource } from "@/lib/writing";
import type { ParagraphFormat, ParagraphScenario } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 900; // 15 minutes for full generation with deep analysis

interface GenerateFullBody {
  projectId: string;
  journalTemplate?: string;
  language?: string;
  targetWords?: number; // total target word count for the article
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as GenerateFullBody;
    if (!body.projectId) {
      return NextResponse.json({ error: "Missing 'projectId'." }, { status: 400 });
    }

    const project = await db.project.findUnique({ where: { id: body.projectId } });
    if (!project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    const language = body.language || "English";
    const targetWords = body.targetWords || 2000;
    const journalTemplate = body.journalTemplate || "generic";

    // ============ STEP 1: Gather data sources ============
    // Generate search queries based on the topic, then execute them
    const gatherSystem =
      "You are a research data strategist. Given a research topic, design 6-10 multi-database " +
      "search queries to gather the most relevant primary sources. Distribute across PubMed, " +
      "UniProt, RCSB PDB, and NCBI based on the topic.";

    const gatherPrompt = `RESEARCH TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}
PURPOSE: Write a comprehensive review article (~${targetWords} words).

Design a search plan with 6-10 queries. Respond as STRICT JSON:
{
  "queries": [
    { "database": "pubmed", "query": "concrete search string" },
    { "database": "rcsb", "query": "concrete search string" },
    ...
  ]
}
Use lowercase database names: pubmed, uniprot, rcsb, ncbi, blast. Output JSON only.`;

    const gatherRaw = await chat(gatherPrompt, { system: gatherSystem, temperature: 0.4 });
    const gatherParsed = safeParseJSON(gatherRaw, { queries: [] });
    const queries = (gatherParsed.queries || []).filter(
      (q: any) => q.database && q.query && ["pubmed", "uniprot", "rcsb", "ncbi", "blast"].includes(q.database)
    );

    // Execute all queries in parallel and collect results (limit to 5 queries for speed)
    const queryResults = await Promise.allSettled(
      queries.slice(0, 5).map((q: any) =>
        queryDatabase(q.database as any, q.query).then((r) => ({ ...r, rationale: q.query }))
      )
    );

    // Collect all items as data sources + references (limit to top 5 per query for speed)
    const allItems: any[] = [];
    for (const r of queryResults) {
      if (r.status === "fulfilled") {
        for (const item of (r.value.items || []).slice(0, 5)) {
          allItems.push({
            ...item,
            queryUsed: r.value.query,
          });
        }
      }
    }

    // Save data sources + references to DB
    const savedDataSources: any[] = [];
    const savedReferences: any[] = [];
    for (const item of allItems) {
      // Save as data source
      const ds = await db.dataSource.create({
        data: {
          projectId: body.projectId,
          source: item.source,
          query: item.queryUsed || item.title,
          rawJson: JSON.stringify({ items: [item] }),
          title: item.title,
          externalId: item.externalId,
          url: item.url,
          authors: item.authors || null,
          journal: item.journal || null,
          year: item.year || null,
          doi: item.doi || null,
          abstract: item.abstract || null,
          extra: item.extra ? JSON.stringify(item.extra) : null,
          pinned: true,
        },
      });
      savedDataSources.push(ds);

      // Save as reference ONLY for PubMed sources (PDB/UniProt/NCBI are data sources, not references)
      // For PDB entries with associated publications, we save the publication info as a reference
      // ONLY if it has a real PMID or DOI (meaning it's a citable publication, not just a structure)
      const isPubMed = item.source === "pubmed";
      const isRcsbWithPub = item.source === "rcsb" && item.extra?.hasPublication;
      const isCitable = isPubMed || isRcsbWithPub;

      if (isCitable) {
        const ref = await db.reference.create({
          data: {
            type: "pubmed", // Always treat as pubmed reference type for citation purposes
            externalId: item.externalId || null,
            title: item.title,
            authors: item.authors || null,
            journal: item.journal || null,
            year: item.year || null,
            url: item.url || null,
            doi: item.doi || null,
            abstract: item.abstract || null,
            projectId: body.projectId,
          },
        });
        savedReferences.push(ref);
      }
    }

    if (savedReferences.length === 0 && savedDataSources.length === 0) {
      return NextResponse.json({
        error: "No data sources could be gathered. Please try again or add sources manually.",
        queriesAttempted: queries.length,
      }, { status: 422 });
    }

    // ============ STEP 1.5: Analyze source relationships ============
    // Use LLM to understand how sources relate, identify themes, contradictions
    let relationshipContext = "";
    let relationshipSummary = "";
    try {
      const sourceList = savedDataSources.map((s, i) => {
        const parts = [`[S${i + 1}] (${s.source}) ${s.title || s.query}`];
        if (s.authors) parts.push(`Authors: ${s.authors}`);
        if (s.journal) parts.push(`Journal: ${s.journal}`);
        if (s.year) parts.push(`Year: ${s.year}`);
        if (s.abstract) parts.push(`Abstract: ${s.abstract.slice(0, 150)}`);
        return parts.join("\n");
      }).join("\n\n");

      const relSystem =
        "You are a scientific knowledge graph analyst. Analyze relationships between data sources " +
        "and produce a thematic summary for deep article writing.";

      const relPrompt = `RESEARCH TOPIC: ${project.topic}

DATA SOURCES:
${sourceList}

Analyze how these sources relate. Respond as STRICT JSON:
{
  "summary": "2-3 sentence overview of source relationships",
  "themes": [{"name": "theme", "sourceLabels": ["S1","S3"], "description": "how they connect"}],
  "keyConnections": ["connection 1", "connection 2"],
  "contradictions": [{"sourceLabels": ["S2","S7"], "description": "what they disagree on"}]
}`;
      const relRaw = await chat(relPrompt, { system: relSystem, temperature: 0.4 });
      const relParsed = safeParseJSON(relRaw, { summary: "", themes: [], keyConnections: [], contradictions: [] });
      relationshipSummary = relParsed.summary || "";
      relationshipContext = `\nSOURCE RELATIONSHIP ANALYSIS (use to write deeper, more connected discussion):\n${relParsed.summary || ""}\n\nKey connections between sources:\n${(relParsed.keyConnections || []).map((k: string, i: number) => `${i + 1}. ${k}`).join("\n")}\n\nThematic clusters:\n${(relParsed.themes || []).map((t: any) => `- ${t.name}: ${t.description}`).join("\n")}\n${(relParsed.contradictions || []).length ? `\nContradictions to discuss:\n${(relParsed.contradictions || []).map((c: any) => `- ${c.sourceLabels.join(" vs ")}: ${c.description}`).join("\n")}` : ""}`;
    } catch {
      // Relationship analysis is optional — continue without it
    }

    // ============ STEP 2: Plan article sections ============
    // Based on the gathered sources, plan the article structure with target word counts
    const planSystem =
      "You are a senior research advisor who designs publication-ready article outlines. " +
      "Given a research topic, purpose, field, and the number of available references, " +
      "produce a detailed section plan with target word counts that sum to the total target.";

    const planPrompt = `RESEARCH TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}
TARGET TOTAL WORDS: ${targetWords}
AVAILABLE REFERENCES: ${savedReferences.length} sources gathered from PubMed, RCSB, UniProt, NCBI.

Plan a review article with 5-8 sections. Each section gets a target word count.
The sum of all section word counts should be approximately ${targetWords}.

Respond as STRICT JSON:
{
  "sections": [
    {
      "format": "intro|background|methods|results|discussion|conclusion|abstract",
      "scenario": "literature-review|protein-structure|sequence-analysis|mechanism|comparative|clinical|custom",
      "title": "A descriptive section title (not truncated)",
      "focus": "What this section should cover",
      "targetWords": 300
    }
  ]
}
Output JSON only. Distribute word counts proportionally to content depth.`;

    const planRaw = await chat(planPrompt, { system: planSystem, temperature: 0.5 });
    const planParsed = safeParseJSON(planRaw, { sections: [] });
    const sections = (planParsed.sections || []).filter(
      (s: any) => s.format && s.scenario && s.title
    );

    if (sections.length === 0) {
      return NextResponse.json({
        error: "Could not plan article sections. Please try again.",
      }, { status: 422 });
    }

    // ============ STEP 3: Allocate sources to sections ============
    // Build the reference context string from all saved references
    const refContext = savedReferences
      .map((r, i) => {
        const auth = r.authors || "Anon";
        const yr = r.year ? ` (${r.year})` : "";
        const jour = r.journal ? `, *${r.journal}*` : "";
        const ext = r.externalId ? ` [${r.type.toUpperCase()}:${r.externalId}]` : "";
        const url = r.url ? ` — ${r.url}` : "";
        const abs = r.abstract ? `\nAbstract: ${r.abstract.slice(0, 200)}` : "";
        return `[${i + 1}] ${auth}${yr}${jour}. ${r.title}.${ext}${url}${abs}`;
      })
      .join("\n");

    // Build data source context with enhanced metadata
    const dsContext = savedDataSources
      .map((d, i) => {
        const parts = [`[DS:${i + 1}] (${d.source}) ${d.title || d.query}`];
        if (d.authors) parts.push(`Authors: ${d.authors}`);
        if (d.journal) parts.push(`Journal: ${d.journal}`);
        if (d.year) parts.push(`Year: ${d.year}`);
        if (d.abstract) parts.push(`Abstract: ${d.abstract.slice(0, 300)}`);
        return parts.join("\n");
      })
      .join("\n\n");

    // ============ STEP 4: Generate each section ============
    const generatedParagraphs: any[] = [];
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const sectionNum = i + 1;

      const system = writingSystemPrompt({
        format: section.format as ParagraphFormat,
        scenario: section.scenario as ParagraphScenario,
        field: project.field || undefined,
        language,
      });

      const prompt = `RESEARCH TOPIC: ${project.topic}
SECTION ${sectionNum} of ${sections.length}: ${section.title}
FORMAT: ${section.format}
SCENARIO: ${section.scenario}
FOCUS: ${section.focus}
TARGET WORDS: ${section.targetWords}

REFERENCE LIST (use ONLY these — cite as [n] where n is the 1-based index):
${refContext}

DATABASE RECORDS (structural/sequence data — reference the associated publication, not the PDB/UniProt ID):
${dsContext}
${relationshipContext}

Now compose this section. Write DEEPLY — discuss connections between sources, highlight
agreements and contradictions, synthesize findings across studies. Every citation MUST
reference one of the sources above (use [n] for references, NOT [SOURCE:ID] in the body text).
If you cannot support a claim with a provided source, write [$REF] as a placeholder.`;

      const content = await chat(prompt, { system, temperature: 0.65 });

      // Create the paragraph
      const paragraph = await db.paragraph.create({
        data: {
          projectId: body.projectId,
          title: section.title,
          content,
          format: section.format,
          scenario: section.scenario,
          status: "draft",
          order: i,
          wordCount: countWords(content),
        },
      });

      // Link all saved references to this paragraph
      await db.reference.updateMany({
        where: { projectId: body.projectId, paragraphId: null },
        data: { paragraphId: paragraph.id },
      });

      generatedParagraphs.push({
        id: paragraph.id,
        title: section.title,
        format: section.format,
        wordCount: paragraph.wordCount,
        contentLength: content.length,
      });
    }

    // ============ STEP 5: Compose the final article ============
    const composePrompt = `Compose a coherent, deeply-synthesized review article titled "${project.topic}".
Source sections (in order, citations already renumbered globally):
${generatedParagraphs
  .map((p, i) => `\n--- Section ${i + 1}: ${p.title} ---\n`)
  .join("\n")}

Instructions:
- Produce a unified article with section headings (## Introduction, ## Background, etc.).
- Deepen the analysis with full synthesis, contrast, and forward-looking discussion.
- Preserve ALL inline citations [n] and [SOURCE:ID] markers exactly.
- After the article body, output a "## References" section with every cited source as a numbered list.
- Output in Markdown.`;

    const composeSystem =
      "You are a senior scientific editor who composes coherent, deeply-synthesized research articles.";
    const articleContent = await chat(composePrompt, { system: composeSystem, temperature: 0.55 });

    const article = await db.article.create({
      data: {
        projectId: body.projectId,
        title: project.topic,
        content: articleContent,
        journalTemplate,
        articleParagraph: {
          create: generatedParagraphs.map((p, i) => ({
            paragraphId: p.id,
            order: i,
            section: p.format,
          })),
        },
      },
    });

    return NextResponse.json({
      success: true,
      article,
      relationshipSummary,
      stats: {
        sourcesGathered: savedDataSources.length,
        referencesSaved: savedReferences.length,
        sectionsPlanned: sections.length,
        paragraphsGenerated: generatedParagraphs.length,
        totalWords: generatedParagraphs.reduce((s, p) => s + p.wordCount, 0),
        articleWordCount: countWords(articleContent),
      },
      sections: generatedParagraphs,
      queriesExecuted: queries.length,
    });
  } catch (err: any) {
    console.error("[/api/ai/generate-full] error:", err);
    return NextResponse.json(
      { error: err?.message || "Full article generation failed." },
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
