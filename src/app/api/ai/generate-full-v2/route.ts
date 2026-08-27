import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { VERIFY_BATCH_SIZE, VERIFY_REMOVE_CONFIDENCE, maxCitableRefsFor } from "@/lib/v2-config";
import { logger } from "@/lib/logger";
import { webSearch } from "@/lib/ai";
import { chatWithSession, chatWithSessionStream, clearSession } from "@/lib/llm-session";
import { queryDatabase } from "@/lib/databases";
import { countWords, sanitizeSectionContent } from "@/lib/writing";
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
  generateWebSearchQueries,
  inferFormat,
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
        preprintDuplicatesDropped: 0,
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

        send("step", {
          step: "init",
          status: "done",
          message: `v2 evidence-grounded pipeline initialized. Target: ${targetWords} words.`,
          config: {
            pipeline: "v2",
            targetWords,
            journalTemplate,
            maxDbQueries,
            maxWebSearchQueries,
            maxTokens,
          },
        });
        log(`init: targetWords=${targetWords}`);

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
        const curatedRefs = await curateReferences(
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

        send("step", {
          step: "plan",
          status: "done",
          sectionCount: sections.length,
          sections: sections.map((s: any) => ({ title: s.title, targetWords: s.targetWords })),
          message: `Planned ${sections.length} sections.`,
        });
        log(`plan: ${sections.length} sections`);

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
            ? `\nFULL OUTLINE OF SECTIONS ALREADY WRITTEN (do NOT repeat their content or re-open their examples):\n${allPreviousTitles}\n\nMOST RECENT SECTIONS (match their style and flow):\n${previousSectionsDigest}\n`
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
          // If the output contains raw numeric [n] markers, malformed keys, or
          // ZERO citations (round-14: a "Therapeutic Perspectives" section
          // shipped with 0 citations while asserting concrete gene-therapy and
          // CRISPR claims), retry ONCE with a corrective instruction.
          const gate = keyedCitationsAreValid(chunkContent, sectionRefs.length);
          const keyedCount = (chunkContent.match(/\{\{R\d+\}\}/g) || []).length;
          const zeroCite = keyedCount === 0;
          if (zeroCite || (!gate.ok && (gate.rawNumericMarkers > 0 || gate.outOfRangeKeys > 0))) {
            stats.gateRetries++;
            if (zeroCite) stats.zeroCitationRetries++;
            log(`generate: section ${sectionNum} FAILED validation gate (zeroCite=${zeroCite}, raw=${gate.rawNumericMarkers}, oor=${gate.outOfRangeKeys}) — retrying`);
            send("step", {
              step: "generate",
              status: "progress",
              section: sectionNum,
              total: sections.length,
              message: zeroCite
                ? `Section ${sectionNum}: validation gate triggered (ZERO citations) — retrying with grounding instruction...`
                : `Section ${sectionNum}: validation gate triggered (raw numeric markers: ${gate.rawNumericMarkers}) — retrying with corrective instruction...`,
            });
            try {
              const retryPrompt = prompt + (zeroCite
                ? `

CORRECTION: your previous output contained ZERO {{Rn}} citations, but this section has ${sectionRefs.length} citable references allocated to it. A review section must ground its claims in the listed references. Rewrite the SAME section so that every factual claim — including each therapeutic strategy, experimental approach, or projected development — cites the specific listed reference that supports it, using {{Rn}} keys. If a claim cannot be supported by any listed reference, rephrase it as an explicitly open question or replace it with content drawn from the references. Output the corrected section only.`
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
              const improved = zeroCite
                ? retryKeyed > 0 && retryGate.rawNumericMarkers === 0
                : retryGate.rawNumericMarkers < gate.rawNumericMarkers;
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

          const opening = sectionContent.slice(0, 160).replace(/\n+/g, " ");
          const digestEntry = `§${sectionNum} "${section.title}": opens "${opening}..." [${citedRefs.length} refs]`;
          previousSectionsDigest = (previousSectionsDigest + "\n" + digestEntry)
            .split("\n")
            .filter(Boolean)
            .slice(-3)
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
          return result;
        });

        // Keep only refs actually cited in the body; renumber 1..N
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
            title: project.topic,
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
        await db.articleVersion.create({
          data: {
            articleId: article.id,
            content: articleContent,
            title: project.topic,
            label: "v2 evidence-grounded (auto-saved)",
            wordCount: countWords(articleContent),
          },
        }).catch((versionErr: any) => {
          // FIX (silent swallow): a failed auto-save used to vanish with
          // `.catch(() => {})` — the user's undo/version trail silently broke.
          // Non-fatal (the article itself is already saved) but now logged.
          log(`compose: version snapshot FAILED: ${String(versionErr?.message ?? versionErr).slice(0, 120)}`);
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

        const totalMs = Date.now() - t0;
        send("complete", {
          articleId: article.id,
          wordCount: countWords(articleContent),
          references: globalRefs.length,
          sections: generatedParagraphs.length,
          totalMs,
          pipeline: "v2",
          accuracy: {
            droppedKeys: stats.droppedKeys,
            strippedNumeric: stats.strippedNumeric,
            gateRetries: stats.gateRetries,
            zeroCitationRetries: stats.zeroCitationRetries,
            preprintDuplicatesDropped: stats.preprintDuplicatesDropped,
            citationsChecked: stats.citationsChecked,
            citationsRemoved: stats.citationsRemoved,
            citationsFlagged: stats.citationsFlagged,
            auditBlockingErrors: audit.summary.blockingErrors,
            auditTopicalityWarnings: audit.summary.suspect + audit.summary.unsupported,
            auditOrphans: audit.summary.orphan,
          },
          message: `v2 pipeline complete: ${countWords(articleContent)} words, ${globalRefs.length} references, ${stats.citationsChecked} citations adversarially verified (${stats.citationsRemoved} removed).`,
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
