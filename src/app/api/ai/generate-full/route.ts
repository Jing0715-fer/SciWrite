import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";
import { queryDatabase } from "@/lib/databases";
import { writingSystemPrompt, countWords } from "@/lib/writing";
import type { ParagraphFormat, ParagraphScenario } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 1800; // 30 minutes — streaming keeps connection alive

interface GenerateFullBody {
  projectId: string;
  journalTemplate?: string;
  language?: string;
  targetWords?: number;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as GenerateFullBody;
  const projectId = body.projectId;

  if (!projectId) {
    return Response.json({ error: "Missing 'projectId'." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ event, ...data })}\n\n`)
        );
      };

      try {
        const project = await db.project.findUnique({ where: { id: projectId } });
        if (!project) {
          send("error", { error: "Project not found." });
          controller.close();
          return;
        }

        const language = body.language || "English";
        const targetWords = body.targetWords || 3000;
        const journalTemplate = body.journalTemplate || "generic";

        // ============ STEP 1: Gather data sources ============
        send("step", { step: "gather", status: "started", message: "Generating search queries..." });

        const gatherSystem =
          "You are a research data strategist. Given a research topic, design 8-12 multi-database " +
          "search queries to gather the most relevant primary sources. Distribute across PubMed, " +
          "UniProt, RCSB PDB, and NCBI based on the topic.";

        const gatherPrompt = `RESEARCH TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}
PURPOSE: Write a comprehensive review article (~${targetWords} words).

Design a search plan with 8-12 queries. Respond as STRICT JSON:
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

        send("step", { step: "gather", status: "progress", message: `Executing ${queries.length} database queries...`, queries: queries.length });

        // Execute ALL queries in parallel — no limit on count
        const queryResults = await Promise.allSettled(
          queries.map((q: any) =>
            queryDatabase(q.database as any, q.query).then((r) => ({ ...r, rationale: q.query }))
          )
        );

        // Collect ALL items — no limit on per-query items
        const allItems: any[] = [];
        for (const r of queryResults) {
          if (r.status === "fulfilled") {
            for (const item of r.value.items || []) {
              allItems.push({
                ...item,
                queryUsed: r.value.query,
              });
            }
          }
        }

        send("step", {
          step: "gather",
          status: "progress",
          message: `Saving ${allItems.length} data sources with full metadata...`,
          itemsFound: allItems.length,
        });

        // Save ALL data sources + references with FULL metadata
        const savedDataSources: any[] = [];
        const savedReferences: any[] = [];
        for (const item of allItems) {
          const ds = await db.dataSource.create({
            data: {
              projectId,
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

          // Save as reference ONLY for PubMed or RCSB-with-publication
          const isPubMed = item.source === "pubmed";
          const isRcsbWithPub = item.source === "rcsb" && item.extra?.hasPublication;
          if (isPubMed || isRcsbWithPub) {
            const ref = await db.reference.create({
              data: {
                type: "pubmed",
                externalId: item.externalId || null,
                title: item.title,
                authors: item.authors || null,
                journal: item.journal || null,
                year: item.year || null,
                url: item.url || null,
                doi: item.doi || null,
                abstract: item.abstract || null,
                projectId,
              },
            });
            savedReferences.push(ref);
          }
        }

        send("step", {
          step: "gather",
          status: "done",
          sourcesGathered: savedDataSources.length,
          referencesSaved: savedReferences.length,
        });

        if (savedReferences.length === 0 && savedDataSources.length === 0) {
          send("error", { error: "No data sources could be gathered." });
          controller.close();
          return;
        }

        // ============ STEP 1.5: Analyze source relationships ============
        send("step", { step: "relationships", status: "started", message: "Analyzing source relationships..." });

        let relationshipContext = "";
        let relationshipSummary = "";
        try {
          const sourceList = savedDataSources.map((s, i) => {
            const parts = [`[S${i + 1}] (${s.source}) ${s.title || s.query}`];
            if (s.authors) parts.push(`Authors: ${s.authors}`);
            if (s.journal) parts.push(`Journal: ${s.journal}`);
            if (s.year) parts.push(`Year: ${s.year}`);
            if (s.abstract) parts.push(`Abstract: ${s.abstract.slice(0, 200)}`);
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

          send("step", {
            step: "relationships",
            status: "done",
            summary: relationshipSummary,
            themes: relParsed.themes?.length || 0,
            connections: relParsed.keyConnections?.length || 0,
            contradictions: relParsed.contradictions?.length || 0,
          });
        } catch {
          send("step", { step: "relationships", status: "skipped", message: "Relationship analysis skipped." });
        }

        // ============ STEP 2: Plan article sections ============
        send("step", { step: "plan", status: "started", message: "Planning article sections..." });

        const planSystem =
          "You are a senior research advisor who designs publication-ready article outlines. " +
          "Given a research topic, purpose, field, and the number of available references, " +
          "produce a detailed section plan with target word counts that sum to the total target.";

        const planPrompt = `RESEARCH TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}
TARGET TOTAL WORDS: ${targetWords}
AVAILABLE REFERENCES: ${savedReferences.length} citable references + ${savedDataSources.length} data sources.

Plan a review article with 5-8 sections. Each section gets a target word count.
The sum of all section word counts should be approximately ${targetWords}.

Respond as STRICT JSON:
{
  "sections": [
    {
      "format": "intro|background|methods|results|discussion|conclusion|abstract",
      "scenario": "literature-review|protein-structure|sequence-analysis|mechanism|comparative|clinical|custom",
      "title": "A descriptive section title",
      "focus": "What this section should cover",
      "targetWords": 300
    }
  ]
}
Output JSON only.`;

        const planRaw = await chat(planPrompt, { system: planSystem, temperature: 0.5 });
        const planParsed = safeParseJSON(planRaw, { sections: [] });
        const sections = (planParsed.sections || []).filter(
          (s: any) => s.format && s.scenario && s.title
        );

        if (sections.length === 0) {
          send("error", { error: "Could not plan article sections." });
          controller.close();
          return;
        }

        send("step", {
          step: "plan",
          status: "done",
          sections: sections.map((s: any) => ({ title: s.title, format: s.format, targetWords: s.targetWords })),
          sectionCount: sections.length,
        });

        // ============ STEP 3: Build context strings ============
        const refContext = savedReferences
          .map((r, i) => {
            const auth = r.authors || "Anon";
            const yr = r.year ? ` (${r.year})` : "";
            const jour = r.journal ? `, *${r.journal}*` : "";
            const url = r.url ? ` — ${r.url}` : "";
            const abs = r.abstract ? `\nAbstract: ${r.abstract.slice(0, 200)}` : "";
            return `[${i + 1}] ${auth}${yr}${jour}. ${r.title}.${url}${abs}`;
          })
          .join("\n");

        const dsContext = savedDataSources
          .map((d, i) => {
            const parts = [`[DS:${i + 1}] (${d.source}) ${d.title || d.query}`];
            if (d.authors) parts.push(`Authors: ${d.authors}`);
            if (d.journal) parts.push(`Journal: ${d.journal}`);
            if (d.year) parts.push(`Year: ${d.year}`);
            if (d.abstract) parts.push(`Abstract: ${d.abstract.slice(0, 300)}`);
            if (d.extra) {
              try {
                const extra = JSON.parse(d.extra);
                if (extra.resolution) parts.push(`Resolution: ${extra.resolution}Å`);
                if (extra.method) parts.push(`Method: ${extra.method}`);
                if (extra.organism) parts.push(`Organism: ${extra.organism}`);
              } catch {}
            }
            return parts.join("\n");
          })
          .join("\n\n");

        // ============ STEP 4: Generate each section ============
        const generatedParagraphs: any[] = [];
        for (let i = 0; i < sections.length; i++) {
          const section = sections[i];
          const sectionNum = i + 1;

          send("step", {
            step: "generate",
            status: "started",
            section: sectionNum,
            total: sections.length,
            title: section.title,
            message: `Generating section ${sectionNum}/${sections.length}: ${section.title}`,
          });

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
agreements and contradictions, synthesize findings across studies.

CITATION FORMAT (MANDATORY):
- Use ONLY numeric [n] citations in the body text (e.g. [1], [2], [3]).
- Number citations starting from [1] for THIS section. Each [n] refers to the n-th entry
  in the REFERENCE LIST above (which starts at [1]).
- Do NOT use [SOURCE:ID] format (no [PDB:xxx], [PMID:xxx], [UniProt:xxx] in body).
- Do NOT write empty brackets [] — always include a number.
- Do NOT output a "### Citations" block — just write the paragraph text with [n] markers.
- If you cannot support a claim with a provided source, write [$REF] as a placeholder.`;

          const content = await chat(prompt, { system, temperature: 0.65 });

          const paragraph = await db.paragraph.create({
            data: {
              projectId,
              title: section.title,
              content,
              format: section.format,
              scenario: section.scenario,
              status: "draft",
              order: i,
              wordCount: countWords(content),
            },
          });

          // Link ALL saved references to THIS paragraph (each paragraph has its own copy
          // of the full reference list, numbered from [1] to [N])
          for (const ref of savedReferences) {
            // Check if this ref is already linked to this paragraph
            const existing = await db.reference.findFirst({
              where: {
                externalId: ref.externalId,
                type: ref.type,
                paragraphId: paragraph.id,
              },
            });
            if (!existing) {
              await db.reference.create({
                data: {
                  type: ref.type,
                  externalId: ref.externalId,
                  title: ref.title,
                  authors: ref.authors,
                  journal: ref.journal,
                  year: ref.year,
                  url: ref.url,
                  doi: ref.doi,
                  abstract: ref.abstract,
                  projectId,
                  paragraphId: paragraph.id,
                },
              });
            }
          }

          generatedParagraphs.push({
            id: paragraph.id,
            title: section.title,
            format: section.format,
            wordCount: paragraph.wordCount,
            contentLength: content.length,
          });

          send("step", {
            step: "generate",
            status: "done",
            section: sectionNum,
            total: sections.length,
            title: section.title,
            wordCount: paragraph.wordCount,
            message: `Section ${sectionNum} complete: ${paragraph.wordCount} words`,
          });
        }

        // ============ STEP 5: Compose the final article ============
        send("step", { step: "compose", status: "started", message: "Composing final article..." });

        // Fetch all paragraph contents for composition, along with their references
        const allParagraphData = await Promise.all(
          generatedParagraphs.map(async (p) => {
            const para = await db.paragraph.findUnique({
              where: { id: p.id },
              include: { references: true },
            });
            const content = para?.content || "";
            const citIdx = content.indexOf("### Citations");
            const cleanContent = citIdx >= 0 ? content.slice(0, citIdx).trim() : content.trim();
            // Build paragraph-local reference map: [1] -> reference record
            const refs = para?.references || [];
            return { content: cleanContent, refs };
          })
        );

        // Renumber citations globally: walk through all paragraphs in order,
        // map each paragraph-local [n] to a global number, deduplicating references
        const globalRefMap = new Map<string, number>(); // key: type+externalId -> global number
        const globalRefs: any[] = []; // ordered list of unique references

        const renumberedContents = allParagraphData.map(({ content, refs }) => {
          // Build paragraph-local ref index: local number [1] = refs[0], etc.
          // But refs are not ordered by citation number — they're in DB order.
          // The AI cites [1] through [N] where N = refs.length, so [1] = refs[0].
          let result = content;
          // For each local citation [n] in this paragraph, map to global number
          const citeRe = /\[(\d+(?:[,\-–\s]\d+)*)\]/g;
          result = result.replace(citeRe, (match, inner: string) => {
            const nums = inner.split(/[,;]\s*/).flatMap((s: string) => {
              const rangeMatch = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
              if (rangeMatch) {
                const arr = [];
                for (let n = parseInt(rangeMatch[1]); n <= parseInt(rangeMatch[2]); n++) arr.push(n);
                return arr;
              }
              const n = parseInt(s);
              return isNaN(n) ? [] : [n];
            });

            const globalNums = nums.map((localNum: number) => {
              if (localNum < 1 || localNum > refs.length) return null;
              const ref = refs[localNum - 1];
              if (!ref) return null;
              const key = `${ref.type}:${ref.externalId || ref.title}`;
              if (!globalRefMap.has(key)) {
                const globalNum = globalRefs.length + 1;
                globalRefMap.set(key, globalNum);
                globalRefs.push(ref);
              }
              return globalRefMap.get(key)!;
            }).filter(Boolean);

            if (globalNums.length === 0) return match; // keep original if we can't resolve
            return `[${globalNums.join(",")}]`;
          });
          return result;
        });

        const composePrompt = `Compose a coherent, deeply-synthesized review article titled "${project.topic}".

Source sections (in order, with [n] citations already renumbered globally):
${renumberedContents.map((c, i) => `\n## Section ${i + 1}\n\n${c}`).join("\n\n")}

Instructions:
- Produce a unified article with section headings (## Introduction, ## Background, etc.).
- Deepen the analysis with full synthesis, contrast, and forward-looking discussion.
- Preserve ALL inline citations [n] exactly as they appear — do NOT change any numbers.
- Do NOT add a "## References" section — references are handled separately.
- Output in Markdown.`;

        const composeSystem =
          "You are a senior scientific editor who composes coherent, deeply-synthesized research articles.";
        const articleBody = await chat(composePrompt, { system: composeSystem, temperature: 0.55 });

        // Build the references list from globally renumbered, deduplicated references
        const refList = globalRefs
          .map((r, i) => {
            const auth = r.authors || "Anonymous";
            const yr = r.year ? ` (${r.year})` : "";
            const jour = r.journal ? `, ${r.journal}` : "";
            const url = r.url ? ` — ${r.url}` : "";
            return `[${i + 1}] ${auth}${yr}${jour}. ${r.title}.${url}`;
          })
          .join("\n");

        // Strip any AI-generated references section from the body
        let cleanBody = articleBody.trim();
        const refIdx = cleanBody.indexOf("## References");
        if (refIdx >= 0) {
          cleanBody = cleanBody.slice(0, refIdx).trim();
        }
        const citIdx2 = cleanBody.indexOf("### Citations");
        if (citIdx2 >= 0) {
          cleanBody = cleanBody.slice(0, citIdx2).trim();
        }

        const articleContent = cleanBody + "\n\n## References\n\n" + refList;

        const article = await db.article.create({
          data: {
            projectId,
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

        send("step", {
          step: "compose",
          status: "done",
          articleId: article.id,
          articleWordCount: countWords(articleContent),
          message: `Article composed: ${countWords(articleContent)} words`,
        });

        // ============ FINAL RESULT ============
        send("complete", {
          success: true,
          articleId: article.id,
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
        send("error", { error: err?.message || "Generation failed." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
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
