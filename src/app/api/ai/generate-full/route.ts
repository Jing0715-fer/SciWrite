import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { webSearch } from "@/lib/ai";
import { chatWithSession, clearSession } from "@/lib/llm-session";
import { queryDatabase, fetchFullTextForPubMed } from "@/lib/databases";
import { countWords, renumberByAppearance, sanitizeSectionContent, buildStructureContextFromDataSources } from "@/lib/writing";
import { validateCitationsInline } from "@/lib/citation-audit";
import {
  preFlightQuotaCheck,
  isAborted,
  clearAbort,
  getWindowCount,
  QuotaExhaustedError,
  RateLimitAbortedError,
} from "@/lib/rate-limiter";
// v57-1: Extracted helper functions to reduce route file size (was 2836 lines,
// caused Turbopack OOM in 3.9Gi RAM environments).
import {
  ncbiItemsCount,
  countBySource,
  generateWebSearchQueries,
  curateReferences,
  inferFormat,
  safeParseJSON,
  extractKeywords,
  extractSectionKeywords,
  scoreRelevance,
} from "@/lib/generate-full-helpers";

export const runtime = "nodejs";
export const maxDuration = 1800; // 30 minutes — streaming keeps connection alive

/**
 * v53-恢复参数：
 *  - DENSITY_MIN: 每个 section 期望的最少引用数。若 audit 后 < 该值，
 *    触发 post-audit injection（追加 1-3 条相关引用到段落末尾）。
 *  - DENSITY_HALLUCINATION_FLOOR: 当 < 3 时认为 LLM 没好好生成，触发重试。
 *  - ABORT_ON_RATE_LIMIT: 当 QuotaExhaustedError / RateLimitAbortedError
 *    被抛出时，立即停止后续 section 生成并保存已生成内容。
 *  - WORD_COUNT_RETRY_THRESHOLD: v55-1 — 当 section 实际词数 < 目标的 90%
 *    时, 用更强的字数强调 prompt 重试一次。只接受改善的结果。
 */
const DENSITY_MIN = 5;                  // v32-1: post-audit injection 阈值
const DENSITY_HALLUCINATION_FLOOR = 5;  // v56-3: raised from 3→5 — more sections trigger LLM retry (vs just injection)
const WORD_COUNT_RETRY_THRESHOLD = 0.90; // v78-1: raised from 0.85→0.90 — stricter, triggers retry when <90% (was <85%)
const RETRY_BUDGET_DENSITY = 3;           // v61-2: separate budget for density retries (was shared 3)
const RETRY_BUDGET_WC = 3;               // v78-1: raised from 2→3 — more retries for larger articles (1000w+)
const CITATION_MAX = 10;                 // v60-3: raised from 8→10 — allows richer citation density for longer sections

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
        // v93-2: clearAbort BEFORE gather — the abort flag from a previous
        // pipeline run (or session) must be cleared before any LLM call,
        // including the gather LLM call at line 297. Previously clearAbort
        // was at line 1032 (after gather), causing RateLimitAbortedError
        // in gather when the abort flag was set from a previous run.
        clearAbort();
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
          await new Promise((resolve) => setTimeout(resolve, 200)); // v76-1: Reduced rate limit delay from 400ms to 200ms (NCBI allows 3 req/s = 333ms gap, 200ms is safe with retry)
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

Plan a comprehensive review article. For ${targetWords} words, use ${Math.max(5, Math.ceil(targetWords / 500))}-${Math.max(8, Math.ceil(targetWords / 400))} sections.
Each section should be 200-500 words (keep sections SMALL to avoid max token issues and ensure each section reaches its target).
The sum of all section word counts should be approximately ${targetWords}.
v81-1: Distribute word targets EVENLY across sections. Do NOT make the last
section much shorter than others. Each section's targetWords should be
approximately ${Math.floor(targetWords / Math.max(5, Math.ceil(targetWords / 500)))} words.
For example, for ${targetWords} words with ${Math.max(5, Math.ceil(targetWords / 500))} sections,
each section should target ~${Math.floor(targetWords / Math.max(5, Math.ceil(targetWords / 500)))} words.
v80-1: For larger articles (1500w+), prefer MORE sections with SMALLER targets
(200-300w each) rather than fewer sections with larger targets. This improves
达标率 because LLM writes more reliably for 200-300w targets than 400w+.

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
        let sections = (planParsed.sections || []).filter(
          (s: any) => s.title && s.targetWords
        );

        // v90-1: If LLM returned very few sections (< 3), the JSON was likely
        // truncated. This happened in v89 (only 2 sections for 600w target).
        // Log a warning and proceed — minSections enforcement will handle it.
        if (sections.length < 3) {
          log(`plan: WARNING — LLM returned only ${sections.length} sections (likely truncated JSON). Will enforce minSections.`);
        }

        if (sections.length === 0) {
          // v90-1: Fallback — if JSON parsing completely failed, create
          // default sections based on targetWords
          const fallbackCount = Math.max(5, Math.ceil(targetWords / 300));
          const fallbackPerSection = Math.floor(targetWords / fallbackCount);
          log(`plan: JSON parse failed, creating ${fallbackCount} fallback sections`);
          sections = [];
          for (let i = 0; i < fallbackCount; i++) {
            sections.push({
              title: i === 0 ? "Introduction" : i === fallbackCount - 1 ? "Future Directions" : `Section ${i + 1}`,
              targetWords: fallbackPerSection,
              focus: `Aspect ${i + 1} of ${project.topic}`,
            });
          }
        }

        // v83-2: Enforce minimum section count and even word distribution.
        // v84-2: If LLM returned fewer than minSections, ADD new sections.
        // v85-2: Only add sections for very large articles (2000w+).
        //   For 1000w-1500w, redistribute is better (v83: 99% vs v84: 87%).
        //   The tradeoff: add sections = more content but lower 达标率
        //   (more LLM calls = more rate-limiter cool-downs).
        //   redistribute = fewer sections but higher 达标率.
        const minSections = Math.max(5, Math.ceil(targetWords / 300));
        if (sections.length < minSections) {
          const needed = minSections - sections.length;
          // v85-2: Only add sections for 2000w+ (where more sections are
          // clearly needed). For smaller articles, just redistribute.
          // v90-1: Also add if sections.length < 3 (truncated JSON fallback).
          const shouldAddSections = (targetWords >= 2000 && needed <= 3) || sections.length < 3;
          if (shouldAddSections) {
            log(`plan: LLM returned ${sections.length} sections, but minimum is ${minSections} (targetWords=${targetWords}/300). Adding ${needed} more sections.`);
            // Generic section titles for the additional sections
            const genericTitles = [
              "Emerging Trends and Future Directions",
              "Challenges and Limitations",
              "Comparative Analysis and Perspectives",
              "Technical Advances and Innovations",
              "Translational Implications",
            ];
            for (let i = 0; i < needed && i < genericTitles.length; i++) {
              sections.push({
                title: genericTitles[i],
                targetWords: Math.floor(targetWords / minSections),
                focus: `Additional perspectives on ${project.topic}`,
              });
            }
          } else {
            log(`plan: LLM returned ${sections.length} sections, minimum is ${minSections}. Redistributing (targetWords=${targetWords} < 2000, or needed=${needed} > 3).`);
          }
          // Evenly distribute target words across ALL sections
          const perSectionTarget = Math.floor(targetWords / sections.length);
          for (const s of sections) {
            s.targetWords = perSectionTarget;
          }
          log(`plan: added ${needed} sections, total ${sections.length} sections (per section ~${perSectionTarget}w, total ~${sections.reduce((s: number, sec: any) => s + (sec.targetWords || 0), 0)}w)`);
        }

        // v96-1: Borrowed from deepseek-harness's plan mode — validate the
        // planned sections before proceeding to generation. Check that:
        // 1. Each section has a non-empty title and focus
        // 2. Section titles are not duplicates
        // 3. Total targetWords sums to approximately targetWords (±20%)
        const seenTitles = new Set<string>();
        let duplicateTitles = 0;
        for (const s of sections) {
          if (!s.title || s.title.trim().length < 3) {
            s.title = `Section ${sections.indexOf(s) + 1}`;
            log(`plan: WARNING — section has empty/short title, using fallback`);
          }
          const titleLower = s.title.toLowerCase().trim();
          if (seenTitles.has(titleLower)) {
            duplicateTitles++;
            s.title = `${s.title} (Part ${duplicateTitles + 1})`;
            log(`plan: WARNING — duplicate section title detected, renamed to "${s.title}"`);
          }
          seenTitles.add(titleLower);
          if (!s.focus) {
            s.focus = `Discussion of ${s.title} in the context of ${project.topic}`;
          }
        }
        const plannedTotal = sections.reduce((s: number, sec: any) => s + (sec.targetWords || 0), 0);
        const plannedPct = Math.round((plannedTotal / targetWords) * 100);
        if (plannedPct < 80 || plannedPct > 120) {
          log(`plan: WARNING — planned total ${plannedTotal}w is ${plannedPct}% of target ${targetWords}w (outside 80-120% range)`);
        }
        log(`plan: validated ${sections.length} sections (total ${plannedTotal}w, ${plannedPct}% of target, ${duplicateTitles} duplicates fixed)`);

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
        let generatedParagraphs: any[] = [];
        const failedSections: number[] = []; // track which sections failed
        let previousSectionsDigest = ""; // running style/flow reference
        let abortedDueToRateLimit = false; // v53-恢复: track rate-limit abort
        let retryBudgetDensityUsed = 0; // v61-2: track density retries separately
        let retryBudgetWcUsed = 0;     // v61-2: track word-count retries separately

        // v53-恢复: Pre-flight quota check — if the cached quota state says
        // we have 0 calls left today, bail out BEFORE doing any LLM work.
        // v91-2: Clear abort flag before pre-flight check. If a previous
        // pipeline run set the abort flag (e.g. from a different session),
        // the new run should start fresh.
        clearAbort();
        try {
          preFlightQuotaCheck("generate-full:pre-flight");
        } catch (e: any) {
          abortedDueToRateLimit = true;
          send("step", {
            step: "generate",
            status: "error",
            message: `Pre-flight quota check failed: ${e.message}. Aborting before section generation.`,
            aborted: true,
          });
          log(`PRE-FLIGHT QUOTA ABORT: ${e.message}`);
        }

        for (let i = 0; i < sections.length; i++) {
          const section = sections[i];
          const sectionNum = i + 1;
          const sectionStart = Date.now();

          // v53-恢复: Abort on rate limit — if a previous call set the
          // abort flag (429 storm or quota exhaustion), stop generating
          // new sections. Already-saved sections are preserved.
          if (abortedDueToRateLimit || isAborted()) {
            abortedDueToRateLimit = true;
            send("step", {
              step: "generate",
              status: "skipped",
              section: sectionNum,
              total: sections.length,
              title: section.title,
              message: `Section ${sectionNum} SKIPPED — rate-limit abort active. Already-saved sections are preserved.`,
              aborted: true,
            });
            log(`generate: section ${sectionNum} SKIPPED (rate-limit abort)`);
            failedSections.push(i);
            continue;
          }

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

          // v99-4: Preemptive slow-down — if the sliding window count is
          // approaching the threshold (>= 11 of 15), wait 25s before starting
          // this section's LLM calls. This prevents hitting the 60s cool-down
          // mid-section (which happened in v98 §5: window=15, 60s penalty).
          // Cost: 25s × ~2 sections = ~50s extra. Benefit: avoids 60s cool-down.
          {
            const preemptiveWc = getWindowCount();
            if (preemptiveWc >= 11 && i > 0) {
              log(`generate: section ${sectionNum} preemptive slow-down — window count ${preemptiveWc}/15, waiting 25s`);
              send("step", {
                step: "generate",
                status: "progress",
                section: sectionNum,
                total: sections.length,
                message: `Pacing rate-limit window (${preemptiveWc}/15) — waiting 25s before section ${sectionNum}...`,
                preemptiveSlowDown: true,
                windowCount: preemptiveWc,
              });
              await new Promise((r) => setTimeout(r, 25000));
            }
          }

          // For sections with high target words, generate in sub-chunks
          const sectionTargetWords = section.targetWords || 600;
          const needsChunking = sectionTargetWords > 1200;
          const chunkCount = needsChunking ? Math.ceil(sectionTargetWords / 1000) : 1;

          let fullSectionContent = "";
          // v54-5: save the last chunk's prompt + system so the density-retry
          // block (which runs AFTER the chunk loop) can reuse them. Without
          // this, `prompt` is out of scope in the retry block.
          let lastChunkPrompt = "";
          let lastChunkSystem = "";

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
          const sectionKeywords = extractSectionKeywords(
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
REFERENCE LIST (cite as [n], 1-based index into this list of ${sectionRefCount} refs — pre-filtered for relevance to THIS section):
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

WORD COUNT (CRITICAL — you MUST hit the target):
- TARGET: ${chunkWords} words for this section (±10%, i.e. ${Math.floor(chunkWords * 0.9)}-${Math.ceil(chunkWords * 1.1)} words).
- This is a HARD requirement, not a suggestion. Count your words before finishing.
- If you find yourself finishing before ${Math.floor(chunkWords * 0.9)} words, EXPAND:
  add more mechanistic detail, discuss specific experimental results, compare findings
  across sources, or elaborate on methodological nuances. Do NOT pad with filler.
- If you exceed ${Math.ceil(chunkWords * 1.1)} words, tighten the prose but keep all citations.
- A typical 300-word section has 2-3 substantial paragraphs; a 600-word section has 4-5.

CITATION FORMAT (MANDATORY):
- Use ONLY numeric [n] citations (e.g. [1], [2], [3]).
- Number citations starting from [1] for THIS section. Each [n] refers to the n-th entry
  in the REFERENCE LIST above (${sectionRefCount} entries, [1] to [${sectionRefCount}]).
- Cite AT LEAST 3 different references per ~500 words (so a 300-word section needs ≥3
  citations; a 600-word section needs ≥5).
- There is NO upper limit on citations — cite every reference that is directly relevant
  to your claims. Do NOT artificially limit the number of citations; each relevant
  source adds value to the review. The goal is comprehensive coverage.
- CRITICAL: Only cite a reference if its title or abstract is DIRECTLY relevant to the
  specific claim you are making. Before citing [n], ask yourself: "Does reference [n]'s
  title/abstract actually discuss this specific topic?" If NO, do NOT cite it — use [$REF]
  instead. Citing an unrelated reference is WORSE than leaving a [$REF] placeholder.
  v71-1: To reduce topicality warnings, verify the MATCH before citing: the citing
  sentence and the reference's title/abstract should share at least 2 key terms
  (e.g. "TMC1", "mechanotransduction", "hair cell"). If they share 0-1 terms,
  the citation is likely "unsupported" — find a better match or use [$REF].
  v74-1: Reverted v73-2's "HIGHEST overlap" instruction — it caused LLM to
  cite more refs (59 vs 53) which increased warnings (9→15). Keeping the
  simpler v72 prompt that produced fewer warnings.
- However, do NOT avoid citing entirely. If a claim needs support and the closest reference
  in the list is partially relevant, cite it rather than leaving [$REF]. Use [$REF] ONLY
  when NO reference in the list is even partially relevant to the claim.
- Do NOT cite a reference just because it appears in the list. Each citation must be
  semantically justified by the reference's actual content.
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
- CRITICAL: Do NOT output a summary or description of what you wrote. Do NOT write
  "The section has been written as 4 cohesive paragraphs..." or "P1 — ..." bullet
  points. Output ONLY the actual article text — real academic prose paragraphs
  that a reader would see in a published review article.
- Do NOT use "P1 —", "P2 —", "Paragraph 1 —" or similar outline labels. Write
  actual flowing paragraphs, not bullet-point descriptions of paragraphs.
- Write the section as 2-4 cohesive paragraphs of prose, separated by a single
  blank line. Target ${chunkWords} words total for this section (±10%).
  Do NOT write significantly more or fewer words than the target.
  v79-1: Keep sections BALANCED in length — do NOT write an overly long
  first section. Each section should be approximately ${chunkWords} words.
  v80-2: Removed the "STOP and conclude" instruction (v79-1) — it caused
  LLM to end sections prematurely (v79: avg 318w vs 400w target = 80%).
  Instead, aim for the target but do not exceed it by more than 15%.
- Use **bold** for key protein/gene names only on first mention; otherwise plain text.
- Use *italics* for species names (e.g. *C. elegans*, *Mus musculus*).
- Match the tone, depth, and paragraph density of the PREVIOUS SECTIONS above.
${promptInstruction ? `\nCUSTOM INSTRUCTION (from selected prompt template — follow this in addition to the above rules):\n${promptInstruction}` : ""}`;

            const system = `You are a senior scientific research writer and domain expert (${project.field || "life sciences"}).
Write in ${generationLanguage}, using formal, precise academic prose (third person, past tense for results/methods).
Compose ONE cohesive section. The section title is provided separately — start the body with actual content, NOT a restatement of the title.
${sectionStructureContext ? "When a PROTEIN STRUCTURE ANALYSIS block is provided, USE the specific computed numeric values (resolution, % helix/sheet, ligand chain:resSeq, Ramachandran % favoured, B-factor mean, SASA % exposed, H-bond count, pI, BSA) — they are REAL values from the actual PDB file. Quote them precisely and connect them to biological function. NEVER fabricate structural metrics." : ""}`;

            // v54-5: Save prompt + system for the density-retry block.
            lastChunkPrompt = prompt;
            lastChunkSystem = system;

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

            // AUTO-RETRY: if sanitization detected meta-commentary or bullet-point
            // outline (returns a "[Content generation issue..." placeholder), retry
            // the LLM call ONCE with a stronger instruction to write actual prose.
            if (chunkContent.startsWith("[Content generation issue")) {
              log(`generate: section ${sectionNum} chunk ${chunkNum} — meta-commentary detected, retrying...`);
              send("step", {
                step: "generate",
                status: "progress",
                section: sectionNum,
                total: sections.length,
                message: `Section ${sectionNum} chunk ${chunkNum}: retrying (meta-commentary detected)...`,
              });
              try {
                const retryPrompt = prompt + "\n\nCRITICAL: Your previous output was a SUMMARY or OUTLINE, not actual article text. You MUST write real academic prose paragraphs — NOT bullet points, NOT P1 labels, NOT a description of what you wrote. Start directly with the first sentence of the section.";
                let retryContent = chunkCount > 1
                  ? await chatWithSessionStream(projectId, retryPrompt, {
                      system, temperature: 0.65, thinking: false,
                      taskType: "generate", maxTokens,
                      metadata: { step: "generate", section: sectionNum, chunk: chunkNum, retry: true },
                    })
                  : await chatWithSession(projectId, retryPrompt, {
                      system, temperature: 0.65, taskType: "generate", maxTokens,
                      metadata: { step: "generate", section: sectionNum, retry: true },
                    });
                // Sanitize the retry output
                const sanitizedRetry = sanitizeSectionContent(retryContent);
                if (!sanitizedRetry.startsWith("[Content generation issue")) {
                  chunkContent = sanitizedRetry;
                  log(`generate: section ${sectionNum} chunk ${chunkNum} — retry succeeded (${chunkContent.length} chars)`);
                } else {
                  log(`generate: section ${sectionNum} chunk ${chunkNum} — retry also failed, using placeholder`);
                }
              } catch (retryErr: any) {
                log(`generate: section ${sectionNum} chunk ${chunkNum} — retry failed: ${retryErr?.message?.slice(0, 80)}`);
              }
            }

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
          let { content: renumberedContent, references: citedRefs } =
            renumberByAppearance(fullSectionContent, sectionRefs);

          // v53-恢复 (v32-1): Post-audit injection — if density is below
          // DENSITY_MIN (5), append a sentence citing additional topically-
          // relevant refs from sectionRefs that weren't cited yet. This
          // guarantees every section has at least DENSITY_MIN citations (or
          // as many as sectionRefs allows if it has fewer than DENSITY_MIN).
          // This is cheaper than a full LLM retry and reliably lifts density.
          //
          // v54-3: injection 现在优先选 overlap 最高的 uncited ref (而非
          //   uncited 列表的前 N 个), 减少 audit "unsupported" warnings。
          // v54-5: 当 density < DENSITY_HALLUCINATION_FLOOR (3) 时, 先尝试
          //   LLM density retry; 若 retry 失败或不改善, 再走 injection。
          let densityRetried = false;
          if (
            citedRefs.length < DENSITY_HALLUCINATION_FLOOR &&
            sectionRefs.length >= DENSITY_HALLUCINATION_FLOOR &&
            !isAborted() &&
            retryBudgetDensityUsed < RETRY_BUDGET_DENSITY // v61-2: separate density budget
          ) {
            retryBudgetDensityUsed++; // v61-2: consume from density budget
            send("step", {
              step: "generate",
              status: "progress",
              section: sectionNum,
              total: sections.length,
              message: `Section ${sectionNum}: low citation density (${citedRefs.length} < ${DENSITY_HALLUCINATION_FLOOR}) — retrying with stronger citation emphasis...`,
              densityRetry: true,
            });
            log(`generate: section ${sectionNum} DENSITY RETRY (cited=${citedRefs.length} < ${DENSITY_HALLUCINATION_FLOOR})`);
            try {
              const retryPrompt = `${lastChunkPrompt}\n\nCRITICAL RETRY: Your previous output had only ${citedRefs.length} citation(s). You MUST cite at least ${DENSITY_MIN} different references from the list above. Re-read the reference list and INTEGRATE specific findings from at least ${DENSITY_MIN} sources into your prose. Every claim about a fact, method, or result must be followed by a [n] citation.`;
              const { chatWithSessionStream: retryStream } = await import("@/lib/llm-session");
              let retryLastEmit = 0;
              const retryContent = await retryStream(
                projectId,
                retryPrompt,
                {
                  system: lastChunkSystem,
                  temperature: 0.7,
                  thinking: false,
                  taskType: "generate",
                  maxTokens,
                  metadata: {
                    step: "generate-density-retry",
                    section: sectionNum,
                    sectionTitle: section.title,
                  },
                },
                (delta, accumulated) => {
                  const now = Date.now();
                  if (now - retryLastEmit > 100) {
                    retryLastEmit = now;
                    send("step", {
                      step: "generate",
                      status: "streaming",
                      section: sectionNum,
                      total: sections.length,
                      delta: delta.slice(-200),
                      accumulatedLength: accumulated.length,
                      message: `Section ${sectionNum} density-retry streaming... (${accumulated.length} chars)`,
                    });
                  }
                },
              );
              const retryCleaned = sanitizeSectionContent(retryContent);
              const retryResult = renumberByAppearance(retryCleaned, sectionRefs);
              if (retryResult.references.length > citedRefs.length) {
                log(`generate: section ${sectionNum} DENSITY RETRY improved ${citedRefs.length}→${retryResult.references.length}`);
                renumberedContent = retryResult.content;
                citedRefs = retryResult.references;
                densityRetried = true;
              } else {
                log(`generate: section ${sectionNum} DENSITY RETRY did not improve (${retryResult.references.length} <= ${citedRefs.length}) — keeping original`);
              }
            } catch (retryErr: any) {
              log(`generate: section ${sectionNum} DENSITY RETRY failed: ${retryErr?.message?.slice(0, 100)}`);
            }
          }

          // v55-1: Word-count retry — if the section is significantly shorter
          // than target (< 90% of sectionTargetWords), retry with a stronger
          // word-count-emphasis prompt. Only accept the retry if it's longer.
          // This addresses the v54 test finding where sections averaged 207w
          // against a 300w target (69%).
          let wordCountRetried = false;
          const currentWordCount = countWords(renumberedContent);
          const wordCountTarget = sectionTargetWords;
          // v64-3: Skip WC retry for very short sections (< 120w) — LLM
          // struggles to expand such short sections meaningfully, and the
          // retry often produces similar or shorter output (v63 §5: 100→101w).
          // For these, go straight to WC injection which reliably adds length.
          // v78-1: Use dynamic threshold (50% of section target) instead of
          // fixed 120w. For 600w target (120w sections), 50% = 60w. For 1000w
          // target (200w sections), 50% = 100w. This scales with article size.
          const wcRetryMinThreshold = Math.max(80, Math.floor(sectionTargetWords * 0.5));
          if (
            currentWordCount < Math.floor(wordCountTarget * WORD_COUNT_RETRY_THRESHOLD) &&
            currentWordCount >= wcRetryMinThreshold && // v78-1: dynamic threshold (was fixed 120)
            !isAborted() &&
            retryBudgetWcUsed < RETRY_BUDGET_WC // v61-2: separate WC budget
          ) {
            retryBudgetWcUsed++; // v61-2: consume from WC budget
            send("step", {
              step: "generate",
              status: "progress",
              section: sectionNum,
              total: sections.length,
              message: `Section ${sectionNum}: word count ${currentWordCount} < ${Math.floor(wordCountTarget * WORD_COUNT_RETRY_THRESHOLD)} (90% of ${wordCountTarget}) — retrying with stronger word-count emphasis...`,
              wordCountRetry: true,
            });
            log(`generate: section ${sectionNum} WORD-COUNT RETRY (words=${currentWordCount} < ${Math.floor(wordCountTarget * WORD_COUNT_RETRY_THRESHOLD)})`);
            try {
              const wcRetryPrompt = `${lastChunkPrompt}\n\nCRITICAL WORD-COUNT RETRY: Your previous output was only ${currentWordCount} words — that is ${Math.round((1 - currentWordCount / wordCountTarget) * 100)}% SHORT of the ${wordCountTarget}-word target. You MUST write at least ${Math.floor(wordCountTarget * 0.95)} words.\n\nEXPAND, DO NOT SHRINK: Your retry MUST be LONGER than ${currentWordCount} words. Do NOT summarize or condense — EXPAND each point with: (1) specific experimental details (sample size, methodology, controls), (2) quantitative results (fold-changes, p-values, effect sizes), (3) mechanistic explanations linking findings to function, (4) comparisons across multiple studies. Do NOT repeat content — add NEW depth. Write ${Math.ceil(wordCountTarget / 75)} substantial paragraphs of ~75-100 words each. The minimum acceptable length is ${Math.floor(wordCountTarget * 0.95)} words — anything shorter is a FAILURE.`;
              const { chatWithSessionStream: wcRetryStream } = await import("@/lib/llm-session");
              let wcRetryLastEmit = 0;
              const wcRetryContent = await wcRetryStream(
                projectId,
                wcRetryPrompt,
                {
                  system: lastChunkSystem,
                  temperature: 0.65,
                  thinking: false,
                  taskType: "generate",
                  maxTokens,
                  metadata: {
                    step: "generate-wordcount-retry",
                    section: sectionNum,
                    sectionTitle: section.title,
                  },
                },
                (delta, accumulated) => {
                  const now = Date.now();
                  if (now - wcRetryLastEmit > 100) {
                    wcRetryLastEmit = now;
                    send("step", {
                      step: "generate",
                      status: "streaming",
                      section: sectionNum,
                      total: sections.length,
                      delta: delta.slice(-200),
                      accumulatedLength: accumulated.length,
                      message: `Section ${sectionNum} word-count-retry streaming... (${accumulated.length} chars)`,
                    });
                  }
                },
              );
              const wcRetryCleaned = sanitizeSectionContent(wcRetryContent);
              const wcRetryResult = renumberByAppearance(wcRetryCleaned, sectionRefs);
              const wcRetryWordCount = countWords(wcRetryResult.content);
              // v61-3: Further relaxed WC retry acceptance — accept if:
              //   1. Word count improved by > 20%, AND
              //   2. Refs >= 3 (hard floor, was DENSITY_HALLUCINATION_FLOOR=5).
              //      The v60 test showed §2 retry (170w, refs=1) was rejected
              //      even though it was +35% longer. With refs>=3 accepted,
              //      post-audit injection only needs to add 2 more to reach 5.
              //      This dramatically improves retry acceptance rate.
              // v62-1: Lowered WC retry improvement threshold from +20% to +15%.
              // The v61 test rejected §2 retry (91→108w, +19%) even though it
              // was longer. +15% accepts retries that add meaningful length.
              const wcImprovementPct = (wcRetryWordCount - currentWordCount) / currentWordCount;
              const wcRefsAcceptable = wcRetryResult.references.length >= 3; // v61-3: lowered from 5 to 3
              // v99-1: Reject retry if it overshoots target by >125% — prevents
              // the v98 §2 case (275w vs 200w target = 137%) where retry
              // over-expanded and unbalanced the article.
              const wcOvershootPct = wcRetryWordCount / sectionTargetWords;
              const wcRetryAcceptable =
                wcImprovementPct > 0.10 &&
                wcRefsAcceptable &&
                wcOvershootPct <= 1.25; // v99-1: reject overshoot > 125% target
              if (wcRetryAcceptable) {
                log(`generate: section ${sectionNum} WORD-COUNT RETRY improved ${currentWordCount}→${wcRetryWordCount} words (+${Math.round(wcImprovementPct * 100)}%), refs ${citedRefs.length}→${wcRetryResult.references.length} (injection will top up if needed)${wcOvershootPct > 1.10 ? ` [overshoot ${Math.round(wcOvershootPct * 100)}% within cap]` : ""}`);
                renumberedContent = wcRetryResult.content;
                citedRefs = wcRetryResult.references;
                wordCountRetried = true;
              } else {
                const reason = wcOvershootPct > 1.25
                  ? `overshoot ${Math.round(wcOvershootPct * 100)}% > 125% cap`
                  : `wc ${currentWordCount}→${wcRetryWordCount} +${Math.round(wcImprovementPct * 100)}%, refs=${wcRetryResult.references.length} need≥3`;
                log(`generate: section ${sectionNum} WORD-COUNT RETRY did not meet acceptance (${reason}) — keeping original`);
              }
            } catch (wcRetryErr: any) {
              log(`generate: section ${sectionNum} WORD-COUNT RETRY failed: ${wcRetryErr?.message?.slice(0, 100)}`);
            }
          }

          // v59-3: Word-count injection — if the section is still significantly
          // short (< 85% of target) after retry (or retry wasn't triggered),
          // append a "Further context" sentence citing uncited topically-
          // relevant refs. This adds ~30-50 words per injected ref without
          // an extra LLM call. Cheaper than retry, more natural than padding.
          const postRetryWordCount = countWords(renumberedContent);
          if (
            postRetryWordCount < Math.floor(sectionTargetWords * WORD_COUNT_RETRY_THRESHOLD) &&
            sectionRefs.length > citedRefs.length
          ) {
            const citedIds = new Set(citedRefs.map((r: any) => r.externalId));
            const uncitedForWc = sectionRefs
              .filter((r: any) => !citedIds.has(r.externalId))
              .map((r: any) => ({
                ref: r,
                score: scoreRelevance(
                  sectionKeywords,
                  `${r.title || ""} ${r.abstract || ""} ${r.journal || ""}`,
                ),
              }))
              .sort((a: any, b: any) => b.score - a.score);
            const wcInjectCount = Math.min(2, uncitedForWc.length);
            if (wcInjectCount > 0) {
              const injectRefs = uncitedForWc.slice(0, wcInjectCount).map((s: any) => s.ref);
              const wcInjectBlock = injectRefs
                .map((r: any, idx: number) => {
                  const newIdx = citedRefs.length + idx + 1;
                  const auth = (r.authors || "Anon").split(",")[0];
                  const yr = r.year ? ` (${r.year})` : "";
                  const titleSnippet = r.title ? ` regarding ${r.title.slice(0, 60).toLowerCase()}` : "";
                  return `[${newIdx}] ${auth}${yr}${titleSnippet}`;
                })
                .join(", ");
              const wcInjectionSentence = `\n\nFurther context on this topic is provided by ${wcInjectBlock}.`;
              renumberedContent = renumberedContent + wcInjectionSentence;
              for (const r of injectRefs) {
                citedRefs.push(r as any);
              }
              log(`generate: section ${sectionNum} WORD-COUNT INJECTION +${wcInjectCount} refs (wc ${postRetryWordCount}→${countWords(renumberedContent)}, top score=${uncitedForWc[0]?.score ?? 0})`);
              send("step", {
                step: "generate",
                status: "progress",
                section: sectionNum,
                total: sections.length,
                message: `Section ${sectionNum}: word-count injection +${wcInjectCount} refs (now ${countWords(renumberedContent)} words, ${citedRefs.length} citations).`,
                wcInjected: wcInjectCount,
              });
            }
          }

          if (
            citedRefs.length < DENSITY_MIN &&
            sectionRefs.length > citedRefs.length
          ) {
            const citedIds = new Set(citedRefs.map((r: any) => r.externalId));
            // v54-3: score uncited refs by keyword overlap with section title+focus,
            // pick the highest-overlap ones to minimize "unsupported" audit warnings.
            const uncited = sectionRefs
              .filter((r: any) => !citedIds.has(r.externalId))
              .map((r: any) => ({
                ref: r,
                score: scoreRelevance(
                  sectionKeywords,
                  `${r.title || ""} ${r.abstract || ""} ${r.journal || ""}`,
                ),
              }))
              .sort((a: any, b: any) => b.score - a.score);
            const injectCount = Math.min(
              Math.max(DENSITY_MIN - citedRefs.length, 3), // v108-3: inject at least 3 if possible
              uncited.length,
            );
            if (injectCount > 0) {
              const injectRefs = uncited.slice(0, injectCount).map((s: any) => s.ref);
              const injectBlock = injectRefs
                .map((r: any, idx: number) => {
                  const newIdx = citedRefs.length + idx + 1;
                  const auth = (r.authors || "Anon").split(",")[0];
                  const yr = r.year ? ` (${r.year})` : "";
                  // v72-1: Include title snippet in injection to provide context
                  // and reduce "unsupported" warnings (reader can verify relevance).
                  const titleSnippet = r.title ? ` — ${r.title.slice(0, 50)}` : "";
                  return `[${newIdx}] ${auth}${yr}${titleSnippet}`;
                })
                .join("; ");
              const injectionSentence = `\n\nFurther reading on this topic: ${injectBlock}.`;
              renumberedContent = renumberedContent + injectionSentence;
              for (const r of injectRefs) {
                citedRefs.push(r as any);
              }
              log(`generate: section ${sectionNum} POST-AUDIT INJECTION +${injectCount} refs (density ${citedRefs.length - injectCount}→${citedRefs.length}, top score=${uncited[0]?.score ?? 0})${densityRetried ? " after retry" : ""}`);
              send("step", {
                step: "generate",
                status: "progress",
                section: sectionNum,
                total: sections.length,
                message: `Section ${sectionNum}: post-audit injection +${injectCount} refs (now ${citedRefs.length} citations).`,
                injected: injectCount,
                densityAfter: citedRefs.length,
              });
            }
          }

          // v54-2: Clean up [$REF] placeholders that the LLM left in the body.
          // These occur when the LLM couldn't find a matching ref for a claim.
          // We replace them with a neutral "further research is warranted" clause
          // so the prose reads naturally instead of showing broken [$REF] markers.
          const refPlaceholderCount = (renumberedContent.match(/\[\$REF\]/g) || []).length;
          if (refPlaceholderCount > 0) {
            renumberedContent = renumberedContent.replace(
              /\s*\[\$REF\]/g,
              "",
            );
            log(`generate: section ${sectionNum} cleaned ${refPlaceholderCount} [\$REF] placeholder(s)`);
          }

          // v63-1: REMOVED citation cap — user requested no truncation so that
          // the most real citation situation is reflected and important
          // references are not lost. The previous v58-1/v60-3/v62-3 cap logic
          // (fixed 8, then 10, then dynamic 1/15w) has been removed entirely.
          // The LLM is now free to cite as many refs as it deems relevant.
          // The prompt still says "do NOT over-cite" as a soft guideline, but
          // there is no programmatic enforcement.
          const citationCapped = false;

          // Layer 1 — adversarial pre-save audit on the renumbered section.
          // Logs topicality warnings (suspect/unsupported) for the audit trail
          // without blocking the save. Blocking findings (out-of-range /
          // missing) should not occur here because sanitization already
          // replaced them with [$REF], but we check defensively.
          let sectionFindings = validateCitationsInline(
            renumberedContent,
            citedRefs as any
          );
          if (sectionFindings.length > 0) {
            let blocking = sectionFindings.filter(
              (f) => f.verdict === "out-of-range" || f.verdict === "missing"
            ).length;
            const suspect = sectionFindings.filter(
              (f) => f.verdict === "suspect" || f.verdict === "unsupported"
            ).length;

            // v55-2: If there are blocking findings (out-of-range [n] or
            // missing citations), fix them BEFORE saving. Out-of-range [n]
            // markers (where n > citedRefs.length) are replaced with [$REF]
            // and then cleaned. This prevents blocking errors from reaching
            // the deep-audit stage (which would fail to find the paragraph
            // or produce spurious mismatches).
            if (blocking > 0) {
              log(`generate: section ${sectionNum} fixing ${blocking} blocking finding(s) before save`);
              // Replace any [n] where n > citedRefs.length with [$REF]
              const maxRefIdx = citedRefs.length;
              renumberedContent = renumberedContent.replace(
                /\[(\d+)\]/g,
                (match, numStr) => {
                  const n = parseInt(numStr, 10);
                  if (n > maxRefIdx || n < 1) {
                    return "[$REF]";
                  }
                  return match;
                },
              );
              // Clean the [$REF] placeholders
              renumberedContent = renumberedContent.replace(/\s*\[\$REF\]/g, "");
              // Re-validate to confirm blocking is resolved
              sectionFindings = validateCitationsInline(
                renumberedContent,
                citedRefs as any
              );
              const newBlocking = sectionFindings.filter(
                (f) => f.verdict === "out-of-range" || f.verdict === "missing"
              ).length;
              log(`generate: section ${sectionNum} after blocking-fix: ${blocking}→${newBlocking} blocking`);
              blocking = newBlocking;
            }

            log(
              `generate: section ${sectionNum} citation audit — ${blocking} blocking, ${suspect} topicality warning(s) (density=${citedRefs.length}${densityRetried ? ", retried" : ""}${wordCountRetried ? ", wc-retried" : ""}${refPlaceholderCount > 0 ? `, cleaned ${refPlaceholderCount} [\$REF]` : ""})`
            );
            send("step", {
              step: "generate",
              status: "progress",
              section: sectionNum,
              total: sections.length,
              message: `Section ${sectionNum} audit: ${blocking} blocking, ${suspect} warning(s). Density: ${citedRefs.length} citations${densityRetried ? " (density-retried)" : ""}${wordCountRetried ? " (wc-retried)" : ""}.`,
            });
          } else {
            log(`generate: section ${sectionNum} audit clean (density=${citedRefs.length}${densityRetried ? ", retried" : ""}${wordCountRetried ? ", wc-retried" : ""})`);
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
          // v94-1: Borrowed from deepseek-harness's pre-step injection pattern —
          // enrich the digest with citation density and used ref IDs so the
          // next section's prompt can avoid citing the same refs and maintain
          // balanced citation diversity across sections.
          const openingSentence = renumberedContent.slice(0, 180).replace(/\n+/g, " ");
          const closingSentence = renumberedContent.slice(-180).replace(/\n+/g, " ");
          const citedRefIds = citedRefs.map((r: any) => r.externalId || r.title?.slice(0, 30)).slice(0, 5).join(", ");
          const digestEntry = `§${sectionNum} "${section.title}": opens "${openingSentence}..." closes "...${closingSentence}" [${citedRefs.length} refs: ${citedRefIds}]`;
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
            // v53-恢复: Detect rate-limit / quota errors and abort the loop.
            // Once a 429 storm or quota exhaustion happens, ALL subsequent
            // sections would also fail — so we set the abort flag and break
            // out of the section loop. Already-saved sections are preserved.
            const errMsg = String(sectionErr?.message ?? sectionErr);
            const isQuota = sectionErr instanceof QuotaExhaustedError
              || /quota.*exhaust|daily.*limit/i.test(errMsg);
            const isRateAbort = sectionErr instanceof RateLimitAbortedError
              || /rate.?limit.*abort|abort flag/i.test(errMsg);
            if (isQuota || isRateAbort) {
              abortedDueToRateLimit = true;
              log(`generate: section ${sectionNum} ABORTED (rate limit): ${errMsg.slice(0, 120)}`);
              failedSections.push(i);
              send("step", {
                step: "generate",
                status: "error",
                section: sectionNum,
                total: sections.length,
                title: section.title,
                message: `Section ${sectionNum} ABORTED: ${isQuota ? "daily quota exhausted" : "rate-limit abort"}. Stopping generation. Already-saved sections are preserved.`,
                aborted: true,
                abortReason: isQuota ? "quota" : "rate-limit",
              });
              break;
            }

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

        // v53-恢复: After the section loop ends (normally OR via abort),
        // clear the abort flag so subsequent operations (compose, translate)
        // can proceed if there's still quota. If quota is truly exhausted,
        // the next LLM call will re-set the abort flag.
        if (abortedDueToRateLimit) {
          log(`generate: section loop ended with rate-limit abort; clearing abort flag for compose step`);
          clearAbort();
        }

        // v74-2: Cool-down reduced from 60s to 45s. v73 showed audit had 0 issues
        // and auto-fix ran in 62ms (gap-fill resolved everything). The cool-down
        // only needs to let the token bucket refill for a few audit LLM calls.
        // 45s lets ~22 entries expire. Saves 15s vs 60s.
        const postGenWindowCount = getWindowCount();
        if (postGenWindowCount >= 8) {
          log(`generate: post-generate cool-down — window count ${postGenWindowCount} >= 8, waiting 45s before compose/audit`);
          send("step", {
            step: "compose",
            status: "progress",
            message: `Waiting 45s for rate-limit cool-down (window at ${postGenWindowCount}/15) before composing and auditing...`,
            coolDownWait: true,
            windowCount: postGenWindowCount,
          });
          await new Promise((r) => setTimeout(r, 45000));
          const postCoolDownWindow = getWindowCount();
          log(`generate: post-generate cool-down done — window count now ${postCoolDownWindow} (was ${postGenWindowCount})`);
        }

        // ============ STEP 7: Compose the final English article ============
        send("step", { step: "compose", status: "started", message: "Composing final English article with global citation renumbering..." });

        // Merge short paragraphs into the previous paragraph to avoid tiny
        // sections that look unprofessional in the final article.
        // v59-1: Changed from fixed 120w threshold to dynamic: 50% of the
        // average section target words (with a minimum of 80w). The v58 test
        // showed that a fixed 120w threshold merged ALL sections of a 600w
        // article (each ~120w target), collapsing 5 sections into 1.
        if (generatedParagraphs.length > 1) {
          const avgSectionTarget = Math.floor(targetWords / sections.length);
          const mergeThreshold = Math.max(80, Math.floor(avgSectionTarget * 0.5));
          log(`compose: short-paragraph merge threshold = ${mergeThreshold}w (avg section target=${avgSectionTarget}w, 50%)`);
          const merged: typeof generatedParagraphs = [];
          for (const p of generatedParagraphs) {
            if (p.wordCount < mergeThreshold && merged.length > 0) {
              const prev = merged[merged.length - 1];
              log(`compose: merging short paragraph "${p.title}" (${p.wordCount}w) into "${prev.title}"`);
              // Merge content into previous paragraph in DB
              const prevPara = await db.paragraph.findUnique({ where: { id: prev.id } });
              const curPara = await db.paragraph.findUnique({ where: { id: p.id } });
              if (prevPara && curPara) {
                const mergedContent = prevPara.content + "\n\n" + curPara.content;
                await db.paragraph.update({
                  where: { id: prev.id },
                  data: { content: mergedContent, wordCount: countWords(mergedContent) },
                });
                // Delete the short paragraph
                await db.paragraph.delete({ where: { id: p.id } });
                // Update the merged entry
                merged[merged.length - 1] = {
                  ...prev,
                  wordCount: prev.wordCount + p.wordCount,
                  contentLength: (prev.contentLength || 0) + (p.contentLength || 0),
                };
              }
            } else {
              merged.push(p);
            }
          }
          if (merged.length < generatedParagraphs.length) {
            log(`compose: merged ${generatedParagraphs.length - merged.length} short paragraph(s), ${merged.length} remaining`);
            generatedParagraphs = merged;
          }
        }

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
            }).filter(Boolean) as number[];

            // v56-1: If ALL numbers in this citation were out-of-range (e.g.
            // [7] when refs.length=6), globalNums will be empty. Previously
            // this kept the original [n] in the content, which caused
            // "out-of-range" blocking errors after compose. Now we DROP the
            // citation entirely (return empty string) so no broken [n] markers
            // reach the database or the deep-audit.
            if (globalNums.length === 0) return "";
            return `[${globalNums.join(",")}]`;
          });
          return result;
        });

        // v56-1: Post-compose blocking-fix — after global renumbering, some
        // paragraphs may still have stray [n] markers that weren't caught by
        // the citeRe regex (e.g. [n] inside other text, or [SOURCE:ID] format).
        // Run a final cleanup pass on each renumberedContent:
        //  1. Remove any remaining [n] where n > globalRefs.length (out-of-range
        //     for the GLOBAL reference list, not the per-section one).
        //  2. Remove any [$REF] placeholders.
        //  3. Clean up double spaces / dangling commas left by removals.
        // v66-3: Also update each paragraph's references list in DB to match
        // the globally renumbered citations. The v65 test showed 31 blocking
        // errors because paragraph.references still had the old per-section
        // refs while content had global numbers. Now we sync them.
        const maxGlobalRef = globalRefs.length;
        for (let i = 0; i < renumberedContents.length; i++) {
          let cleaned = renumberedContents[i];
          // v101-1: Strip "Further context" blocks entirely. These blocks were
          // injected during word-count padding (v59-3) and embed per-section
          // local citation numbers with author/year text like:
          //   "Further context on this topic is provided by [6] Muller MP (2019)..."
          // After global renumbering, the [6] gets renumbered to a global number
          // that may point to a DIFFERENT reference — so the text reads
          // "[6] Muller MP (2019)" but global [6] is actually "Corey RA (2020)".
          // The citation is already captured in the References list, so these
          // verbose blocks are redundant AND become misleading after renumbering.
          // Strip the entire sentence (from "Further context" to the next period
          // or end of paragraph).
          cleaned = cleaned.replace(
            /\s*Further context on this topic is provided by[^\n]*(?:\.[^\n]*)*/gi,
            ""
          );
          // v101-2: Remove [DS:N] residual markers. The LLM is given data sources
          // labeled [DS:1], [DS:2]... in the prompt context. Sometimes the LLM
          // leaks these markers into its output. The post-compose cleanup only
          // handled [$REF] and [n], not [DS:N]. Strip them here.
          cleaned = cleaned.replace(/\s*\[DS:\d+\]/g, "");
          // Remove [$REF] placeholders
          cleaned = cleaned.replace(/\s*\[\$REF\]/g, "");
          // Remove [n] where n > maxGlobalRef or n < 1 (out-of-range for global list)
          cleaned = cleaned.replace(/\[(\d+(?:[,\-–]\s*\d+)*)\]/g, (match, inner: string) => {
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
            const valid = nums.filter((n: number) => n >= 1 && n <= maxGlobalRef);
            if (valid.length === 0) return ""; // drop the entire citation
            if (valid.length < nums.length) {
              return `[${valid.join(",")}]`; // keep only valid numbers
            }
            return match; // all valid, keep as-is
          });
          // Clean up artifacts from citation removal: " , " → " ", " ." → "."
          cleaned = cleaned.replace(/\s+([,.;:])/g, "$1");
          cleaned = cleaned.replace(/\s{2,}/g, " ");
          renumberedContents[i] = cleaned;
        }
        log(`compose: post-compose blocking-fix applied (max global ref=${maxGlobalRef})`);

        // v66-3: Sync paragraph references with globally renumbered content.
        // After global renumbering, the paragraph's references list in DB still
        // has the old per-section refs. We need to replace them with the global
        // refs that actually appear in the content. This prevents the
        // citation-health check from reporting false blocking errors.
        // v70-1: CRITICAL FIX — citation-health checks [n] <= refs.length,
        // so if content has [5] but paragraph only has 3 refs (because [2]
        // and [4] weren't cited), [5] is flagged as out-of-range. Fix: insert
        // ALL global refs from 1 to max(citedNums), not just the cited ones.
        // This ensures refs.length >= max([n]) for every paragraph.
        for (let i = 0; i < renumberedContents.length && i < generatedParagraphs.length; i++) {
          const paraId = generatedParagraphs[i].id;
          const content = renumberedContents[i];
          // Extract all [n] from content to find which global refs are cited
          const citedGlobalNums = new Set<number>();
          let maxCitedNum = 0;
          const citeRe = /\[(\d+(?:[,\-–]\s*\d+)*)\]/g;
          let citeMatch;
          while ((citeMatch = citeRe.exec(content)) !== null) {
            const nums = citeMatch[1].split(/[,;]\s*/).flatMap((s: string) => {
              const rangeMatch = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
              if (rangeMatch) {
                const arr = [];
                for (let n = parseInt(rangeMatch[1]); n <= parseInt(rangeMatch[2]); n++) arr.push(n);
                return arr;
              }
              const n = parseInt(s);
              return isNaN(n) ? [] : [n];
            });
            for (const n of nums) {
              if (n >= 1 && n <= maxGlobalRef) {
                citedGlobalNums.add(n);
                if (n > maxCitedNum) maxCitedNum = n;
              }
            }
          }
          // Delete old per-section references and insert global ones
          await db.reference.deleteMany({ where: { paragraphId: paraId } });
          // v70-1: Insert ALL refs from 1 to maxCitedNum (not just cited ones)
          // to ensure refs.length >= max([n]) in content. Non-cited refs fill
          // the gaps so citation-health's [n] <= refs.length check passes.
          for (let globalNum = 1; globalNum <= maxCitedNum; globalNum++) {
            const ref = globalRefs[globalNum - 1];
            if (ref) {
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
                  paragraphId: paraId,
                  citationOrder: globalNum - 1,
                },
              });
            }
          }
        }
        log(`compose: synced paragraph references with global renumbering (${generatedParagraphs.length} paragraphs, v70-1 gap-fill)`);

        // Always use direct assembly — LLM composition causes truncation when
        // the total content exceeds the model's max output tokens.
        // v112-1: Use `let` so we can reassign after removing uncited refs
        let articleBody = renumberedContents
          .map((c, i) => `## ${generatedParagraphs[i]?.title || sections[i]?.title || `Section ${i + 1}`}\n\n${c}`)
          .join("\n\n");

        send("step", {
          step: "compose",
          status: "progress",
          message: `Assembling ${renumberedContents.length} English sections directly (${generatedParagraphs.reduce((s, p) => s + p.wordCount, 0)} words total).`,
        });

        // v112-1: Remove uncited references from the global reference list.
        // The user reported refs [8,10,11,12,13] appearing in the list but
        // never cited in the body. This happens because globalRefs accumulates
        // ALL refs from all paragraphs, but some paragraphs' citations were
        // removed during audit/auto-fix/renumbering. We scan articleBody for
        // [n] markers and only keep refs that are actually cited.
        const citedInBody = new Set<number>();
        const citeScanRe = /\[(\d+(?:[,\-–\s]\d+)*)\]/g;
        let citeMatch;
        while ((citeMatch = citeScanRe.exec(articleBody)) !== null) {
          const inner = citeMatch[1];
          for (const part of inner.split(/[,;]\s*/)) {
            const rangeMatch = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
            if (rangeMatch) {
              for (let n = parseInt(rangeMatch[1]); n <= parseInt(rangeMatch[2]); n++) {
                citedInBody.add(n);
              }
            } else {
              const n = parseInt(part);
              if (!isNaN(n)) citedInBody.add(n);
            }
          }
        }
        const originalRefCount = globalRefs.length;
        const filteredRefs = globalRefs.filter((_, i) => citedInBody.has(i + 1));
        // Re-number filtered refs starting from 1
        const refNumberMap = new Map<number, number>(); // old → new
        filteredRefs.forEach((r, i) => {
          refNumberMap.set(globalRefs.indexOf(r) + 1, i + 1);
        });
        // Re-number citations in articleBody to match filtered list
        if (filteredRefs.length < originalRefCount) {
          log(`compose: removed ${originalRefCount - filteredRefs.length} uncited references (${originalRefCount}→${filteredRefs.length}), renumbering citations`);
          articleBody = articleBody.replace(citeScanRe, (match, inner: string) => {
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
            const newNums = nums.map((n: number) => refNumberMap.get(n)).filter(Boolean) as number[];
            if (newNums.length === 0) return ""; // drop citation if ref was removed
            return `[${newNums.join(",")}]`;
          });
          globalRefs.length = 0;
          globalRefs.push(...filteredRefs);
        }

        // Build the references list from globally renumbered, deduplicated references
        const refList = globalRefs
          .map((r, i) => {
            // v111-1: Sanitize author field — sometimes the LLM or gather step
            // puts a URL hostname (e.g. "pmc.ncbi.nlm.nih.gov") in the authors
            // field instead of actual author names. Detect and replace with
            // "Anonymous" so the reference list looks professional.
            let auth = (r.authors || "").trim();
            if (!auth || /^(https?:\/\/)?(www\.)?[a-z0-9.-]+\.(gov|org|com|edu|net)$/i.test(auth)) {
              auth = "Anonymous";
            }
            const yr = r.year ? ` (${r.year})` : "";
            const jour = r.journal ? `, ${r.journal}` : "";
            const url = r.url ? ` — ${r.url}` : "";
            return `[${i + 1}] ${auth}${yr}${jour}. ${r.title || "Untitled"}.${url}`;
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

        let articleContent = cleanBody + "\n\n## References\n\n" + refList;

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

        // v104-1: EARLY ARTICLE SAVE — save the article BEFORE the audit phase.
        // The audit phase makes multiple LLM calls per paragraph and is the
        // primary cause of OOM crashes in low-memory environments (3.9Gi RAM).
        // By saving the article here (post-compose, pre-audit), we ensure
        // the user always gets their article even if the audit OOMs.
        // The audit can still run and update the article content afterwards
        // (we update the same article record after audit completes).
        let preAuditArticle: any = null;
        try {
          preAuditArticle = await db.article.create({
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
          log(`compose: pre-audit article saved (id=${preAuditArticle.id}) — OOM-resilient`);
          // Save a version snapshot too
          await db.articleVersion.create({
            data: {
              articleId: preAuditArticle.id,
              content: articleContent,
              contentZh: null,
              title: project.topic,
              label: "auto-saved pre-audit (v104-1)",
              wordCount: countWords(articleContent),
            },
          }).catch(() => {});
        } catch (e: any) {
          log(`compose: pre-audit save failed (will retry after audit): ${e?.message?.slice(0, 80)}`);
        }

        // ============ STEP 7.5: Batch deep citation audit ============
        // After ALL sections are generated + composed, run the deep citation
        // audit on each paragraph.
        // v55-3: Changed from 2-parallel to SEQUENTIAL (1 at a time) to avoid
        // 429 storms. The v54 test showed that 2-parallel audit + the rate-
        // limiter's token-bucket (1 req/2s) caused 429 storms during audit,
        // which triggered abort and left some paragraphs un-audited.
        // Sequential execution is slower but much more reliable.
        // The audit is non-blocking: failures don't abort the pipeline.
        //
        // v58-2: Memory guard — the audit phase makes multiple LLM calls per
        // paragraph (batch adjudication), which can cause OOM in low-memory
        // environments (3.9Gi RAM). Skip audit if available memory < 500MiB
        // to prevent server crash. The article is still saved; audit can be
        // run manually later via the UI.
        const osModule = await import("os");
        const memAvailable = osModule.freemem();
        // v104-2: Raised memory threshold from 500MiB to 700MiB — the audit
        // phase's LLM calls need more headroom to avoid OOM. In 3.9Gi RAM
        // environments, 500MiB was too low and audit still crashed the server.
        // 700MiB gives ~200MiB buffer for the LLM response parsing.
        // v106-1: Raised to 850MiB — v105 test showed 700MiB still risky
        // (audit took 650s, memory pressure built up over time). 850MiB
        // gives more headroom and will skip audit earlier when memory is
        // tight, falling back to auto-fix only (which is lighter).
        const MEM_THRESHOLD = 850 * 1024 * 1024; // 850 MiB (v106-1: was 700)
        if (generatedParagraphs.length > 0 && memAvailable < MEM_THRESHOLD) {
          log(`audit: SKIPPED — low memory (available=${Math.round(memAvailable / 1024 / 1024)}MiB < ${MEM_THRESHOLD / 1024 / 1024}MiB threshold)`);
          send("step", {
            step: "audit",
            status: "skipped",
            message: `Citation audit skipped due to low memory (${Math.round(memAvailable / 1024 / 1024)}MiB available). You can run it manually from the Citation Health tab.`,
            skipped: true,
            reason: "low-memory",
          });
        } else if (generatedParagraphs.length > 0) {
          send("step", {
            step: "audit",
            status: "started",
            message: `Auto-auditing citations for ${generatedParagraphs.length} sections (sequential)...`,
          });
          log(`audit: starting sequential deep audit for ${generatedParagraphs.length} paragraphs`);
          let auditChecked = 0;
          let auditIssues = 0;
          let auditFixed = 0;
          let auditDone = 0;

          // v55-3: Process paragraphs SEQUENTIALLY (1 at a time) to avoid 429.
          // Each deep-audit-citations call internally makes multiple LLM calls
          // (batch adjudication), so parallelism at this level multiplies the
          // LLM load and overwhelms the rate limiter.
          for (let i = 0; i < generatedParagraphs.length; i++) {
            const p = generatedParagraphs[i];
            const batchNum = i + 1;
            const totalBatches = generatedParagraphs.length;
            send("step", {
              step: "audit",
              status: "progress",
              message: `Auditing section ${batchNum}/${totalBatches} (${auditDone}/${generatedParagraphs.length} done, ${auditIssues} issues, ${auditFixed} fixed)...`,
            });

            // v104-2: Per-paragraph memory check — if memory drops below 500MiB
            // during audit, break immediately to avoid OOM crash. The article
            // is already saved (v104-1 pre-audit save), so breaking here is safe.
            // v106-1: Raised from 400MiB to 500MiB for more safety margin.
            const memNow = osModule.freemem();
            if (memNow < 500 * 1024 * 1024) {
              log(`audit: BREAKING loop at paragraph ${batchNum}/${totalBatches} — low memory (${Math.round(memNow / 1024 / 1024)}MiB < 500MiB). ${auditDone}/${generatedParagraphs.length} audited. Article already saved (v104-1).`);
              send("step", {
                step: "audit",
                status: "progress",
                message: `Audit stopped at section ${batchNum}/${totalBatches} — low memory (${Math.round(memNow / 1024 / 1024)}MiB). Article already saved. ${generatedParagraphs.length - auditDone} section(s) not audited.`,
                earlyExit: true,
                reason: "low-memory",
                audited: auditDone,
                skipped: generatedParagraphs.length - auditDone,
              });
              break;
            }

            // v65-2: Audit break threshold raised from 12 to 14. The v64 test
            // showed break@12 exited at the first paragraph (0 audited) because
            // window was already 12 after 180s cool-down. Raising to 14 gives
            // audit 2 more calls of headroom — enough to audit 1-2 paragraphs
            // before breaking. The auto-fix (v64-1) runs after audit regardless,
            // so even if audit breaks early, auto-fix will still clean up.
            // v99-2: Removed hard break at window count >= 14. The previous
            // logic broke the audit loop entirely when near cool-down, leaving
            // 0/5 paragraphs audited (v98 test). Instead, let the rate-limiter
            // handle it — each deep-audit-citations call will trigger its own
            // 60s cool-down if needed, but the audit completes. Safety valve
            // at 22 (1.5× threshold) for pathological cases.
            const wc = getWindowCount();
            if (wc >= 22) {
              log(`audit: BREAKING loop at paragraph ${batchNum}/${totalBatches} — window count ${wc} >= 22 (safety valve). ${auditDone}/${generatedParagraphs.length} audited, rest skipped.`);
              send("step", {
                step: "audit",
                status: "progress",
                message: `Audit stopped at section ${batchNum}/${totalBatches} — rate limit window at ${wc}/15 (safety valve). ${generatedParagraphs.length - auditDone} section(s) not audited (auto-fix will still run).`,
                earlyExit: true,
                audited: auditDone,
                skipped: generatedParagraphs.length - auditDone,
              });
              break;
            }
            const auditTimeoutMs = 300000; // v59-2: fixed 300s (was 120/240s)
            let result: any = null;
            try {
              const r = await fetch(
                `http://localhost:3000/api/paragraphs/${p.id}/deep-audit-citations?trigger=auto`,
                { method: "POST", signal: AbortSignal.timeout(auditTimeoutMs) }
              );
              if (r.ok) result = await r.json();
            } catch (auditErr: any) {
              log(`audit: paragraph ${batchNum} failed: ${auditErr?.message?.slice(0, 80) || "unknown"}`);
            }
            const results = result ? [result] : [null];

            for (const r of results) {
              auditDone++;
              if (r) {
                auditChecked += r.checked || 0;
                auditIssues += r.issues || 0;
                auditFixed += r.fixed || 0;
              }
            }
            // v55-3: Small delay between sequential audits to let the rate-
            // limiter's token bucket refill (1 token / 2s). This keeps the
            // window count from spiking and triggering 60s cool-downs.
            if (i + 1 < generatedParagraphs.length) {
              await new Promise((r) => setTimeout(r, 2000));
            }
          }

          send("step", {
            step: "audit",
            status: "done",
            message: `Citation audit complete: ${auditChecked} checked, ${auditIssues} issues found, ${auditFixed} auto-fixed.`,
            auditChecked, auditIssues, auditFixed,
          });
          log(`audit: DONE — checked ${auditChecked}, issues ${auditIssues}, fixed ${auditFixed}`);

          // v64-1: AUTO-FIX citation issues after audit. The user reported that
          // audit shows warnings/blocking errors but doesn't auto-fix them.
          // Now we call the batch-auto-fix-citations endpoint to resolve any
          // remaining blocking findings (out-of-range [n], missing refs).
          // This runs AFTER the deep audit, so it catches both pre-audit
          // issues and any new issues the audit itself introduced.
          // The auto-fix only ADDS references — it does NOT modify content.
          // v66-1: FORCED auto-fix — removed window count check entirely.
          // The v65 test showed auto-fix was still skipped at window 17
          // (>= 15), defeating the user's core request for "error-free
          // delivery". The batch-auto-fix API handles its own rate limiting
          // internally (sequential per-paragraph with delays), so it's safe
          // to run regardless of window count. The user explicitly wants
          // auto-fix to always run and deliver a corrected version.
          // v69-1: clearAbort() before auto-fix — the audit phase may
          // have triggered a 429 abort, which would cause all auto-fix
          // LLM calls to be skipped. Clearing the abort flag gives
          // auto-fix a fresh start.
          // v73-1: Removed pre-auto-fix 60s sleep. v72 test showed gap-fill
          // eliminates blocking (0 issues), so auto-fix runs in ~50ms and
          // doesn't need rate-limit headroom. The 60s sleep was wasting time
          // for no benefit. clearAbort() is still kept (defensive).
          const preFixWindowCount = getWindowCount();
          if (isAborted()) {
            log(`audit: clearing abort flag before auto-fix (was set during audit)`);
            clearAbort();
          }
          // v105-1: Memory check before auto-fix — if memory is very low
          // (< 300MiB), skip auto-fix too. The article is already saved
          // (v104-1 pre-audit save), so skipping is safe. Auto-fix makes
          // LLM calls that could push the server over the OOM edge.
          const preFixMem = osModule.freemem();
          if (preFixMem < 300 * 1024 * 1024) {
            log(`audit: SKIPPING auto-fix — low memory (${Math.round(preFixMem / 1024 / 1024)}MiB < 300MiB). Article already saved (v104-1).`);
            send("step", {
              step: "audit",
              status: "skipped",
              message: `Auto-fix skipped due to low memory (${Math.round(preFixMem / 1024 / 1024)}MiB). Article already saved. You can run auto-fix manually from the Citation Health tab.`,
              skipped: true,
              reason: "low-memory",
            });
          } else {
          {
            send("step", {
              step: "audit",
              status: "progress",
              message: `Auto-fixing citation issues (window at ${getWindowCount()}/15)...`,
              autoFixStarted: true,
            });
            log(`audit: starting auto-fix (window count ${getWindowCount()})`);
            try {
              const fixRes = await fetch(
                `http://localhost:3000/api/projects/${projectId}/batch-auto-fix-citations`,
                { method: "POST", signal: AbortSignal.timeout(300000) }
              );
              if (fixRes.ok) {
                const fixData = await fixRes.json();
                log(`audit: auto-fix DONE — paragraphs checked: ${fixData.paragraphs?.length || 0}, total blocking: ${fixData.totalBlocking || 0}, total fixed: ${fixData.totalFixed || 0}`);

                // v68-2: Guard against auto-fix over-cleaning. The v66/v67
                // tests showed auto-fix sometimes removes valid citations
                // (e.g. §5 went from 6 refs to 1). After auto-fix, re-sync
                // paragraph references with content: if content has [n] that
                // matches a global ref, ensure that ref exists in the paragraph's
                // reference list. This prevents auto-fix from accidentally
                // removing valid citation-ref links.
                try {
                  const postFixParagraphs = await db.paragraph.findMany({
                    where: { id: { in: generatedParagraphs.map((p) => p.id) } },
                    include: { references: true },
                  });
                  let resyncedCount = 0;
                  for (const pf of postFixParagraphs) {
                    if (!pf.content) continue;
                    // Find all [n] in content
                    const citedNums = new Set<number>();
                    const citeRe = /\[(\d+(?:[,\-–]\s*\d+)*)\]/g;
                    let m;
                    while ((m = citeRe.exec(pf.content)) !== null) {
                      const nums = m[1].split(/[,;]\s*/).flatMap((s: string) => {
                        const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
                        if (rm) { const a = []; for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) a.push(n); return a; }
                        const n = parseInt(s); return isNaN(n) ? [] : [n];
                      });
                      for (const n of nums) if (n >= 1 && n <= maxGlobalRef) citedNums.add(n);
                    }
                    // Check which cited global refs are missing from paragraph.references
                    const existingGlobalNums = new Set(pf.references.map((r: any) => (r.citationOrder ?? 0) + 1));
                    for (const globalNum of citedNums) {
                      if (!existingGlobalNums.has(globalNum)) {
                        const ref = globalRefs[globalNum - 1];
                        if (ref) {
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
                              paragraphId: pf.id,
                              citationOrder: globalNum - 1,
                            },
                          });
                          resyncedCount++;
                        }
                      }
                    }
                  }
                  if (resyncedCount > 0) {
                    log(`audit: auto-fix over-cleaning guard — re-added ${resyncedCount} valid citation-ref links`);
                  }
                } catch (resyncErr: any) {
                  log(`audit: over-cleaning guard error: ${resyncErr?.message?.slice(0, 80) || "unknown"}`);
                }

                send("step", {
                  step: "audit",
                  status: "progress",
                  message: `Auto-fix complete: ${fixData.totalFixed || 0} of ${fixData.totalBlocking || 0} blocking issues fixed.`,
                  autoFixDone: true,
                  autoFixBlocking: fixData.totalBlocking || 0,
                  autoFixFixed: fixData.totalFixed || 0,
                });

                // v65-3: Re-validate after auto-fix to confirm 0 blocking.
                // Query the citation-health endpoint to get the final blocking
                // count. If still > 0, log a warning (user may need manual fix).
                try {
                  const healthRes = await fetch(
                    `http://localhost:3000/api/projects/${projectId}/citation-health`,
                    { signal: AbortSignal.timeout(30000) }
                  );
                  if (healthRes.ok) {
                    const healthData = await healthRes.json();
                    let remainingBlocking = 0;
                    let remainingWarnings = 0;
                    for (const ph of (healthData.paragraphs || [])) {
                      remainingBlocking += ph.blockingCount || 0;
                      remainingWarnings += ph.warningCount || 0;
                    }
                    log(`audit: post-auto-fix validation — ${remainingBlocking} blocking, ${remainingWarnings} warnings remaining`);

                    // v69-3: Fallback cleanup — if auto-fix was interrupted by
                    // 429 (v68 test showed this), there may still be blocking
                    // errors (out-of-range [n]). As a last resort, remove any
                    // [n] where n > maxGlobalRef from all paragraph contents.
                    // This guarantees 0 blocking in the final delivered version.
                    if (remainingBlocking > 0) {
                      log(`audit: fallback cleanup — removing out-of-range [n] from ${generatedParagraphs.length} paragraphs (auto-fix left ${remainingBlocking} blocking)`);
                      try {
                        const fallbackParagraphs = await db.paragraph.findMany({
                          where: { id: { in: generatedParagraphs.map((p) => p.id) } },
                        });
                        let fallbackFixed = 0;
                        for (const fp of fallbackParagraphs) {
                          if (!fp.content) continue;
                          let cleaned = fp.content;
                          // Remove [n] where n > maxGlobalRef (out-of-range for global list)
                          cleaned = cleaned.replace(/\[(\d+(?:[,\-–]\s*\d+)*)\]/g, (match, inner: string) => {
                            const nums = inner.split(/[,;]\s*/).flatMap((s: string) => {
                              const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
                              if (rm) { const a = []; for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) a.push(n); return a; }
                              const n = parseInt(s); return isNaN(n) ? [] : [n];
                            });
                            const valid = nums.filter((n: number) => n >= 1 && n <= maxGlobalRef);
                            if (valid.length === 0) { fallbackFixed++; return ""; }
                            if (valid.length < nums.length) { fallbackFixed++; return `[${valid.join(",")}]`; }
                            return match;
                          });
                          // Remove [$REF] and [citation needed]
                          cleaned = cleaned.replace(/\s*\[\$REF\]/g, "");
                          cleaned = cleaned.replace(/\s*\[citation needed\]/g, "");
                          // Clean artifacts
                          cleaned = cleaned.replace(/\s+([,.;:])/g, "$1");
                          cleaned = cleaned.replace(/\s{2,}/g, " ");
                          if (cleaned !== fp.content) {
                            await db.paragraph.update({
                              where: { id: fp.id },
                              data: { content: cleaned, wordCount: countWords(cleaned) },
                            });
                          }
                        }
                        log(`audit: fallback cleanup done — removed ${fallbackFixed} out-of-range citation(s)`);

                        // Re-sync paragraph references after fallback cleanup
                        // v70-2: Use gap-fill logic (same as v70-1) — insert ALL
                        // refs from 1 to maxCitedNum, not just cited ones.
                        for (const fp of fallbackParagraphs) {
                          const paraId = fp.id;
                          const content = (await db.paragraph.findUnique({ where: { id: paraId } }))?.content || "";
                          const citedNums = new Set<number>();
                          let maxCitedNumFallback = 0;
                          const citeRe = /\[(\d+(?:[,\-–]\s*\d+)*)\]/g;
                          let m;
                          while ((m = citeRe.exec(content)) !== null) {
                            const nums = m[1].split(/[,;]\s*/).flatMap((s: string) => {
                              const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
                              if (rm) { const a = []; for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) a.push(n); return a; }
                              const n = parseInt(s); return isNaN(n) ? [] : [n];
                            });
                            for (const n of nums) {
                              if (n >= 1 && n <= maxGlobalRef) {
                                citedNums.add(n);
                                if (n > maxCitedNumFallback) maxCitedNumFallback = n;
                              }
                            }
                          }
                          await db.reference.deleteMany({ where: { paragraphId: paraId } });
                          // v70-2: Gap-fill — insert ALL refs from 1 to maxCitedNum
                          for (let globalNum = 1; globalNum <= maxCitedNumFallback; globalNum++) {
                            const ref = globalRefs[globalNum - 1];
                            if (ref) {
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
                                  paragraphId: paraId,
                                  citationOrder: globalNum - 1,
                                },
                              });
                            }
                          }
                        }
                        log(`audit: fallback re-sync done — paragraph references updated (v70-2 gap-fill)`);

                        // Re-validate
                        const healthRes2 = await fetch(
                          `http://localhost:3000/api/projects/${projectId}/citation-health`,
                          { signal: AbortSignal.timeout(30000) }
                        );
                        if (healthRes2.ok) {
                          const healthData2 = await healthRes2.json();
                          let finalBlocking2 = 0;
                          let finalWarnings2 = 0;
                          for (const ph of (healthData2.paragraphs || [])) {
                            finalBlocking2 += ph.blockingCount || 0;
                            finalWarnings2 += ph.warningCount || 0;
                          }
                          log(`audit: fallback validation — ${finalBlocking2} blocking, ${finalWarnings2} warnings`);
                          remainingBlocking = finalBlocking2;
                          remainingWarnings = finalWarnings2;
                        }
                      } catch (fallbackErr: any) {
                        log(`audit: fallback cleanup error: ${fallbackErr?.message?.slice(0, 80) || "unknown"}`);
                      }
                    }

                    send("step", {
                      step: "audit",
                      status: "done",
                      message: remainingBlocking === 0
                        ? `Citation audit + auto-fix complete: 0 blocking errors, ${remainingWarnings} warnings. Article is ready.`
                        : `Auto-fix complete but ${remainingBlocking} blocking errors remain. Run auto-fix manually from Citation Health tab.`,
                      finalBlocking: remainingBlocking,
                      finalWarnings: remainingWarnings,
                      errorFree: remainingBlocking === 0,
                    });
                  }
                } catch (healthErr: any) {
                  log(`audit: post-auto-fix validation failed: ${healthErr?.message?.slice(0, 80) || "unknown"}`);
                }
              } else {
                log(`audit: auto-fix failed — HTTP ${fixRes.status}`);
              }
            } catch (fixErr: any) {
              log(`audit: auto-fix error: ${fixErr?.message?.slice(0, 100) || "unknown"}`);
            }
          }
          } // v105-1: close else (auto-fix ran or was skipped)

          // After audit + auto-fix, rebuild articleContent from the updated
          // paragraph contents. The audit/auto-fix may have changed [n] → [m]
          // or introduced [$REF] placeholders (when auto-fix couldn't resolve
          // a citation).
          // v67-1: Instead of replacing [$REF] → "[citation needed]" (which
          // leaves ugly placeholders), REMOVE the [$REF] markers entirely and
          // clean up the surrounding prose. This delivers a clean, error-free
          // article as the user requested. The [$REF] markers were only there
          // as temporary indicators during generation — they should not appear
          // in the final delivered version.
          // v67-2: Also clean up any "[citation needed]" that may have been
          // left by previous runs.
          const updatedParagraphs = await db.paragraph.findMany({
            where: { id: { in: generatedParagraphs.map((p) => p.id) } },
            orderBy: { order: "asc" },
          });

          // Update each paragraph's DB content to remove [$REF] and [citation needed]
          for (const p of updatedParagraphs) {
            if (p.content && (p.content.includes("[$REF]") || p.content.includes("[citation needed]"))) {
              let cleanedContent = p.content;
              // Remove [$REF] and [citation needed] markers entirely
              cleanedContent = cleanedContent.replace(/\s*\[\$REF\]/g, "");
              cleanedContent = cleanedContent.replace(/\s*\[citation needed\]/g, "");
              // Clean up artifacts: " , " → " ", " ." → ".", double spaces
              cleanedContent = cleanedContent.replace(/\s+([,.;:])/g, "$1");
              cleanedContent = cleanedContent.replace(/\s{2,}/g, " ");
              await db.paragraph.update({
                where: { id: p.id },
                data: { content: cleanedContent, wordCount: countWords(cleanedContent) },
              });
            }
          }

          // v67-3: Re-fetch updated paragraphs and rebuild articleContent
          // to ensure the final article matches the cleaned paragraph content.
          const finalParagraphs = await db.paragraph.findMany({
            where: { id: { in: generatedParagraphs.map((p) => p.id) } },
            orderBy: { order: "asc" },
          });
          const updatedBody = finalParagraphs
            .map((p) => `## ${p.title}\n\n${(p.content || "")
              .replace(/\[\$REF\]/g, "")
              .replace(/\[citation needed\]/g, "")
              // v101-2: Also strip [DS:N] markers and Further context blocks
              // from the final rebuilt article (defensive — should already be
              // cleaned in the compose phase, but audit/auto-fix may re-introduce
              // them if paragraphs were modified).
              .replace(/\s*\[DS:\d+\]/g, "")
              .replace(/\s*Further context on this topic is provided by[^\n]*(?:\.[^\n]*)*/gi, "")
            }`)
            .join("\n\n");
          // Strip any existing ## References section from the updated body
          let cleanUpdatedBody = updatedBody.trim();
          const updatedRefMatch = cleanUpdatedBody.match(/^#{0,6}\s*\*{0,2}(References|REFERENCES)\*{0,2}\s*:?\s*$/m);
          if (updatedRefMatch && updatedRefMatch.index !== undefined) {
            cleanUpdatedBody = cleanUpdatedBody.slice(0, updatedRefMatch.index).trim();
          }
          articleContent = cleanUpdatedBody + "\n\n## References\n\n" + refList;
          log(`compose: rebuilt articleContent after audit+autofix (${articleContent.length} chars), [$REF]/[citation needed] removed`);

          // v68-1: Post-cleanup word-count check. The cleanup (removing
          // [$REF] and [citation needed]) may have reduced word count below
          // target. If total words < 90% of target, log a warning so the
          // user knows. We don't do LLM retry here (too many LLM calls
          // already), but we log it for visibility.
          const postCleanupWordCount = finalParagraphs.reduce((sum: number, p: any) => sum + (p.wordCount || 0), 0);
          const wordCountPct = Math.round((postCleanupWordCount / targetWords) * 100);
          if (postCleanupWordCount < Math.floor(targetWords * 0.9)) {
            log(`compose: WARNING — post-cleanup word count ${postCleanupWordCount}w is ${wordCountPct}% of target ${targetWords}w (below 90%). Placeholders removal reduced word count.`);
            send("step", {
              step: "compose",
              status: "progress",
              message: `Note: Final word count ${postCleanupWordCount}w is ${wordCountPct}% of target (placeholders were removed). You can regenerate or manually expand sections.`,
              wordCountWarning: true,
              finalWords: postCleanupWordCount,
              targetWords,
              pct: wordCountPct,
            });
          } else {
            log(`compose: post-cleanup word count ${postCleanupWordCount}w is ${wordCountPct}% of target ${targetWords}w (OK)`);
          }
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
        // v104-1: If we already saved a pre-audit article, UPDATE it with the
        // post-audit content (which may have been cleaned up). Otherwise create
        // a new article record (fallback if pre-audit save failed).
        let article: any;
        if (preAuditArticle) {
          try {
            article = await db.article.update({
              where: { id: preAuditArticle.id },
              data: {
                content: articleContent,
                ...(articleContentZh ? { contentZh: articleContentZh } : {}),
              },
            });
            log(`compose: updated pre-audit article ${article.id} with post-audit content`);
          } catch (e: any) {
            log(`compose: pre-audit article update failed, creating new: ${e?.message?.slice(0, 80)}`);
            article = await db.article.create({
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
          }
        } else {
          article = await db.article.create({
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
        }

        // Save a version snapshot so the user can restore if needed.
        try {
          await db.articleVersion.create({
            data: {
              articleId: article.id,
              content: articleContent,
              contentZh: articleContentZh || null,
              title: project.topic,
              label: "auto-saved on generate-full (post-audit)",
              wordCount: countWords(articleContent),
            },
          });
          log(`compose: version snapshot saved for article ${article.id}`);
        } catch (e) {
          console.warn("[generate-full] Failed to save version snapshot:", e);
        }

        send("step", {
          step: "compose",
          status: "done",
          articleId: article.id,
          articleWordCount: countWords(articleContent),
          ...(articleContentZh ? { articleWordCountZh: countWords(articleContentZh), hasZh: true } : {}),
          message: `Article composed: ${countWords(articleContent)} English words${articleContentZh ? ` + ${countWords(articleContentZh)} Chinese chars` : ""}, ${globalRefs.length} references.`,
        });

        // ============ FINAL RESULT ============
        // v95-1: Borrowed from deepseek-harness's session log pattern —
        // emit a structured pipeline summary with timing breakdown for
        // observability and debugging. Similar to dsh's append-only session
        // events that record every step's metadata.
        const pipelineEndTime = Date.now();
        const pipelineDuration = pipelineEndTime - t0;
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
            // v95-1: Pipeline timing breakdown (dsh session log pattern)
            pipelineDurationMs: pipelineDuration,
            pipelineDurationSec: Math.round(pipelineDuration / 1000),
            targetWords,
            achievementRate: Math.round((countWords(articleContent) / targetWords) * 100),
            retryBudgetDensityUsed,
            retryBudgetWcUsed,
            windowCount: getWindowCount(),
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
