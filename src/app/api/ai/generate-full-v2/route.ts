import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { VERIFY_BATCH_SIZE, VERIFY_REMOVE_CONFIDENCE, maxCitableRefsFor } from "@/lib/v2-config";
import { logger } from "@/lib/logger";
import { webSearch } from "@/lib/ai";
import { chatWithSession, chatWithSessionStream, clearSession } from "@/lib/llm-session";
import { queryDatabase } from "@/lib/databases";
import { countWords, sanitizeSectionContent } from "@/lib/writing";
import { generateArticleTitle } from "@/lib/article-title";
import { translateSectionTitles } from "@/lib/section-title-zh";
import {
  buildAuditReport,
  extractBodyCitations,
  splitBodyAndReferences,
} from "@/lib/citation-audit";
import {
  convertKeysToNumbers,
  keyedCitationsAreValid,
  removeCitationsAndRenumber,
} from "@/lib/citation-binding";
import {
  extractEvidenceBank,
  allocateEvidenceToSections,
  buildEvidenceContext,
  type EvidenceRefInput,
} from "@/lib/evidence-pipeline";
import {
  countBySource,
  curateReferences,
  dedupePreprintVersions,
  ensurePrimaryPaperCoverage,
  generateWebSearchQueries,
  inferFormat,
  removeCrossSectionDuplicates,
  trailingUncitedClaimWords,
  safeParseJSON,
} from "@/lib/generate-full-helpers";
import {
  preFlightQuotaCheck,
  isAborted,
  RateLimitAbortedError,
  QuotaExhaustedError,
} from "@/lib/rate-limiter";

export const runtime = "nodejs";
export const maxDuration = 1800; // 30 minutes — streaming keeps connection alive

/**
 * generate-full-v2 — Evidence-grounded article generation pipeline.
 *
 * Multi-stage architecture (deepseek-harness-inspired: analyze → allocate →
 * write, with a validation gate between every stage):
 *
 *   1. gather      — fresh multi-database + web retrieval (same as v1)
 *   2. curate      — LLM selects the most relevant citable subset
 *   3. plan        — LLM designs the section outline
 *   4. analyze     — ★ NEW: extract a structured EVIDENCE BANK (claims
 *                    pre-bound to their sources) from every curated ref
 *   5. allocate    — ★ NEW: assign references + evidence to sections
 *   6. generate    — ★ per-section writing with STRUCTURAL citation keys
 *                    ({{Rn}}) — the LLM never writes numbers, so numbering
 *                    cannot drift; a validation gate retries sections that
 *                    leak raw numeric markers
 *   7. verify      — ★ NEW: adversarial per-citation verification (does this
 *                    specific reference support this specific claim?) with
 *                    conservative removal of unsupported citations
 *   8. compose     — global renumbering + reference sync + article save
 *
 * Accuracy contract (what v2 guarantees that v1 cannot):
 *   - every [n] in the final article was produced by CODE from a {{Rn}} key
 *     that the model copied from a specific reference entry
 *   - every surviving citation survived an adversarial claim-level check
 *     against the reference's own title/abstract
 *   - paragraph reference lists are synced to global numbering (no drift)
 */

interface GenerateFullV2Body {
  projectId: string;
  journalTemplate?: string;
  language?: string;
  targetWords?: number;
  maxDbQueries?: number;
  maxWebSearchQueries?: number;
  maxTokens?: number;
  promptInstruction?: string;
}

/** Conservative removal verdict for the adversarial verify stage. */
const VERIFY_REMOVE_VERDICT = "UNSUPPORTED";
// VERIFY_BATCH_SIZE / VERIFY_REMOVE_CONFIDENCE / maxCitableRefs constants
// live in @/lib/v2-config (single source of truth for pipeline tuning).

export async function POST(req: NextRequest) {
  const body = (await req.json()) as GenerateFullV2Body;
  const projectId = body.projectId;

  if (!projectId) {
    return Response.json({ error: "Missing 'projectId'." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  // FIX (client-disconnect waste): the ReadableStream previously had no
  // cancel() handler, so when the browser closed the SSE connection the
  // pipeline kept running for up to 30 minutes — LLM calls + DB writes for
  // an audience of zero. `cancel()` flips this flag; the section loop checks
  // it at every iteration boundary and skips all remaining work.
  let clientDisconnected = false;
  const stream = new ReadableStream({
    async start(controller) {
      let isClosed = false;
      const send = (event: string, data: any) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event, ...data })}\n\n`));
        } catch {
          isClosed = true;
        }
      };
      const safeClose = () => {
        if (isClosed) return;
        isClosed = true;
        try { controller.close(); } catch {}
      };

      const t0 = Date.now();
      const slog = logger("generate-full-v2");
      const log = (msg: string) => {
        // Structured single-line JSON (grep-able by level/scope/ms); replaces
        // the old ad-hoc `[generate-full-v2] +123ms ...` format strings.
        try { slog.info(msg, { ms: Date.now() - t0 }); } catch {}
      };

      // Pipeline-wide accuracy telemetry (emitted in `complete`).
      const stats = {
        droppedKeys: 0,
        strippedNumeric: 0,
        gateRetries: 0,
        citationsChecked: 0,
        citationsRemoved: 0,
        citationsFlagged: 0,
        // round-14: citation-management hardening telemetry
        zeroCitationRetries: 0,
        trailingUncitedRetries: 0,
        preprintDuplicatesDropped: 0,
        // round-15: regression-hardening telemetry
        adjacentCitationsMerged: 0,
        coverageBackfills: [] as { signal: string; addedTitle: string; replacedTitle: string | null }[],
        // round-16: mechanical cross-section dedup telemetry
        crossSectionDuplicatesRemoved: [] as { section: number; matchedSection: number; snippet: string }[],
      };

      // Hoisted for the catch block's failure-recovery logic (try-block
      // declarations are invisible to the sibling catch scope — the same
      // class of bug that broke v1's error recovery for months).
      const generatedParagraphs: any[] = [];
      // Pre-run snapshot for crash-safe rollback (assigned in STEP 1 before
      // the force-clear deletes; read by the catch on failure).
      let snapshot: {
        paragraphs: any[];
        dataSources: any[];
        articleParagraphs: any[];
      } | null = null;
      let hadPriorWork = false;

      try {
        const project = await db.project.findUnique({ where: { id: projectId } });
        if (!project) {
          send("error", { error: "Project not found." });
          safeClose();
          return;
        }

        const targetWords = Math.min(body.targetWords || 5000, 50000);
        const journalTemplate = body.journalTemplate || "generic";
        const maxTokens = Math.max(4096, Math.min(32768, body.maxTokens ?? 16384));
        const maxDbQueries = Math.max(5, Math.min(50, body.maxDbQueries ?? 18));
        const maxWebSearchQueries = Math.max(3, Math.min(20, body.maxWebSearchQueries ?? 6));
        const promptInstruction = (body.promptInstruction || "").trim();
        // round-27: the v2 pipeline always WRITES in English (the evidence
        // bank / citation-key machinery is English-first by design), but
        // language === "both" now triggers a dedicated post-compose translate
        // stage (each section EN → 中文, citations preserved) so bilingual
        // users finally get the Chinese half of the article. Previously the
        // UI hard-forced language="English" for v2 and the Chinese half was
        // silently dropped.
        const requestedLanguage = body.language || "English";
        const isBothMode = requestedLanguage === "both";

        send("step", {
          step: "init",
          status: "done",
          message: `v2 evidence-grounded pipeline initialized. Target: ${targetWords} words${isBothMode ? ". Language: English-first, then translate to 中文" : ""}.`,
          config: {
            pipeline: "v2",
            targetWords,
            journalTemplate,
            maxDbQueries,
            maxWebSearchQueries,
            maxTokens,
            language: requestedLanguage,
            bothMode: isBothMode,
          },
        });
        log(`init: language=${requestedLanguage}, bothMode=${isBothMode}, targetWords=${targetWords}`);

        // ============ STEP 1: FORCE re-gather data sources ============
        send("step", {
          step: "gather",
          status: "started",
          message: "Clearing existing sources and re-gathering fresh data...",
        });

        // ★ CRITICAL FIX (data-loss guard): the force-clear below DELETEs all
        // paragraphs/references/dataSources of the project. If the pipeline
        // then dies before composing (LLM timeout, crash, network drop), the
        // user's prior work would be gone FOREVER with no recovery path.
        // Snapshot everything the delete removes; on fatal failure with ZERO
        // newly-generated sections, restore the snapshot (atomic semantics:
        // a failed run leaves the project exactly as it was before).
        snapshot = {
          paragraphs: await db.paragraph.findMany({
            where: { projectId },
            include: { references: true, annotations: true },
          }),
          dataSources: await db.dataSource.findMany({ where: { projectId } }),
          articleParagraphs: await db.articleParagraph.findMany({
            where: { paragraph: { projectId } },
          }),
        };
        hadPriorWork =
          snapshot.paragraphs.length > 0 || snapshot.dataSources.length > 0;
        log(`snapshot: ${snapshot.paragraphs.length} paragraphs, ${snapshot.dataSources.length} data sources (rollback safety net)`);

        await db.$transaction([
          db.annotation.deleteMany({ where: { paragraph: { projectId } } }),
          db.articleParagraph.deleteMany({ where: { paragraph: { projectId } } }),
          db.paragraph.deleteMany({ where: { projectId } }),
          db.dataSource.deleteMany({ where: { projectId } }),
          db.reference.deleteMany({ where: { projectId } }),
        ]);

        // NOTE: no clearAbort() here. The abort flag now auto-expires
        // (rate-limiter.ts ABORT_TTL_MS) so a stale abort from a previous
        // run can't poison this run, and this run can't erase an in-flight
        // sibling run's abort either.
        await clearSession(projectId);
        try {
          const { clearLLMCache } = await import("@/lib/llm-cache");
          clearLLMCache();
        } catch (cacheErr: any) {
          // Non-fatal, but no longer silent — a broken cache module would
          // otherwise silently serve stale LLM results across runs.
          log(`init: clearLLMCache failed (continuing with existing cache): ${String(cacheErr?.message ?? cacheErr).slice(0, 100)}`);
        }

        const gatherSystem =
          "You are a research data strategist. Design a COMPREHENSIVE multi-database search plan.";
        const gatherPrompt = `RESEARCH TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}
PURPOSE: Write a comprehensive review article (~${targetWords} words).

Design a focused search plan with ${Math.max(5, maxDbQueries - 4)}-${maxDbQueries} well-chosen queries (NOT more — too many causes JSON truncation).
Distribute across databases: mostly PubMed (reviews, mechanisms, diseases, methods), a few RCSB structure searches, a few UniProt gene-name searches, 1-2 NCBI gene searches.

Respond as STRICT JSON (keep it under 4000 characters):
{
  "queries": [
    { "database": "pubmed", "query": "concrete search string", "rationale": "short reason" }
  ]
}
Use lowercase database names: pubmed, uniprot, rcsb, ncbi, blast. Output JSON only.`;

        const gatherRaw = await chatWithSession(projectId, gatherPrompt, {
          system: gatherSystem,
          temperature: 0.4,
          taskType: "gather",
          maxTokens,
          metadata: { step: "gather" },
        });
        const gatherParsed = safeParseJSON(gatherRaw, { queries: [] });
        let dbQueries = (gatherParsed.queries || []).filter(
          (q: any) => q.database && q.query && ["pubmed", "uniprot", "rcsb", "ncbi", "blast"].includes(q.database)
        );
        if (dbQueries.length === 0) {
          const topicWords = project.topic.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 5);
          const topicPhrase = topicWords.join(" ");
          dbQueries = [
            { database: "pubmed", query: `${topicPhrase} review`, rationale: "fallback" },
            { database: "pubmed", query: `${topicPhrase} mechanism`, rationale: "fallback" },
            { database: "pubmed", query: `${topicPhrase} clinical`, rationale: "fallback" },
            { database: "rcsb", query: topicWords[0] || project.topic, rationale: "fallback" },
            { database: "uniprot", query: topicWords[0] || project.topic, rationale: "fallback" },
          ];
        }

        send("step", {
          step: "gather",
          status: "progress",
          message: `Executing ${dbQueries.length} database queries...`,
          queries: dbQueries.length,
        });
        log(`gather: ${dbQueries.length} queries designed`);

        // Execute non-NCBI in parallel, NCBI sequentially (rate limit)
        const ncbiQueries = dbQueries.filter((q: any) => q.database === "pubmed" || q.database === "ncbi");
        const otherQueries = dbQueries.filter((q: any) => q.database !== "pubmed" && q.database !== "ncbi");

        const runWithRetry = async (database: string, query: string) => {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              return await queryDatabase(database as any, query);
            } catch (err: any) {
              if (err?.message?.includes("HTTP 400") || attempt >= 2) throw err;
              await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
            }
          }
          throw new Error("unreachable");
        };

        const otherResults = await Promise.allSettled(
          otherQueries.map(async (q: any) => {
            const r = await runWithRetry(q.database, q.query);
            send("step", {
              step: "gather",
              status: "progress",
              message: `[${q.database}] "${q.query.slice(0, 50)}" → ${r.items?.length || 0} results`,
              resultCount: r.items?.length || 0,
            });
            return { ...r, rationale: q.query };
          })
        );

        const ncbiResults: PromiseSettledResult<any>[] = [];
        for (const q of ncbiQueries) {
          try {
            const r = await runWithRetry(q.database, q.query);
            ncbiResults.push({ status: "fulfilled", value: { ...r, rationale: q.query } });
            send("step", {
              step: "gather",
              status: "progress",
              message: `[${q.database}] "${q.query.slice(0, 50)}" → ${r.items?.length || 0} results`,
              resultCount: r.items?.length || 0,
            });
          } catch (err: any) {
            ncbiResults.push({ status: "rejected", reason: err });
          }
          await new Promise((r) => setTimeout(r, 250));
        }

        const dbItems: any[] = [];
        for (const r of [...otherResults, ...ncbiResults]) {
          if (r.status === "fulfilled") {
            for (const item of r.value.items || []) {
              dbItems.push({ ...item, queryUsed: r.value.rationale, gatherMethod: "database" });
            }
          }
        }
        log(`gather: database phase returned ${dbItems.length} items`);

        // Web search supplement
        const webSearchQueries = await generateWebSearchQueries(
          projectId, project.topic, project.field || "life sciences", targetWords, maxWebSearchQueries, maxTokens
        );
        const webItems: any[] = [];
        for (let wi = 0; wi < webSearchQueries.length; wi++) {
          try {
            const searchResults = await webSearch(webSearchQueries[wi], 10);
            for (const item of searchResults) {
              webItems.push({
                source: "web",
                externalId: item.url,
                title: item.name || item.url,
                authors: item.host_name || undefined,
                year: item.date?.slice(0, 4) || undefined,
                url: item.url,
                abstract: item.snippet,
                extra: { host: item.host_name, rank: item.rank },
                queryUsed: "web_search",
                gatherMethod: "web",
              });
            }
            send("step", {
              step: "gather",
              status: "progress",
              message: `Web search ${wi + 1}/${webSearchQueries.length}: "${webSearchQueries[wi].slice(0, 50)}" → ${searchResults.length} results`,
            });
          } catch (webErr: any) {
            // FIX (silent-catch telemetry): failed web-search queries were
            // previously invisible, making "few sources gathered" bugs
            // impossible to diagnose from the logs.
            log(`gather: web search "${webSearchQueries[wi].slice(0, 40)}" failed: ${String(webErr?.message ?? webErr).slice(0, 100)}`);
          }
          await new Promise((r) => setTimeout(r, 1000));
        }

        // Dedup + save
        const allItems = [...dbItems, ...webItems];
        const seenExternalIds = new Set<string>();
        const uniqueItems: any[] = [];
        for (const item of allItems) {
          const dedupKey = `${item.source}:${item.externalId || item.url}`;
          if (seenExternalIds.has(dedupKey)) continue;
          seenExternalIds.add(dedupKey);
          uniqueItems.push(item);
        }
        uniqueItems.sort((a, b) => {
          const score = (x: any) =>
            (x.source === "pubmed" ? 4 : 0) +
            (x.source === "rcsb" && x.extra?.hasPublication ? 3 : 0) +
            (x.source === "rcsb" ? 2 : 0) +
            (x.abstract ? 1 : 0);
          return score(b) - score(a);
        });

        const savedDataSources: any[] = [];
        const savedReferences: any[] = [];
        for (const item of uniqueItems) {
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
            const isCitable =
              item.source === "pubmed" ||
              (item.source === "rcsb" && item.extra?.hasPublication) ||
              (item.source === "web" && item.url);
            if (isCitable) {
              try {
                // FIX: RCSB entries with a linked publication must use the PMID
                // (extra.pmid) as externalId — not the PDB ID — so that the
                // reference identity (type:pubmed + externalId) matches the same
                // paper gathered directly from PubMed and dedup works correctly.
                const ref = await db.reference.create({
                  data: {
                    type: item.source === "web" ? "web" : "pubmed",
                    externalId: item.source === "rcsb"
                      ? (item.extra?.pmid || item.externalId || item.url)
                      : (item.externalId || item.url),
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
              } catch (refErr: any) {
                // FIX (silent-catch telemetry): a failed reference create
                // previously vanished silently — the final "References: N"
                // count silently diverged from what the audit expected.
                log(`gather: reference create failed for "${String(item.title).slice(0, 50)}": ${String(refErr?.message ?? refErr).slice(0, 100)}`);
              }
            }
          } catch (dsErr: any) {
            log(`gather: data source create failed for "${String(item.title).slice(0, 50)}": ${String(dsErr?.message ?? dsErr).slice(0, 100)}`);
          }
        }

        send("step", {
          step: "gather",
          status: "done",
          sourcesGathered: savedDataSources.length,
          referencesSaved: savedReferences.length,
          message: `Gathered ${savedDataSources.length} unique sources (${savedReferences.length} citable references).`,
          detail: `PubMed=${countBySource(savedDataSources, "pubmed")} | RCSB=${countBySource(savedDataSources, "rcsb")} | UniProt=${countBySource(savedDataSources, "uniprot")} | Web=${countBySource(savedDataSources, "web")}`,
        });
        log(`gather: saved ${savedDataSources.length} sources, ${savedReferences.length} refs`);

        if (savedReferences.length === 0) {
          send("error", { error: "No citable references could be gathered." });
          safeClose();
          return;
        }

        // ============ STEP 2: Curate ============
        send("step", { step: "curate", status: "started", message: `Curating references...` });
        // ★ round-14: mechanically drop preprint duplicates of published works
        // BEFORE curation, so the same work can never enter the article twice
        // (E2E finding: bioRxiv/Research Square preprints cited side-by-side
        // with their eLife/Nat Commun published versions).
        const deduped = dedupePreprintVersions(savedReferences);
        if (deduped.dropped.length > 0) {
          stats.preprintDuplicatesDropped = deduped.dropped.length;
          log(
            `curate: dropped ${deduped.dropped.length} preprint/duplicate versions — ` +
              deduped.dropped
                .map((d) => `[${String(d.droppedJournal).slice(0, 24)}] ${d.droppedTitle.slice(0, 60)}`)
                .join(" | ")
          );
        }
        const maxCitableRefs = maxCitableRefsFor(targetWords, deduped.refs.length);
        let curatedRefs = await curateReferences(
          projectId, deduped.refs, project.topic, project.field || "life sciences", maxCitableRefs, maxTokens
        );
        send("step", {
          step: "curate",
          status: "done",
          curatedCount: curatedRefs.length,
          message: `Curated ${curatedRefs.length} references from ${deduped.refs.length}${deduped.dropped.length ? ` (${deduped.dropped.length} preprint duplicates dropped)` : ""}.`,
        });
        log(`curate: ${curatedRefs.length} refs`);

        // ============ STEP 3: Plan outline ============
        send("step", { step: "plan", status: "started", message: "Planning article outline..." });
        const planSystem =
          "You are a senior research advisor who designs publication-ready review outlines. " +
          "Plan sections with target word counts that sum to the total. Prefer MORE sections with SMALLER targets.";
        const planPrompt = `RESEARCH TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}
TARGET TOTAL WORDS: ${targetWords}
CURATED REFERENCES: ${curatedRefs.length} citable references.

KEY SOURCES:
${curatedRefs.slice(0, 30).map((r: any, i: number) => `[${i + 1}] ${r.authors || "Anon"} (${r.year || "n.d."}) ${r.title?.slice(0, 80) || ""}`).join("\n")}

Plan a comprehensive review article with ${Math.max(5, Math.ceil(targetWords / 400))}-${Math.max(8, Math.ceil(targetWords / 300))} sections.
Each section 200-450 words. Sections must cover DISTINCT aspects of the topic.

Respond as STRICT JSON:
{
  "sections": [
    { "title": "descriptive title", "focus": "what this section covers", "targetWords": 300 }
  ]
}
Output JSON only.`;

        const planRaw = await chatWithSession(projectId, planPrompt, {
          system: planSystem,
          temperature: 0.5,
          taskType: "plan",
          maxTokens,
          metadata: { step: "plan", targetWords },
        });
        const planParsed = safeParseJSON(planRaw, { sections: [] });
        let sections: any[] = (planParsed.sections || []).filter((s: any) => s.title && s.targetWords);

        if (sections.length === 0) {
          const fallbackCount = Math.max(5, Math.ceil(targetWords / 300));
          sections = [];
          for (let i = 0; i < fallbackCount; i++) {
            sections.push({
              title: i === 0 ? "Introduction" : i === fallbackCount - 1 ? "Future Directions" : `Section ${i + 1}`,
              targetWords: Math.floor(targetWords / fallbackCount),
              focus: `Aspect ${i + 1} of ${project.topic}`,
            });
          }
        }
        const minSections = Math.max(5, Math.ceil(targetWords / 300));
        if (sections.length < minSections) {
          const perSectionTarget = Math.floor(targetWords / Math.max(sections.length, 1));
          for (const s of sections) s.targetWords = perSectionTarget;
        }
        // Dedup titles
        const seenTitles = new Set<string>();
        for (const s of sections) {
          const tl = (s.title || "").toLowerCase().trim();
          if (seenTitles.has(tl)) s.title = `${s.title} (continued)`;
          seenTitles.add(tl);
          if (!s.focus) s.focus = `Discussion of ${s.title} in the context of ${project.topic}`;
        }

        // ★ round-17: dedup/verify word reserve. The compose-stage mechanical
        // cross-section dedup + adversarial citation verification strip
        // content AFTER allocation (third E2E run: 15 sentences ≈ 360 words +
        // 8 citation removals → 2119 words against a 2500 target, -15%).
        // Budget a 12% headroom (capped at 1.18× target) so the composed
        // article still lands within the ±10% band.
        {
          const plannedTotal = sections.reduce(
            (s: number, x: any) => s + (Number(x.targetWords) || 0),
            0,
          );
          const cappedTotal = Math.round(targetWords * 1.18);
          if (plannedTotal > 0 && plannedTotal < cappedTotal) {
            const scale = Math.min(1.12, cappedTotal / plannedTotal);
            for (const s of sections) {
              s.targetWords = Math.round((Number(s.targetWords) || 0) * scale);
            }
            log(`plan: word reserve ×${scale.toFixed(3)} applied (${plannedTotal} → ${sections.reduce((s: number, x: any) => s + (Number(x.targetWords) || 0), 0)} planned) for dedup/verify loss`);
          }
        }

        send("step", {
          step: "plan",
          status: "done",
          sectionCount: sections.length,
          sections: sections.map((s: any) => ({ title: s.title, targetWords: s.targetWords })),
          message: `Planned ${sections.length} sections.`,
        });
        log(`plan: ${sections.length} sections`);

        // ★ round-15: mechanical primary-paper coverage assertion. The LLM
        // curation prompt (priority 5) asks for primary structure/therapy
        // papers, but the TMC regression run still shipped a "Cryo-EM
        // Advances" section whose only structure paper was one PNAS paper
        // (Jeong 2022 Nature sat unused in the gather pool), and a therapeutic
        // section with zero therapy references (Askew 2015 never curated).
        // Enforce coverage mechanically now that the section titles are known.
        const coverage = ensurePrimaryPaperCoverage(
          project.topic,
          sections.map((s: any) => `${s.title} ${s.focus || ""}`),
          deduped.refs,
          curatedRefs,
        );
        if (coverage.backfilled.length > 0) {
          curatedRefs = coverage.refs;
          stats.coverageBackfills = coverage.backfilled;
          log(
            `plan: coverage backfill — ` +
              coverage.backfilled
                .map((b) => `[${b.signal}] +"${b.addedTitle.slice(0, 60)}"${b.replacedTitle ? ` replacing review "${b.replacedTitle.slice(0, 50)}"` : " (appended)"}`)
                .join(" | ")
          );
          send("step", {
            step: "plan",
            status: "progress",
            message: `Coverage assertion: backfilled ${coverage.backfilled.length} primary paper(s) — ${coverage.backfilled.map((b) => b.signal).join(", ")}.`,
          });
        }

        // ============ STEP 4: ★ Analyze — extract evidence bank ============
        send("step", {
          step: "analyze",
          status: "started",
          message: `Analyzing ${curatedRefs.length} sources and extracting an evidence bank (claims pre-bound to references)...`,
        });

        const evidenceBank = await extractEvidenceBank(
          projectId,
          curatedRefs as EvidenceRefInput[],
          project.topic,
          project.field || "life sciences",
          { maxRefs: Math.min(curatedRefs.length, 40), batchSize: 14, maxTokens }
        );

        send("step", {
          step: "analyze",
          status: "done",
          evidenceItems: evidenceBank.length,
          refsAnalyzed: Math.min(curatedRefs.length, 40),
          message: `Extracted ${evidenceBank.length} evidence claims from ${Math.min(curatedRefs.length, 40)} references.`,
          detail: evidenceBank.slice(0, 6).map((e) => `[REF-${e.refIndex}] ${e.claim.slice(0, 100)}`).join("\n"),
        });
        log(`analyze: ${evidenceBank.length} evidence items`);

        // ============ STEP 5: ★ Allocate evidence to sections ============
        send("step", { step: "allocate", status: "started", message: "Allocating references + evidence to sections..." });

        const allocations = await allocateEvidenceToSections(
          projectId,
          sections,
          curatedRefs as EvidenceRefInput[],
          evidenceBank,
          project.topic,
          { minRefsPerSection: 5, maxRefsPerSection: 12, maxTokens }
        );

        send("step", {
          step: "allocate",
          status: "done",
          message: `Allocated references to ${allocations.length} sections (avg ${Math.round(allocations.reduce((s, a) => s + a.refIndices.length, 0) / Math.max(1, allocations.length))} refs/section).`,
          detail: allocations.map((a, i) => `§${i + 1}: ${a.refIndices.length} refs, ${a.evidence.length} claims (${a.rationale})`).join("\n"),
        });
        log(`allocate: ${JSON.stringify(allocations.map(a => a.refIndices.length))}`);

        // ============ STEP 6: Generate sections with keyed citations ============
        send("step", {
          step: "generate",
          status: "started",
          message: `Generating ${sections.length} sections with structural citation keys...`,
        });

        preFlightQuotaCheck("generate-full-v2:pre-flight");

        let previousSectionsDigest = "";
        let abortedDueToRateLimit = false;

        for (let i = 0; i < sections.length; i++) {
          const section = sections[i];
          const sectionNum = i + 1;
          const allocation = allocations[i];
          const sectionStart = Date.now();

          if (abortedDueToRateLimit || isAborted() || clientDisconnected) {
            send("step", {
              step: "generate",
              status: "skipped",
              section: sectionNum,
              total: sections.length,
              message: `Section ${sectionNum} SKIPPED — ${clientDisconnected ? "client disconnected" : "rate-limit abort"}.`,
            });
            continue;
          }

          send("step", {
            step: "generate",
            status: "started",
            section: sectionNum,
            total: sections.length,
            title: section.title,
            message: `Generating section ${sectionNum}/${sections.length}: ${section.title} (~${section.targetWords} words, ${allocation.refIndices.length} allocated refs)`,
          });
          log(`generate: section ${sectionNum} starting — "${section.title}" refs=${allocation.refIndices.length}`);

          // The per-section reference subset (pre-allocated in the analyze stage)
          const sectionRefs = allocation.refIndices
            .map((n) => curatedRefs[n - 1])
            .filter(Boolean);

          if (!sectionRefs.length) {
            log(`generate: section ${sectionNum} has no allocated refs — topping up from curated list`);
            sectionRefs.push(...curatedRefs.slice(0, 6));
          }

          const evidenceContext = buildEvidenceContext(allocation, curatedRefs as EvidenceRefInput[]);

          // ★ FIX (narrow digest window): the digest only carries the LAST 3
          // sections (style reference). By section 8 of a 10-section article
          // the model had no idea sections 1-4 existed and repeated their
          // examples. The full outline of every previously-written section is
          // now always included so nothing is invisible.
          const allPreviousTitles = sections
            .slice(0, i)
            .map((s: any, j: number) => `§${j + 1}: ${s.title}`)
            .join("\n");
          const continuityBlock = previousSectionsDigest
            ? `\nFULL OUTLINE OF SECTIONS ALREADY WRITTEN (do NOT repeat their content or re-open their examples):\n${allPreviousTitles}\n\nCLAIMS ALREADY ESTABLISHED IN RECENT SECTIONS (do NOT restate these — not even in reworded form):\n${previousSectionsDigest}\n`
            : "";

          const prompt = `RESEARCH TOPIC: ${project.topic}
SECTION ${sectionNum} of ${sections.length}: ${section.title}
FOCUS: ${section.focus}
TARGET WORDS: ${section.targetWords} (±10%)
${continuityBlock}
${evidenceContext}

Now write this section. HARD RULES:

CITATION SYSTEM (STRUCTURAL — the most important rule):
- Cite a source by writing its citation key EXACTLY as shown, e.g. {{R1}}, {{R3}}.
  Keys look like {{R<number>}} and are listed next to each reference above.
- EVERY factual sentence must end with the key of the source that supports it.
- You may cite multiple sources for one claim: {{R2}}{{R5}} or {{R2,R5}}.
- NEVER write numeric citations like [1] or [2] — numbers are assigned by the
  system. Only {{Rn}} keys.
- ONLY cite keys from the list above ({{R1}} to {{R${sectionRefs.length}}}).
- NEVER cite a source for a claim its title/abstract does not support. If no
  listed source supports a claim, DROP the claim — do not pad with unrelated
  citations. An uncited claim is better than a miscited one.
- A section with ZERO {{Rn}} citations is a FAILED output — this includes
  perspectives/outlook/future-directions sections: ground each therapeutic
  strategy, technical approach, or projected development in the specific
  listed study that demonstrated it, and phrase unsupported aspirations as
  explicitly hypothetical rather than asserting them as established.
- Match the citation to the claim TYPE: cite the paper that determined a
  structure for structural/architecture claims, the functional study for
  functional claims, and the primary research paper (not a review) when both
  are listed. Never cite a purely functional study as evidence for a
  structural finding, or a review as the source of a primary finding the
  review merely summarizes.

STRUCTURE-CLAIM HONESTY (round-16):
- Only write "cryo-EM/NMR/X-ray structures have revealed/shown X" when a
  listed reference IS a primary structure determination of that exact
  complex/species (its title typically contains "structure(s)", "architecture",
  or "cryo-EM"). Check the species: a worm/invertebrate structure does not
  establish the vertebrate protein's architecture.
- If NO listed reference determined the subject's structure, state that gap
  explicitly (e.g., "no atomic structure of X has yet been reported") and
  attribute architectural inferences to homology modeling, mutagenesis, or
  biochemical reconstitution with the citations that actually did that work.

NO REPETITION ACROSS SECTIONS (round-15):
- The outline and "CLAIMS ALREADY ESTABLISHED" list above show what earlier
  sections already said. NEVER restate an established claim — not even
  reworded, and ESPECIALLY not with the same citation. If a brief link to a
  prior point is needed for flow, refer to it in ONE short clause WITHOUT a
  citation and move on.
- Spend the entire word budget on NEW claims drawn from THIS section's
  allocated references. When two sections would naturally cite the same
  reference for the same fact, let the more topical section own that fact and
  let the other section skip it entirely.

EVIDENCE FIDELITY:
- Write FROM the VERIFIED EVIDENCE claims listed above — those claims were
  extracted directly from each source. When you use one, cite that source's key.
- Do not invent numbers, methods, or findings that are not in the evidence list
  or the reference titles/abstracts.

STYLE:
- Formal academic prose, third person. 2-4 cohesive paragraphs.
- Start directly with the first sentence of content (no headings, no preamble,
  no "Here is the section", no word-count postscripts).
- Use *italics* for species names; **bold** for gene/protein names on first mention.
${promptInstruction ? `\nCUSTOM INSTRUCTION:\n${promptInstruction}` : ""}`;

          const system = `You are a senior scientific research writer and domain expert (${project.field || "life sciences"}).
Write in English using formal, precise academic prose.
Compose ONE cohesive section. Start the body with actual content, NOT a restatement of the title.
You cite ONLY with {{Rn}} keys — never numeric [n] citations.`;

          let chunkContent = "";
          let lastStreamEmit = 0;
          try {
            chunkContent = await chatWithSessionStream(
              projectId,
              prompt,
              {
                system,
                temperature: 0.6,
                thinking: false,
                taskType: "generate",
                maxTokens,
                metadata: { step: "generate", section: sectionNum, sectionTitle: section.title, pipeline: "v2" },
              },
              (delta, accumulated) => {
                const now = Date.now();
                if (now - lastStreamEmit > 100) {
                  lastStreamEmit = now;
                  send("step", {
                    step: "generate",
                    status: "streaming",
                    section: sectionNum,
                    total: sections.length,
                    delta: delta.slice(-200),
                    accumulatedLength: accumulated.length,
                    message: `Section ${sectionNum} streaming... (${accumulated.length} chars)`,
                  });
                }
              }
            );
          } catch (err: any) {
            // ★ FIX (dead-code repair): RateLimitAbortedError / QuotaExhaustedError
            // previously fell through to the non-streaming fallback below — which
            // ALSO rate-limits and rethrows — escaping the section loop entirely and
            // killing the pipeline with a raw error. The "skipped" path above was
            // unreachable. Now rate-limit aborts mark the flag so REMAINING sections
            // are skipped gracefully and the article composes from what exists.
            if (err instanceof RateLimitAbortedError || err instanceof QuotaExhaustedError) {
              abortedDueToRateLimit = true;
              send("step", {
                step: "generate",
                status: "skipped",
                section: sectionNum,
                total: sections.length,
                message: `Section ${sectionNum} SKIPPED — rate limit hit; remaining sections will be skipped.`,
              });
              continue;
            }
            send("step", {
              step: "generate",
              status: "progress",
              section: sectionNum,
              message: `Streaming failed, falling back: ${err?.message?.slice(0, 80) || ""}`,
            });
            try {
              chunkContent = await chatWithSession(projectId, prompt, {
                system,
                temperature: 0.6,
                taskType: "generate",
                maxTokens,
                metadata: { step: "generate", section: sectionNum, fallback: true },
              });
            } catch (fbErr: any) {
              if (fbErr instanceof RateLimitAbortedError || fbErr instanceof QuotaExhaustedError) {
                abortedDueToRateLimit = true;
                send("step", {
                  step: "generate",
                  status: "skipped",
                  section: sectionNum,
                  total: sections.length,
                  message: `Section ${sectionNum} SKIPPED — rate limit hit during fallback; remaining sections will be skipped.`,
                });
                continue;
              }
              throw fbErr;
            }
          }

          await new Promise((r) => setTimeout(r, 2000));

          // Sanitize preambles/postscripts/meta-commentary
          chunkContent = sanitizeSectionContent(chunkContent);

          // ---- ★ VALIDATION GATE (deepseek-harness-style step validation) ----
          // If the output contains raw numeric [n] markers, malformed keys,
          // ZERO citations (round-14: a "Therapeutic Perspectives" section
          // shipped with 0 citations while asserting concrete gene-therapy and
          // CRISPR claims), or a TRAILING UNCITED CLAIM BLOCK (round-17: §8 of
          // the E2E run made substantive therapeutic claims for its last ~100
          // words while all {{Rn}} keys sat in the first paragraph), retry
          // ONCE with a corrective instruction.
          const gate = keyedCitationsAreValid(chunkContent, sectionRefs.length);
          const keyedCount = (chunkContent.match(/\{\{R\d+\}\}/g) || []).length;
          const zeroCite = keyedCount === 0;
          const trailingBlock = trailingUncitedClaimWords(chunkContent);
          const trailingGate = !zeroCite && keyedCount > 0 && trailingBlock !== null;
          if (zeroCite || trailingGate || (!gate.ok && (gate.rawNumericMarkers > 0 || gate.outOfRangeKeys > 0))) {
            stats.gateRetries++;
            if (zeroCite) stats.zeroCitationRetries++;
            if (trailingGate) stats.trailingUncitedRetries++;
            log(`generate: section ${sectionNum} FAILED validation gate (zeroCite=${zeroCite}, trailing=${trailingGate ? `${trailingBlock}w` : "no"}, raw=${gate.rawNumericMarkers}, oor=${gate.outOfRangeKeys}) — retrying`);
            send("step", {
              step: "generate",
              status: "progress",
              section: sectionNum,
              total: sections.length,
              message: zeroCite
                ? `Section ${sectionNum}: validation gate triggered (ZERO citations) — retrying with grounding instruction...`
                : trailingGate
                  ? `Section ${sectionNum}: validation gate triggered (trailing ${trailingBlock} uncited claim words) — retrying with grounding instruction...`
                  : `Section ${sectionNum}: validation gate triggered (raw numeric markers: ${gate.rawNumericMarkers}) — retrying with corrective instruction...`,
            });
            try {
              const retryPrompt = prompt + (zeroCite
                ? `

CORRECTION: your previous output contained ZERO {{Rn}} citations, but this section has ${sectionRefs.length} citable references allocated to it. A review section must ground its claims in the listed references. Rewrite the SAME section so that every factual claim — including each therapeutic strategy, experimental approach, or projected development — cites the specific listed reference that supports it, using {{Rn}} keys. If a claim cannot be supported by any listed reference, rephrase it as an explicitly open question or replace it with content drawn from the references. Output the corrected section only.`
                : trailingGate
                  ? `

CORRECTION: in your previous output, the last ${trailingBlock} words make substantive factual claims (experimental findings, therapeutic advances, mechanistic assertions) WITHOUT any {{Rn}} citation, while all citations sit earlier in the section. Every claim sentence — especially in closing/outlook paragraphs — must cite the specific listed reference that supports it, using {{Rn}} keys. Rewrite the SAME section, either grounding those trailing claims in the listed references or reframing them as explicitly open questions. Output the corrected section only.`
                  : `

CORRECTION: your previous output contained FORBIDDEN numeric citations like [1] or [2], or invalid keys. Rewrite the SAME section content using ONLY {{Rn}} citation keys from the list. Every citation must be a {{Rn}} key. Output the corrected section only.`);
              const retryContent = await chatWithSession(projectId, retryPrompt, {
                system,
                temperature: 0.5,
                taskType: "generate",
                maxTokens,
                metadata: { step: "generate", section: sectionNum, retry: true, zeroCite },
              });
              const sanitizedRetry = sanitizeSectionContent(retryContent);
              const retryGate = keyedCitationsAreValid(sanitizedRetry, sectionRefs.length);
              const retryKeyed = (sanitizedRetry.match(/\{\{R\d+\}\}/g) || []).length;
              const retryTrailing = trailingUncitedClaimWords(sanitizedRetry);
              let improved: boolean;
              if (zeroCite) {
                improved = retryKeyed > 0 && retryGate.rawNumericMarkers === 0;
              } else if (trailingGate) {
                improved = retryTrailing === null || (retryTrailing ?? 0) < (trailingBlock ?? 0);
              } else {
                improved = retryGate.rawNumericMarkers < gate.rawNumericMarkers;
              }
              if (improved) {
                chunkContent = sanitizedRetry;
                log(`generate: section ${sectionNum} retry improved (keyed ${keyedCount}→${retryKeyed}, raw ${gate.rawNumericMarkers}→${retryGate.rawNumericMarkers})`);
              }
            } catch (retryErr: any) {
              log(`generate: section ${sectionNum} retry failed: ${retryErr?.message?.slice(0, 80)}`);
            }
          }

          // ---- ★ MECHANICAL key→number conversion (no LLM numbering) ----
          const converted = convertKeysToNumbers(chunkContent, sectionRefs);
          stats.droppedKeys += converted.droppedKeys;
          stats.strippedNumeric += converted.strippedNumeric;
          let sectionContent = converted.content;
          let citedRefs = converted.citedRefs;

          log(`generate: section ${sectionNum} converted — ${citedRefs.length} cited refs, dropped=${converted.droppedKeys} keys, stripped=${converted.strippedNumeric} raw numerics`);

          // ============ STEP 7 (per-section): ★ Adversarial verification ============
          // Every (sentence, citation) pair is checked against the reference's
          // actual title/abstract. Unsupported citations are surgically removed.
          send("step", {
            step: "verify",
            status: "started",
            section: sectionNum,
            total: sections.length,
            message: `Adversarially verifying ${extractBodyCitations(sectionContent).length} citations in section ${sectionNum}...`,
          });

          const verifyStart = Date.now();
          let verifyResult;
          try {
            verifyResult = await adversarialVerifySection(
              projectId,
              sectionContent,
              citedRefs,
              {
                batchSize: VERIFY_BATCH_SIZE,
                removeVerdict: VERIFY_REMOVE_VERDICT,
                removeConfidence: VERIFY_REMOVE_CONFIDENCE,
                maxTokens,
              }
            );
          } catch (verifyErr: any) {
            // Rate-limit aborts during verification also skip gracefully — the
            // section keeps its citations UNVERIFIED rather than killing the run.
            if (verifyErr instanceof RateLimitAbortedError || verifyErr instanceof QuotaExhaustedError) {
              abortedDueToRateLimit = true;
              log(`verify: section ${sectionNum} skipped — rate limit hit; saving section with unverified citations`);
              verifyResult = { checked: 0, removedNums: [], flagged: [], removals: [] } as any;
            } else {
              throw verifyErr;
            }
          }
          stats.citationsChecked += verifyResult.checked;
          stats.citationsRemoved += verifyResult.removedNums.length;
          stats.citationsFlagged += verifyResult.flagged.length;

          if (verifyResult.removedNums.length > 0) {
            const after = removeCitationsAndRenumber(sectionContent, citedRefs, new Set(verifyResult.removedNums));
            sectionContent = after.content;
            citedRefs = after.refs;
          }

          send("step", {
            step: "verify",
            status: "done",
            section: sectionNum,
            total: sections.length,
            checked: verifyResult.checked,
            removed: verifyResult.removedNums.length,
            flagged: verifyResult.flagged.length,
            message: `Section ${sectionNum} verification: ${verifyResult.checked} citations checked, ${verifyResult.removedNums.length} removed, ${verifyResult.flagged.length} flagged (${Date.now() - verifyStart}ms).`,
            detail: verifyResult.removals.map((r) => `[${r.n}] ${r.reason}`).join("\n"),
          });
          log(`verify: section ${sectionNum} — checked=${verifyResult.checked} removed=${verifyResult.removedNums.length} flagged=${verifyResult.flagged.length}`);

          // ---- Save the paragraph + cited references ----
          // ★ FIX (atomic section save): paragraph + references were created
          // sequentially with no transaction — a failure on reference #5 left a
          // paragraph with partial references, desyncing compose's global
          // renumbering. One $transaction keeps them all-or-nothing.
          const paragraph = await db.$transaction(async (tx) => {
            const p = await tx.paragraph.create({
              data: {
                projectId,
                title: section.title,
                content: sectionContent,
                format: inferFormat(section.title, i, sections.length),
                scenario: "literature-review",
                status: "draft",
                order: i,
                wordCount: countWords(sectionContent),
              },
            });
            if (citedRefs.length > 0) {
              await tx.reference.createMany({
                data: citedRefs.map((ref: any, idx: number) => ({
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
                  paragraphId: p.id,
                  citationOrder: idx,
                })),
              });
            }
            return p;
          });

          generatedParagraphs.push({
            id: paragraph.id,
            title: section.title,
            wordCount: paragraph.wordCount,
          });

          // ★ round-15: claim-level digest. The old digest (first 160 chars)
          // carried style but not substance — the TMC regression repeated the
          // dimer/TMEM16 and cysteine-mutagenesis claims verbatim across three
          // sections because later sections never SAW those claims. Now each
          // digest entry lists the citation-bearing sentences so downstream
          // sections know exactly what is already established.
          const claimSentences = sectionContent
            .split(/(?<=[.!?])\s+/)
            .filter((s: string) => /\[\d/.test(s))
            .slice(0, 6)
            .map((s: string) => s.replace(/\s+/g, " ").replace(/^[-•*]\s*/, "").slice(0, 150));
          const digestEntry =
            `§${sectionNum} "${section.title}" established:\n` +
            (claimSentences.length > 0
              ? claimSentences.map((s: string) => `- ${s}`).join("\n")
              : `- (opening: ${sectionContent.slice(0, 140).replace(/\n+/g, " ")}...)`);
          previousSectionsDigest = (previousSectionsDigest + "\n" + digestEntry)
            .split("\n")
            .filter(Boolean)
            .slice(-24)
            .join("\n");

          send("step", {
            step: "generate",
            status: "done",
            section: sectionNum,
            total: sections.length,
            title: section.title,
            wordCount: paragraph.wordCount,
            citations: citedRefs.length,
            message: `Section ${sectionNum} complete: ${paragraph.wordCount} words, ${citedRefs.length} verified citations (${Date.now() - sectionStart}ms).`,
          });
          log(`generate: section ${sectionNum} DONE (${paragraph.wordCount} words, ${citedRefs.length} citations, ${Date.now() - sectionStart}ms)`);
        }

        if (generatedParagraphs.length === 0) {
          send("error", { error: "All sections failed to generate." });
          safeClose();
          return;
        }

        // ============ STEP 8: Compose with global renumbering ============
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
            return { content: cleanContent, refs: para?.references || [] };
          })
        );

        // Global renumbering: local [n] → global [m] via reference identity
        const globalRefMap = new Map<string, number>();
        const globalRefs: any[] = [];

        const renumberedContents = allParagraphData.map(({ content, refs }) => {
          let result = content;
          const citeRe = /\[(\d+(?:[,\-–]\s*\d+)*)\]/g;
          result = result.replace(citeRe, (_match, inner: string) => {
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
            const globalNums = nums
              .map((localNum: number) => {
                if (localNum < 1 || localNum > refs.length) return null;
                const ref = refs[localNum - 1];
                if (!ref) return null;
                const key = `${(ref.type || "").toLowerCase()}:${(ref.externalId || ref.title || "").toLowerCase()}`;
                if (!globalRefMap.has(key)) {
                  const globalNum = globalRefs.length + 1;
                  globalRefMap.set(key, globalNum);
                  globalRefs.push(ref);
                }
                return globalRefMap.get(key)!;
              })
              .filter(Boolean) as number[];
            if (globalNums.length === 0) return "";
            globalNums.sort((a, b) => a - b);
            return `[${globalNums.join(",")}]`;
          });
          // ★ round-15: normalize adjacent bracket pairs. The LLM sometimes
          // emits two separate citation markers back-to-back ("[3][14]" —
          // user-reported format inconsistency). Merge them into the canonical
          // comma form, chained ([1][2][3] → [1,2,3]), AFTER global
          // renumbering so the merged numbers are final.
          let prevMerged = "";
          while (prevMerged !== result) {
            prevMerged = result;
            result = result.replace(/\[(\d+(?:,\d+)*)\]\s*\[(\d+(?:,\d+)*)\]/g, (_m, a: string, b: string) => `[${a},${b}]`);
            if (result !== prevMerged) stats.adjacentCitationsMerged++;
          }
          return result;
        });

        // Keep only refs actually cited in the body; renumber 1..N
        // ★ round-16: mechanical cross-section near-duplicate removal. The
        // round-15 prompt rule + claim-level digest reduced but did NOT
        // eliminate verbatim claim restatements across sections (two
        // consecutive E2E runs repeated 5+ claims). This deterministic pass
        // drops any citation-bearing sentence in a LATER section that
        // near-matches an EARLIER section's claim pool (first occurrence
        // wins; ≤3 removals/section; a section always keeps ≥1 citation).
        // Runs BEFORE the orphan-ref filter so references that lose their
        // only citation are pruned from the final list automatically.
        const crossSectionDeduped = removeCrossSectionDuplicates(renumberedContents);
        if (crossSectionDeduped.removals.length > 0) {
          for (let di = 0; di < renumberedContents.length; di++) {
            renumberedContents[di] = crossSectionDeduped.contents[di];
          }
          stats.crossSectionDuplicatesRemoved = crossSectionDeduped.removals;
          log(
            `compose: cross-section dedup removed ${crossSectionDeduped.removals.length} near-duplicate claim sentences: ` +
              crossSectionDeduped.removals.map((r) => `§${r.section}←§${r.matchedSection}`).join(", "),
          );
        }
        let articleBody = renumberedContents
          .map((c, i) => `## ${generatedParagraphs[i]?.title || `Section ${i + 1}`}\n\n${c}`)
          .join("\n\n");

        const citedInBody = new Set<number>();
        const citeScanRe = /\[(\d+(?:[,\-–\s]\d+)*)\]/g;
        let citeMatch;
        while ((citeMatch = citeScanRe.exec(articleBody)) !== null) {
          for (const part of citeMatch[1].split(/[,;]\s*/)) {
            const rm = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
            if (rm) {
              for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) citedInBody.add(n);
            } else {
              const n = parseInt(part);
              if (!isNaN(n)) citedInBody.add(n);
            }
          }
        }
        const filteredRefs = globalRefs.filter((_, i) => citedInBody.has(i + 1));
        const refNumberMap = new Map<number, number>();
        if (filteredRefs.length < globalRefs.length) {
          // Build the object-identity → index map once (indexOf inside the
          // loop below was O(n²) with object identity).
          const globalIndex = new Map(globalRefs.map((r, i) => [r, i] as const));
          filteredRefs.forEach((r, i) => {
            const gi = globalIndex.get(r);
            if (gi !== undefined) refNumberMap.set(gi + 1, i + 1);
          });
          articleBody = articleBody.replace(citeScanRe, (match, inner: string) => {
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
            const newNums = nums.map((n: number) => refNumberMap.get(n)).filter(Boolean) as number[];
            if (newNums.length === 0) return "";
            newNums.sort((a, b) => a - b);
            return `[${newNums.join(",")}]`;
          });
          globalRefs.length = 0;
          globalRefs.push(...filteredRefs);
        }

        const refList = globalRefs
          .map((r, i) => {
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

        const articleContent = articleBody.trim() + "\n\n## References\n\n" + refList;

        // v121: generate a real article title from what was actually written
        // (the old code stored `project.topic` — the project-creation brief —
        // as the title, so exports named the file after the brief).
        let articleTitle = project.topic;
        let articleTitleZh: string | null = null;
        try {
          send("step", { status: "progress", message: "Generating article title..." });
          const titleResult = await generateArticleTitle({
            topic: project.topic,
            sectionTitles: sections.map((s: any) => s?.title).filter(Boolean),
            excerpt: articleBody.trim().slice(0, 800),
            // round-27: bilingual runs also want a Chinese title (v1 already
            // passed wantZh; v2 never did, so titleZh was always null).
            wantZh: isBothMode,
          });
          articleTitle = titleResult.title;
          articleTitleZh = titleResult.titleZh;
          log(
            `compose: article title ${titleResult.generated ? "(LLM-generated)" : "(fallback to project topic)"}: ${articleTitle}`,
          );
        } catch (titleErr: any) {
          log(`compose: title generation failed, using project topic: ${String(titleErr?.message ?? titleErr).slice(0, 120)}`);
        }

        // Update each paragraph's content + references to GLOBAL numbering so
        // the workspace view matches the article (v70-1 gap-fill pattern).
        // ★ FIX (atomic rewrite): update + reference deleteMany + reference
        // creates now run in ONE transaction — previously a failure between the
        // delete and the re-creates left the paragraph referenceless (citations
        // [1][2][3] in the body, empty reference panel) with no recovery.
        for (let i = 0; i < renumberedContents.length && i < generatedParagraphs.length; i++) {
          const paraId = generatedParagraphs[i].id;
          const content = renumberedContents[i];
          const citedGlobalNums = new Set<number>();
          let maxCitedNum = 0;
          const citeRe2 = /\[(\d+(?:[,\-–\s]*\d+)*)\]/g;
          let cm;
          while ((cm = citeRe2.exec(content)) !== null) {
            for (const part of cm[1].split(/[,;]\s*/)) {
              const rm = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
              if (rm) {
                for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) {
                  if (n <= globalRefs.length) { citedGlobalNums.add(n); if (n > maxCitedNum) maxCitedNum = n; }
                }
              } else {
                const n = parseInt(part);
                if (!isNaN(n) && n <= globalRefs.length) { citedGlobalNums.add(n); if (n > maxCitedNum) maxCitedNum = n; }
              }
            }
          }
          const refsToCreate: any[] = [];
          for (let globalNum = 1; globalNum <= maxCitedNum; globalNum++) {
            const ref = globalRefs[globalNum - 1];
            if (ref) {
              refsToCreate.push({
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
              });
            }
          }
          await db.$transaction([
            db.paragraph.update({ where: { id: paraId }, data: { content } }),
            db.reference.deleteMany({ where: { paragraphId: paraId } }),
            ...(refsToCreate.length > 0
              ? [db.reference.createMany({ data: refsToCreate })]
              : []),
          ]);
        }

        // Save the article
        const article = await db.article.create({
          data: {
            projectId,
            title: articleTitle,
            ...(articleTitleZh ? { titleZh: articleTitleZh } : {}),
            content: articleContent,
            journalTemplate,
            articleParagraph: {
              create: generatedParagraphs.map((p, i) => ({
                paragraphId: p.id,
                order: i,
                section: inferFormat(sections[i]?.title || "", i, sections.length),
              })),
            },
          },
        });

        // Final mechanical audit of the composed article (Layer-2 deterministic)
        // ★ FIX: previously called with `[]` which silently SKIPPED the
        // numbering-integrity check (body [n] ↔ saved reference [n-1]). Pass the
        // real composed references so mismatches surface in the final report.
        const audit = buildAuditReport(
          articleContent,
          globalRefs.map((r: any) => ({
            type: r.type,
            externalId: r.externalId,
            title: r.title || "Untitled",
          })),
        );

        send("step", {
          step: "compose",
          status: "done",
          message: `Article composed: ${countWords(articleContent)} words, ${globalRefs.length} references.`,
          wordCount: countWords(articleContent),
          references: globalRefs.length,
        });
        log(`compose: article saved (${countWords(articleContent)} words, ${globalRefs.length} refs, audit: ${audit.summary.blockingErrors} blocking, ${audit.summary.suspect + audit.summary.unsupported} topicality warnings)`);

        // ============ STEP 9 (both mode only): Translate each section EN → ZH
        // round-27: the UI used to hard-force language="English" for v2, so
        // bilingual users never got the Chinese half. Now language === "both"
        // translates every section AFTER compose — by this point each
        // paragraph's content carries FINAL GLOBAL citation numbers (compose
        // renumbered them above), so a translation that preserves [n] markers
        // verbatim is guaranteed to stay consistent with the article's
        // reference list. Mirrors the v1 translate stage's prompt contract.
        let articleContentZh: string | null = null;
        if (isBothMode) {
          send("step", {
            step: "translate",
            status: "started",
            message: `Translating ${generatedParagraphs.length} sections from English to Chinese (one by one)...`,
            detail: "Each section is translated independently to preserve citations and structure",
          });
          log(`translate: starting for ${generatedParagraphs.length} sections`);

          // round-28: translate ALL section titles in ONE small batched call
          // so the composed Chinese article carries Chinese headings (the
          // English half keeps its own titles). Null entries fall back to the
          // English title — a heading-translation failure never blocks
          // generation.
          const sectionTitles = generatedParagraphs.map(
            (gp: any, i: number) => gp?.title || sections[i]?.title || "",
          );
          let titleZhs: (string | null)[] = [];
          try {
            titleZhs = await translateSectionTitles(sectionTitles);
            const got = titleZhs.filter(Boolean).length;
            log(`translate: section titles ${got}/${sectionTitles.length} translated`);
          } catch (titleErr: any) {
            log(`translate: section-title batch FAILED (keeping English headings): ${titleErr?.message?.slice(0, 80) || "unknown"}`);
          }

          const translatedContents: string[] = [];
          for (let i = 0; i < generatedParagraphs.length; i++) {
            const p = generatedParagraphs[i];
            const sectionNum = i + 1;
            const trStart = Date.now();
            try {
              const para = await db.paragraph.findUnique({ where: { id: p.id } });
              if (!para) {
                translatedContents.push("");
                continue;
              }
              // Content is already global-numbered; strip any trailing
              // "### Citations" bookkeeping block before translating.
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
                // chatWithSessionStream keeps session context across sections
                // so terminology stays consistent (once "mechanotransduction"
                // is rendered as "机械转导", later sections reuse it).
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
                zhContent = await chatWithSession(projectId, translatePrompt, {
                  system: translateSystem,
                  temperature: 0.3,
                  taskType: "translate",
                  maxTokens,
                  metadata: { step: "translate", section: sectionNum, fallback: true },
                });
              }

              // Sanitize: strip any preamble the LLM may have added despite
              // the prompt, then apply the general section sanitizer.
              zhContent = zhContent
                .replace(/^(以下是|翻译如下|中文翻译：?|译文：?|Translation:?)\s*\n*/i, "")
                .trim();
              zhContent = sanitizeSectionContent(zhContent);

              // Citation-integrity check (cheap, deterministic): the Chinese
              // section must cite EXACTLY the same global numbers as the
              // English one — otherwise the bilingual halves disagree.
              const numsOf = (s: string) => {
                const set = new Set<number>();
                const re = /\[(\d+(?:[,\-–]\s*\d+)*)\]/g;
                let m;
                while ((m = re.exec(s)) !== null) {
                  for (const part of m[1].split(/[,;]\s*/)) {
                    const rm = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
                    if (rm) {
                      for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) set.add(n);
                    } else {
                      const n = parseInt(part);
                      if (!isNaN(n)) set.add(n);
                    }
                  }
                }
                return set;
              };
              const enNums = numsOf(cleanEn);
              const zhNums = numsOf(zhContent);
              let citationDrift = false;
              for (const n of enNums) {
                if (!zhNums.has(n)) citationDrift = true;
              }
              if (citationDrift) {
                log(`translate: section ${sectionNum} citation drift detected (EN ${enNums.size} vs ZH ${zhNums.size} unique cites) — keeping translation as-is, drift is non-fatal`);
              }

              const zhWordCount = countWords(zhContent);
              await db.paragraph.update({
                where: { id: para.id },
                data: {
                  contentZh: zhContent,
                  wordCountZh: zhWordCount,
                  ...(titleZhs[i] ? { titleZh: titleZhs[i] as string } : {}),
                },
              });

              translatedContents.push(zhContent);

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
              log(`translate: section ${sectionNum} DONE in ${Date.now() - trStart}ms (${zhContent.length} chars${citationDrift ? ", citation drift" : ""})`);

              // Rate limit between sections
              await new Promise((r) => setTimeout(r, 1500));
            } catch (trErr: any) {
              // Translation of this section failed — skip and continue
              log(`translate: section ${sectionNum} FAILED: ${trErr?.message?.slice(0, 120) || "unknown"}`);
              translatedContents.push("");
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

          // Guard: if EVERY section translation failed, translatedContents is
          // all empty strings — composing would produce a headers-only shell.
          // Skip attaching contentZh (the EN article stands alone; the user
          // can batch-retranslate from the article viewer).
          const translatedCount = translatedContents.filter((c) => c.trim().length > 0).length;
          if (translatedCount === 0) {
            send("step", {
              step: "translate",
              status: "done",
              message: `Chinese translation FAILED for all ${generatedParagraphs.length} sections — the English article was saved without a Chinese half. You can batch-retranslate from the article viewer.`,
              failed: true,
            });
            log(`translate: all ${generatedParagraphs.length} sections failed — skipping zh compose`);
          } else {
          send("step", {
            step: "translate",
            status: "progress",
            message: `Composing Chinese full article from ${translatedCount}/${translatedContents.length} translated sections...`,
          });

          const zhBody = translatedContents
            .map((c, i) => `## ${titleZhs[i] || generatedParagraphs[i]?.title || sections[i]?.title || `Section ${i + 1}`}\n\n${c}`)
            .join("\n\n");

          let cleanZhBody = zhBody.trim();
          cleanZhBody = cleanZhBody.replace(/^#{1}\s+.+\n*/m, "").trim();
          // Strip any AI-generated 参考文献 section (we append the real one)
          const zhRefRe = /^#{0,6}\s*\*{0,2}(参考文献|References|REFERENCES)\*{0,2}\s*:?\s*$/m;
          const zhRefMatch = cleanZhBody.match(zhRefRe);
          if (zhRefMatch && zhRefMatch.index !== undefined) {
            cleanZhBody = cleanZhBody.slice(0, zhRefMatch.index).trim();
          }

          // Same global references list (citations unchanged), Chinese header
          const zhRefList = globalRefs
            .map((r: any, i: number) => {
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

          articleContentZh = cleanZhBody + "\n\n## 参考文献\n\n" + zhRefList;

          // Attach the Chinese half to the saved article (the EN half was
          // already persisted above; this UPDATE adds contentZh).
          await db.article.update({
            where: { id: article.id },
            data: { contentZh: articleContentZh },
          });

          send("step", {
            step: "translate",
            status: "done",
            message: `Chinese translation complete: ${countWords(articleContentZh)} chars across ${translatedCount}/${translatedContents.length} sections.`,
            articleWordCountZh: countWords(articleContentZh),
          });
          log(`translate: compose done — zh article ${articleContentZh.length} chars (${translatedCount}/${translatedContents.length} sections)`);
          }
        }

        await db.articleVersion.create({
          data: {
            articleId: article.id,
            content: articleContent,
            ...(articleContentZh ? { contentZh: articleContentZh } : {}),
            title: articleTitle,
            label: "v2 evidence-grounded (auto-saved)",
            wordCount: countWords(articleContent),
          },
        }).catch((versionErr: any) => {
          // FIX (silent swallow): a failed auto-save used to vanish with
          // `.catch(() => {})` — the user's undo/version trail silently broke.
          // Non-fatal (the article itself is already saved) but now logged.
          log(`compose: version snapshot FAILED: ${String(versionErr?.message ?? versionErr).slice(0, 120)}`);
        });

        const totalMs = Date.now() - t0;
        const articleWordCount = countWords(articleContent);
        send("complete", {
          articleId: article.id,
          wordCount: articleWordCount,
          references: globalRefs.length,
          sections: generatedParagraphs.length,
          totalMs,
          pipeline: "v2",
          hasChinese: !!articleContentZh,
          // round-27: V1-shaped stats block — the UI's completion toast and
          // result card read data.stats.articleWordCount / referencesSaved,
          // which never existed in the v2 payload, so every v2 run showed
          // "0 words". Also keep the flat fields above for older clients.
          stats: {
            sourcesGathered: savedDataSources.length,
            referencesSaved: savedReferences.length,
            curatedReferences: curatedRefs.length,
            sectionsPlanned: sections.length,
            paragraphsGenerated: generatedParagraphs.length,
            totalWords: generatedParagraphs.reduce((s, p) => s + (p.wordCount || 0), 0),
            articleWordCount,
            ...(articleContentZh ? { articleWordCountZh: countWords(articleContentZh) } : {}),
            globalReferenceCount: globalRefs.length,
            pipelineDurationMs: totalMs,
            pipelineDurationSec: Math.round(totalMs / 1000),
            targetWords,
            achievementRate: Math.round((articleWordCount / targetWords) * 100),
          },
          accuracy: {
            droppedKeys: stats.droppedKeys,
            strippedNumeric: stats.strippedNumeric,
            gateRetries: stats.gateRetries,
            zeroCitationRetries: stats.zeroCitationRetries,
            trailingUncitedRetries: stats.trailingUncitedRetries,
            preprintDuplicatesDropped: stats.preprintDuplicatesDropped,
            adjacentCitationsMerged: stats.adjacentCitationsMerged,
            coverageBackfills: stats.coverageBackfills,
            crossSectionDuplicatesRemoved: stats.crossSectionDuplicatesRemoved.length,
            crossSectionDuplicateDetails: stats.crossSectionDuplicatesRemoved,
            citationsChecked: stats.citationsChecked,
            citationsRemoved: stats.citationsRemoved,
            citationsFlagged: stats.citationsFlagged,
            auditBlockingErrors: audit.summary.blockingErrors,
            auditTopicalityWarnings: audit.summary.suspect + audit.summary.unsupported,
            auditOrphans: audit.summary.orphan,
          },
          message: `v2 pipeline complete: ${articleWordCount} words${articleContentZh ? ` + ${countWords(articleContentZh)} Chinese chars` : ""}, ${globalRefs.length} references, ${stats.citationsChecked} citations adversarially verified (${stats.citationsRemoved} removed).`,
        });
        safeClose();
      } catch (err: any) {
        const errMsg = String(err?.message ?? err);
        try { slog.error("FATAL", { ms: Date.now() - t0, error: errMsg.slice(0, 300) }); } catch {}
        log(`FATAL: ${errMsg.slice(0, 300)}`);

        // ★ CRITICAL FIX (crash-safe rollback). Previously ANY failure after
        // the force-clear left the project EMPTY (the deletes had already
        // committed; nothing re-created them) — the user's prior work was gone
        // forever. Recovery strategy:
        //   - ≥1 section WAS generated → keep the partial work (the user can
        //     regenerate missing sections) and report clearly.
        //   - 0 sections AND the project had prior work → restore the pre-run
        //     snapshot so the project is exactly as it was before (atomic run).
        //   - 0 sections and no prior work → nothing to protect; plain error.
        if (generatedParagraphs.length > 0) {
          send("error", {
            error: `v2 pipeline failed after ${generatedParagraphs.length} section(s) were saved: ${errMsg.slice(0, 200)}. Partial work was KEPT — regenerate to fill in the missing sections.`,
            partial: true,
            savedSections: generatedParagraphs.length,
          });
        } else if (hadPriorWork && snapshot) {
          try {
            const snap = snapshot;
            log(`rollback: restoring snapshot (${snap.paragraphs.length} paragraphs, ${snap.dataSources.length} data sources)`);
            await db.$transaction([
              db.annotation.deleteMany({ where: { paragraph: { projectId } } }),
              db.articleParagraph.deleteMany({ where: { paragraph: { projectId } } }),
              db.paragraph.deleteMany({ where: { projectId } }),
              db.dataSource.deleteMany({ where: { projectId } }),
              db.reference.deleteMany({ where: { projectId } }),
            ]);
            for (const ds of snap.dataSources) {
              await db.dataSource.create({ data: { ...ds } });
            }
            for (const para of snap.paragraphs) {
              const { references, annotations, ...paraData } = para as any;
              // Recreate with the ORIGINAL id so article-paragraph links and
              // share tokens that reference the id stay valid.
              await db.paragraph.create({
                data: {
                  ...paraData,
                  ...(references?.length
                    ? { references: { create: references.map(({ id, paragraphId, ...r }: any) => r) } }
                    : {}),
                  ...(annotations?.length
                    ? { annotations: { create: annotations.map(({ id, paragraphId, ...a }: any) => a) } }
                    : {}),
                },
              });
            }
            if (snap.articleParagraphs.length > 0) {
              await db.articleParagraph.createMany({
                data: snap.articleParagraphs.map(({ id, ...ap }: any) => ap),
              });
            }
            log(`rollback: restored ${snap.paragraphs.length} paragraphs, ${snap.dataSources.length} data sources, ${snap.articleParagraphs.length} article links`);
            send("error", {
              error: `v2 pipeline failed before any section was generated: ${errMsg.slice(0, 180)}. Your previous ${snap.paragraphs.length} paragraphs and ${snap.dataSources.length} data sources were RESTORED — the project is unchanged.`,
            });
          } catch (restoreErr: any) {
            log(`ROLLBACK FAILED: ${String(restoreErr?.message ?? restoreErr).slice(0, 200)}`);
            send("error", {
              error: `v2 pipeline failed: ${errMsg.slice(0, 200)} (automatic rollback also failed: ${String(restoreErr?.message ?? restoreErr).slice(0, 120)}). Please contact support / check the server log.`,
            });
          }
        } else {
          send("error", { error: `v2 pipeline failed: ${errMsg.slice(0, 300)}` });
        }
        safeClose();
      }
    },
    cancel() {
      // Browser closed the SSE stream (navigate away / refresh / drop).
      // The start() closure observes this via `clientDisconnected`.
      clientDisconnected = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/* ================================================================
 * Adversarial per-citation verification (used by STEP 7 and by the
 * standalone /api/articles/[id]/adversarial-review route).
 * ================================================================ */

export interface VerifyCheck {
  n: number;
  sentence: string;
  verdict: "SUPPORTED" | "UNSUPPORTED" | "PARTIAL";
  confidence: number;
  reason: string;
}

export interface VerifySectionResult {
  checked: number;
  removals: VerifyCheck[];
  flagged: VerifyCheck[];
  removedNums: number[];
  llmCalls: number;
}

export async function adversarialVerifySection(
  projectId: string,
  content: string,
  refs: any[],
  opts: {
    batchSize?: number;
    removeVerdict?: string;
    removeConfidence?: number;
    maxTokens?: number;
  } = {}
): Promise<VerifySectionResult> {
  const batchSize = opts.batchSize ?? 10;
  const removeVerdict = opts.removeVerdict ?? "UNSUPPORTED";
  const removeConfidence = opts.removeConfidence ?? 80;

  const { body } = splitBodyAndReferences(content);
  const citations = extractBodyCitations(body).filter((c) => c.n >= 1 && c.n <= refs.length);
  if (!citations.length) {
    return { checked: 0, removals: [], flagged: [], removedNums: [], llmCalls: 0 };
  }

  // De-duplicate by n (multiple sentences citing the same ref are checked once
  // per DISTINCT sentence, capped at 2 sentences per ref to bound cost)
  const byRef = new Map<number, { n: number; sentence: string }[]>();
  for (const c of citations) {
    const arr = byRef.get(c.n) || [];
    if (arr.length < 2) arr.push({ n: c.n, sentence: c.sentence });
    byRef.set(c.n, arr);
  }
  const checks: { n: number; sentence: string }[] = [];
  for (const arr of byRef.values()) checks.push(...arr);

  const system = `You are a rigorous peer reviewer auditing citation accuracy in a scientific review article.
For each CHECK you receive a claim sentence from the article and the FULL metadata of the reference it cites.
Your job: decide whether that specific reference actually supports the specific claim.

Be rigorous BUT FAIR:
- UNSUPPORTED only when the reference is genuinely about a DIFFERENT subject than the claim
  (different protein/method/organism/topic), or the claim asserts specifics that clearly
  contradict or are absent from the reference's subject matter.
- Topical match is enough for SUPPORTED: if the reference's title/abstract covers the SAME
  subject as the claim, verdict SUPPORTED even if the wording differs or the sentence adds
  hyperbole ("unprecedented", "significant progress").
- PARTIAL when the reference covers the topic but the sentence asserts a very specific
  statistic or mechanism detail you cannot find in the reference.
- CITATION-TYPE MISMATCH is PARTIAL, not UNSUPPORTED: when the claim describes a
  STRUCTURE/architecture determination ("cryo-EM revealed", "the structure shows") but
  the cited reference is a purely functional or review study, or vice versa, the
  subject overlaps but the wrong primary source is credited — flag verdict PARTIAL
  with reason "citation-type mismatch" so the generator can re-attribute it.
- Do NOT verdict UNSUPPORTED while your own reason says the reference "explicitly
  describes/defines/states" the claim — that is a contradiction. If the reference covers
  the claim, it is SUPPORTED. Be consistent between your verdict and your reason.

Respond as STRICT JSON only:
{"checks":[{"id":1,"verdict":"SUPPORTED|UNSUPPORTED|PARTIAL","confidence":0,"reason":"one line"}]}
confidence is 0-100 (how sure you are of YOUR verdict). Output JSON only.`;

  const removals: VerifyCheck[] = [];
  const flagged: VerifyCheck[] = [];
  let llmCalls = 0;

  for (let b = 0; b < checks.length; b += batchSize) {
    const batch = checks.slice(b, b + batchSize);
    const block = batch
      .map((c, i) => {
        const ref = refs[c.n - 1] || {};
        const auth = (ref.authors || "Anon").trim();
        const yr = ref.year ? ` (${ref.year})` : "";
        const jour = ref.journal ? `, ${ref.journal}` : "";
        const abs = ref.abstract ? `\n  Abstract: ${ref.abstract.slice(0, 600)}` : "\n  (no abstract)";
        return `[CHECK ${i + 1}] (cited as [${c.n}])\n  Claim sentence: "${c.sentence.slice(0, 400)}"\n  Reference: ${auth}${yr}${jour}. ${ref.title || "Untitled"}.${abs}`;
      })
      .join("\n\n");

    const prompt = `CHECKS:
${block}

Adjudicate every check. Respond as STRICT JSON:
{"checks":[{"id":1,"verdict":"...","confidence":0,"reason":"..."}]}`;

    try {
      llmCalls++;
      const raw = await chatWithSession(projectId, prompt, {
        system,
        temperature: 0.1,
        taskType: "verify",
        maxTokens: opts.maxTokens,
        metadata: { step: "adversarial-verify", batch: Math.floor(b / batchSize) + 1 },
      });
      const parsed = safeParseJSON(raw, { checks: [] });
      for (const c of parsed.checks || []) {
        const id = parseInt(String(c.id), 10);
        if (isNaN(id) || id < 1 || id > batch.length) continue;
        let verdict = String(c.verdict || "").toUpperCase();
        if (!["SUPPORTED", "UNSUPPORTED", "PARTIAL"].includes(verdict)) continue;
        const reason = String(c.reason || "").slice(0, 240);
        // Contradiction guard (E2E finding): verdict=UNSUPPORTED while the
        // reason says the reference "explicitly describes/defines/states" the
        // claim is a reviewer false positive — downgrade to PARTIAL (flag only).
        if (
          verdict === "UNSUPPORTED" &&
          (/explicitly (describes|defines|states|discusses|mentions|reports|shows|demonstrates)/i.test(reason) ||
            /directly matches/i.test(reason) ||
            /(?:directly|closely) (?:relates|aligns|correspond)s?/i.test(reason))
        ) {
          verdict = "PARTIAL";
        }
        const confidence = Math.max(0, Math.min(100, parseInt(String(c.confidence ?? 50), 10) || 50));
        const item: VerifyCheck = {
          n: batch[id - 1].n,
          sentence: batch[id - 1].sentence,
          verdict: verdict as VerifyCheck["verdict"],
          confidence,
          reason,
        };
        if (verdict === removeVerdict && confidence >= removeConfidence) {
          removals.push(item);
        } else if (verdict === "UNSUPPORTED" || verdict === "PARTIAL") {
          flagged.push(item);
        }
      }
    } catch (err: any) {
      console.warn(`[adversarialVerifySection] batch failed: ${err?.message?.slice(0, 100)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  return {
    checked: checks.length,
    removals,
    flagged,
    removedNums: [...new Set(removals.map((r) => r.n))],
    llmCalls,
  };
}
