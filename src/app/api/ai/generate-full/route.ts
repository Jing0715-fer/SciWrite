import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { webSearch } from "@/lib/ai";
import { chatWithSession, clearSession } from "@/lib/llm-session";
import { queryDatabase } from "@/lib/databases";
import { countWords, renumberByAppearance } from "@/lib/writing";

export const runtime = "nodejs";
export const maxDuration = 1800; // 30 minutes — streaming keeps connection alive

interface GenerateFullBody {
  projectId: string;
  journalTemplate?: string;
  language?: string;
  targetWords?: number;
}

/**
 * Full article auto-generation pipeline:
 *  1. FORCE re-gather data sources via MULTIPLE methods (database queries + web search)
 *  2. LLM curates the most relevant sources for the article
 *  3. LLM plans article outline (sections) based on source content
 *  4. Generate each section in CHUNKS (to avoid max token) with citations
 *  5. Compose final article with global citation renumbering
 *
 * No paragraph format/scenario selection — the LLM decides the outline.
 * Target word count up to 50,000 words.
 */
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
        const targetWords = Math.min(body.targetWords || 5000, 50000);
        const journalTemplate = body.journalTemplate || "generic";

        // ============ STEP 1: FORCE re-gather data sources ============
        // Delete ALL existing data sources for this project first (fresh start)
        send("step", {
          step: "gather",
          status: "started",
          message: "Clearing existing data sources and re-gathering fresh sources...",
        });

        await db.dataSource.deleteMany({ where: { projectId } });
        // Also clear paragraph-level references (keep project-level ones for now)
        await db.reference.deleteMany({
          where: { projectId, NOT: { paragraphId: null } },
        });

        // Strategy 1: LLM-designed multi-database queries (15-20 queries)
        send("step", {
          step: "gather",
          status: "progress",
          message: "Designing multi-database search queries (PubMed, RCSB, UniProt, NCBI)...",
        });

        const gatherSystem =
          "You are a research data strategist. Given a research topic and target word count, " +
          "design a COMPREHENSIVE multi-database search plan to gather as many relevant primary " +
          "sources as possible. Distribute queries across databases based on the topic.";

        const gatherPrompt = `RESEARCH TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}
PURPOSE: Write a comprehensive review article (~${targetWords} words).

Design a search plan with 15-25 queries covering multiple aspects of the topic.
Distribute across databases: PubMed (papers), RCSB (structures), UniProt (proteins), NCBI (genes), BLAST (sequences).
Include both broad and specific queries, recent and foundational works.

Respond as STRICT JSON:
{
  "queries": [
    { "database": "pubmed", "query": "concrete search string", "rationale": "why this query" },
    { "database": "rcsb", "query": "concrete search string", "rationale": "why this query" },
    ...
  ]
}
Use lowercase database names: pubmed, uniprot, rcsb, ncbi, blast. Output JSON only.`;

        // Clear prior session for this pipeline (fresh full-article generation)
        await clearSession(projectId);

        const gatherRaw = await chatWithSession(projectId, gatherPrompt, {
          system: gatherSystem,
          temperature: 0.4,
          taskType: "gather",
          metadata: { step: "gather" },
        });
        const gatherParsed = safeParseJSON(gatherRaw, { queries: [] });
        const dbQueries = (gatherParsed.queries || []).filter(
          (q: any) => q.database && q.query && ["pubmed", "uniprot", "rcsb", "ncbi", "blast"].includes(q.database)
        );

        send("step", {
          step: "gather",
          status: "progress",
          message: `Executing ${dbQueries.length} database queries in parallel...`,
          queries: dbQueries.length,
        });

        // Strategy 1: Execute ALL database queries in parallel
        const dbQueryResults = await Promise.allSettled(
          dbQueries.map((q: any) =>
            queryDatabase(q.database as any, q.query).then((r) => ({ ...r, rationale: q.query }))
          )
        );

        const dbItems: any[] = [];
        for (const r of dbQueryResults) {
          if (r.status === "fulfilled") {
            for (const item of r.value.items || []) {
              dbItems.push({ ...item, queryUsed: r.value.query, gatherMethod: "database" });
            }
          }
        }

        send("step", {
          step: "gather",
          status: "progress",
          message: `Database queries returned ${dbItems.length} items. Now running web searches for additional sources...`,
          itemsFound: dbItems.length,
        });

        // Strategy 2: Web search for additional sources (5-10 queries)
        const webSearchQueries = await generateWebSearchQueries(projectId, project.topic, project.field || "life sciences", targetWords);
        send("step", {
          step: "gather",
          status: "progress",
          message: `Running ${webSearchQueries.length} web searches for supplementary sources...`,
        });

        const webSearchResults = await Promise.allSettled(
          webSearchQueries.map((q: string) => webSearch(q, 10))
        );

        const webItems: any[] = [];
        for (const r of webSearchResults) {
          if (r.status === "fulfilled") {
            for (const item of r.value) {
              webItems.push({
                source: "web",
                externalId: item.url,
                title: item.name || item.url,
                authors: item.host_name || undefined,
                journal: undefined,
                year: item.date?.slice(0, 4) || undefined,
                url: item.url,
                doi: undefined,
                abstract: item.snippet,
                extra: { host: item.host_name, rank: item.rank },
                queryUsed: "web_search",
                gatherMethod: "web",
              });
            }
          }
        }

        const allItems = [...dbItems, ...webItems];
        send("step", {
          step: "gather",
          status: "progress",
          message: `Total gathered: ${allItems.length} sources (${dbItems.length} from databases + ${webItems.length} from web). Saving...`,
          itemsFound: allItems.length,
        });

        // Save ALL data sources with FULL metadata
        const savedDataSources: any[] = [];
        const savedReferences: any[] = [];
        const seenExternalIds = new Set<string>(); // Dedup by externalId+source

        for (const item of allItems) {
          const dedupKey = `${item.source}:${item.externalId || item.url}`;
          if (seenExternalIds.has(dedupKey)) continue;
          seenExternalIds.add(dedupKey);

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

          // Save as reference for PubMed, RCSB-with-publication, or web sources with URLs
          const isPubMed = item.source === "pubmed";
          const isRcsbWithPub = item.source === "rcsb" && item.extra?.hasPublication;
          const isWebWithUrl = item.source === "web" && item.url;
          if (isPubMed || isRcsbWithPub || isWebWithUrl) {
            const ref = await db.reference.create({
              data: {
                type: isPubMed ? "pubmed" : isRcsbWithPub ? "pubmed" : "web",
                externalId: item.externalId || item.url,
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
          message: `Gathered ${savedDataSources.length} unique sources (${savedReferences.length} citable references).`,
        });

        if (savedReferences.length === 0 && savedDataSources.length === 0) {
          send("error", { error: "No data sources could be gathered." });
          controller.close();
          return;
        }

        // ============ STEP 2: LLM curates the most relevant sources ============
        send("step", {
          step: "curate",
          status: "started",
          message: `LLM curating ${savedReferences.length} references for a ${targetWords}-word article...`,
        });

        // For large source sets, have the LLM select the most relevant subset
        // to keep the context window manageable and the article focused.
        const maxCitableRefs = Math.min(savedReferences.length, Math.max(20, Math.floor(targetWords / 200)));
        const curatedRefs = await curateReferences(projectId, savedReferences, project.topic, project.field || "life sciences", maxCitableRefs);

        send("step", {
          step: "curate",
          status: "done",
          curatedCount: curatedRefs.length,
          totalAvailable: savedReferences.length,
          message: `Curated ${curatedRefs.length} most relevant references from ${savedReferences.length} total.`,
        });

        // ============ STEP 3: Analyze source relationships ============
        send("step", { step: "relationships", status: "started", message: "Analyzing source relationships..." });

        let relationshipContext = "";
        let relationshipSummary = "";
        try {
          const sourceList = curatedRefs.slice(0, 40).map((r: any, i: number) => {
            const parts = [`[S${i + 1}] ${r.authors || "Anon"} (${r.year || "n.d."}) — ${r.title?.slice(0, 100) || "Untitled"}`];
            if (r.journal) parts.push(`Journal: ${r.journal}`);
            if (r.abstract) parts.push(`Abstract: ${r.abstract.slice(0, 150)}`);
            return parts.join("\n");
          }).join("\n\n");

          const relSystem =
            "You are a scientific knowledge graph analyst. Analyze relationships between data sources " +
            "and produce a thematic summary for deep article writing.";

          const relPrompt = `RESEARCH TOPIC: ${project.topic}

TOP ${curatedRefs.length} CURATED SOURCES:
${sourceList}

Analyze how these sources relate. Respond as STRICT JSON:
{
  "summary": "2-3 sentence overview of source relationships",
  "themes": [{"name": "theme", "sourceLabels": ["S1","S3"], "description": "how they connect"}],
  "keyConnections": ["connection 1", "connection 2"],
  "contradictions": [{"sourceLabels": ["S2","S7"], "description": "what they disagree on"}]
}`;

          const relRaw = await chatWithSession(projectId, relPrompt, {
            system: relSystem,
            temperature: 0.4,
            taskType: "relationships",
            metadata: { step: "relationships", sourceCount: curatedRefs.length },
          });
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

        // ============ STEP 4: Plan article outline from source content ============
        send("step", { step: "plan", status: "started", message: "Planning article outline based on source content..." });

        const planSystem =
          "You are a senior research advisor who designs publication-ready article outlines. " +
          "Given a research topic, curated references, and a target word count, produce a detailed " +
          "section plan with target word counts that sum to the total target. " +
          "For large articles, plan MORE sections with SMALLER word counts to avoid exceeding " +
          "the LLM's max token limit per section.";

        const planPrompt = `RESEARCH TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}
TARGET TOTAL WORDS: ${targetWords}
CURATED REFERENCES: ${curatedRefs.length} citable references + ${savedDataSources.length} data sources.

KEY SOURCES BY THEME:
${curatedRefs.slice(0, 30).map((r: any, i: number) =>
  `[${i + 1}] ${r.authors || "Anon"} (${r.year || "n.d."}) ${r.title?.slice(0, 80) || ""}`
).join("\n")}

Plan a comprehensive review article. For ${targetWords} words, use ${Math.max(5, Math.ceil(targetWords / 800))}-${Math.max(8, Math.ceil(targetWords / 600))} sections.
Each section should be 400-1500 words (keep sections SMALL to avoid max token issues).
The sum of all section word counts should be approximately ${targetWords}.

Respond as STRICT JSON:
{
  "sections": [
    {
      "title": "A descriptive section title",
      "focus": "What this section should cover, which source themes to draw from",
      "targetWords": 600,
      "suggestedRefIndices": [1, 3, 5]
    }
  ]
}
Output JSON only.`;

        const planRaw = await chatWithSession(projectId, planPrompt, {
          system: planSystem,
          temperature: 0.5,
          taskType: "plan",
          metadata: { step: "plan", targetWords, refCount: curatedRefs.length },
        });
        const planParsed = safeParseJSON(planRaw, { sections: [] });
        const sections = (planParsed.sections || []).filter(
          (s: any) => s.title && s.targetWords
        );

        if (sections.length === 0) {
          send("error", { error: "Could not plan article sections." });
          controller.close();
          return;
        }

        send("step", {
          step: "plan",
          status: "done",
          sections: sections.map((s: any) => ({ title: s.title, targetWords: s.targetWords })),
          sectionCount: sections.length,
          message: `Planned ${sections.length} sections totaling ~${sections.reduce((s: number, sec: any) => s + (sec.targetWords || 0), 0)} words.`,
        });

        // ============ STEP 5: Build context strings ============
        const refContext = curatedRefs
          .map((r: any, i: number) => {
            const auth = r.authors || "Anon";
            const yr = r.year ? ` (${r.year})` : "";
            const jour = r.journal ? `, ${r.journal}` : "";
            const url = r.url ? ` — ${r.url}` : "";
            const abs = r.abstract ? `\nAbstract: ${r.abstract.slice(0, 200)}` : "";
            return `[${i + 1}] ${auth}${yr}${jour}. ${r.title}.${url}${abs}`;
          })
          .join("\n");

        const dsContext = savedDataSources
          .slice(0, 60) // Limit data source context to avoid token overflow
          .map((d: any, i: number) => {
            const parts = [`[DS:${i + 1}] (${d.source}) ${d.title || d.query}`];
            if (d.authors) parts.push(`Authors: ${d.authors}`);
            if (d.journal) parts.push(`Journal: ${d.journal}`);
            if (d.year) parts.push(`Year: ${d.year}`);
            if (d.abstract) parts.push(`Abstract: ${d.abstract.slice(0, 200)}`);
            return parts.join("\n");
          })
          .join("\n\n");

        // ============ STEP 6: Generate each section (chunked) ============
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
            message: `Generating section ${sectionNum}/${sections.length}: ${section.title} (~${section.targetWords} words)`,
          });

          // For sections with high target words, generate in sub-chunks
          const sectionTargetWords = section.targetWords || 600;
          const needsChunking = sectionTargetWords > 1200;
          const chunkCount = needsChunking ? Math.ceil(sectionTargetWords / 1000) : 1;

          let fullSectionContent = "";

          for (let chunk = 0; chunk < chunkCount; chunk++) {
            const chunkNum = chunk + 1;
            if (chunkCount > 1) {
              send("step", {
                step: "generate",
                status: "progress",
                section: sectionNum,
                total: sections.length,
                chunk: chunkNum,
                totalChunks: chunkCount,
                message: `Section ${sectionNum} chunk ${chunkNum}/${chunkCount}...`,
              });
            }

            const chunkFocus = chunkCount > 1
              ? `${section.focus} (Part ${chunkNum} of ${chunkCount} — focus on ${chunk === 0 ? "introduction and background" : chunk === chunkCount - 1 ? "synthesis and conclusion" : "detailed analysis"})`
              : section.focus;

            const chunkWords = Math.ceil(sectionTargetWords / chunkCount);

            const prompt = `RESEARCH TOPIC: ${project.topic}
SECTION ${sectionNum} of ${sections.length}: ${section.title}
${chunkCount > 1 ? `PART ${chunkNum} of ${chunkCount}` : ""}
FOCUS: ${chunkFocus}
TARGET WORDS: ${chunkWords}
LANGUAGE: ${language}

REFERENCE LIST (cite as [n], 1-based index into this list of ${curatedRefs.length} refs):
${refContext}

DATABASE RECORDS (structural/sequence data — cite the associated publication):
${dsContext}
${relationshipContext}

${chunk > 0 ? `PREVIOUS PART OF THIS SECTION (for continuity, do NOT repeat):\n${fullSectionContent.slice(-800)}` : ""}

Now compose ${chunkCount > 1 ? `part ${chunkNum}` : "this section"}. Write DEEPLY — discuss connections between sources,
highlight agreements and contradictions, synthesize findings across studies.

CITATION FORMAT (MANDATORY):
- Use ONLY numeric [n] citations (e.g. [1], [2], [3]).
- Number citations starting from [1] for THIS section. Each [n] refers to the n-th entry
  in the REFERENCE LIST above (${curatedRefs.length} entries, [1] to [${curatedRefs.length}]).
- Cite AT LEAST 3 different references per ~500 words.
- Do NOT use numbers greater than ${curatedRefs.length}. Use [$REF] as placeholder if needed.
- Do NOT use [SOURCE:ID] format in body.
- Do NOT write empty brackets [].
- Do NOT output a "### Citations" block — just write the text with [n] markers.`;

            const system = `You are a senior scientific research writer and domain expert (${project.field || "life sciences"}).
Write in ${language}, using formal, precise academic prose (third person, past tense for results/methods).
Compose ONE cohesive section without markdown headers.`;

            let chunkContent = await chatWithSession(projectId, prompt, {
              system,
              temperature: 0.65,
              taskType: "generate",
              metadata: {
                step: "generate",
                section: sectionNum,
                sectionTitle: section.title,
                chunk: chunkCount > 1 ? `${chunkNum}/${chunkCount}` : undefined,
                targetWords: chunkWords,
              },
            });

            // Sanitize citations
            const maxRefNum = curatedRefs.length;
            chunkContent = chunkContent.replace(
              /\[(\d+(?:[,\-–]\s*\d+)*)\]/g,
              (match, inner: string) => {
                const nums = inner.split(/[,;]\s*/).flatMap((s: string) => {
                  const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
                  if (rm) {
                    const arr: number[] = [];
                    for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) arr.push(n);
                    return arr;
                  }
                  const n = parseInt(s);
                  return isNaN(n) ? [] : [n];
                });
                const validNums = nums.filter((n: number) => n >= 1 && n <= maxRefNum);
                if (validNums.length === 0) return "[$REF]";
                if (validNums.length < nums.length) return `[${validNums.join(",")}]`;
                return match;
              }
            );

            fullSectionContent += (chunk > 0 ? "\n\n" : "") + chunkContent;
          }

          // Renumber citations by order of first appearance within this section
          const { content: renumberedContent, references: citedRefs } =
            renumberByAppearance(fullSectionContent, curatedRefs);

          const paragraph = await db.paragraph.create({
            data: {
              projectId,
              title: section.title,
              content: renumberedContent,
              format: inferFormat(section.title, i, sections.length),
              scenario: "literature-review",
              status: "draft",
              order: i,
              wordCount: countWords(renumberedContent),
            },
          });

          // Link ONLY cited references (copies, not move)
          for (let idx = 0; idx < citedRefs.length; idx++) {
            const ref = citedRefs[idx] as any;
            const existing = await db.reference.findFirst({
              where: { externalId: ref.externalId, paragraphId: paragraph.id },
            });
            if (!existing) {
              await db.reference.create({
                data: {
                  type: ref.type || "pubmed",
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
                  citationOrder: idx,
                },
              });
            } else {
              await db.reference.update({
                where: { id: existing.id },
                data: { citationOrder: idx },
              });
            }
          }

          generatedParagraphs.push({
            id: paragraph.id,
            title: section.title,
            wordCount: paragraph.wordCount,
            contentLength: renumberedContent.length,
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

        // ============ STEP 7: Compose the final article ============
        send("step", { step: "compose", status: "started", message: "Composing final article with global citation renumbering..." });

        const allParagraphData = await Promise.all(
          generatedParagraphs.map(async (p) => {
            const para = await db.paragraph.findUnique({
              where: { id: p.id },
              include: { references: { orderBy: { citationOrder: "asc" } } },
            });
            const content = para?.content || "";
            const citIdx = content.indexOf("### Citations");
            const cleanContent = citIdx >= 0 ? content.slice(0, citIdx).trim() : content.trim();
            const refs = para?.references || [];
            return { content: cleanContent, refs };
          })
        );

        // Global citation renumbering
        const globalRefMap = new Map<string, number>();
        const globalRefs: any[] = [];

        const renumberedContents = allParagraphData.map(({ content, refs }) => {
          let result = content;
          const citeRe = /\[(\d+(?:[,\-–]\s*\d+)*)\]/g;
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

            if (globalNums.length === 0) return match;
            return `[${globalNums.join(",")}]`;
          });
          return result;
        });

        // For very large articles, compose without LLM (just concatenate with headings)
        // to avoid max token issues. The LLM already generated coherent sections.
        const isLargeArticle = generatedParagraphs.reduce((s, p) => s + p.wordCount, 0) > 8000;

        let articleBody: string;
        if (isLargeArticle) {
          // Direct assembly — no LLM composition (sections already coherent)
          articleBody = renumberedContents
            .map((c, i) => `## ${sections[i].title}\n\n${c}`)
            .join("\n\n");
          send("step", {
            step: "compose",
            status: "progress",
            message: `Large article (${generatedParagraphs.reduce((s, p) => s + p.wordCount, 0)} words) — assembling sections directly (no LLM re-composition to avoid token limits).`,
          });
        } else {
          // LLM composition for smaller articles
          const composePrompt = `Compose a coherent, deeply-synthesized review article titled "${project.topic}".

Source sections (in order, with [n] citations already renumbered globally):
${renumberedContents.map((c, i) => `\n## Section ${i + 1}\n\n${c}`).join("\n\n")}

Instructions:
- Produce a unified article with section headings.
- Deepen the analysis with synthesis, contrast, and forward-looking discussion.
- Preserve ALL inline citations [n] exactly as they appear — do NOT change any numbers.
- Do NOT include ANY references, citations list, bibliography, or "## References" section.
- Output ONLY the article body in Markdown.`;

          const composeSystem =
            "You are a senior scientific editor who composes coherent, deeply-synthesized research articles.";
          articleBody = await chatWithSession(projectId, composePrompt, {
            system: composeSystem,
            temperature: 0.55,
            taskType: "compose",
            metadata: { step: "compose", sectionCount: renumberedContents.length },
          });
        }

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

        // Strip any AI-generated references section
        let cleanBody = articleBody.trim();
        const refSectionRe =
          /^#{0,6}\s*\*{0,2}(References|REFERENCES|Citations|Bibliography|文献|参考文献)\*{0,2}\s*:?\s*$/m;
        const refMatch = cleanBody.match(refSectionRe);
        if (refMatch && refMatch.index !== undefined) {
          cleanBody = cleanBody.slice(0, refMatch.index).trim();
        }
        const bareRefRe = /^\s*(REFERENCES|References)\s*:?\s*$/m;
        const bareMatch = cleanBody.match(bareRefRe);
        if (bareMatch && bareMatch.index !== undefined) {
          cleanBody = cleanBody.slice(0, bareMatch.index).trim();
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
                section: inferFormat(sections[i].title, i, sections.length),
              })),
            },
          },
        });

        send("step", {
          step: "compose",
          status: "done",
          articleId: article.id,
          articleWordCount: countWords(articleContent),
          message: `Article composed: ${countWords(articleContent)} words, ${globalRefs.length} references.`,
        });

        // ============ FINAL RESULT ============
        send("complete", {
          success: true,
          articleId: article.id,
          relationshipSummary,
          stats: {
            sourcesGathered: savedDataSources.length,
            referencesSaved: savedReferences.length,
            curatedReferences: curatedRefs.length,
            sectionsPlanned: sections.length,
            paragraphsGenerated: generatedParagraphs.length,
            totalWords: generatedParagraphs.reduce((s, p) => s + p.wordCount, 0),
            articleWordCount: countWords(articleContent),
            globalReferenceCount: globalRefs.length,
          },
          sections: generatedParagraphs,
          queriesExecuted: dbQueries.length + webSearchQueries.length,
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

/**
 * Generate web search queries to supplement database queries.
 */
async function generateWebSearchQueries(projectId: string, topic: string, field: string, targetWords: number): Promise<string[]> {
  try {
    const system = "You are a research strategist who designs web search queries to find supplementary sources.";
    const prompt = `RESEARCH TOPIC: ${topic}
FIELD: ${field}
TARGET: ${targetWords}-word comprehensive review article.

Design 5-8 web search queries to find recent reviews, preprints, news articles, and
supplementary sources not available in PubMed/RCSB/UniProt. Include review-specific
and mechanism-specific queries.

Respond as STRICT JSON: { "queries": ["query 1", "query 2", ...] }`;

    const raw = await chatWithSession(projectId, prompt, {
      system,
      temperature: 0.4,
      taskType: "gather",
      metadata: { step: "web-search-queries" },
    });
    const parsed = safeParseJSON(raw, { queries: [] });
    return (parsed.queries || []).slice(0, 8);
  } catch {
    return [`${topic} review`, `${topic} mechanism`, `${topic} recent advances`];
  }
}

/**
 * Have the LLM curate the most relevant references for the article.
 * This reduces the reference set to a manageable size and ensures focus.
 */
async function curateReferences(
  projectId: string,
  references: any[],
  topic: string,
  field: string,
  maxCount: number
): Promise<any[]> {
  if (references.length <= maxCount) return references;

  try {
    const system = "You are a research curator who selects the most relevant references for a review article.";
    const refList = references.map((r, i) => {
      const auth = r.authors || "Anon";
      const yr = r.year ? ` (${r.year})` : "";
      return `[${i + 1}] ${auth}${yr} ${r.title?.slice(0, 80) || ""}`;
    }).join("\n");

    const prompt = `RESEARCH TOPIC: ${topic}
FIELD: ${field}
TARGET: Select the ${maxCount} MOST relevant references for a comprehensive review.

AVAILABLE REFERENCES (${references.length} total):
${refList}

Select the most relevant, recent, and authoritative references. Prioritize:
1. Recent publications (last 5 years)
2. Seminal/foundational papers
3. Review articles covering the topic
4. Primary research with key findings

Respond as STRICT JSON: { "indices": [1, 3, 5, 7, ...] }
Use 1-based indices. Select exactly ${maxCount} references.`;

    const raw = await chatWithSession(projectId, prompt, {
      system,
      temperature: 0.3,
      taskType: "curate",
      metadata: { step: "curate", total: references.length, maxCount },
    });
    const parsed = safeParseJSON(raw, { indices: [] });
    const indices = (parsed.indices || [])
      .filter((n: number) => n >= 1 && n <= references.length)
      .slice(0, maxCount);

    if (indices.length === 0) {
      return references.slice(0, maxCount);
    }

    return indices.map((n: number) => references[n - 1]);
  } catch {
    return references.slice(0, maxCount);
  }
}

/**
 * Infer paragraph format from section title and position.
 */
function inferFormat(title: string, index: number, total: number): string {
  const lower = title.toLowerCase();
  if (index === 0) return "abstract";
  if (lower.includes("introduc")) return "intro";
  if (lower.includes("background")) return "background";
  if (lower.includes("method")) return "methods";
  if (lower.includes("result")) return "results";
  if (lower.includes("discussion")) return "discussion";
  if (lower.includes("conclusion") || lower.includes("future") || index === total - 1) return "conclusion";
  return "background";
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
