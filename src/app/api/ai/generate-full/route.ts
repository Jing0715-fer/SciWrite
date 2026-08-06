import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { webSearch } from "@/lib/ai";
import { chatWithSession, clearSession } from "@/lib/llm-session";
import { queryDatabase, fetchFullTextForPubMed } from "@/lib/databases";
import { countWords, renumberByAppearance, sanitizeSectionContent, buildStructureContextFromDataSources } from "@/lib/writing";
import { validateCitationsInline } from "@/lib/citation-audit";

export const runtime = "nodejs";
export const maxDuration = 1800; // 30 minutes — streaming keeps connection alive

interface GenerateFullBody {
  projectId: string;
  journalTemplate?: string;
  language?: string;
  targetWords?: number;
  /**
   * Advanced tuning parameters (all optional — sensible defaults are applied
   * so the UI's "Advanced settings" panel can stay collapsed for most users).
   * These are surfaced in the Full Article tab's Advanced section so users
   * can adjust gathering aggressiveness and per-section reference filtering
   * without editing code.
   */
  /** Max number of database (PubMed/RCSB/UniProt/NCBI/BLAST) queries the
   *  LLM is told to design in the gather step. Default 25. */
  maxDbQueries?: number;
  /** Max number of supplementary web-search queries. Default 8. */
  maxWebSearchQueries?: number;
  /** Character budget the gather prompt tells the LLM to stay under for the
   *  JSON response. Default 4000. */
  gatherJsonCharLimit?: number;
  /** Per-section reference filtering: how many top-scoring refs to keep
   *  (by keyword overlap with the section title+focus). Default 20. */
  sectionRefTopN?: number;
  /** Per-section reference filtering: minimum refs to keep (topped up from
   *  the global list if fewer match). Default 8. */
  sectionRefMinN?: number;
  /** Per-section data-source filtering: top N to keep. Default 15. */
  sectionDsTopN?: number;
  /** Per-section data-source filtering: minimum to keep. Default 5. */
  sectionDsMinN?: number;
  /** max_tokens for LLM calls. Default 16384. */
  maxTokens?: number;
  /** Custom instruction from a selected prompt template — appended to the
   *  section-generation prompt to customize LLM behavior (e.g. "Focus on
   *  clinical implications"). Empty string = no custom instruction. */
  promptInstruction?: string;
}

/**
 * Full article auto-generation pipeline:
 *  1. FORCE re-gather data sources via MULTIPLE methods (database queries + web search)
 *     — NO artificial cap on the number of sources; we keep ALL unique results.
 *  2. LLM curates the most relevant sources for the article (informational; full set is still saved)
 *  3. LLM plans article outline (sections) based on source content
 *  4. Generate each section in CHUNKS with citations — token streams to the client
 *     — When language === "both", we ALWAYS generate English first, then translate per-section
 *        to Chinese in a dedicated "translate" step. This eliminates the prior bug where
 *        mixed-language prompts produced chapters that were only in English.
 *  5. Compose final article with global citation renumbering (English version)
 *  6. (both mode only) Translate every section English → Chinese, compose Chinese article
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
      let isClosed = false;
      const send = (event: string, data: any) => {
        if (isClosed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ event, ...data })}\n\n`)
          );
        } catch {
          // Controller may be closed already
          isClosed = true;
        }
      };
      const safeClose = () => {
        if (isClosed) return;
        isClosed = true;
        try { controller.close(); } catch {}
      };

      // Hang-instrumentation: per-step timing markers.
      const t0 = Date.now();
      const fsModule = await import("node:fs");
      const debugLogPath = "generate-full-debug.log";
      try {
        fsModule.writeFileSync(
          debugLogPath,
          `--- generate-full start @ ${new Date().toISOString()} pid=${process.pid} projectId=${projectId}\n`,
        );
      } catch {}
      const log = (msg: string) => {
        const line = `[generate-full] +${String(Date.now() - t0).padStart(7)}ms ${msg}`;
        try { fsModule.appendFileSync(debugLogPath, line + "\n"); } catch {}
        try { console.log(line); } catch {}
      };
      log("controller open, entering try-block");

      try {
        const project = await db.project.findUnique({ where: { id: projectId } });
        if (!project) {
          send("error", { error: "Project not found." });
          safeClose();
          return;
        }

        const requestedLanguage = body.language || "English";
        const isBothMode = requestedLanguage === "both";
        // For section generation we ALWAYS use English first (even in "both" mode).
        // Chinese is produced in a dedicated translate step afterwards.
        const generationLanguage = "English";
        const targetWords = Math.min(body.targetWords || 5000, 50000);
        const journalTemplate = body.journalTemplate || "generic";

        // ---- Advanced tuning parameters (all clamped to safe ranges) ----
        // These come from the UI's "Advanced settings" panel. Defaults match
        // the previously hard-coded values so behavior is unchanged when the
        // user leaves the panel collapsed.
        //
        // SEMANTICS: a value of 0 means "no upper limit" — the LLM is told
        // to design as many queries / keep as many refs as it sees fit. This
        // is useful for power users who want maximum coverage. Internally we
        // represent "no limit" with a large sentinel (9999) so downstream
        // .slice(0, N) calls effectively keep everything.
        const clampOrUnlimited = (v: number | undefined, dflt: number, lo: number, hi: number) => {
          const raw = v ?? dflt;
          if (raw === 0) return 9999; // 0 = no limit
          return Math.max(lo, Math.min(hi, raw));
        };
        const maxDbQueries = clampOrUnlimited(body.maxDbQueries, 25, 5, 50);
        const maxWebSearchQueries = clampOrUnlimited(body.maxWebSearchQueries, 8, 3, 20);
        const gatherJsonCharLimit = Math.max(2000, Math.min(10000, body.gatherJsonCharLimit ?? 4000));
        const sectionRefTopN = clampOrUnlimited(body.sectionRefTopN, 20, 5, 40);
        const sectionRefMinN = Math.max(3, Math.min(Math.min(sectionRefTopN, 40), body.sectionRefMinN ?? 8));
        const sectionDsTopN = clampOrUnlimited(body.sectionDsTopN, 15, 3, 30);
        const sectionDsMinN = Math.max(2, Math.min(Math.min(sectionDsTopN, 30), body.sectionDsMinN ?? 5));
        const maxTokens = Math.max(4096, Math.min(32768, body.maxTokens ?? 16384));
        // Custom prompt instruction from a selected template — appended to
        // the section-generation prompt. Empty string = no customization.
        const promptInstruction = (body.promptInstruction || "").trim();

        send("step", {
          step: "init",
          status: "done",
          message: `Pipeline initialized. Language: ${requestedLanguage}${isBothMode ? " (English-first, then translate)" : ""}. Target: ${targetWords} words.`,
          config: {
            language: requestedLanguage,
            targetWords,
            journalTemplate,
            bothMode: isBothMode,
            advanced: {
              maxDbQueries,
              maxWebSearchQueries,
              gatherJsonCharLimit,
              sectionRefTopN,
              sectionRefMinN,
              sectionDsTopN,
              sectionDsMinN,
              maxTokens,
            },
          },
        });
        log(`init: language=${requestedLanguage}, bothMode=${isBothMode}, targetWords=${targetWords}, advanced={dbQ:${maxDbQueries}, webQ:${maxWebSearchQueries}, refTop:${sectionRefTopN}, refMin:${sectionRefMinN}, dsTop:${sectionDsTopN}, dsMin:${sectionDsMinN}, maxTok:${maxTokens}}`);

        // ============ STEP 1: FORCE re-gather data sources ============
        // Delete ALL existing data sources for this project first (fresh start)
        send("step", {
          step: "gather",
          status: "started",
          message: "Clearing existing data sources and re-gathering fresh sources...",
        });
        log("gather: starting, clearing existing rows");

        await db.$transaction([
          db.annotation.deleteMany({ where: { paragraph: { projectId } } }),
          db.articleParagraph.deleteMany({ where: { paragraph: { projectId } } }),
          db.paragraph.deleteMany({ where: { projectId } }),
          db.dataSource.deleteMany({ where: { projectId } }),
          db.reference.deleteMany({ where: { projectId } }),
        ]);
        log("gather: cleared existing rows in DB (single transaction)");

        // Strategy 1: LLM-designed multi-database queries (capped at maxDbQueries)
        send("step", {
          step: "gather",
          status: "progress",
          message: "Designing multi-database search queries (PubMed, RCSB, UniProt, NCBI)...",
          detail: `Asking LLM to design up to ${maxDbQueries} queries across databases`,
        });

        const gatherSystem =
          "You are a research data strategist. Given a research topic and target word count, " +
          "design a COMPREHENSIVE multi-database search plan to gather as many relevant primary " +
          "sources as possible. Distribute queries across databases based on the topic.";

        // Build the gather prompt. When maxDbQueries === 9999 (user set 0 =
        // no limit in the UI), tell the LLM to design as many queries as it
        // sees fit. Otherwise give a concrete cap to avoid JSON truncation.
        const isDbUnlimited = maxDbQueries >= 9999;
        const dbQueryInstruction = isDbUnlimited
          ? `Design as many well-chosen queries as needed for MAXIMUM coverage (no upper limit — but keep the JSON concise so it doesn't get truncated).`
          : `Design a focused search plan with ${Math.max(5, maxDbQueries - 5)}-${maxDbQueries} well-chosen queries (NOT more — generating too many causes the JSON to be truncated by the LLM's output token limit, which wastes the entire step).`;

        const gatherPrompt = `RESEARCH TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}
PURPOSE: Write a comprehensive review article (~${targetWords} words).

${dbQueryInstruction} Each query should target a distinct aspect of the topic.

For PubMed (use ${isDbUnlimited ? "10-30" : `${Math.max(4, Math.round(maxDbQueries * 0.5))}-${Math.max(6, Math.round(maxDbQueries * 0.6))}`} queries with DIFFERENT strategies):
- 1-2 broad topic reviews (e.g. "TMC protein family review")
- 2-3 specific mechanism queries (e.g. "TMC1 cryo-EM structure pore")
- 2-3 disease/mutation queries (e.g. "TMC1 mutation deafness DFNA36")
- 1-2 protein interaction queries (e.g. "TMC1 LHFPL5 CIB2 interaction")
- 1-2 functional queries (e.g. "TMC mechanotransduction ion channel")
- 1-2 gene-specific queries for the MOST IMPORTANT family members only

For RCSB: ${isDbUnlimited ? "2-5" : `${Math.max(1, Math.round(maxDbQueries * 0.1))}-${Math.max(2, Math.round(maxDbQueries * 0.15))}`} structure-related keyword searches
For UniProt: ${isDbUnlimited ? "2-5" : `${Math.max(1, Math.round(maxDbQueries * 0.1))}-${Math.max(2, Math.round(maxDbQueries * 0.15))}`} searches for the main family members by gene name (avoid organism: filter)
For NCBI: 1-${isDbUnlimited ? "3" : Math.max(2, Math.round(maxDbQueries * 0.1))} gene searches for the main members
For BLAST: 1 representative sequence search

Keep the JSON concise — short rationale strings (under 60 chars).
Duplicates will be removed automatically, so don't generate near-duplicate queries.

Respond as STRICT JSON (keep it under ${gatherJsonCharLimit} characters total):
{
  "queries": [
    { "database": "pubmed", "query": "concrete search string", "rationale": "short reason" },
    { "database": "rcsb", "query": "concrete search string", "rationale": "short reason" },
    ...
  ]
}
Use lowercase database names: pubmed, uniprot, rcsb, ncbi, blast. Output JSON only.`;

        // Clear prior session for this pipeline (fresh full-article generation).
        // Also clear the LLM cache so gather/curate/plan/relationships get
        // fresh results — the user explicitly clicked "generate" so they want
        // new output, not cached results from a previous run.
        await clearSession(projectId);
        try {
          const { clearLLMCache } = await import("@/lib/llm-cache");
          clearLLMCache();
          log("cleared LLM cache for fresh generation");
        } catch {}

        const gatherRaw = await chatWithSession(projectId, gatherPrompt, {
          system: gatherSystem,
          temperature: 0.4,
          taskType: "gather",
          metadata: { step: "gather" },
          maxTokens,
        });
        const gatherParsed = safeParseJSON(gatherRaw, { queries: [] });
        let dbQueries = (gatherParsed.queries || []).filter(
          (q: any) => q.database && q.query && ["pubmed", "uniprot", "rcsb", "ncbi", "blast"].includes(q.database)
        );

        // Fallback: if LLM didn't return valid JSON queries, generate
        // basic queries from the topic so we still get some data
        if (dbQueries.length === 0) {
          log(`gather: LLM returned 0 queries (JSON parse failed), using fallback queries`);
          send("step", {
            step: "gather",
            status: "progress",
            message: `LLM JSON parse failed — using fallback search queries based on topic...`,
          });
          // Extract key terms from the topic
          const topicLower = project.topic.toLowerCase();
          const topicWords = topicLower.split(/\s+/).filter(w => w.length > 3).slice(0, 5);
          const topicPhrase = topicWords.join(" ");

          dbQueries = [
            { database: "pubmed", query: `${topicPhrase} review`, rationale: "fallback" },
            { database: "pubmed", query: `${topicPhrase} mechanism`, rationale: "fallback" },
            { database: "pubmed", query: `${topicPhrase} function`, rationale: "fallback" },
            { database: "pubmed", query: `${topicPhrase} structure`, rationale: "fallback" },
            { database: "pubmed", query: `${topicPhrase} mutation disease`, rationale: "fallback" },
            { database: "pubmed", query: `${topicPhrase} recent advances`, rationale: "fallback" },
            { database: "pubmed", query: `${topicWords[0]} protein family`, rationale: "fallback" },
            { database: "pubmed", query: `${topicWords[0]} gene expression`, rationale: "fallback" },
            { database: "pubmed", query: `${topicWords[0]} interaction`, rationale: "fallback" },
            { database: "pubmed", query: `${topicWords[0]} clinical`, rationale: "fallback" },
            { database: "rcsb", query: topicWords[0] || project.topic, rationale: "fallback" },
            { database: "uniprot", query: topicWords[0] || project.topic, rationale: "fallback" },
            { database: "ncbi", query: `${topicWords[0]}[Gene] AND Homo sapiens[Organism]`, rationale: "fallback" },
          ];
        }

        send("step", {
          step: "gather",
          status: "progress",
          message: `LLM designed ${dbQueries.length} database queries. Executing in parallel (rate-limited for NCBI)...`,
          queries: dbQueries.length,
          detail: dbQueries.map((q: any) => `[${q.database}] ${q.query}`).join("\n"),
        });
        log(`gather: LLM designed ${dbQueries.length} queries`);

        // Strategy 1: Execute database queries with rate limiting for NCBI APIs
        // NCBI E-utilities limit: 3 requests/second without API key.
        // Group by database and execute PubMed/NCBI queries sequentially with delay.
        const ncbiQueries = dbQueries.filter((q: any) => q.database === "pubmed" || q.database === "ncbi");
        const otherQueries = dbQueries.filter((q: any) => q.database !== "pubmed" && q.database !== "ncbi");

        log(`gather: kicking off parallel DB queries — ncbi=${ncbiQueries.length}, others=${otherQueries.length}`);

        // Execute non-NCBI queries in parallel (RCSB, UniProt, BLAST don't rate-limit)
        // Emit per-query progress so the user sees exactly which queries ran.
        // Each query is retried up to 2 times with exponential backoff for
        // transient failures (429 rate limit, network errors).
        const otherResults: PromiseSettledResult<any>[] = await Promise.all(
          otherQueries.map(async (q: any) => {
            try {
              let r: any = null;
              let lastErr: any = null;
              // Retry loop: up to 3 attempts (1 initial + 2 retries)
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  r = await queryDatabase(q.database as any, q.query);
                  break;
                } catch (err: any) {
                  lastErr = err;
                  // Don't retry on 400 (query syntax error — retrying won't help)
                  if (err?.message?.includes("HTTP 400")) break;
                  // Don't retry on the last attempt
                  if (attempt >= 2) break;
                  // Exponential backoff: 1s, 2s
                  const delay = 1000 * Math.pow(2, attempt);
                  send("step", {
                    step: "gather",
                    status: "progress",
                    message: `[${q.database}] "${q.query.slice(0, 50)}..." retry ${attempt + 1}/2 (${delay}ms delay)...`,
                    queryDatabase: q.database,
                    queryPreview: q.query.slice(0, 80),
                    resultCount: 0,
                    retrying: true,
                  });
                  await new Promise((resolve) => setTimeout(resolve, delay));
                }
              }
              if (!r) throw lastErr;
              send("step", {
                step: "gather",
                status: "progress",
                message: `[${q.database}] "${q.query.slice(0, 50)}${q.query.length > 50 ? "..." : ""}" → ${r.items?.length || 0} results`,
                queryDatabase: q.database,
                queryPreview: q.query.slice(0, 80),
                resultCount: r.items?.length || 0,
              });
              return { status: "fulfilled", value: { ...r, rationale: q.query } } as PromiseSettledResult<any>;
            } catch (err: any) {
              send("step", {
                step: "gather",
                status: "progress",
                message: `[${q.database}] "${q.query.slice(0, 50)}..." FAILED: ${err?.message?.slice(0, 80) || "unknown"}`,
                queryDatabase: q.database,
                queryPreview: q.query.slice(0, 80),
                resultCount: 0,
                failed: true,
              });
              return { status: "rejected", reason: err } as PromiseSettledResult<any>;
            }
          })
        );

        // Execute NCBI queries sequentially with 400ms delay between each (stays under 3/sec)
        // Each query is retried up to 2 times for transient failures.
        const ncbiResults: PromiseSettledResult<any>[] = [];
        for (let qi = 0; qi < ncbiQueries.length; qi++) {
          const q = ncbiQueries[qi];
          try {
            let r: any = null;
            let lastErr: any = null;
            // Retry loop: up to 3 attempts (1 initial + 2 retries)
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                r = await queryDatabase(q.database as any, q.query);
                break;
              } catch (err: any) {
                lastErr = err;
                if (err?.message?.includes("HTTP 400")) break;
                if (attempt >= 2) break;
                const delay = 1000 * Math.pow(2, attempt);
                send("step", {
                  step: "gather",
                  status: "progress",
                  message: `[${q.database} ${qi + 1}/${ncbiQueries.length}] retry ${attempt + 1}/2 (${delay}ms delay)...`,
                  queryDatabase: q.database,
                  queryIndex: qi + 1,
                  queryTotal: ncbiQueries.length,
                  queryPreview: q.query.slice(0, 80),
                  resultCount: 0,
                  retrying: true,
                });
                await new Promise((resolve) => setTimeout(resolve, delay));
              }
            }
            if (!r) throw lastErr;
            ncbiResults.push({ status: "fulfilled", value: { ...r, rationale: q.query } });
            send("step", {
              step: "gather",
              status: "progress",
              message: `[${q.database} ${qi + 1}/${ncbiQueries.length}] "${q.query.slice(0, 50)}${q.query.length > 50 ? "..." : ""}" → ${r.items?.length || 0} results`,
              queryDatabase: q.database,
              queryIndex: qi + 1,
              queryTotal: ncbiQueries.length,
              queryPreview: q.query.slice(0, 80),
              resultCount: r.items?.length || 0,
            });
          } catch (err: any) {
            ncbiResults.push({ status: "rejected", reason: err });
            send("step", {
              step: "gather",
              status: "progress",
              message: `[${q.database} ${qi + 1}/${ncbiQueries.length}] "${q.query.slice(0, 50)}..." FAILED: ${err?.message?.slice(0, 80) || "unknown"}`,
              queryDatabase: q.database,
              queryIndex: qi + 1,
              queryTotal: ncbiQueries.length,
              queryPreview: q.query.slice(0, 80),
              resultCount: 0,
              failed: true,
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 400)); // Rate limit
        }

        const dbQueryResults = [...otherResults, ...ncbiResults];

        const dbItems: any[] = [];
        let failedQueries = 0;
        for (const r of dbQueryResults) {
          if (r.status === "fulfilled") {
            for (const item of r.value.items || []) {
              dbItems.push({ ...item, queryUsed: r.value.query, gatherMethod: "database" });
            }
          } else {
            failedQueries++;
          }
        }

        send("step", {
          step: "gather",
          status: "progress",
          message: `Database phase complete: ${dbItems.length} items from ${dbQueryResults.length - failedQueries}/${dbQueryResults.length} successful queries (${failedQueries} failed). Starting web searches...`,
          itemsFound: dbItems.length,
          detail: `PubMed/NCBI: ${ncbiItemsCount(dbItems)} | RCSB: ${countBySource(dbItems, "rcsb")} | UniProt: ${countBySource(dbItems, "uniprot")} | BLAST: ${countBySource(dbItems, "blast")}`,
        });
        log(`gather: database queries returned ${dbItems.length} items`);

        // Strategy 2: Web search for additional sources.
        // We no longer cap web search queries — generate as many as the LLM thinks is useful
        // (capped only by a sane upper bound to avoid runaway costs).
        const webSearchQueries = await generateWebSearchQueries(projectId, project.topic, project.field || "life sciences", targetWords, maxWebSearchQueries, maxTokens);
        send("step", {
          step: "gather",
          status: "progress",
          message: `Running ${webSearchQueries.length} web searches (sequential to avoid rate limits)...`,
          detail: webSearchQueries.map((q, i) => `${i + 1}. ${q}`).join("\n"),
        });

        const webItems: any[] = [];
        for (let wi = 0; wi < webSearchQueries.length; wi++) {
          const wsStart = Date.now();
          try {
            // No cap on results per query — ask for up to 10
            const searchResults = await webSearch(webSearchQueries[wi], 15);
            for (const item of searchResults) {
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
            send("step", {
              step: "gather",
              status: "progress",
              message: `Web search ${wi + 1}/${webSearchQueries.length} (${Date.now() - wsStart}ms): "${webSearchQueries[wi].slice(0, 50)}${webSearchQueries[wi].length > 50 ? "..." : ""}" → ${searchResults.length} results`,
              queryIndex: wi + 1,
              queryTotal: webSearchQueries.length,
              queryPreview: webSearchQueries[wi].slice(0, 80),
              resultCount: searchResults.length,
            });
          } catch (err: any) {
            send("step", {
              step: "gather",
              status: "progress",
              message: `Web search ${wi + 1}/${webSearchQueries.length} FAILED: ${err?.message?.slice(0, 80) || "rate limit"}`,
              queryIndex: wi + 1,
              queryTotal: webSearchQueries.length,
              queryPreview: webSearchQueries[wi].slice(0, 80),
              resultCount: 0,
              failed: true,
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 1000)); // Rate limit
        }

        const allItems = [...dbItems, ...webItems];
        send("step", {
          step: "gather",
          status: "progress",
          message: `Total gathered: ${allItems.length} raw sources (${dbItems.length} from databases + ${webItems.length} from web). Deduplicating...`,
          itemsFound: allItems.length,
        });
        log(`gather: total ${allItems.length} sources, beginning dedup + save`);

        // Save ALL data sources with FULL metadata — NO artificial cap.
        // The previous MAX_SOURCES=30 limit discarded ~70% of gathered sources,
        // producing shallow articles. We now keep every unique item.
        const savedDataSources: any[] = [];
        const savedReferences: any[] = [];
        const seenExternalIds = new Set<string>(); // Dedup by externalId+source
        const uniqueItems: any[] = [];
        for (const item of allItems) {
          const dedupKey = `${item.source}:${item.externalId || item.url}`;
          if (seenExternalIds.has(dedupKey)) continue;
          seenExternalIds.add(dedupKey);
          uniqueItems.push(item);
        }

        // Sort items so the most likely-to-be-useful come first: PubMed + RCSB-with-pub
        // before noisy uniprot/ncbi stubs; prefer items with abstracts. We do NOT cap
        // the list — every unique source is persisted so the article has full coverage.
        uniqueItems.sort((a: any, b: any) => {
          const aScore =
            (a.source === "pubmed" ? 4 : 0) +
            (a.source === "rcsb" && a.extra?.hasPublication ? 3 : 0) +
            (a.source === "rcsb" ? 2 : 0) +
            (a.abstract ? 1 : 0);
          const bScore =
            (b.source === "pubmed" ? 4 : 0) +
            (b.source === "rcsb" && b.extra?.hasPublication ? 3 : 0) +
            (b.source === "rcsb" ? 2 : 0) +
            (b.abstract ? 1 : 0);
          return bScore - aScore;
        });
        const itemsToSave = uniqueItems; // NO cap — keep all unique sources
        send("step", {
          step: "gather",
          status: "progress",
          message: `Saving ALL ${itemsToSave.length} unique sources (no cap — full coverage)...`,
          detail: `Dedup removed ${allItems.length - itemsToSave.length} duplicates`,
        });

        // Persist sources serially — Prisma+SQLite serializes writes internally anyway,
        // and serial calls avoid transaction-lock contention. Progress is emitted every batch.
        for (let i = 0; i < itemsToSave.length; i++) {
          const item = itemsToSave[i];
          const start = Date.now();
          try {
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
            const isPubMed = item.source === "pubmed";
            const isRcsbWithPub = item.source === "rcsb" && item.extra?.hasPublication;
            const isWebWithUrl = item.source === "web" && item.url;
            if (isPubMed || isRcsbWithPub || isWebWithUrl) {
              try {
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
              } catch (refErr) {
                // Reference-table unique constraint collision (same externalId
                // already exists for the project) — skip, keep the source row.
              }
            }
          } catch (err) {
            // Single-row failure should not abort the whole gather — log and continue.
            console.warn(`[generate-full] failed to save ${item.source}:${item.externalId}:`, (err as Error).message);
          }
          const elapsed = Date.now() - start;
          // Emit progress every 5 saves OR for notable sources (PubMed, RCSB-with-pub)
          if ((i + 1) % 5 === 0 || i === itemsToSave.length - 1) {
            log(`gather: saved ${i + 1}/${itemsToSave.length} sources (last insert took ${elapsed}ms)`);
            send("step", {
              step: "gather",
              status: "progress",
              message: `Saved ${i + 1}/${itemsToSave.length} sources... [${item.source}] ${item.title?.slice(0, 60) || ""}`,
              sourcesGathered: i + 1,
              lastSourceTitle: (item.title || "").slice(0, 80),
              lastSourceDb: item.source,
            });
          }
        }
        log(`gather: save loop done (savedDataSources=${savedDataSources.length}, refs=${savedReferences.length}, total ${Date.now() - t0}ms since gather start)`);

        log("gather: status=done emitted");
        send("step", {
          step: "gather",
          status: "done",
          sourcesGathered: savedDataSources.length,
          referencesSaved: savedReferences.length,
          message: `Gathered ${savedDataSources.length} unique sources (${savedReferences.length} citable references).`,
          detail: `Breakdown: PubMed=${countBySource(savedDataSources, "pubmed")} | RCSB=${countBySource(savedDataSources, "rcsb")} | UniProt=${countBySource(savedDataSources, "uniprot")} | NCBI=${countBySource(savedDataSources, "ncbi")} | BLAST=${countBySource(savedDataSources, "blast")} | Web=${countBySource(savedDataSources, "web")}`,
        });

        if (savedReferences.length === 0 && savedDataSources.length === 0) {
          send("error", { error: "No data sources could be gathered." });
          safeClose();
          return;
        }

        // ============ STEP 2: LLM curates the most relevant sources ============
        log(`curate: starting — chatWithSession for relevance ranking (${savedReferences.length} refs)`);
        send("step", {
          step: "curate",
          status: "started",
          message: `LLM curating ${savedReferences.length} references for a ${targetWords}-word article...`,
          detail: "Selecting most relevant subset for focused context window",
        });

        // Curate references to keep the context window manageable. We still SAVE every
        // source — curation only selects which ones to inject into the LLM's context.
        const maxCitableRefs = Math.min(savedReferences.length, Math.max(20, Math.floor(targetWords / 200)));
        const curatedRefs = await curateReferences(projectId, savedReferences, project.topic, project.field || "life sciences", maxCitableRefs, maxTokens);

        send("step", {
          step: "curate",
          status: "done",
          curatedCount: curatedRefs.length,
          totalAvailable: savedReferences.length,
          message: `Curated ${curatedRefs.length} most relevant references from ${savedReferences.length} total.`,
          detail: curatedRefs.slice(0, 10).map((r: any, i: number) => `${i + 1}. ${r.authors || "Anon"} (${r.year || "n.d."}) ${r.title?.slice(0, 60) || ""}`).join("\n") + (curatedRefs.length > 10 ? `\n... and ${curatedRefs.length - 10} more` : ""),
        });

        // ============ STEP 2.5: Fetch full text for PMC-indexed articles ============
        send("step", {
          step: "curate",
          status: "progress",
          message: `Fetching full text for PMC-indexed free articles (enables deeper discussion)...`,
          detail: "Up to 8 PMC free articles, 15k chars each",
        });

        let fullTextsFetched = 0;
        const fullTexts = new Map<string, string>(); // refId → full text

        // Fetch full text for up to 8 PMC-indexed references (raised from 5)
        const pmcRefs = curatedRefs.filter((r: any) => r.type === "pubmed" && r.externalId).slice(0, 8);
        for (let pi = 0; pi < pmcRefs.length; pi++) {
          const ref = pmcRefs[pi];
          try {
            const ds = savedDataSources.find((d: any) =>
              d.externalId === ref.externalId && d.extra
            );
            let pmcId: string | undefined;
            if (ds?.extra) {
              try {
                const extra = JSON.parse(ds.extra);
                pmcId = extra.pmcId || extra.hasFreeFullText ? extra.pmcId : undefined;
              } catch {}
            }

            const ftStart = Date.now();
            const fullText = await fetchFullTextForPubMed(ref.externalId, pmcId);
            if (fullText && fullText.length > 500) {
              // Limit to 15000 chars per article to balance depth vs context window
              fullTexts.set(ref.id, fullText.slice(0, 15000));
              fullTextsFetched++;
              send("step", {
                step: "curate",
                status: "progress",
                message: `Fetched full text for PMID:${ref.externalId} (${pi + 1}/${pmcRefs.length}, ${Math.round(fullText.length / 1000)}k chars, ${Date.now() - ftStart}ms)`,
                pmcIndex: pi + 1,
                pmcTotal: pmcRefs.length,
                pmid: ref.externalId,
                chars: fullText.length,
              });
            } else {
              send("step", {
                step: "curate",
                status: "progress",
                message: `PMID:${ref.externalId} — no free full text available (skipped)`,
                pmid: ref.externalId,
                skipped: true,
              });
            }
          } catch {
            // Skip failed fetches
          }
        }

        send("step", {
          step: "curate",
          status: "progress",
          message: `Full text retrieval complete: ${fullTextsFetched}/${pmcRefs.length} PMC articles fetched.`,
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

          // Rate limit: wait 2s before LLM call
          await new Promise((r) => setTimeout(r, 2000));
          // Check LLM cache — relationships analysis is deterministic for the
          // same curated refs, so caching saves a 10-30s LLM call on regenerate.
          const { llmCacheKey: relCacheKeyFn, getCachedLLMResult: relGetCache, setCachedLLMResult: relSetCache } = await import("@/lib/llm-cache");
          const relCacheKey = relCacheKeyFn(relPrompt, { system: relSystem, temperature: 0.4, taskType: "relationships", maxTokens });
          const relCached = relGetCache(relCacheKey);
          let relRaw: string;
          if (relCached) {
            console.log("[relationships] cache hit — skipping LLM call");
            relRaw = relCached;
          } else {
            console.log("[relationships] cache miss — calling LLM");
            relRaw = await chatWithSession(projectId, relPrompt, {
              system: relSystem,
              temperature: 0.4,
              taskType: "relationships",
              metadata: { step: "relationships", sourceCount: curatedRefs.length },
              maxTokens,
            });
            relSetCache(relCacheKey, relRaw);
          }
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
            detail: relationshipSummary,
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

        // Rate limit: wait 2s before LLM call
        await new Promise((r) => setTimeout(r, 2000));
        // Check LLM cache — outline planning is deterministic for the same
        // topic + curated refs, so caching saves a 10-20s LLM call on regenerate.
        const { llmCacheKey: planCacheKeyFn, getCachedLLMResult: planGetCache, setCachedLLMResult: planSetCache } = await import("@/lib/llm-cache");
        const planCacheKey = planCacheKeyFn(planPrompt, { system: planSystem, temperature: 0.5, taskType: "plan", maxTokens });
        const planCached = planGetCache(planCacheKey);
        let planRaw: string;
        if (planCached) {
          console.log("[plan] cache hit — skipping LLM call");
          planRaw = planCached;
        } else {
          console.log("[plan] cache miss — calling LLM");
          planRaw = await chatWithSession(projectId, planPrompt, {
            system: planSystem,
            temperature: 0.5,
            taskType: "plan",
            metadata: { step: "plan", targetWords, refCount: curatedRefs.length },
            maxTokens,
          });
          planSetCache(planCacheKey, planRaw);
        }
        const planParsed = safeParseJSON(planRaw, { sections: [] });
        const sections = (planParsed.sections || []).filter(
          (s: any) => s.title && s.targetWords
        );

        if (sections.length === 0) {
          send("error", { error: "Could not plan article sections." });
          safeClose();
          return;
        }

        send("step", {
          step: "plan",
          status: "done",
          sections: sections.map((s: any) => ({ title: s.title, targetWords: s.targetWords })),
          sectionCount: sections.length,
          message: `Planned ${sections.length} sections totaling ~${sections.reduce((s: number, sec: any) => s + (sec.targetWords || 0), 0)} words.`,
          detail: sections.map((s: any, i: number) => `§${i + 1} ${s.title} (~${s.targetWords}w)`).join("\n"),
        });

        // ============ STEP 5: Context strings are now built PER SECTION ============
        // Previously we built a single global refContext + dsContext here and
        // injected the same list into every section. That caused the LLM to
        // cite irrelevant sources (e.g. TMC7-fertility refs in a section
        // about TMC1 animal models). Now each section builds its own
        // filtered sectionRefContext + sectionDsContext inside the section
        // loop below, using keyword-overlap scoring to keep only topically
        // relevant sources. See extractKeywords() + scoreRelevance().

        // ============ STEP 6: Generate each section (chunked, ENGLISH FIRST) ============
        // Cross-section continuity context:
        // We DO NOT route section generation through chatWithSession() because
        // chatWithSession doesn't support token streaming. As a result each
        // section's chatStream() call is stateless — the LLM has no memory of
        // how previous sections were formatted. To compensate and keep style/
        // format consistent across sections, we maintain a running
        // "previousSectionsDigest" that records each finished section's title
        // + opening sentence + closing sentence, and inject it into the next
        // section's prompt. This mimics the consistency that a shared CLI
        // session would otherwise provide.
        //
        // PER-SECTION REFERENCE FILTERING:
        // Previously ALL curated refs + ALL data sources were injected into
        // EVERY section's prompt. This caused the LLM to cite irrelevant
        // sources (e.g. TMC7-fertility refs in a section about TMC1 animal
        // models) because they were in the list even though they had nothing
        // to do with the section's focus. Now we filter refs + data sources
        // per section using keyword overlap between the section focus/title
        // and each ref's title/abstract. This keeps only topically relevant
        // sources in the prompt, dramatically reducing miscitation.
        const generatedParagraphs: any[] = [];
        const failedSections: number[] = []; // track which sections failed
        let previousSectionsDigest = ""; // running style/flow reference
        for (let i = 0; i < sections.length; i++) {
          const section = sections[i];
          const sectionNum = i + 1;
          const sectionStart = Date.now();

          send("step", {
            step: "generate",
            status: "started",
            section: sectionNum,
            total: sections.length,
            title: section.title,
            message: `Generating section ${sectionNum}/${sections.length}: ${section.title} (~${section.targetWords} words, English)`,
            detail: `Focus: ${section.focus?.slice(0, 200) || ""}`,
          });
          log(`generate: section ${sectionNum}/${sections.length} starting — "${section.title}" targetWords=${section.targetWords}`);

          // For sections with high target words, generate in sub-chunks
          const sectionTargetWords = section.targetWords || 600;
          const needsChunking = sectionTargetWords > 1200;
          const chunkCount = needsChunking ? Math.ceil(sectionTargetWords / 1000) : 1;

          let fullSectionContent = "";

          // ---- Per-section reference & data-source filtering ----
          // Filter the global curatedRefs + savedDataSources down to only
          // those relevant to THIS section's title + focus. This prevents
          // the LLM from citing irrelevant sources (e.g. TMC7-fertility refs
          // in a section about TMC1 animal models).
          //
          // Strategy: extract keywords from the section title + focus, then
          // score each ref/data-source by keyword overlap with its title +
          // abstract. Keep the top sectionRefTopN refs (min sectionRefMinN)
          // and top sectionDsTopN data sources (min sectionDsMinN). These
          // thresholds are configurable via the UI's Advanced settings.
          const sectionKeywords = extractKeywords(
            `${section.title} ${section.focus || ""}`,
          );
          const scoredRefs = curatedRefs.map((r: any, idx: number) => ({
            ref: r,
            originalIndex: idx,
            score: scoreRelevance(sectionKeywords, `${r.title || ""} ${r.abstract || ""} ${r.journal || ""}`),
          }));
          scoredRefs.sort((a: any, b: any) => b.score - a.score);
          // Keep refs with score > 0, but always keep at least sectionRefMinN
          // (so the LLM has enough to cite from) and at most sectionRefTopN
          // (to stay within context budget). If fewer than sectionRefMinN
          // have score > 0, top up from the remaining refs by original order.
          const relevantScored = scoredRefs.filter((s: any) => s.score > 0);
          let sectionRefs: any[];
          if (relevantScored.length >= sectionRefMinN) {
            sectionRefs = relevantScored.slice(0, sectionRefTopN).map((s: any) => s.ref);
          } else {
            // Not enough keyword-matched refs — take what we have + top up
            // from the rest to reach sectionRefMinN. This ensures the LLM
            // always has a reasonable pool to cite from.
            const have = new Set(relevantScored.map((s: any) => s.originalIndex));
            const topUp = scoredRefs
              .filter((s: any) => !have.has(s.originalIndex))
              .slice(0, sectionRefMinN - relevantScored.length);
            sectionRefs = [...relevantScored, ...topUp].map((s: any) => s.ref);
          }

          // Same filtering for data sources
          const scoredDs = savedDataSources.map((d: any, idx: number) => ({
            ds: d,
            originalIndex: idx,
            score: scoreRelevance(sectionKeywords, `${d.title || ""} ${d.abstract || ""} ${d.query || ""}`),
          }));
          scoredDs.sort((a: any, b: any) => b.score - a.score);
          const relevantDs = scoredDs.filter((s: any) => s.score > 0);
          let sectionDataSources: any[];
          if (relevantDs.length >= sectionDsMinN) {
            sectionDataSources = relevantDs.slice(0, sectionDsTopN).map((s: any) => s.ds);
          } else {
            const have = new Set(relevantDs.map((s: any) => s.originalIndex));
            const topUp = scoredDs
              .filter((s: any) => !have.has(s.originalIndex))
              .slice(0, sectionDsMinN - relevantDs.length);
            sectionDataSources = [...relevantDs, ...topUp].map((s: any) => s.ds);
          }

          // Build per-section ref + ds context strings (with PMC full text
          // attached to refs that have it). These are scoped to this section
          // only — the next section gets its own filtered subset.
          const sectionRefContext = sectionRefs
            .map((r: any, i: number) => {
              const auth = r.authors || "Anon";
              const yr = r.year ? ` (${r.year})` : "";
              const jour = r.journal ? `, ${r.journal}` : "";
              const url = r.url ? ` — ${r.url}` : "";
              const abs = r.abstract ? `\nAbstract: ${r.abstract.slice(0, 200)}` : "";
              const ft = fullTexts.get(r.id);
              const fullTextSection = ft ? `\n\n--- FULL TEXT (PMC free article) ---\n${ft}` : "";
              return `[${i + 1}] ${auth}${yr}${jour}. ${r.title}.${url}${abs}${fullTextSection}`;
            })
            .join("\n");

          const sectionDsContext = sectionDataSources
            .map((d: any, i: number) => {
              const parts = [`[DS:${i + 1}] (${d.source}) ${d.title || d.query}`];
              if (d.authors) parts.push(`Authors: ${d.authors}`);
              if (d.journal) parts.push(`Journal: ${d.journal}`);
              if (d.year) parts.push(`Year: ${d.year}`);
              if (d.abstract) parts.push(`Abstract: ${d.abstract.slice(0, 200)}`);
              return parts.join("\n");
            })
            .join("\n\n");

          // Molcraft fusion: load cached protein structure analyses for the
          // RCSB data sources relevant to this section. This injects REAL
          // computed structural metrics (helix/sheet %, ligands, Ramachandran,
          // B-factor, SASA, H-bonds, charge/pI, BSA) so the LLM can discuss
          // the structures in depth rather than just citing metadata.
          const sectionStructureContext = await buildStructureContextFromDataSources(
            sectionDataSources.map((d: any) => d.id),
            { maxEntries: 4, maxCharsPerEntry: 2500 }
          );
          if (sectionStructureContext) {
            log(`generate: section ${sectionNum} — loaded structure analyses for ${sectionDataSources.filter((d:any)=>d.source==="rcsb").length} RCSB source(s)`);
          }

          log(`generate: section ${sectionNum} — filtered ${curatedRefs.length}→${sectionRefs.length} refs, ${savedDataSources.length}→${sectionDataSources.length} data sources (keywords: ${sectionKeywords.slice(0, 8).join(",")})`);
          send("step", {
            step: "generate",
            status: "progress",
            section: sectionNum,
            total: sections.length,
            message: `Section ${sectionNum}: filtered to ${sectionRefs.length} relevant refs + ${sectionDataSources.length} data sources`,
            refsFiltered: sectionRefs.length,
            dataSourcesFiltered: sectionDataSources.length,
          });

          // Wrap the entire section generation+save in a try-catch so that
          // if the LLM fails on one section, we can skip it and continue
          // with the remaining sections. The failed section is tracked in
          // failedSections[] so we can report it and allow resuming later.
          try {
          for (let chunk = 0; chunk < chunkCount; chunk++) {
            const chunkNum = chunk + 1;
            const chunkStart = Date.now();
            if (chunkCount > 1) {
              send("step", {
                step: "generate",
                status: "progress",
                section: sectionNum,
                total: sections.length,
                chunk: chunkNum,
                totalChunks: chunkCount,
                message: `Section ${sectionNum} chunk ${chunkNum}/${chunkCount} starting...`,
              });
            }

            const chunkFocus = chunkCount > 1
              ? `${section.focus} (Part ${chunkNum} of ${chunkCount} — focus on ${chunk === 0 ? "introduction and background" : chunk === chunkCount - 1 ? "synthesis and conclusion" : "detailed analysis"})`
              : section.focus;

            const chunkWords = Math.ceil(sectionTargetWords / chunkCount);

            // Cap the three context blocks so the total prompt stays under
            // chatWithSession's ~28KB hard cap. Use the PER-SECTION filtered
            // ref + ds context (not the global ones) so only topically
            // relevant sources are in the prompt.
            const REF_BUDGET = 6000;
            const DS_BUDGET = 6000;
            const REL_BUDGET = 4000;
            const trimmedRef = sectionRefContext.length > REF_BUDGET
              ? sectionRefContext.slice(0, REF_BUDGET) + "\n... (truncated for context window)"
              : sectionRefContext;
            const trimmedDs = sectionDsContext.length > DS_BUDGET
              ? sectionDsContext.slice(0, DS_BUDGET) + "\n... (truncated for context window)"
              : sectionDsContext;
            const trimmedRel = relationshipContext.length > REL_BUDGET
              ? relationshipContext.slice(0, REL_BUDGET) + "\n... (truncated for context window)"
              : relationshipContext;

            // Cross-section continuity digest. When present, this tells the
            // LLM what the immediately preceding sections were about and how
            // they ended, so it can (a) avoid repeating content and (b) match
            // the same paragraph style.
            const continuityBlock = previousSectionsDigest
              ? `\nPREVIOUS SECTIONS (already written — do NOT repeat their content, match their style and tone):\n${previousSectionsDigest}\n`
              : "";

            const sectionRefCount = sectionRefs.length;
            const prompt = `RESEARCH TOPIC: ${project.topic}
SECTION ${sectionNum} of ${sections.length}: ${section.title}
${chunkCount > 1 ? `PART ${chunkNum} of ${chunkCount}` : ""}
FOCUS: ${chunkFocus}
TARGET WORDS: ${chunkWords}
LANGUAGE: ${generationLanguage}
${continuityBlock}
REFERENCE LIST (cite as [n], 1-based index into this list of ${sectionRefCount} refs — these have been pre-filtered for relevance to THIS section's focus):
${trimmedRef}

DATABASE RECORDS (structural/sequence data — cite the associated publication only if directly relevant to this section):
${trimmedDs}
${sectionStructureContext ? `\nPROTEIN STRUCTURE ANALYSIS (REAL values computed from PDB files via Molcraft — USE THESE SPECIFIC NUMBERS when discussing structures: resolution, chain count, % helix/sheet, ligand names+chain:resSeq, Ramachandran % favoured/outliers, B-factor mean, SASA % exposed/buried, H-bond count, net charge, pI, BSA, pocket volumes. Cite the structure by its [n] index. NEVER fabricate structural metrics.):\n${sectionStructureContext.slice(0, 6000)}` : ""}
${trimmedRel}

${chunk > 0 ? `PREVIOUS PART OF THIS SECTION (for continuity, do NOT repeat):\n${fullSectionContent.slice(-800)}` : ""}

Now compose ${chunkCount > 1 ? `part ${chunkNum}` : "this section"}. Write DEEPLY and THOROUGHLY.
You have access to FULL TEXT from PMC free articles (marked "--- FULL TEXT ---").
Read these full texts carefully and synthesize their findings in detail.
Discuss SPECIFIC findings, methods, and results from these articles — not just abstracts.
Highlight agreements, contradictions, and nuanced differences between studies.
Draw connections across multiple sources. Provide mechanistic detail and context.
Write as if you have read the complete papers, not just their abstracts.

CITATION FORMAT (MANDATORY):
- Use ONLY numeric [n] citations (e.g. [1], [2], [3]).
- Number citations starting from [1] for THIS section. Each [n] refers to the n-th entry
  in the REFERENCE LIST above (${sectionRefCount} entries, [1] to [${sectionRefCount}]).
- Cite AT LEAST 3 different references per ~500 words.
- CRITICAL: Only cite a reference if its content is DIRECTLY relevant to this section's
  focus. Do NOT cite a source just because it appears in the list — if a ref is about a
  different protein/function/tissue than what this section covers, skip it.
- Do NOT use numbers greater than ${sectionRefCount}. Use [$REF] as placeholder if needed.
- Do NOT use [SOURCE:ID] format in body.
- Do NOT write empty brackets [].
- Do NOT output a "### Citations" block — just write the text with [n] markers.

PARAGRAPH FORMAT (MANDATORY — critical for consistent document export):
- Start the body DIRECTLY with the first sentence of the section content.
  The section title is rendered separately by the export step; do NOT repeat it.
- Do NOT prefix the body with a numbered heading like "2. Genomic Organization..."
  or "Section 9. TMC1 Mutations..." or "SECTION 6 — CHANNEL BIOPHYSICS...".
  These duplicate the title and corrupt the exported document.
- Do NOT include any markdown headers (#, ##, ###) inside the body.
- Do NOT add a preamble such as "Here is the section:", "Now I will write...",
  "Below is the draft for section N:" — start with the actual content.
- Do NOT add a postscript such as "Word count: ~790" or "Citations used: [1],[2]".
- Write the section as 2-5 cohesive paragraphs of prose, separated by a single
  blank line. Each paragraph should be 120-250 words.
- Use **bold** for key protein/gene names only on first mention; otherwise plain text.
- Use *italics* for species names (e.g. *C. elegans*, *Mus musculus*).
- Match the tone, depth, and paragraph density of the PREVIOUS SECTIONS above.
${promptInstruction ? `\nCUSTOM INSTRUCTION (from selected prompt template — follow this in addition to the above rules):\n${promptInstruction}` : ""}`;

            const system = `You are a senior scientific research writer and domain expert (${project.field || "life sciences"}).
Write in ${generationLanguage}, using formal, precise academic prose (third person, past tense for results/methods).
Compose ONE cohesive section. The section title is provided separately — start the body with actual content, NOT a restatement of the title.
${sectionStructureContext ? "When a PROTEIN STRUCTURE ANALYSIS block is provided, USE the specific computed numeric values (resolution, % helix/sheet, ligand chain:resSeq, Ramachandran % favoured, B-factor mean, SASA % exposed, H-bond count, pI, BSA) — they are REAL values from the actual PDB file. Quote them precisely and connect them to biological function. NEVER fabricate structural metrics." : ""}`;

            // STREAMING + SESSION CONTEXT:
            // Use chatWithSessionStream() — this is the streaming variant of
            // chatWithSession(). It (1) loads the project's conversation
            // history (gather → curate → plan → generate §1 → §2 → ...) so
            // the LLM sees how it wrote prior sections and maintains a
            // consistent paragraph style, (2) streams tokens to the client
            // via onChunk, and (3) saves both the user prompt and the
            // assistant response to the ConversationSession table.
            //
            // Previously this used chatStream() directly, which is stateless
            // — each section was generated with no memory of prior sections,
            // causing inconsistent formatting (numbered title prefixes,
            // varying paragraph density, etc.). Routing through session
            // context fixes that at the source.
            let chunkContent = "";
            let lastStreamEmit = 0;
            try {
              const { chatWithSessionStream } = await import("@/lib/llm-session");
              chunkContent = await chatWithSessionStream(
                projectId,
                prompt,
                {
                  system,
                  temperature: 0.65,
                  thinking: false,
                  taskType: "generate",
                  maxTokens,
                  metadata: {
                    step: "generate",
                    section: sectionNum,
                    sectionTitle: section.title,
                    chunk: chunkCount > 1 ? `${chunkNum}/${chunkCount}` : undefined,
                    targetWords: chunkWords,
                  },
                },
                (delta, accumulated) => {
                  // Throttle stream events to ~10/sec to avoid flooding the SSE channel
                  const now = Date.now();
                  if (now - lastStreamEmit > 100) {
                    lastStreamEmit = now;
                    send("step", {
                      step: "generate",
                      status: "streaming",
                      section: sectionNum,
                      total: sections.length,
                      chunk: chunkNum,
                      totalChunks: chunkCount,
                      delta: delta.slice(-200), // only the last 200 chars of this delta
                      accumulatedLength: accumulated.length,
                      accumulatedTail: accumulated.slice(-300), // last 300 chars so UI can render live preview
                      message: `Section ${sectionNum} chunk ${chunkNum}/${chunkCount} streaming... (${accumulated.length} chars)`,
                    });
                  }
                },
              );
            } catch (err: any) {
              // Fallback to non-streaming chat if chatWithSessionStream fails.
              // We still save to session so the next section can see this one.
              send("step", {
                step: "generate",
                status: "progress",
                section: sectionNum,
                total: sections.length,
                chunk: chunkNum,
                totalChunks: chunkCount,
                message: `Streaming failed, falling back to non-streaming: ${err?.message?.slice(0, 80) || ""}`,
              });
              const { chatWithSession } = await import("@/lib/llm-session");
              chunkContent = await chatWithSession(projectId, prompt, {
                system,
                temperature: 0.65,
                taskType: "generate",
                maxTokens,
                metadata: {
                  step: "generate",
                  section: sectionNum,
                  sectionTitle: section.title,
                  chunk: chunkCount > 1 ? `${chunkNum}/${chunkCount}` : undefined,
                  fallback: true,
                },
              });
            }

            // (Session messages are already saved by chatWithSessionStream /
            // chatWithSession above — no manual saveSessionMessage needed.)

            // Rate limit: wait 2s between LLM calls to avoid 429
            await new Promise((r) => setTimeout(r, 2000));

            // Sanitize citations
            // Bug #9 fix: use sectionRefs.length (the per-section list the LLM
            // was told to cite against), NOT curatedRefs.length (the global
            // list). Using the global length let hallucinated [n] in the
            // gap between sectionRefs.length and curatedRefs.length survive,
            // then renumberByAppearance silently dropped them but left the
            // raw [n] text in the body unresolved.
            const maxRefNum = sectionRefs.length;
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

            // Sanitize content — remove LLM preambles, postscripts, meta-commentary,
            // horizontal rules, "### Citations" blocks, and redundant section headers.
            // This prevents non-article text (e.g. "Now I'll compose...", "Word count:
            // ~790 words", "A note on the full text...") from appearing in the UI.
            chunkContent = sanitizeSectionContent(chunkContent);

            fullSectionContent += (chunk > 0 ? "\n\n" : "") + chunkContent;

            send("step", {
              step: "generate",
              status: "progress",
              section: sectionNum,
              total: sections.length,
              chunk: chunkNum,
              totalChunks: chunkCount,
              message: `Section ${sectionNum} chunk ${chunkNum}/${chunkCount} complete (${chunkContent.length} chars, ${Date.now() - chunkStart}ms).`,
              chunkChars: chunkContent.length,
              chunkMs: Date.now() - chunkStart,
            });
            log(`generate: section ${sectionNum} chunk ${chunkNum}/${chunkCount} done in ${Date.now() - chunkStart}ms (${chunkContent.length} chars)`);
          }

          // Renumber citations by order of first appearance within this section.
          // IMPORTANT: use sectionRefs (the per-section filtered subset), NOT
          // curatedRefs (the global list). The prompt told the LLM that [n]
          // refers to the n-th entry in the per-section REFERENCE LIST, so
          // renumbering must use the same ordering.
          const { content: renumberedContent, references: citedRefs } =
            renumberByAppearance(fullSectionContent, sectionRefs);

          // Layer 1 — adversarial pre-save audit on the renumbered section.
          // Logs topicality warnings (suspect/unsupported) for the audit trail
          // without blocking the save. Blocking findings (out-of-range /
          // missing) should not occur here because sanitization already
          // replaced them with [$REF], but we check defensively.
          const sectionFindings = validateCitationsInline(
            renumberedContent,
            citedRefs as any
          );
          if (sectionFindings.length > 0) {
            const blocking = sectionFindings.filter(
              (f) => f.verdict === "out-of-range" || f.verdict === "missing"
            ).length;
            const suspect = sectionFindings.filter(
              (f) => f.verdict === "suspect" || f.verdict === "unsupported"
            ).length;
            log(
              `generate: section ${sectionNum} citation audit — ${blocking} blocking, ${suspect} topicality warning(s)`
            );
            send("step", {
              step: "generate",
              status: "progress",
              section: sectionNum,
              total: sections.length,
              message: `Section ${sectionNum} audit: ${blocking} blocking, ${suspect} warning(s).`,
            });
          }

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

          // Update the cross-section continuity digest so the NEXT section's
          // prompt can reference what came before. We keep the last 3 sections
          // (~600 chars total) to stay within the prompt budget while still
          // giving the LLM enough context to match style and avoid repetition.
          const openingSentence = renumberedContent.slice(0, 180).replace(/\n+/g, " ");
          const closingSentence = renumberedContent.slice(-180).replace(/\n+/g, " ");
          const digestEntry = `§${sectionNum} "${section.title}": opens "${openingSentence}..." closes "...${closingSentence}"`;
          previousSectionsDigest = (previousSectionsDigest + "\n" + digestEntry)
            .split("\n")
            .filter(Boolean)
            .slice(-3) // keep only the 3 most recent sections
            .join("\n");

          send("step", {
            step: "generate",
            status: "done",
            section: sectionNum,
            total: sections.length,
            title: section.title,
            wordCount: paragraph.wordCount,
            message: `Section ${sectionNum} complete: ${paragraph.wordCount} words, ${citedRefs.length} citations (${Date.now() - sectionStart}ms total)`,
            citations: citedRefs.length,
            ms: Date.now() - sectionStart,
          });
          log(`generate: section ${sectionNum} DONE in ${Date.now() - sectionStart}ms (${paragraph.wordCount} words, ${citedRefs.length} citations)`);
          } catch (sectionErr: any) {
            // Section generation failed (LLM error, timeout, etc.)
            // Don't abort the entire pipeline — skip this section and continue.
            // The failed section index is tracked so it can be resumed later.
            log(`generate: section ${sectionNum} FAILED: ${sectionErr?.message?.slice(0, 120) || "unknown"}`);
            failedSections.push(i);
            send("step", {
              step: "generate",
              status: "progress",
              section: sectionNum,
              total: sections.length,
              title: section.title,
              message: `Section ${sectionNum} FAILED (skipped): ${sectionErr?.message?.slice(0, 80) || "LLM error"}. Will continue with remaining sections.`,
              failed: true,
            });
            // Brief delay before next section to allow LLM provider to recover
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
        }

        // ============ STEP 7: Compose the final English article ============
        send("step", { step: "compose", status: "started", message: "Composing final English article with global citation renumbering..." });

        const allParagraphData = await Promise.all(
          generatedParagraphs.map(async (p) => {
            const para = await db.paragraph.findUnique({
              where: { id: p.id },
              include: { references: { orderBy: { citationOrder: "asc" } } },
            });
            const content = para?.content || "";
            const citIdx = content.indexOf("### Citations");
            let cleanContent = citIdx >= 0 ? content.slice(0, citIdx).trim() : content.trim();
            // Sanitize stray ]] symbols in citations
            cleanContent = cleanContent.replace(/\]\]/g, "]");
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

        // Always use direct assembly — LLM composition causes truncation when
        // the total content exceeds the model's max output tokens.
        const articleBody = renumberedContents
          .map((c, i) => `## ${generatedParagraphs[i]?.title || sections[i]?.title || `Section ${i + 1}`}\n\n${c}`)
          .join("\n\n");

        send("step", {
          step: "compose",
          status: "progress",
          message: `Assembling ${renumberedContents.length} English sections directly (${generatedParagraphs.reduce((s, p) => s + p.wordCount, 0)} words total).`,
        });

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

        let cleanBody = articleBody.trim();
        cleanBody = cleanBody.replace(/^#{1}\s+.+\n*/m, "").trim();

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

        // Update each paragraph's content in the database with the globally
        // renumbered citations. This ensures that when users view paragraphs
        // in the main workspace (ParagraphCard), the citation numbers match
        // the composed article — [20] in the paragraph corresponds to [20]
        // in the article's References section.
        for (let i = 0; i < renumberedContents.length && i < generatedParagraphs.length; i++) {
          try {
            await db.paragraph.update({
              where: { id: generatedParagraphs[i].id },
              data: { content: renumberedContents[i] },
            });
          } catch (e) {
            console.warn("[generate-full] Failed to update paragraph content with global citations:", e);
          }
        }
        log(`compose: updated ${renumberedContents.length} paragraphs with globally renumbered citations`);

        // ============ STEP 7.5: Batch deep citation audit ============
        // After ALL sections are generated + composed, run the deep citation
        // audit on each paragraph in BATCH mode. This is better than per-
        // paragraph auditing during generation because:
        //  1. The user sees progress faster (generation completes first)
        //  2. Global citation renumbering is already applied (so [n] matches)
        //  3. The audit can cross-reference the full reference list
        // The audit is non-blocking: failures don't abort the pipeline.
        if (generatedParagraphs.length > 0) {
          send("step", {
            step: "audit",
            status: "started",
            message: `Auto-auditing citations for ${generatedParagraphs.length} sections...`,
          });
          log(`audit: starting batch deep audit for ${generatedParagraphs.length} paragraphs`);
          let auditChecked = 0;
          let auditIssues = 0;
          let auditFixed = 0;
          for (let i = 0; i < generatedParagraphs.length; i++) {
            const p = generatedParagraphs[i];
            try {
              const auditRes = await fetch(
                `http://localhost:3000/api/paragraphs/${p.id}/deep-audit-citations?trigger=auto`,
                { method: "POST", signal: AbortSignal.timeout(120000) }
              );
              if (auditRes.ok) {
                const data = await auditRes.json();
                auditChecked += data.checked || 0;
                auditIssues += data.issues || 0;
                auditFixed += data.fixed || 0;
              }
            } catch (e: any) {
              log(`audit: paragraph ${i + 1} failed: ${e?.message?.slice(0, 80) || "unknown"}`);
            }
            send("step", {
              step: "audit",
              status: "progress",
              message: `Audited ${i + 1}/${generatedParagraphs.length} sections (${auditIssues} issues, ${auditFixed} auto-fixed)...`,
            });
          }
          send("step", {
            step: "audit",
            status: "done",
            message: `Citation audit complete: ${auditChecked} checked, ${auditIssues} issues found, ${auditFixed} auto-fixed.`,
            auditChecked, auditIssues, auditFixed,
          });
          log(`audit: DONE — checked ${auditChecked}, issues ${auditIssues}, fixed ${auditFixed}`);
        }

        // ============ STEP 8 (both mode only): Translate each section EN → ZH ============
        let articleContentZh: string | null = null;
        if (isBothMode) {
          send("step", {
            step: "translate",
            status: "started",
            message: `Translating ${generatedParagraphs.length} sections from English to Chinese (one by one)...`,
            detail: "Each section is translated independently to preserve citations and structure",
          });
          log(`translate: starting for ${generatedParagraphs.length} sections`);

          const translatedParagraphContents: string[] = []; // Chinese version of each section body
          for (let i = 0; i < generatedParagraphs.length; i++) {
            const p = generatedParagraphs[i];
            const sectionNum = i + 1;
            const trStart = Date.now();
            try {
            const para = await db.paragraph.findUnique({
              where: { id: p.id },
              include: { references: { orderBy: { citationOrder: "asc" } } },
            });
            if (!para) {
              translatedParagraphContents.push("");
              continue;
            }
            const enContent = para.content;
            const citIdx = enContent.indexOf("### Citations");
            const cleanEn = citIdx >= 0 ? enContent.slice(0, citIdx).trim() : enContent.trim();

            send("step", {
              step: "translate",
              status: "started",
              section: sectionNum,
              total: generatedParagraphs.length,
              title: para.title,
              message: `Translating section ${sectionNum}/${generatedParagraphs.length}: ${para.title} (${para.wordCount} EN words → 中文)`,
            });

            const translateSystem =
              "You are a professional scientific translator. Translate English academic text into formal, " +
              "precise Chinese (中文) academic prose. Preserve ALL inline citations [n] EXACTLY as they appear " +
              "(do NOT renumber, do NOT remove). Preserve ALL markdown formatting. Do NOT add any preamble, " +
              "commentary, or section headers — output ONLY the translated Chinese text.";

            const translatePrompt = `Translate the following English scientific section into formal Chinese academic prose.

REQUIREMENTS:
1. Preserve ALL inline citations [n] EXACTLY (e.g. [1], [2,3], [4-6] — keep the numbers unchanged).
2. Preserve ALL markdown formatting (## headings, **bold**, *italic*, lists, etc.).
3. Use formal, precise academic Chinese (书面语，第三人称，结果/方法部分使用过去时).
4. Use domain-correct terminology. Translate technical terms using standard Chinese scientific equivalents.
5. Do NOT add any preamble like "以下是翻译" or "翻译如下". Output ONLY the translated text.
6. Do NOT translate citation numbers, DOIs, URLs, or [SOURCE:ID] markers.
7. Maintain the same paragraph structure and flow.

ENGLISH SECTION (section ${sectionNum} of ${generatedParagraphs.length}):

${cleanEn}`;

            let zhContent = "";
            let lastZhStream = 0;
            try {
              // Use chatWithSessionStream so translation also benefits from
              // session context — the translator sees the English sections
              // it already translated and keeps terminology consistent
              // across sections (e.g. once it renders "mechanotransduction"
              // as "机械转导", subsequent sections use the same term).
              const { chatWithSessionStream } = await import("@/lib/llm-session");
              zhContent = await chatWithSessionStream(
                projectId,
                translatePrompt,
                {
                  system: translateSystem,
                  temperature: 0.3, // lower temp for faithful translation
                  thinking: false,
                  taskType: "translate",
                  maxTokens,
                  metadata: {
                    step: "translate",
                    section: sectionNum,
                    sectionTitle: para.title,
                    sourceChars: cleanEn.length,
                  },
                },
                (delta, accumulated) => {
                  const now = Date.now();
                  if (now - lastZhStream > 100) {
                    lastZhStream = now;
                    send("step", {
                      step: "translate",
                      status: "streaming",
                      section: sectionNum,
                      total: generatedParagraphs.length,
                      delta: delta.slice(-200),
                      accumulatedLength: accumulated.length,
                      accumulatedTail: accumulated.slice(-300),
                      message: `Section ${sectionNum} translating... (${accumulated.length} chars)`,
                    });
                  }
                },
              );
            } catch (err: any) {
              send("step", {
                step: "translate",
                status: "progress",
                section: sectionNum,
                total: generatedParagraphs.length,
                message: `Streaming failed, falling back: ${err?.message?.slice(0, 80) || ""}`,
              });
              const { chatWithSession } = await import("@/lib/llm-session");
              zhContent = await chatWithSession(projectId, translatePrompt, {
                system: translateSystem,
                temperature: 0.3,
                taskType: "translate",
                maxTokens,
                metadata: { step: "translate", section: sectionNum, fallback: true },
              });
            }

            // (Session messages already saved by chatWithSessionStream /
            // chatWithSession above — no manual saveSessionMessage needed.)

            // Sanitize: strip any preamble the LLM may have added despite instructions
            zhContent = zhContent
              .replace(/^(以下是|翻译如下|中文翻译：?|译文：?|Translation:?)\s*\n*/i, "")
              .trim();
            // Also apply general section sanitization to remove postscripts,
            // meta-commentary, horizontal rules, etc.
            zhContent = sanitizeSectionContent(zhContent);

            // Save the Chinese version to the paragraph
            const zhWordCount = countWords(zhContent);
            await db.paragraph.update({
              where: { id: para.id },
              data: {
                contentZh: zhContent,
                wordCountZh: zhWordCount,
              },
            });

            translatedParagraphContents.push(zhContent);

            send("step", {
              step: "translate",
              status: "done",
              section: sectionNum,
              total: generatedParagraphs.length,
              title: para.title,
              wordCount: zhWordCount,
              message: `Section ${sectionNum} translated: ${zhWordCount} Chinese chars (${Date.now() - trStart}ms)`,
              ms: Date.now() - trStart,
            });
            log(`translate: section ${sectionNum} DONE in ${Date.now() - trStart}ms (${zhContent.length} chars)`);

            // Rate limit
            await new Promise((r) => setTimeout(r, 1500));
            } catch (trErr: any) {
              // Translation of this section failed — skip and continue
              log(`translate: section ${sectionNum} FAILED: ${trErr?.message?.slice(0, 120) || "unknown"}`);
              translatedParagraphContents.push("");
              send("step", {
                step: "translate",
                status: "progress",
                section: sectionNum,
                total: generatedParagraphs.length,
                title: p.title,
                message: `Translation of section ${sectionNum} FAILED (skipped): ${trErr?.message?.slice(0, 80) || "LLM error"}. You can retranslate later.`,
                failed: true,
              });
              await new Promise((r) => setTimeout(r, 3000));
            }
          }

          // Compose the Chinese article by assembling translated sections
          send("step", {
            step: "translate",
            status: "progress",
            message: `Composing Chinese full article from ${translatedParagraphContents.length} translated sections...`,
          });

          const zhBody = translatedParagraphContents
            .map((c, i) => `## ${generatedParagraphs[i]?.title || sections[i]?.title || `Section ${i + 1}`}\n\n${c}`)
            .join("\n\n");

          let cleanZhBody = zhBody.trim();
          cleanZhBody = cleanZhBody.replace(/^#{1}\s+.+\n*/m, "").trim();
          // Strip any AI-generated 参考文献 section
          const zhRefRe = /^#{0,6}\s*\*{0,2}(参考文献|References|REFERENCES)\*{0,2}\s*:?\s*$/m;
          const zhRefMatch = cleanZhBody.match(zhRefRe);
          if (zhRefMatch && zhRefMatch.index !== undefined) {
            cleanZhBody = cleanZhBody.slice(0, zhRefMatch.index).trim();
          }

          // Use the same global references list (citations are unchanged) but with a Chinese header
          const zhRefList = globalRefs
            .map((r, i) => {
              const auth = r.authors || "Anonymous";
              const yr = r.year ? ` (${r.year})` : "";
              const jour = r.journal ? `, ${r.journal}` : "";
              const url = r.url ? ` — ${r.url}` : "";
              return `[${i + 1}] ${auth}${yr}${jour}. ${r.title}.${url}`;
            })
            .join("\n");

          articleContentZh = cleanZhBody + "\n\n## 参考文献\n\n" + zhRefList;

          send("step", {
            step: "translate",
            status: "done",
            message: `Chinese translation complete: ${countWords(articleContentZh)} chars across ${translatedParagraphContents.length} sections.`,
            articleWordCountZh: countWords(articleContentZh),
          });
          log(`translate: compose done — zh article ${articleContentZh.length} chars`);
        }

        // ============ STEP 9: Persist the article(s) ============
        const article = await db.article.create({
          data: {
            projectId,
            title: project.topic,
            content: articleContent,
            ...(articleContentZh ? { contentZh: articleContentZh } : {}),
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
          ...(articleContentZh ? { articleWordCountZh: countWords(articleContentZh), hasZh: true } : {}),
          message: `Article composed: ${countWords(articleContent)} English words${articleContentZh ? ` + ${countWords(articleContentZh)} Chinese chars` : ""}, ${globalRefs.length} references.`,
        });

        // ============ FINAL RESULT ============
        send("complete", {
          success: true,
          articleId: article.id,
          relationshipSummary,
          hasChinese: !!articleContentZh,
          stats: {
            sourcesGathered: savedDataSources.length,
            referencesSaved: savedReferences.length,
            curatedReferences: curatedRefs.length,
            sectionsPlanned: sections.length,
            paragraphsGenerated: generatedParagraphs.length,
            totalWords: generatedParagraphs.reduce((s, p) => s + p.wordCount, 0),
            articleWordCount: countWords(articleContent),
            ...(articleContentZh ? { articleWordCountZh: countWords(articleContentZh) } : {}),
            globalReferenceCount: globalRefs.length,
            failedSections: failedSections.length,
          },
          sections: generatedParagraphs,
          failedSectionIndices: failedSections,
          queriesExecuted: dbQueries.length + webSearchQueries.length,
        });
      } catch (err: any) {
        console.error("[/api/ai/generate-full] error:", err);
        // Even if the pipeline failed midway, try to compose and save a
        // partial article from whatever sections were successfully generated.
        // This ensures the user doesn't lose all progress.
        if (generatedParagraphs.length > 0) {
          try {
            log(`error recovery: composing partial article from ${generatedParagraphs.length} generated sections`);
            // Re-fetch paragraph data for composing
            const partialParagraphData = await Promise.all(
              generatedParagraphs.map(async (p) => {
                const para = await db.paragraph.findUnique({
                  where: { id: p.id },
                  include: { references: { orderBy: { citationOrder: "asc" } } },
                });
                const content = para?.content || "";
                const citIdx = content.indexOf("### Citations");
                let cleanContent = citIdx >= 0 ? content.slice(0, citIdx).trim() : content.trim();
                cleanContent = cleanContent.replace(/\]\]/g, "]");
                return { content: cleanContent, refs: para?.references || [] };
              })
            );
            // Simple global citation renumbering for partial article
            const globalRefMap = new Map<string, number>();
            const globalRefs: any[] = [];
            const renumberedContents = partialParagraphData.map(({ content, refs }) => {
              let result = content;
              const citeRe = /\[(\d+(?:[,\-–]\s*\d+)*)\]/g;
              result = result.replace(citeRe, (match, inner: string) => {
                const nums = inner.split(/[,;]\s*/).flatMap((s: string) => {
                  const rangeMatch = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
                  if (rangeMatch) {
                    const arr: number[] = [];
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
            const articleBody = renumberedContents
              .map((c, i) => `## ${sections[i].title}\n\n${c}`)
              .join("\n\n");
            const refList = globalRefs
              .map((r, i) => {
                const auth = r.authors || "Anonymous";
                const yr = r.year ? ` (${r.year})` : "";
                const jour = r.journal ? `, ${r.journal}` : "";
                const url = r.url ? ` — ${r.url}` : "";
                return `[${i + 1}] ${auth}${yr}${jour}. ${r.title}.${url}`;
              })
              .join("\n");
            const partialArticleContent = articleBody + "\n\n## References\n\n" + refList;

            const partialArticle = await db.article.create({
              data: {
                projectId,
                title: `${project.topic} (partial — ${generatedParagraphs.length}/${sections.length} sections)`,
                content: partialArticleContent,
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
            log(`error recovery: saved partial article ${partialArticle.id} with ${generatedParagraphs.length} sections`);
            send("complete", {
              success: true,
              partial: true,
              articleId: partialArticle.id,
              message: `Generation was interrupted, but ${generatedParagraphs.length}/${sections.length} sections were saved. You can regenerate the missing sections.`,
              stats: {
                sourcesGathered: savedDataSources.length,
                sectionsPlanned: sections.length,
                paragraphsGenerated: generatedParagraphs.length,
                failedSections: sections.length - generatedParagraphs.length,
                articleWordCount: countWords(partialArticleContent),
              },
              sections: generatedParagraphs,
              failedSectionIndices: sections.map((_: any, i: number) => i).filter((i: number) => !generatedParagraphs.find((p: any) => p.title === sections[i].title)),
            });
          } catch (recoveryErr: any) {
            log(`error recovery failed: ${recoveryErr?.message}`);
            send("error", { error: `${err?.message || "Generation failed."} (Recovery also failed: ${recoveryErr?.message})` });
          }
        } else {
          send("error", { error: err?.message || "Generation failed." });
        }
      } finally {
        safeClose();
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

function ncbiItemsCount(items: any[]): number {
  return items.filter((i) => i.source === "pubmed" || i.source === "ncbi").length;
}
function countBySource(items: any[], source: string): number {
  return items.filter((i) => i.source === source).length;
}

/**
 * Generate web search queries to supplement database queries.
 * Capped at maxQueries to avoid JSON truncation by the LLM's output token limit.
 */
async function generateWebSearchQueries(projectId: string, topic: string, field: string, targetWords: number, maxQueries: number = 8, maxTokens?: number): Promise<string[]> {
  // maxQueries >= 9999 means "no limit" (user set 0 in the UI).
  const isUnlimited = maxQueries >= 9999;
  try {
    const system = "You are a research strategist who designs web search queries to find supplementary sources.";
    const prompt = `RESEARCH TOPIC: ${topic}
FIELD: ${field}
TARGET: ${targetWords}-word comprehensive review article.

${isUnlimited
  ? `Design as many well-chosen web search queries as needed for MAXIMUM coverage (no upper limit — but keep the JSON concise).`
  : `Design ${Math.max(3, maxQueries - 3)}-${maxQueries} well-chosen web search queries (NOT more — too many causes JSON truncation).`
} Find recent reviews, preprints, news, and supplementary sources
NOT available in PubMed/RCSB/UniProt. Use distinct strategies:
- 1 broad review search (e.g. "TMC protein family review 2024")
- 1-2 specific mechanism searches (e.g. "TMC1 cryo-EM structure mechanism")
- 1 disease/clinical search (e.g. "TMC1 gene therapy hearing loss clinical trial")
- 1 recent news/breakthrough (e.g. "TMC channel discovery 2025")
- 1 preprint search (e.g. "site:biorxiv.org TMC mechanotransduction")
- 1 comparison/phylogeny search if relevant

Keep the JSON concise. Duplicates will be removed automatically.

Respond as STRICT JSON: { "queries": ["query 1", "query 2", ...] }`;

    const raw = await chatWithSession(projectId, prompt, {
      system,
      temperature: 0.4,
      taskType: "gather",
      metadata: { step: "web-search-queries" },
      maxTokens,
    });
    const parsed = safeParseJSON(raw, { queries: [] });
    // When unlimited, don't slice — keep everything the LLM returned.
    const queries = isUnlimited
      ? (parsed.queries || [])
      : (parsed.queries || []).slice(0, maxQueries);
    // Fallback: if LLM didn't return any queries, use basic topic-based queries
    if (queries.length === 0) {
      const topicWords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
      const topicPhrase = topicWords.join(" ");
      return [
        `${topicPhrase} review`,
        `${topicPhrase} mechanism`,
        `${topicPhrase} recent advances`,
        `${topicWords[0]} protein family`,
        `${topicWords[0]} structure function`,
      ];
    }
    return queries;
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
  maxCount: number,
  maxTokens?: number,
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

    // Check LLM cache — if the user has regenerated with the same topic +
    // reference list, the curation result is reusable. This saves a 5-15s
    // LLM call on every regeneration.
    const { llmCacheKey, getCachedLLMResult, setCachedLLMResult } = await import("@/lib/llm-cache");
    const cacheKey = llmCacheKey(prompt, { system, temperature: 0.3, taskType: "curate", maxTokens });
    const cached = getCachedLLMResult(cacheKey);
    let raw: string;
    if (cached) {
      console.log("[curateReferences] cache hit — skipping LLM call");
      raw = cached;
    } else {
      console.log("[curateReferences] cache miss — calling LLM");
      raw = await chatWithSession(projectId, prompt, {
        system,
        temperature: 0.3,
        taskType: "curate",
        metadata: { step: "curate", total: references.length, maxCount },
        maxTokens,
      });
      setCachedLLMResult(cacheKey, raw);
    }
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
  // Strategy 1: Try to find a JSON code block ```json ... ```
  // Use greedy match to capture the FULL JSON object inside code block
  const codeBlockMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch {}
  }

  // Strategy 1b: Try code block without closing ``` (LLM may have forgotten it)
  const codeBlockMatch2 = raw.match(/```(?:json)?\s*(\{[\s\S]*\})/);
  if (codeBlockMatch2) {
    try {
      return JSON.parse(codeBlockMatch2[1]);
    } catch {}
  }

  // Strategy 2: Greedy match — find the largest { ... } block
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn("[safeParseJSON] No JSON found in response (length=" + raw.length + ")");
    console.warn("[safeParseJSON] First 500 chars: " + raw.slice(0, 500));
    return fallback;
  }
  try {
    return JSON.parse(match[0]);
  } catch (e: any) {
    console.warn("[safeParseJSON] Failed to parse JSON (length=" + match[0].length + ")");
    console.warn("[safeParseJSON] Error: " + (e?.message || "unknown"));
    console.warn("[safeParseJSON] First 200 chars: " + match[0].slice(0, 200));
    console.warn("[safeParseJSON] Last 200 chars: " + match[0].slice(-200));

    // Strategy 3: Try to fix common JSON issues
    let fixed = match[0]
      .replace(/,\s*}/g, "}")  // trailing comma
      .replace(/,\s*]/g, "]")  // trailing comma in array
      .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3')  // unquoted keys
      .replace(/'/g, '"');  // single quotes
    try {
      return JSON.parse(fixed);
    } catch (e2: any) {
      console.warn("[safeParseJSON] Fix attempt also failed: " + (e2?.message || "unknown"));
      return fallback;
    }
  }
}

/**
 * Extract meaningful keywords from a section's title + focus text.
 * Used for per-section reference filtering — we score each ref by how many
 * of these keywords appear in its title/abstract, and keep only the top
 * scoring refs so the LLM isn't tempted to cite irrelevant sources.
 *
 * Strategy:
 * 1. Lowercase + tokenize on non-alphanumeric.
 * 2. Remove stopwords (the/a/an/of/and/...) and very short tokens (<3 chars).
 * 3. Remove the project topic words themselves (they'd match everything).
 * 4. Keep terms that are >= 4 chars OR look like gene/protein names (TMC1,
 *    TMC2, ...), species (mouse, zebrafish), or methods (cryo-EM, CRISPR).
 *
 * Returns a de-duplicated keyword array.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "by",
  "for", "with", "from", "into", "this", "that", "these", "those", "is",
  "are", "was", "were", "be", "been", "being", "have", "has", "had", "do",
  "does", "did", "will", "would", "could", "should", "may", "might", "can",
  "shall", "must", "not", "no", "nor", "so", "if", "then", "than", "too",
  "very", "just", "also", "only", "about", "above", "after", "again",
  "against", "all", "any", "because", "before", "below", "between", "both",
  "during", "each", "few", "more", "most", "other", "over", "same", "some",
  "such", "through", "under", "until", "up", "down", "out", "off", "over",
  "under", "again", "further", "once", "here", "there", "when", "where",
  "why", "how", "what", "which", "who", "whom", "whose", "section", "part",
  "focus", "describe", "discuss", "review", "summarize", "provide", "cover",
  "include", "using", "used", "use", "via", "within", "without", "upon",
  "their", "they", "them", "it", "its", "as", "we", "our", "us", "you",
  "your", "he", "she", "his", "her", "its", "our", "their",
]);

function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  // Match word-like tokens including TMC1, CRISPR-Cas9, cryo-EM, etc.
  const tokens = lower.match(/[a-z][a-z0-9\-]{2,}/g) || [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    if (t.length < 4 && !/^[a-z]+\d+$/.test(t)) continue; // keep TMC1-style short names
    if (seen.has(t)) continue;
    seen.add(t);
    keywords.push(t);
  }
  return keywords;
}

/**
 * Score how relevant a reference's text (title + abstract + journal) is to
 * a set of section keywords. Returns the count of distinct keyword matches.
 *
 * This is a simple keyword-overlap heuristic — not semantic similarity —
 * but it's fast (no LLM call) and catches the common case where a ref about
 * "TMC7 acrosome biogenesis" should NOT be cited in a section about
 * "TMC1 animal models and hearing".
 */
function scoreRelevance(keywords: string[], refText: string): number {
  if (keywords.length === 0) return 0;
  const lower = refText.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) score++;
  }
  return score;
}
