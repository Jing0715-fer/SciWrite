import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  verifySourcesWithKnowledge,
  verifyMissingViaPubMed,
  verifyMissingViaCrossref,
  applyKnowledgeCompletions,
  backfillFromExternalIds,
  persistKnowledgeSuggestions,
  type KVSourceInput,
} from "@/lib/knowledge-verify";
import {
  VERIFY_BATCH_SIZE,
  VERIFY_REMOVE_CONFIDENCE,
  REPAIR_MAX_REVISIONS,
} from "@/lib/v2-config";
import { logger } from "@/lib/logger";
import { webSearch } from "@/lib/ai";
import { chatWithSession, chatWithSessionStream, clearSession } from "@/lib/llm-session";
import { queryDatabase } from "@/lib/databases";
import { countWords, sanitizeSectionContent } from "@/lib/writing";
import { generateArticleTitle, retranslateTitleZhWithGlossary } from "@/lib/article-title";
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
import { PipelineProgressTracker } from "@/lib/progress-tracker";
import {
  countBySource,
  dedupePreprintVersions,
  ensurePrimaryPaperCoverage,
  generateWebSearchQueries,
  inferFormat,
  removeCrossSectionDuplicates,
  trailingUncitedClaimWords,
  uncitedAssertionSentences,
  safeParseJSON,
} from "@/lib/generate-full-helpers";
// round-57 (P0-1): mechanical source-tier gate — hospital/news/encyclopedia/
// gene-portal web pages are partitioned out of the citation pool before the
// plan/analyze/allocate stages ever see them. Fail-safe: an empty result
// keeps the unfiltered pool (the run never bricks on a classification).
import { partitionCitablePool } from "@/lib/source-tier";
// round-59: in-pipeline auto review & repair — review findings (including
// the round-57 fact-check verdicts) are REPAIRED before translation, so one
// click yields a final, fact-hardened, bilingual article instead of
// "here are the problems, go fix them yourself".
import {
  actionableFindings,
  renormalizeArticleCitations,
  restoreOriginalHeadings,
  revisionGuard,
  reviseArticleCore,
  reviseArticleScoped,
  reviewArticleCore,
  splitBodySections,
} from "@/lib/review-engine";
// round-42: importance-driven citation planning — score every source,
// curate with a dynamic count, fetch full texts, co-plan outline+citations.
import {
  buildFullTextProfiles,
  scoreSources,
  smartCurateReferences,
  fetchFullTextsForRefs,
  formatScoredRefLine,
  validateSectionCitationPlan,
  synthesizeBackfillScore,
  typicalCitationCount,
  type SourceScore,
} from "@/lib/citation-planner";
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
 *   1.5 knowledge  — ★ round-33: cross-check gathered sources against the
 *                    LLM's own knowledge: fill MISSING metadata (authors/
 *                    year/journal/doi, fill-gaps-only) and close coverage
 *                    gaps with LLM-suggested sources (PubMed-verified
 *                    before they can be cited; unverified ones saved as
 *                    flagged, non-citable suggestions)
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
      const rawSend = (event: string, data: any) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event, ...data })}\n\n`));
        } catch {
          isClosed = true;
        }
      };
      // round-52: honest progress bar. The old bar was
      // (stepIndex+1)/totalSteps — the generate/verify loop (N sections ×
      // LLM write + adversarial check, 60-80% of wall clock) got a fixed
      // ~10%+10% share, and the per-section event interleave
      // (generate.started §i → verify.started §i → generate.started §i+1)
      // made the bar oscillate 8→9→8→9 across the whole loop. The tracker
      // gives loop families a bar region proportional to unitWeight × N,
      // learns the real section count from the plan event, and only ever
      // emits monotonic values. `progress` rides on every step event.
      const trackerBothMode = (body.language || "English") === "both";
      const progressTracker = new PipelineProgressTracker([
        { step: "gather", weight: 2.2 },
        { step: "knowledge", weight: 1.4 },
        { step: "score", weight: 0.9 },
        { step: "curate", weight: 0.7 },
        { step: "plan", weight: 0.9 },
        { step: "analyze", weight: 1.1 },
        { step: "allocate", weight: 0.2 },
        // generate+verify interleave PER SECTION — consecutive loop phases
        // share one family region so the bar sweeps forward through the
        // whole loop instead of bouncing between two step slots.
        { step: "generate", unitWeight: 2 },
        { step: "verify", unitWeight: 0.9 },
        { step: "compose", weight: 0.5 },
        // round-59: auto review & repair between compose and translate —
        // external fact-check + peer review + surgical revision run BEFORE
        // the Chinese half exists (the final EN text is translated once).
        { step: "repair", weight: 1.2 },
        ...(trackerBothMode ? [{ step: "translate", unitWeight: 0.75 }] : []),
      ]);
      const send = (event: string, data: any) => {
        if (event === "step" && data && typeof data === "object") {
          const progress = progressTracker.onEvent(data);
          if (progress != null) {
            rawSend(event, { ...data, progress });
            return;
          }
        }
        if (event === "complete") progressTracker.finish();
        rawSend(event, data);
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
        // round-33: knowledge cross-check telemetry
        knowledgeFieldsCompleted: 0,
        knowledgeDbFieldsCompleted: 0,
        knowledgeSourcesAdded: 0,
        knowledgeCrossrefAdded: 0,
        knowledgePromoted: 0,
        knowledgeUnverified: 0,
        // round-42: citation-planning telemetry
        citationPlanned: 0,
        citationCoreCovered: 0,
        citationLLMDriven: false,
        fullTextsUsed: 0,
        // round-57: source-tier / uncited-assertion / verify-retry telemetry
        sourceTierDropped: 0,
        uncitedAssertionRetries: 0,
        citationsUnverified: 0,
        outOfRangeCitationsStripped: 0,
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
        // round-41: 0 = unlimited for the two query caps (same 9999-sentinel
        // contract as v1); omitted params also default to unlimited. maxTokens
        // default 20480, upper bound 81920 (was 16384/32768).
        const rawDbQ = body.maxDbQueries ?? 0;
        const rawWebQ = body.maxWebSearchQueries ?? 0;
        const maxTokens = Math.max(4096, Math.min(81920, body.maxTokens ?? 20480));
        const maxDbQueries = rawDbQ === 0 ? 9999 : Math.max(5, Math.min(50, rawDbQ));
        const maxWebSearchQueries = rawWebQ === 0 ? 9999 : Math.max(3, Math.min(20, rawWebQ));
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

        // ============ round-61 (P2): RESUME an interrupted run ============
        // If the latest checkpoint set for this project matches the CURRENT
        // topic, the in-memory pipeline state (citation pool / plan /
        // completed sections) is restored and gather→allocate are skipped —
        // a provider outage mid-run no longer restarts from zero. Checkpoints
        // are deleted on successful completion and purged when the topic
        // changes, so a "resumable" state never leaks into a different article.
        let curatedRefs: any[] = [];
        let fullTexts: Map<string, string> = new Map();
        let sections: any[] = [];
        let allocations: any[] = [];
        let previousSectionsDigest = "";
        const sectionsCheckpointData: { title: string; content: string; refs: any[] }[] = [];
        // round-61: hoisted from STEP 1 (fresh-run scope) — the complete-event
        // stats read .length even on a resumed run.
        const savedDataSources: any[] = [];
        const savedReferences: any[] = [];
        let resume: {
          runId: string;
          pool: { curatedRefs: any[]; fullTexts: [string, string][]; sections: any[]; allocations: any[] };
          sectionsDone: { title: string; content: string; refs: any[] }[] | null;
        } | null = null;
        try {
          const latestCp = await db.pipelineCheckpoint.findFirst({
            where: { projectId },
            orderBy: { updatedAt: "desc" },
          });
          if (
            latestCp &&
            (latestCp.topic || "").trim().toLowerCase() === project.topic.trim().toLowerCase()
          ) {
            const poolCp = await db.pipelineCheckpoint.findUnique({
              where: { runId_stage: { runId: latestCp.runId, stage: "pool" } },
            });
            if (poolCp) {
              const pool = JSON.parse(poolCp.payload);
              let sectionsDone: any[] | null = null;
              const secCp = await db.pipelineCheckpoint.findUnique({
                where: { runId_stage: { runId: latestCp.runId, stage: "sections" } },
              });
              if (secCp) {
                const parsed = JSON.parse(secCp.payload);
                if (Array.isArray(parsed) && parsed.length > 0) sectionsDone = parsed;
              }
              resume = { runId: latestCp.runId, pool, sectionsDone };
            }
          }
        } catch (resumeErr: any) {
          log(`resume: checkpoint load failed — fresh run: ${String(resumeErr?.message ?? resumeErr).slice(0, 120)}`);
        }
        const activeRunId = resume?.runId || crypto.randomUUID();

        if (resume) {
          // ---- RESTORE PATH: rebuild the in-memory state + DB paragraphs ----
          send("step", {
            step: "gather",
            status: "skipped",
            resumed: true,
            message:
              `Resuming the interrupted run — the citation pool and plan are restored from the last checkpoint` +
              `${resume.sectionsDone ? `, plus ${resume.sectionsDone.length} completed section(s)` : ""}. Gather → allocate skipped.`,
          });
          log(
            `resume: run ${activeRunId.slice(0, 8)} — pool=${resume.pool.curatedRefs.length} refs, ${resume.pool.sections.length} sections planned, ${resume.sectionsDone?.length ?? 0} section(s) done`,
          );

          await clearSession(projectId);

          // Snapshot for THIS resumed run's rollback hygiene (same shape as
          // STEP 1's fresh-run snapshot).
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
          hadPriorWork = snapshot.paragraphs.length > 0 || snapshot.dataSources.length > 0;

          // round-63 (resume bug fix): RESTORE the pipeline's working state
          // from the checkpoint pool. The round-61 resume path logged
          // "pool=25 refs, 9 sections planned" but never ASSIGNED the pool
          // back into the route's working variables — a resumed run
          // proceeded with curatedRefs/sections/allocations all EMPTY
          // ("Generating 0 sections" → "All sections failed to generate").
          // The checkpoint write/lifecycle was verified in round-61 but the
          // RESTORE path was never actually exercised until now.
          curatedRefs = Array.isArray(resume.pool.curatedRefs)
            ? resume.pool.curatedRefs
            : [];
          fullTexts = new Map<string, string>(
            Array.isArray(resume.pool.fullTexts) ? resume.pool.fullTexts : [],
          );
          sections = (Array.isArray(resume.pool.sections) ? resume.pool.sections : [])
            .filter((s: any) => s?.title && s?.targetWords);
          allocations = Array.isArray(resume.pool.allocations)
            ? resume.pool.allocations
            : [];
          // The generate loop reads allocations[i].refIndices — a checkpoint
          // saved before allocation completed (or a hand-edited payload) may
          // be short; pad with empty allocations so the loop's top-up path
          // (sectionRefs from curated list) handles it.
          while (allocations.length < sections.length) allocations.push({ refIndices: [] });

          // The checkpoint is the AUTHORITATIVE state for sections — clear
          // whatever partial paragraphs exist (a failed run may have KEPT
          // its partial work) and re-create them from the checkpoint so the
          // compose stage and the workspace stay consistent. Data sources
          // are NOT cleared: they are real gathered data, only cosmetic here.
          await db.$transaction([
            db.annotation.deleteMany({ where: { paragraph: { projectId } } }),
            db.articleParagraph.deleteMany({ where: { paragraph: { projectId } } }),
            db.paragraph.deleteMany({ where: { projectId } }),
            db.reference.deleteMany({ where: { projectId } }),
          ]);

          // (gather stats: the gather itself ran in the interrupted run —
          // count what it left in the DB so the completion stats stay honest)
          try {
            savedDataSources.push(
              ...(await db.dataSource.findMany({ where: { projectId }, select: { id: true } })),
            );
            savedReferences.push(
              ...(await db.reference.findMany({ where: { projectId }, select: { id: true } })),
            );
          } catch {}

          if (resume.sectionsDone) {
            for (let i = 0; i < resume.sectionsDone.length; i++) {
              const sd = resume.sectionsDone[i];
              const paragraph = await db.$transaction(async (tx) => {
                const p = await tx.paragraph.create({
                  data: {
                    projectId,
                    title: sd.title,
                    content: sd.content,
                    format: inferFormat(sd.title, i, resume!.pool.sections.length),
                    scenario: "literature-review",
                    status: "draft",
                    order: i,
                    wordCount: countWords(sd.content),
                  },
                });
                if (sd.refs?.length > 0) {
                  await tx.reference.createMany({
                    data: sd.refs.map((ref: any, idx: number) => ({
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
                title: sd.title,
                wordCount: paragraph.wordCount,
              });
              sectionsCheckpointData.push({ title: sd.title, content: sd.content, refs: sd.refs || [] });
            }
            // Rebuild the continuity digest with the same mechanical logic
            // the generate loop uses (claim-level, last 24 lines).
            for (let i = 0; i < resume.sectionsDone.length; i++) {
              const sd = resume.sectionsDone[i];
              const claimSentences = sd.content
                .split(/(?<=[.!?])\s+/)
                .filter((s: string) => /\[\d/.test(s))
                .slice(0, 6)
                .map((s: string) => s.replace(/\s+/g, " ").replace(/^[-•*]\s*/, "").slice(0, 150));
              const digestEntry =
                `§${i + 1} "${sd.title}" established:\n` +
                (claimSentences.length > 0
                  ? claimSentences.map((s: string) => `- ${s}`).join("\n")
                  : `- (opening: ${sd.content.slice(0, 140).replace(/\n+/g, " ")}...)`);
              previousSectionsDigest = (previousSectionsDigest + "\n" + digestEntry)
                .split("\n")
                .filter(Boolean)
                .slice(-24)
                .join("\n");
            }
          }
        } else {
          // Fresh run: purge stale checkpoints from older interrupted runs.
          try {
            await db.pipelineCheckpoint.deleteMany({ where: { projectId } });
          } catch {}
        }

        if (!resume) {
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

Design ${maxDbQueries >= 9999
          ? "a comprehensive multi-database search plan with as many well-chosen queries as the topic needs for MAXIMUM coverage (no fixed limit — but keep the JSON under 4000 characters to avoid output truncation)"
          : `a focused search plan with ${Math.max(5, maxDbQueries - 4)}-${maxDbQueries} well-chosen queries (NOT more — too many causes JSON truncation)`
        }.
Distribute across databases: mostly PubMed (reviews, mechanisms, diseases, methods), a few RCSB structure searches, a few UniProt gene-name searches, 1-2 NCBI gene searches.
CRITICAL: every query must center on the primary molecule's symbol or specific name (e.g. "TMC1 cryo-EM structure", "transmembrane channel-like protein 1") — NEVER a generic descriptor phrase (e.g. "membrane protein complex structure") whose common words full-text-match thousands of unrelated entries.

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
              // round-50: searchOpts adds query variant expansion (TMC1 /
              // TMC-1 / TMC 1 …) + LLM relevance filtering, with the project
              // topic as organism/context disambiguator.
              return await queryDatabase(database as any, query, {
                searchOpts: { context: project.topic },
              });
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
                // round-35: the search host is NOT an author — storing it as
                // one put "www.nature.com" in authors for 40 rows of real
                // project data. extra.host keeps the provenance display.
                authors: undefined,
                // round-35: dates like "Jul 15, 2024" sliced to "Jul " —
                // extract a real 4-digit year or leave empty for the
                // knowledge pass to fill.
                year: item.date?.match(/\b(19|20)\d{2}\b/)?.[0] || undefined,
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

        // (savedDataSources / savedReferences are declared in the round-61
        // hoisted block above — populated here during gather, or from the DB
        // on resume — the complete-event stats read .length in both cases.)
        let skippedTitleless = 0;
        for (const item of uniqueItems) {
          // round-51 junk guard: an item with no real title (missing, or just
          // the external ID — the RCSB metadata-fetch failure fallback) is
          // unverifiable and un-citable; saving it floods the knowledge panel
          // with bare-ID cards (the exact 6VYM/2QTS/5W2O/5W2Q defect).
          const itemTitle = String(item.title || "").trim();
          if (!itemTitle || itemTitle === String(item.externalId || "")) {
            skippedTitleless++;
            log(`gather: skipped titleless item ${item.source}:${item.externalId || item.url || "?"}`);
            continue;
          }
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
        if (skippedTitleless > 0) {
          log(`gather: junk guard skipped ${skippedTitleless} titleless item(s) — not saved`);
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

        // ============ STEP 1.5: Knowledge cross-check (round-33/35) ============
        // The user observed two classes of gather gaps: (a) sources saved
        // with missing metadata, (b) important works the searches never
        // surfaced. This stage closes both, DATABASE-FIRST then LLM:
        //   0. backfill — PMID-backed rows completed from PubMed's own
        //      records (zero hallucination risk) + web-gather garbage reset
        //      (domain-as-authors, month-fragment years, sentinel journals);
        //   A. LLM fills MISSING fields (authors/year/journal) — fill-gaps-
        //      only, real DB data is never overwritten;
        //   B. LLM-suggested missing sources looked up in PubMed BY TITLE;
        //      B'. leftovers re-tried in Crossref (DOI registry + biblio
        //      search) — only confirmed matches enter the citable pool;
        //      unmatched suggestions are saved flagged (extra.unverified)
        //      for review but are NOT citable, protecting the article from
        //      hallucinated refs.
        send("step", {
          step: "knowledge",
          status: "started",
          message: "Cross-checking gathered sources with LLM knowledge...",
        });
        {
          // 0. Authoritative backfill BEFORE the LLM sees anything
          const backfill = await backfillFromExternalIds(
            projectId, savedDataSources, savedReferences, db, { onLog: (m) => log(m) }
          );
          if (backfill.fieldsCompleted || backfill.repairedGarbage) {
            send("step", {
              step: "knowledge",
              status: "progress",
              message: `PubMed backfill: ${backfill.fieldsCompleted} fields completed from PubMed records, ${backfill.repairedGarbage} rows of garbage metadata reset.`,
            });
          }

          const kvInputs: KVSourceInput[] = savedDataSources.map((ds: any) => ({
            id: ds.id,
            source: ds.source,
            externalId: ds.externalId,
            title: ds.title || "",
            authors: ds.authors,
            year: ds.year,
            journal: ds.journal,
            doi: ds.doi,
            abstract: ds.abstract,
          }));
          const kvResult = await verifySourcesWithKnowledge(
            projectId, kvInputs, project.topic, project.field || "life sciences",
            { maxTokens, onLog: (m) => log(m) }
          );
          send("step", {
            step: "knowledge",
            status: "progress",
            message: `LLM knowledge pass done: ${kvResult.completions.length} sources assessed, ${kvResult.missing.length} gap suggestions.`,
          });

          // A. apply metadata completions (fills only)
          const applied = await applyKnowledgeCompletions(
            projectId, savedDataSources, savedReferences, kvResult.completions, db,
            { onLog: (m) => log(m) }
          );

          // B. PubMed channel, then B'. Crossref for the leftovers — both
          // at the same ≥0.72 normalized-title similarity bar.
          const pubmed = await verifyMissingViaPubMed(
            kvResult.missing, { onLog: (m) => log(m) }
          );
          const crossref = pubmed.unverified.length
            ? await verifyMissingViaCrossref(pubmed.unverified, { onLog: (m) => log(m) })
            : { verified: [], unverified: [] };
          const allVerified = [...pubmed.verified, ...crossref.verified];

          // C. Shared persist (round-35): verified items become citable
          // data sources + references (previously-unverified rows matching a
          // verified work are PROMOTED in place instead of duplicated);
          // leftovers saved flagged + non-citable. onSaved keeps the
          // in-memory arrays in sync so curate sees everything.
          const persisted = await persistKnowledgeSuggestions(
            projectId, allVerified, crossref.unverified, db,
            {
              onLog: (m) => log(m),
              onSaved: (ds: any, ref: any) => {
                if (ds) savedDataSources.push(ds);
                if (ref) savedReferences.push(ref);
              },
            }
          );

          stats.knowledgeFieldsCompleted = applied.fieldsCompleted + backfill.fieldsCompleted;
          stats.knowledgeDbFieldsCompleted = backfill.fieldsCompleted;
          stats.knowledgeSourcesAdded = persisted.addedSources.length;
          stats.knowledgeCrossrefAdded = persisted.addedSources.filter((s: any) => s.source === "crossref").length;
          stats.knowledgePromoted = persisted.promoted;
          stats.knowledgeUnverified = persisted.unverifiedSaved.length;
          send("step", {
            step: "knowledge",
            status: "done",
            fieldsCompleted: applied.fieldsCompleted + backfill.fieldsCompleted,
            sourcesAdded: persisted.addedSources.length,
            crossrefAdded: stats.knowledgeCrossrefAdded,
            promoted: persisted.promoted,
            unverified: persisted.unverifiedSaved.length,
            message:
              `Knowledge cross-check: ${applied.fieldsCompleted + backfill.fieldsCompleted} missing fields completed` +
              ` (${applied.sourcesCompleted + backfill.sourcesCompleted} sources), ${persisted.addedSources.length} gap sources verified & added` +
              `${stats.knowledgeCrossrefAdded ? ` (${stats.knowledgeCrossrefAdded} via Crossref)` : ""}` +
              `${persisted.promoted ? `, ${persisted.promoted} previously-unverified suggestions promoted` : ""}` +
              `${persisted.unverifiedSaved.length ? `, ${persisted.unverifiedSaved.length} unverified suggestions saved for review` : ""}.`,
            detail: persisted.addedSources
              .slice(0, 6)
              .map((v: any) => `+ ${String(v.title).slice(0, 60)}${v.journal ? ` (${String(v.journal).slice(0, 24)}, ${v.year || "n.d."})` : ""}`)
              .join(" | "),
          });
          log(
            `knowledge: ${applied.fieldsCompleted + backfill.fieldsCompleted} fields filled (${backfill.fieldsCompleted} from PubMed records) on ` +
              `${applied.sourcesCompleted + backfill.sourcesCompleted} sources; ${persisted.addedSources.length} verified gap sources added ` +
              `(${stats.knowledgeCrossrefAdded} via Crossref, ${persisted.promoted} promoted); ${persisted.unverifiedSaved.length} unverified suggestions saved`
          );
        }

        // ============ STEP 1.7: Score source importance (round-42) ============
        // 先对文献重要性打分：LLM scores EVERY gathered source for topical
        // relevance + scholarly importance, with the mechanical full-text
        // profile (PMC free article / deep-read summary) as an understanding-
        // depth tiebreaker. The preprint dedupe runs BEFORE scoring so the
        // scores align with the deduplicated pool the curator will see.
        send("step", {
          step: "score",
          status: "started",
          message: `Scoring ${savedReferences.length} sources for importance (relevance × importance × full-text depth)...`,
        });
        // ★ round-14 (moved up from the curate step): mechanically drop
        // preprint duplicates of published works BEFORE scoring/curation, so
        // the same work can never enter the article twice.
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
        const fullTextProfiles = buildFullTextProfiles(deduped.refs, savedDataSources);
        const scoring = await scoreSources(
          projectId,
          deduped.refs,
          fullTextProfiles,
          project.topic,
          project.field || "life sciences",
          {
            maxTokens,
            onProgress: (m) => send("step", { step: "score", status: "progress", message: m }),
          }
        );
        const allScores = scoring.scores;
        {
          const core = allScores.filter((s) => s.tier === "core").length;
          const important = allScores.filter((s) => s.tier === "important").length;
          const marginal = allScores.length - core - important;
          const withFullText = allScores.filter((s) => s.depth === "fulltext").length;
          send("step", {
            step: "score",
            status: "done",
            scoredCount: allScores.length,
            coreCount: core,
            importantCount: important,
            marginalCount: marginal,
            fullTextCount: withFullText,
            llmBatches: scoring.llmBatches,
            fallbackBatches: scoring.fallbackBatches,
            message: `Scored ${allScores.length} sources: ${core} core / ${important} important / ${marginal} marginal (${withFullText} with full text available).`,
          });
          log(`score: ${allScores.length} sources — core=${core} important=${important} marginal=${marginal} fulltext=${withFullText} llmBatches=${scoring.llmBatches} fallbackBatches=${scoring.fallbackBatches}`);
        }

        // ============ STEP 2: Curate — dynamic citation count (round-42) ============
        // The LLM now decides HOW MANY references the article genuinely
        // needs from the scored pool (bounded by guardrails), instead of the
        // old fixed-count selection. A thin pool yields a smaller citation
        // list; a rich pool feeding a short article drops marginal sources.
        send("step", {
          step: "curate",
          status: "started",
          message: `Selecting the citation pool — the count follows source quality, not a fixed quota...`,
        });
        const smart = await smartCurateReferences(
          projectId,
          deduped.refs,
          allScores,
          project.topic,
          project.field || "life sciences",
          targetWords,
          {
            maxTokens,
            onProgress: (m) => send("step", { step: "curate", status: "progress", message: m }),
          }
        );
        curatedRefs = smart.refs;
        let curatedScores = smart.scores;
        stats.citationPlanned = smart.plannedCount;
        stats.citationLLMDriven = smart.llmDriven;
        send("step", {
          step: "curate",
          status: "done",
          curatedCount: curatedRefs.length,
          plannedCitations: smart.plannedCount,
          llmDriven: smart.llmDriven,
          message: `Citation pool: ${curatedRefs.length} of ${deduped.refs.length} scored sources selected for a ${targetWords}-word article (typical density ~${typicalCitationCount(targetWords)}).`,
          detail: smart.rationale,
        });
        log(`curate: ${curatedRefs.length}/${deduped.refs.length} refs — plannedCitations=${smart.plannedCount} llmDriven=${smart.llmDriven} — ${smart.rationale}`);

        // ============ STEP 2.2 (round-57 P0-1): Source-tier gate ============
        // The curate LLM scores topical relevance, not SOURCE TIER — a
        // hospital outreach page about the topic scores REL 8/10 while being
        // useless as first-class evidence (round-56: [19] was a Boston
        // Children's popular-science page standing in for Askew 2015). This
        // mechanical pass partitions non-primary WEB pages (hospital/media/
        // encyclopedia/gene-portal) out of the pool. Database-typed refs
        // (pubmed/rcsb/uniprot) are exempt; empty-result falls back to the
        // unfiltered pool rather than bricking the run.
        {
          const tier = partitionCitablePool(curatedRefs, curatedScores);
          if (tier.dropped.length > 0 && !tier.fellBackToUnfiltered) {
            stats.sourceTierDropped = tier.dropped.length;
            log(
              `source-tier: dropped ${tier.dropped.length} non-primary web source(s) — ` +
                tier.dropped.map((d) => `[${d.reason}]`).join(" | "),
            );
            send("step", {
              step: "curate",
              status: "progress",
              message: `Source-tier gate: ${tier.dropped.length} non-primary web source(s) removed from the citation pool (${curatedRefs.length} → ${tier.keptRefs.length}).`,
              detail: tier.dropped.map((d) => `dropped: ${d.reason} — ${String(d.ref?.title || "").slice(0, 70)}`).join("\n"),
            });
            curatedRefs = tier.keptRefs;
            curatedScores = tier.keptScores;
          } else if (tier.fellBackToUnfiltered) {
            log(`source-tier: gate would have emptied the pool (${tier.dropped.length} candidates) — kept unfiltered pool as fail-safe`);
            send("step", {
              step: "curate",
              status: "progress",
              message: `Source-tier gate skipped — every candidate was non-primary; pool kept unfiltered as fail-safe.`,
            });
          }
        }

        // ============ STEP 2.5: Fetch full texts for the pool (round-42) ============
        // 能获取到全文的一定要看全文：the pool arrives priority-ordered, so
        // the fetch budget goes to the most important sources first. Deep-read
        // summaries ride along free; PMC fetches are capped at 8 × 15k chars.
        send("step", {
          step: "curate",
          status: "progress",
          message: `Fetching full texts for the highest-priority sources (enables deeper discussion)...`,
        });
        fullTexts = await fetchFullTextsForRefs(curatedRefs, fullTextProfiles, {
          maxCount: 8,
          maxChars: 15000,
          onProgress: (m, extra) => send("step", { step: "curate", status: "progress", message: m, ...extra }),
        });
        stats.fullTextsUsed = fullTexts.size;
        send("step", {
          step: "curate",
          status: "progress",
          message: `Full-text stage complete: ${fullTexts.size} source(s) readable in depth.`,
        });
        log(`fulltext: ${fullTexts.size} sources with full text/deep-read content`);

        // ============ STEP 3: Plan outline + citation map (round-42) ============
        // 先根据主题、长度确定大纲和引用哪些参考文献，再细化内容：the plan
        // now co-designs the outline AND which pool sources each section
        // cites — the allocation stage downstream only refines this map.
        send("step", {
          step: "plan",
          status: "started",
          message: `Planning the outline + citation map for a ${targetWords}-word article from ${curatedRefs.length} scored sources...`,
        });
        const planSystem =
          "You are a senior research advisor who designs publication-ready review outlines. " +
          "Plan sections with target word counts that sum to the total, AND decide which references each section cites. " +
          "Prefer MORE sections with SMALLER targets.";
        const scoredPoolLines = curatedRefs
          .slice(0, 40)
          .map((r: any, i: number) => formatScoredRefLine(r, curatedScores[i], i + 1))
          .join("\n");
        const planPrompt = `RESEARCH TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}
TARGET TOTAL WORDS: ${targetWords}
CITATION POOL: ${curatedRefs.length} scored sources — the article's citations come ONLY from this pool.

SCORED SOURCES (sorted by citation priority — CORE > IMPORTANT > MARGINAL):
${scoredPoolLines}

Plan a comprehensive review article with ${Math.max(5, Math.ceil(targetWords / 400))}-${Math.max(8, Math.ceil(targetWords / 300))} sections.
Each section 200-450 words. Sections must cover DISTINCT aspects of the topic.

CITATION PLANNING — design the outline AND the citations TOGETHER:
- For EACH section, list the pool sources it will cite as "refIndices" (the [n] numbers above).
- Every CORE source must be cited by at least one section.
- MARGINAL sources may be dropped entirely — never cite a source that does not fit a section's focus just to use it.
- A ${targetWords}-word review typically cites ~${typicalCitationCount(targetWords)} references in total; let the pool and the section needs decide the final count — do not pad.
- Give each section 2-6 refIndices (more for evidence-dense sections, fewer for outlook/perspective sections).
- Sources with FULL TEXT: yes support deeper claims — favor them for sections needing mechanistic or quantitative detail.

Respond as STRICT JSON:
{
  "sections": [
    { "title": "descriptive title", "focus": "what this section covers", "targetWords": 300, "refIndices": [1, 4, 7] }
  ]
}
Output JSON only.`;

        // round-63 (storm-proofing): the plan call is the KEYSTONE of the
        // whole pipeline — everything before the pool checkpoint (gather →
        // knowledge → score → curate → plan) is unrecoverable work, and the
        // provider's account-level 429 storms (rounds 60/62/63: they hit
        // mid-run and last minutes-to-hours) used to make this single call
        // FATAL after only the rate limiter's 5×≤30s retries. The storm
        // wrapper waits out the storm instead: up to 6 attempts with 4-min
        // waits (the rate limiter's abort flag self-expires after 2 min, so
        // each retry starts clean).
        const stormRetry = async <T,>(label: string, fn: () => Promise<T>, attempts = 6, waitMs = 4 * 60_000): Promise<T> => {
          for (let a = 1; ; a++) {
            try {
              return await fn();
            } catch (e: any) {
              const msg = String(e?.message ?? e);
              if (!/429|too many|rate.?limit|quota/i.test(msg) || a >= attempts) throw e;
              log(`${label}: provider throttled (attempt ${a}/${attempts}) — waiting 4 min for the storm to pass`);
              send("step", {
                step: "plan",
                status: "progress",
                message: `${label}: provider rate-limited (attempt ${a}/${attempts}) — waiting out the 429 storm before retrying...`,
              });
              await new Promise((r) => setTimeout(r, waitMs));
            }
          }
        };

        const planRaw = await stormRetry("plan", () => chatWithSession(projectId, planPrompt, {
          system: planSystem,
          temperature: 0.5,
          taskType: "plan",
          maxTokens,
          metadata: { step: "plan", targetWords },
        }));
        const planParsed = safeParseJSON(planRaw, { sections: [] });
        sections = (planParsed.sections || []).filter((s: any) => s.title && s.targetWords);

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
          // round-42: re-align the score array with the post-backfill pool
          // BEFORE citation-plan validation. Replacements swap the ref at an
          // index (plan refIndices pointing there are stale → stripped below;
          // core-retention re-adds the new primary paper deliberately);
          // appends extend the array. Every backfilled paper gets a
          // synthesized CORE score so the validator force-retains it.
          const scoreByTitle = new Map<string, SourceScore>();
          curatedRefs.forEach((r: any, i: number) => {
            const key = `${String(r?.title || "").toLowerCase().trim()}|${String(r?.doi || r?.url || r?.externalId || "").toLowerCase()}`;
            scoreByTitle.set(key, curatedScores[i]);
          });
          const staleIndices = new Set<number>();
          for (const b of coverage.backfilled) {
            if (!b.replacedTitle) continue;
            const idx = coverage.refs.findIndex((r: any) => String(r.title || "") === b.addedTitle);
            if (idx >= 0) staleIndices.add(idx + 1);
          }
          curatedRefs = coverage.refs;
          curatedScores = coverage.refs.map((r: any, i: number) => {
            const key = `${String(r?.title || "").toLowerCase().trim()}|${String(r?.doi || r?.url || r?.externalId || "").toLowerCase()}`;
            const found = scoreByTitle.get(key);
            if (found) return { ...found, index: i + 1 };
            return { ...synthesizeBackfillScore(r, fullTextProfiles.get(r.id)), index: i + 1 };
          });
          if (staleIndices.size > 0) {
            for (const s of sections) {
              if (Array.isArray(s.refIndices)) {
                s.refIndices = s.refIndices.filter((n: any) => !staleIndices.has(parseInt(String(n), 10)));
              }
            }
          }
          stats.coverageBackfills = coverage.backfilled;
          // round-57 fix: the backfill pulls from the PRE-curation pool
          // (deduped.refs) which bypassed the STEP 2.2 source-tier gate —
          // the E2E run's [therapy] signal re-imported a Boston Children's
          // hospital page AFTER the gate had dropped its siblings. Re-run
          // the mechanical tier partition on the post-backfill pool so every
          // appended web source faces the same non-primary check.
          const backfillTier = partitionCitablePool(coverage.refs, curatedScores);
          if (backfillTier.dropped.length > 0 && !backfillTier.fellBackToUnfiltered) {
            log(
              `source-tier (post-backfill): dropped ${backfillTier.dropped.length} non-primary web source(s) — ` +
                backfillTier.dropped.map((d) => `[${d.reason}] ${String(d.ref?.title || "").slice(0, 50)}`).join(" | "),
            );
            send("step", {
              step: "plan",
              status: "progress",
              message: `Source-tier gate (post-backfill): ${backfillTier.dropped.length} non-primary web source(s) removed from the backfilled pool.`,
            });
            curatedRefs = backfillTier.keptRefs;
            curatedScores = backfillTier.keptScores;
            stats.sourceTierDropped += backfillTier.dropped.length;
          }
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

        // round-42: enforce the joint outline+citation plan mechanically —
        // validate indices, top thin sections up to 2 refs in pool-priority
        // order (never forcing relevance < 4 sources), and force-retain every
        // CORE-tier source in its best-matching section (重要引用持续保留).
        const citationPlanSummary = validateSectionCitationPlan(
          sections,
          curatedRefs,
          curatedScores,
          { key: "refIndices", minPerSection: 2, maxPerSection: 12 },
        );
        stats.citationPlanned = citationPlanSummary.totalPlanned;
        stats.citationCoreCovered = citationPlanSummary.coreCovered;
        send("step", {
          step: "plan",
          status: "progress",
          message: `Citation map: ${citationPlanSummary.totalPlanned}/${curatedRefs.length} pool sources cited — ${citationPlanSummary.coreCovered} core retained${citationPlanSummary.toppedUp ? `, ${citationPlanSummary.toppedUp} priority top-up(s)` : ""}${citationPlanSummary.coreMissing ? `, ${citationPlanSummary.coreMissing} core UNCOVERED (sections at capacity)` : ""}.`,
        });
        log(
          `plan: citation map — ${citationPlanSummary.totalPlanned}/${curatedRefs.length} cited, coreCovered=${citationPlanSummary.coreCovered}, coreMissing=${citationPlanSummary.coreMissing}, toppedUp=${citationPlanSummary.toppedUp}`
        );

        // ============ STEP 4: ★ Analyze — extract evidence bank ============
        // round-42: full texts ride along — refs whose full text was fetched
        // get a ~900-char excerpt in the analysis prompt, so their extracted
        // claims come from the COMPLETE article, deeper than abstract-only
        // refs (能获取到全文的一定要看全文).
        send("step", {
          step: "analyze",
          status: "started",
          message: `Analyzing ${curatedRefs.length} sources and extracting an evidence bank (${fullTexts.size} with full text)...`,
        });

        const evidenceBank = await extractEvidenceBank(
          projectId,
          curatedRefs as EvidenceRefInput[],
          project.topic,
          project.field || "life sciences",
          { maxRefs: Math.min(curatedRefs.length, 40), batchSize: 14, maxTokens, fullTexts }
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
        // round-42: the plan stage already co-designed the citation map —
        // pass it as the pre-allocation so this stage validates + tops up
        // instead of re-deciding from scratch. minRefsPerSection drops 5→3:
        // a thin pool must not be padded with irrelevant sources just to
        // reach a per-section quota (数据源有限时宁缺毋滥).
        send("step", { step: "allocate", status: "started", message: "Allocating references + evidence to sections per the citation map..." });

        const preallocatedRefs = sections.map((s: any) =>
          Array.isArray(s.refIndices) ? s.refIndices : []
        );
        const hasPreallocation = preallocatedRefs.some((a) => a.length > 0);
        allocations = await allocateEvidenceToSections(
          projectId,
          sections,
          curatedRefs as EvidenceRefInput[],
          evidenceBank,
          project.topic,
          {
            minRefsPerSection: 3,
            maxRefsPerSection: 12,
            maxTokens,
            ...(hasPreallocation ? { preallocatedRefs } : {}),
          }
        );

        send("step", {
          step: "allocate",
          status: "done",
          message: `Allocated references to ${allocations.length} sections (avg ${Math.round(allocations.reduce((s, a) => s + a.refIndices.length, 0) / Math.max(1, allocations.length))} refs/section${hasPreallocation ? ", from the plan's citation map" : ""}).`,
          detail: allocations.map((a, i) => `§${i + 1}: ${a.refIndices.length} refs, ${a.evidence.length} claims (${a.rationale})`).join("\n"),
        });
        log(`allocate: ${JSON.stringify(allocations.map(a => a.refIndices.length))}${hasPreallocation ? " (plan-preallocated)" : ""}`);
        } // end fresh-run phase block (round-61 resume wrap)

        // round-61 (P2): pool checkpoint — everything the generate loop needs,
        // serialized after allocate. Written only on fresh runs (a resumed
        // run already has it). Best-effort: a checkpoint failure must never
        // fail the run.
        if (!resume) {
          try {
            await db.pipelineCheckpoint.upsert({
              where: { runId_stage: { runId: activeRunId, stage: "pool" } },
              create: {
                projectId,
                runId: activeRunId,
                stage: "pool",
                topic: project.topic,
                payload: JSON.stringify({
                  curatedRefs,
                  fullTexts: [...fullTexts.entries()],
                  sections,
                  allocations,
                }),
              },
              update: { payload: JSON.stringify({
                curatedRefs,
                fullTexts: [...fullTexts.entries()],
                sections,
                allocations,
              }), updatedAt: new Date() },
            });
            log(`checkpoint: pool saved (${curatedRefs.length} refs, ${sections.length} sections, ${fullTexts.size} full texts)`);
          } catch (cpErr: any) {
            log(`checkpoint: pool save FAILED (run continues, resume unavailable): ${String(cpErr?.message ?? cpErr).slice(0, 100)}`);
          }
        }

        // ============ STEP 6: Generate sections with keyed citations ============
        send("step", {
          step: "generate",
          status: "started",
          message: `Generating ${sections.length} sections with structural citation keys...`,
        });

        preFlightQuotaCheck("generate-full-v2:pre-flight");

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

          // round-42: full-text excerpts ride into the writer's context so
          // sections citing fetched sources can draw on the complete article.
          const evidenceContext = buildEvidenceContext(allocation, curatedRefs as EvidenceRefInput[], fullTexts);

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
          // round-57 (P1-1): whole-sentence uncited-assertion scan — the
          // trailing-60-words gate missed mid-paragraph fabrications (the
          // Drosophila-first inversion narrated with zero citations).
          const uncitedAssertions = uncitedAssertionSentences(chunkContent);
          const uncitedGate = !zeroCite && uncitedAssertions.length > 0;
          if (zeroCite || trailingGate || uncitedGate || (!gate.ok && (gate.rawNumericMarkers > 0 || gate.outOfRangeKeys > 0))) {
            stats.gateRetries++;
            if (zeroCite) stats.zeroCitationRetries++;
            if (trailingGate) stats.trailingUncitedRetries++;
            if (uncitedGate) stats.uncitedAssertionRetries = (stats.uncitedAssertionRetries || 0) + 1;
            log(`generate: section ${sectionNum} FAILED validation gate (zeroCite=${zeroCite}, trailing=${trailingGate ? `${trailingBlock}w` : "no"}, uncitedAssert=${uncitedGate ? uncitedAssertions.length : 0}, raw=${gate.rawNumericMarkers}, oor=${gate.outOfRangeKeys}) — retrying`);
            send("step", {
              step: "generate",
              status: "progress",
              section: sectionNum,
              total: sections.length,
              message: zeroCite
                ? `Section ${sectionNum}: validation gate triggered (ZERO citations) — retrying with grounding instruction...`
                : trailingGate
                  ? `Section ${sectionNum}: validation gate triggered (trailing ${trailingBlock} uncited claim words) — retrying with grounding instruction...`
                  : uncitedGate
                    ? `Section ${sectionNum}: validation gate triggered (${uncitedAssertions.length} uncited high-risk assertion sentence(s)) — retrying with grounding instruction...`
                    : `Section ${sectionNum}: validation gate triggered (raw numeric markers: ${gate.rawNumericMarkers}) — retrying with corrective instruction...`,
            });
            try {
              const retryPrompt = prompt + (zeroCite
                ? `

CORRECTION: your previous output contained ZERO {{Rn}} citations, but this section has ${sectionRefs.length} citable references allocated to it. A review section must ground its claims in the listed references. Rewrite the SAME section so that every factual claim — including each therapeutic strategy, experimental approach, or projected development — cites the specific listed reference that supports it, using {{Rn}} keys. If a claim cannot be supported by any listed reference, rephrase it as an explicitly open question or replace it with content drawn from the references. Output the corrected section only.`
                : trailingGate
                  ? `

CORRECTION: in your previous output, the last ${trailingBlock} words make substantive factual claims (experimental findings, therapeutic advances, mechanistic assertions) WITHOUT any {{Rn}} citation, while all citations sit earlier in the section. Every claim sentence — especially in closing/outlook paragraphs — must cite the specific listed reference that supports it, using {{Rn}} keys. Rewrite the SAME section, either grounding those trailing claims in the listed references or reframing them as explicitly open questions. Output the corrected section only.`
                  : uncitedGate
                    ? `

CORRECTION: these specific sentences from your previous output make high-risk factual assertions (numbers, existence claims, or first/novel claims) WITHOUT any {{Rn}} citation:
${uncitedAssertions.map((s: string, j: number) => `${j + 1}. "${s}"`).join("\n")}

Every factual assertion of this kind MUST cite the listed reference that supports it ({{Rn}} keys), or be removed/reframed as explicitly open. Do NOT leave checkable claims (specific quantities, existence claims, first-discovery claims) uncited anywhere in the section — including mid-paragraph. Rewrite the SAME section. Output the corrected section only.`
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
              } else if (uncitedGate) {
                improved = uncitedAssertionSentences(sanitizedRetry).length < uncitedAssertions.length;
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
              verifyResult = { checked: 0, removedNums: [], flagged: [], removals: [], llmCalls: 0, unverifiedChecks: 0 } as any;
            } else {
              throw verifyErr;
            }
          }
          stats.citationsChecked += verifyResult.checked;
          stats.citationsRemoved += verifyResult.removedNums.length;
          stats.citationsFlagged += verifyResult.flagged.length;
          if (verifyResult.unverifiedChecks > 0) {
            stats.citationsUnverified = (stats.citationsUnverified || 0) + verifyResult.unverifiedChecks;
          }

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
            message: `Section ${sectionNum} verification: ${verifyResult.checked} citations checked, ${verifyResult.removedNums.length} removed, ${verifyResult.flagged.length} flagged${verifyResult.unverifiedChecks ? `, ${verifyResult.unverifiedChecks} SAVED UNVERIFIED (batch failure)` : ""} (${Date.now() - verifyStart}ms).`,
            detail: verifyResult.removals.map((r) => `[${r.n}] ${r.reason}`).join("\n"),
          });
          log(`verify: section ${sectionNum} — checked=${verifyResult.checked} removed=${verifyResult.removedNums.length} flagged=${verifyResult.flagged.length}${verifyResult.unverifiedChecks ? ` unverified=${verifyResult.unverifiedChecks}` : ""}`);

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

          // round-61 (P2): incremental section checkpoint — after EVERY
          // saved section, so an interruption at §7 of 9 only re-runs §7-9.
          sectionsCheckpointData.push({
            title: section.title,
            content: sectionContent,
            refs: citedRefs,
          });
          try {
            await db.pipelineCheckpoint.upsert({
              where: { runId_stage: { runId: activeRunId, stage: "sections" } },
              create: {
                projectId,
                runId: activeRunId,
                stage: "sections",
                topic: project.topic,
                payload: JSON.stringify(sectionsCheckpointData),
              },
              update: { payload: JSON.stringify(sectionsCheckpointData), updatedAt: new Date() },
            });
          } catch {
            // best-effort — a failed checkpoint write never fails the run
          }

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
          // round-63: this silent exit had NO log line — a run that died
          // here (all sections skipped on client disconnect / rate abort)
          // left no trace in dev.log at all.
          log(`generate: ALL ${sections.length} sections failed/skipped — run aborted (checkpoint kept for resume)`);
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

        // ---- round-57 (P2-1): strip out-of-range citation markers ----
        // The orphan-ref filter below only REMAPS in-range citations when
        // orphans exist; when every real ref is cited (filteredRefs.length
        // === globalRefs.length) its replace pass is skipped entirely and a
        // stray LLM marker like [21] with only 20 refs would survive into
        // the final article pointing at nothing. Mechanical, unconditional:
        // any citation number outside 1..globalRefs.length is dropped from
        // its marker (valid numbers in the same marker are kept).
        {
          const maxGlobal = globalRefs.length;
          let oorStripped = 0;
          const oorRe = /\[(\d+(?:[,\-–\s]\d+)*)\]/g;
          articleBody = articleBody.replace(oorRe, (match, inner: string) => {
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
            const valid = nums.filter((n: number) => n >= 1 && n <= maxGlobal);
            if (valid.length === nums.length) return match;
            oorStripped += nums.length - valid.length;
            if (valid.length === 0) return "";
            return `[${valid.sort((a, b) => a - b).join(",")}]`;
          });
          if (oorStripped > 0) {
            stats.outOfRangeCitationsStripped = oorStripped;
            log(`compose: stripped ${oorStripped} out-of-range citation number(s) (pool has ${maxGlobal} refs)`);
            send("step", {
              step: "compose",
              status: "progress",
              message: `Compose guard: removed ${oorStripped} citation marker(s) pointing beyond the reference list (${maxGlobal} refs).`,
            });
          }
        }

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

        // round-59: let — the auto-repair loop (STEP 8.5) may replace this
        // with the revised, renormalized content before anything downstream
        // (paragraph sync, article save, translate) consumes it.
        let articleContent = articleBody.trim() + "\n\n## References\n\n" + refList;

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

        // ============ STEP 8.5 (round-59): ★ Auto review & repair loop ============
        // One-click completeness contract. Round-57 made fabrication VISIBLE
        // (fact-check verdicts land in the Review tab) but not REPAIRED —
        // the user had to read the review, trigger a manual revise,
        // retranslate, and re-check by hand. This stage closes the loop
        // IN-PIPELINE, BEFORE the Chinese half exists (the final EN text is
        // translated exactly once, so there is no zhCleared dance):
        //   review (external fact-check + LLM peer review)
        //     → surgical revise (CONTRADICTED removed/corrected, unhedged
        //       UNVERIFIABLE softened, citation findings fixed)
        //     → mechanical citation renormalization (OOR strip, orphan drop,
        //       renumber) + original-heading pinning (bilingual structure)
        //     → revision guard (word/citation/structure floors)
        //     → re-review; bounded at REPAIR_MAX_REVISIONS revisions.
        // Every round is persisted as a Review row after the article is
        // saved, so the Review tab shows the whole loop. A guard-rejected
        // revision keeps the pre-revision article. Non-fatal: on ANY failure
        // the compose output stands exactly as round-57 produced it and the
        // legacy post-pipeline review self-fetch runs instead.
        const repairRounds: any[] = [];
        const repairTelemetry = {
          reviews: 0,
          revisions: 0,
          guardRejections: 0,
          droppedRefs: 0,
          strippedNumbers: 0,
          triggered: false,
          stopReason: "",
          finalVerdict: "",
          finalOverall: null as number | null,
        };
        send("step", {
          step: "repair",
          status: "started",
          message: "Auto-review & repair: fact-checking the composed article before translation...",
        });
        try {
          const originalSectionTitles = generatedParagraphs.map(
            (gp: any, i: number) => gp?.title || sections[i]?.title || `Section ${i + 1}`,
          );
          let currentContent = articleContent;
          let revisionsDone = 0;
          // round-61 (P0-A): abstracts of the article's own references, keyed
          // by the CURRENT citation numbering (globalRefs order ↔ refList).
          // Cited claims are fact-checked against the cited source's own
          // abstract BEFORE any web search — the round-60 production flagged
          // 6/6 faithful claims as UNVERIFIABLE purely because web search
          // couldn't surface those papers' content while the abstracts sat
          // in the pool the whole time.
          let abstractMap = new Map<number, { title: string; abstract: string }>();
          globalRefs.forEach((r: any, i: number) => {
            if (r?.abstract && String(r.abstract).length > 80) {
              abstractMap.set(i + 1, { title: String(r.title || ""), abstract: String(r.abstract) });
            }
          });
          for (let round = 1; round <= REPAIR_MAX_REVISIONS + 1; round++) {
            if (clientDisconnected) {
              repairTelemetry.stopReason = "client disconnected";
              break;
            }
            const rc = await reviewArticleCore(
              projectId,
              { title: articleTitle, content: currentContent },
              { topic: project.topic, maxClaims: 8, refAbstracts: abstractMap },
            );
            repairTelemetry.reviews++;
            repairTelemetry.finalVerdict = rc.parsed.verdict || "";
            repairTelemetry.finalOverall = rc.parsed.scores?.overall ?? null;
            const act = actionableFindings(rc);
            const roundEntry: any = {
              round,
              core: rc,
              actionable: act.actionable,
              trigger: act.trigger,
              reason: act.reason,
              revisedContent: null as string | null,
              guardRejected: null as string[] | null,
            };
            repairRounds.push(roundEntry);
            const factLine = rc.factReport?.ran
              ? ` fact={v${rc.factReport.summary.verified} c${rc.factReport.summary.contradicted} u${rc.factReport.summary.unverifiable} e${rc.factReport.summary.errors}}`
              : "";
            send("step", {
              step: "repair",
              status: "progress",
              round,
              message:
                `Review round ${round}: ${rc.parsed.verdict || "?"}` +
                `${rc.parsed.scores?.overall != null ? ` (${rc.parsed.scores.overall}/10)` : ""}` +
                `${factLine}` +
                (act.actionable ? ` — ${act.reason}; revising...` : " — no actionable issues, done."),
            });
            log(
              `repair: round ${round} verdict=${rc.parsed.verdict || "?"} overall=${rc.parsed.scores?.overall ?? "?"}${factLine} actionable=${act.actionable}${act.reason ? ` (${act.reason})` : ""}`,
            );
            if (!act.actionable) {
              repairTelemetry.stopReason = "review clean — no actionable findings";
              break;
            }
            if (revisionsDone >= REPAIR_MAX_REVISIONS) {
              repairTelemetry.stopReason =
                "revision budget exhausted — remaining issues are disclosed in the Review tab";
              send("step", { step: "repair", status: "progress", message: `${repairTelemetry.stopReason}.` });
              break;
            }

            // --- Produce a candidate revision against THIS round's findings ---
            const feedback = {
              round,
              verdict: rc.parsed.verdict || "major-revision",
              summary: rc.parsed.summary || "",
              scores: rc.parsed.scores,
              strengths: rc.parsed.strengths || [],
              weaknesses: rc.mergedWeaknesses,
              suggestions: rc.parsed.suggestions || [],
            };

            let candidate: string | null = null;
            let candidateMode = "";

            // round-61 (P1): SECTION-SCOPED revision first — only the sections
            // containing flagged claims get an isolated LLM call; headings and
            // the reference block are byte-preserved by construction. The
            // round-60 production showed the whole-article "surgical" mode
            // merging 9 sections into 7 — scoped mode is structurally immune.
            if (act.hardFindings.length > 0 || (feedback.suggestions || []).length > 0) {
              try {
                const scoped = await reviseArticleScoped(
                  projectId,
                  { title: articleTitle, content: currentContent },
                  feedback,
                  act.hardFindings,
                );
                if (scoped.ok && scoped.content) {
                  const scopedGuard = revisionGuard(currentContent, scoped.content);
                  if (scopedGuard.ok) {
                    candidate = scoped.content;
                    candidateMode = `scoped (§${scoped.revisedSections.map((i) => i + 1).join(",")})`;
                    roundEntry.scopedSections = scoped.revisedSections.map((i) => i + 1);
                    log(
                      `repair: round ${round} scoped revision ready — sections §${roundEntry.scopedSections.join(",")} (${Object.values(scoped.findingsPerSection).join("/")} findings each), guard ok`,
                    );
                  } else {
                    roundEntry.guardRejected = scopedGuard.reasons;
                    repairTelemetry.guardRejections++;
                    log(`repair: round ${round} scoped revision REJECTED by guard: ${scopedGuard.reasons.join("; ")}`);
                  }
                } else {
                  log(`repair: round ${round} scoped revision unavailable (${scoped.reason}) — whole-article fallback`);
                }
              } catch (scopedErr: any) {
                log(`repair: round ${round} scoped revision failed: ${String(scopedErr?.message ?? scopedErr).slice(0, 100)} — whole-article fallback`);
              }
            }

            // round-61 (P0-B): whole-article surgical with the STRUCTURAL
            // CONTRACT pinned in the prompt + ONE feedback retry after a
            // guard rejection (round-60 wasted the whole budget on a single
            // structure-collapsing attempt followed by a hard break).
            let lastRejectReasons: string[] = [];
            for (let attempt = 1; candidate === null && attempt <= 2; attempt++) {
              const surgical = await reviseArticleCore(
                projectId,
                { title: articleTitle, content: currentContent },
                feedback,
                "surgical",
                attempt > 1 && lastRejectReasons.length > 0
                  ? { retryFeedback: lastRejectReasons.join("; ") }
                  : {},
              );
              const guard = revisionGuard(currentContent, surgical);
              if (guard.ok) {
                candidate = surgical;
                candidateMode = attempt > 1 ? "surgical (retry)" : "surgical";
                break;
              }
              lastRejectReasons = guard.reasons;
              roundEntry.guardRejected = guard.reasons;
              repairTelemetry.guardRejections++;
              log(`repair: round ${round} surgical attempt ${attempt} REJECTED by guard: ${guard.reasons.join("; ")}`);
              send("step", {
                step: "repair",
                status: "progress",
                round,
                message: `Round ${round} revision attempt ${attempt} rejected by mechanical guard (${guard.reasons[0]})${attempt === 1 ? " — retrying with structural feedback..." : ""}`,
              });
            }

            if (candidate === null) {
              repairTelemetry.stopReason = "revision failed the mechanical guard (all attempts)";
              send("step", {
                step: "repair",
                status: "progress",
                message: `Round ${round}: every revision attempt failed the mechanical guard — keeping the pre-revision article.`,
              });
              break;
            }

            // Renormalize citations deterministically (the LLM never gets to
            // renumber), then pin the ORIGINAL section headings — the ZH
            // compose stage builds its half from paragraph titles, so a
            // reworded EN heading would structurally diverge the halves.
            const norm = renormalizeArticleCitations(candidate);
            const revSplit = splitBodyAndReferences(norm.content);
            const pinnedBody = restoreOriginalHeadings(revSplit.body, originalSectionTitles);
            if (!pinnedBody) {
              repairTelemetry.guardRejections++;
              repairTelemetry.stopReason = "revision heading structure unrepairable";
              log("repair: revision heading count mismatch after guard — rejected");
              break;
            }
            currentContent = pinnedBody.trimEnd() + "\n\n" + revSplit.referencesText.trim();
            revisionsDone++;
            repairTelemetry.revisions++;
            repairTelemetry.triggered = true;
            repairTelemetry.droppedRefs += norm.droppedRefs;
            repairTelemetry.strippedNumbers += norm.strippedNumbers;
            stats.outOfRangeCitationsStripped += norm.strippedNumbers;
            roundEntry.revisedContent = currentContent;
            roundEntry.mode = candidateMode;
            // round-61 (P0-A): keep the abstract map aligned with the CURRENT
            // numbering after the deterministic renumber (survivors only).
            if (norm.renumbered && norm.oldToNew.size > 0) {
              const remapped = new Map<number, { title: string; abstract: string }>();
              for (const [oldN, newN] of norm.oldToNew) {
                const a = abstractMap.get(oldN);
                if (a) remapped.set(newN, a);
              }
              abstractMap = remapped;
            }
            send("step", {
              step: "repair",
              status: "progress",
              round,
              message:
                `Round ${round} revision applied [${candidateMode}]${act.hardFindings.length > 0 ? `: ${act.hardFindings.length} flagged claim(s) repaired` : ""}` +
                `${norm.droppedRefs > 0 ? `, ${norm.droppedRefs} orphaned reference(s) dropped` : ""}. Re-reviewing...`,
            });
            log(
              `repair: round ${round} revision APPLIED [${candidateMode}] (guard ok; droppedRefs=${norm.droppedRefs} stripped=${norm.strippedNumbers} renumbered=${norm.renumbered})`,
            );
          }

          // Adopt the repaired content: re-derive everything the downstream
          // stages consume (paragraph sync, article save, audit, translate,
          // ZH reference list) so the WHOLE pipeline sees the final article.
          if (repairTelemetry.triggered && currentContent !== articleContent) {
            articleContent = currentContent;
            const finalSplit = splitBodyAndReferences(articleContent);
            const finalSections = splitBodySections(finalSplit.body);
            if (finalSections && finalSections.contents.length === renumberedContents.length) {
              for (let i = 0; i < renumberedContents.length; i++) {
                renumberedContents[i] = finalSections.contents[i];
              }
              // Rebuild globalRefs from the final reference list (survivors
              // keep their original relative order — the normalizer only
              // compacts, never reorders). Match final ref LINES back to the
              // composed list verbatim; a mismatch falls back to the composed
              // refs (logged) rather than guessing.
              const origRefLines = refList.split("\n").map((l: string) => l.replace(/^\s*\[\d+\]\s*/, "").trim());
              const finalRefLines = finalSplit.referencesText
                .split("\n")
                .map((l: string) => l.trim())
                .filter((l: string) => /^\[\d+\]\s/.test(l))
                .map((l: string) => l.replace(/^\[\d+\]\s*/, "").trim());
              const newGlobalRefs: any[] = [];
              for (const fl of finalRefLines) {
                const idx = origRefLines.findIndex((ol: string) => ol === fl);
                if (idx >= 0 && idx < globalRefs.length) newGlobalRefs.push(globalRefs[idx]);
                else break;
              }
              const finalBodyCit = new Set<number>();
              let fcm: RegExpExecArray | null;
              const fcre = /\[(\d+(?:[,\-–\s]\d+)*)\]/g;
              while ((fcm = fcre.exec(finalSplit.body)) !== null) {
                for (const part of fcm[1].split(/[,;]\s*/)) {
                  const rm = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
                  if (rm) {
                    for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) finalBodyCit.add(n);
                  } else {
                    const n = parseInt(part);
                    if (!isNaN(n)) finalBodyCit.add(n);
                  }
                }
              }
              const maxFinalCit = finalBodyCit.size > 0 ? Math.max(...finalBodyCit) : 0;
              if (
                newGlobalRefs.length === finalRefLines.length &&
                maxFinalCit <= newGlobalRefs.length
              ) {
                globalRefs.length = 0;
                globalRefs.push(...newGlobalRefs);
                log(`repair: globalRefs re-synced to the final reference list (${globalRefs.length} refs)`);
              } else {
                log(
                  `repair: reference rematch incomplete (${newGlobalRefs.length}/${finalRefLines.length} lines, maxCit=${maxFinalCit}) — globalRefs kept as composed`,
                );
              }
            } else {
              log(
                `repair: final section split mismatch (${finalSections?.contents.length ?? "?"} vs ${renumberedContents.length}) — article content adopted, paragraphs keep pre-repair text`,
              );
            }
          }
          send("step", {
            step: "repair",
            status: "done",
            message:
              repairTelemetry.triggered
                ? `Auto-repair complete: ${repairTelemetry.reviews} review round(s), ${repairTelemetry.revisions} revision(s) applied${repairTelemetry.droppedRefs > 0 ? `, ${repairTelemetry.droppedRefs} orphaned reference(s) dropped` : ""}. Final verdict: ${repairTelemetry.finalVerdict}${repairTelemetry.finalOverall != null ? ` (${repairTelemetry.finalOverall}/10)` : ""}.`
                : `Auto-review complete (${repairTelemetry.reviews} round(s)): ${repairTelemetry.stopReason || "no revision needed"}. Final verdict: ${repairTelemetry.finalVerdict}${repairTelemetry.finalOverall != null ? ` (${repairTelemetry.finalOverall}/10)` : ""}.`,
          });
          log(
            `repair: done — reviews=${repairTelemetry.reviews} revisions=${repairTelemetry.revisions} guardRejections=${repairTelemetry.guardRejections} stop="${repairTelemetry.stopReason}"`,
          );
        } catch (repairErr: any) {
          // Non-fatal by contract: the compose output stands, no Review rows
          // are persisted for a half-applied loop (they would describe
          // revisions that were rolled back), and the legacy post-pipeline
          // review self-fetch runs instead.
          repairRounds.length = 0;
          repairTelemetry.revisions = 0;
          repairTelemetry.triggered = false;
          repairTelemetry.stopReason = `loop failed: ${String(repairErr?.message ?? repairErr).slice(0, 120)}`;
          log(`repair: FAILED — ${repairTelemetry.stopReason}`);
          send("step", {
            step: "repair",
            status: "skipped",
            message: `Auto-repair skipped after an error (the composed article is unaffected): ${repairErr?.message?.slice(0, 80) || "LLM error"}.`,
          });
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

        // round-59: persist the repair loop's review rounds (round 1..N) —
        // the Review tab shows the full loop: what each round found, and (on
        // rounds that triggered a revision) the revisedContent it produced.
        // A failed persistence is logged, never fatal.
        if (repairRounds.length > 0) {
          for (const r of repairRounds) {
            try {
              await db.review.create({
                data: {
                  articleId: article.id,
                  round: r.round,
                  scoreNovelty: r.core.parsed.scores?.novelty ?? null,
                  scoreSignificance: r.core.parsed.scores?.significance ?? null,
                  scoreClarity: r.core.parsed.scores?.clarity ?? null,
                  scoreMethodology: r.core.parsed.scores?.methodology ?? null,
                  scoreCitations: r.core.parsed.scores?.citations ?? null,
                  scoreOverall: r.core.parsed.scores?.overall ?? null,
                  verdict: r.core.parsed.verdict || "major-revision",
                  summary: r.core.parsed.summary || "",
                  strengths: JSON.stringify(r.core.parsed.strengths || []),
                  weaknesses: JSON.stringify(r.core.mergedWeaknesses),
                  suggestions: JSON.stringify(r.core.parsed.suggestions || []),
                  ...(r.revisedContent ? { revisedContent: r.revisedContent } : {}),
                },
              });
            } catch (revRowErr: any) {
              log(
                `repair: review round ${r.round} persistence FAILED: ${String(revRowErr?.message ?? revRowErr).slice(0, 100)}`,
              );
            }
          }
          log(`repair: persisted ${repairRounds.length} review round(s)`);
        }

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
          // round-62: the glossary is built FIRST (moved up from below the
          // batch call) and injected into it, so the HEADINGS obey the same
          // anchored terminology as the body (round-61 shipped headings and
          // a titleZh that drifted from the body's standard translations).
          const sectionTitles = generatedParagraphs.map(
            (gp: any, i: number) => gp?.title || sections[i]?.title || "",
          );

          const translatedContents: string[] = [];

          // round-61: terminology anchor — ONE glossary call before the
          // section loop extracts the article's key domain terms + their
          // STANDARD Chinese translations (通行译名). Injected into every
          // section prompt so "prime editing" becomes 先导编辑 consistently,
          // not 初级编辑 (the round-60 article mistranslated the title term
          // because each section translated in isolation). round-62: now
          // ALSO feeds the section-heading batch and the article title
          // re-anchoring below.
          let termGlossary = "";
          try {
            const glossarySystem =
              "You are a bilingual (English–Chinese) scientific terminology expert. " +
              "You know the STANDARD Chinese translations (通行译名) used in Chinese scientific " +
              "literature for domain terms, and you never invent literal-sounding alternatives.";
            const glossaryPrompt = `Extract the 10-20 MOST IMPORTANT domain-specific terms from this scientific article (methods, molecules, technologies, techniques, disease names). For each, give the STANDARD Chinese translation used in Chinese scientific literature — e.g. "prime editing" → "先导编辑", "cryo-EM" → "冷冻电镜", "base editing" → "碱基编辑". Prefer established 通行译名 over literal word-by-word renderings; keep widely-used acronyms (DNA, CRISPR, PE) untranslated.

Respond as STRICT JSON only:
{"glossary":[{"en":"term","zh":"通行译名"}]}

ARTICLE TITLE: ${articleTitle}

ARTICLE EXCERPT (first sections):
${articleContent.slice(0, 3500)}`;
            const glossaryRaw = await chatWithSession(projectId, glossaryPrompt, {
              system: glossarySystem,
              temperature: 0.1,
              thinking: false,
              taskType: "translate",
              maxTokens: 2000,
              metadata: { step: "translate-glossary" },
            });
            const glossaryParsed = safeParseJSON(glossaryRaw, { glossary: [] });
            const entries = (glossaryParsed.glossary || [])
              .filter((g: any) => g?.en && g?.zh)
              .slice(0, 20);
            if (entries.length > 0) {
              termGlossary =
                "DOMAIN TERM GLOSSARY (use these EXACT translations consistently everywhere):\n" +
                entries.map((g: any) => `- ${g.en} → ${g.zh}`).join("\n");
              log(`translate: glossary anchored (${entries.length} terms)`);
            }
          } catch (glossErr: any) {
            log(`translate: glossary generation failed (proceeding without): ${glossErr?.message?.slice(0, 80) || "unknown"}`);
          }

          let titleZhs: (string | null)[] = [];
          try {
            titleZhs = await translateSectionTitles(sectionTitles, { glossary: termGlossary });
            const got = titleZhs.filter(Boolean).length;
            log(`translate: section titles ${got}/${sectionTitles.length} translated${termGlossary ? " (glossary-anchored)" : ""}`);
          } catch (titleErr: any) {
            log(`translate: section-title batch FAILED (keeping English headings): ${titleErr?.message?.slice(0, 80) || "unknown"}`);
          }

          // round-62: re-anchor the ARTICLE title translation on the glossary.
          // The original titleZh was produced at compose time (before the
          // glossary existed) — a small follow-up call re-renders the SAME
          // English title with the anchored terms so the bilingual title pair
          // matches the body's terminology. Best-effort: on failure the
          // compose-time titleZh stands.
          if (articleTitleZh && termGlossary && article?.id) {
            try {
              const anchoredTitleZh = await retranslateTitleZhWithGlossary(articleTitle, termGlossary);
              if (anchoredTitleZh) {
                articleTitleZh = anchoredTitleZh;
                await db.article.update({
                  where: { id: article.id },
                  data: { titleZh: anchoredTitleZh },
                });
                log(`translate: article titleZh re-anchored on glossary: ${anchoredTitleZh.slice(0, 60)}`);
              } else {
                log(`translate: titleZh re-anchor returned no result (keeping compose-time titleZh)`);
              }
            } catch (titleAnchorErr: any) {
              log(`translate: titleZh re-anchor FAILED (keeping compose-time titleZh): ${titleAnchorErr?.message?.slice(0, 80) || "unknown"}`);
            }
          }
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
                // round-52: rides along for the progress tracker's streaming
                // interpolation (chars-written → fraction of the unit).
                wordCount: para.wordCount,
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
4. Use domain-correct terminology. Translate technical terms using standard Chinese scientific equivalents — the DOMAIN TERM GLOSSARY below lists the exact translations you MUST use where a term appears.
5. Do NOT add any preamble like "以下是翻译" or "翻译如下". Output ONLY the translated text.
6. Do NOT translate citation numbers, DOIs, URLs, or [SOURCE:ID] markers.
7. Maintain the same paragraph structure and flow.
${termGlossary ? "\n" + termGlossary + "\n" : ""}
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

          // round-57 (P2-3, v2 side): failed section translations are EXCLUDED
          // from the composed Chinese body rather than emitted as heading-
          // only holes — a "## 标题\n\n(空)" gap makes the two halves
          // structurally divergent (the EN half has the content, the ZH half
          // silently lacks it). The missing sections are logged and named so
          // the user knows exactly what to retranslate.
          const missingZh = translatedContents
            .map((c, i) => (c.trim().length === 0 ? i + 1 : 0))
            .filter((n) => n > 0);
          const zhBody = translatedContents
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => c.trim().length > 0)
            .map(({ c, i }) => `## ${titleZhs[i] || generatedParagraphs[i]?.title || sections[i]?.title || `Section ${i + 1}`}\n\n${c}`)
            .join("\n\n");
          if (missingZh.length > 0) {
            log(`translate: zh compose EXCLUDED ${missingZh.length} failed section(s): §${missingZh.join(", §")} (retranslate available per-section)`);
          }

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

        // ============ Post-pipeline persistence (round-39) ============
        // The workspace's Relationships + Review tabs read only from the
        // RelationshipAnalysis / Review tables — v2 writes NEITHER (its
        // evidence pipeline has no relationships step and no peer review),
        // so both tabs were empty after every v2 generation. Run both now
        // (best-effort, non-fatal: an LLM 429/timeout just leaves the manual
        // buttons) via the established self-fetch pattern (r37:
        // req.nextUrl.origin, never a hardcoded host). Both endpoints
        // persist their results, so the tabs have content immediately.
        try {
          send("step", { step: "relationships", status: "started", message: "Analyzing source relationships..." });
          const relRes = await fetch(`${req.nextUrl.origin}/api/ai/source-relationships`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId }),
            signal: AbortSignal.timeout(120000),
          });
          if (relRes.ok) {
            const relJson = await relRes.json();
            send("step", {
              step: "relationships",
              status: "done",
              message: `Relationship analysis saved: ${relJson.themes?.length || 0} themes, ${relJson.edges?.length || 0} connections — see the Relationships tab.`,
            });
            log(`relationships: auto analysis saved (${relJson.themes?.length || 0} themes)`);
          } else {
            send("step", { step: "relationships", status: "skipped", message: `Relationship analysis skipped (${relRes.status}) — run it manually from the Relationships tab.` });
            log(`relationships: auto analysis FAILED (${relRes.status})`);
          }
        } catch (relErr: any) {
          send("step", { step: "relationships", status: "skipped", message: "Relationship analysis skipped (timeout or LLM error)." });
          log(`relationships: auto analysis ERROR: ${String(relErr?.message ?? relErr).slice(0, 100)}`);
        }
        // round-59: the repair loop already reviewed the FINAL article
        // in-pipeline (fact-check + peer review, possibly multiple rounds)
        // and persisted Review rows — re-fetching would burn another
        // fact-check pass to restate the same verdict. The self-fetch below
        // is now the FALLBACK for when the loop failed wholesale.
        if (repairRounds.length > 0) {
          const lastRound = repairRounds[repairRounds.length - 1];
          send("step", {
            step: "review",
            status: "done",
            verdict: lastRound.core.parsed.verdict,
            message:
              `Peer review complete (in-pipeline, ${repairRounds.length} round(s)): ${lastRound.core.parsed.verdict || "done"}` +
              `${lastRound.core.parsed.scores?.overall != null ? ` (overall ${lastRound.core.parsed.scores.overall}/10)` : ""}` +
              `${repairTelemetry.revisions > 0 ? ` — ${repairTelemetry.revisions} auto-revision(s) applied` : ""} — see the Review tab.`,
          });
          log(
            `review: in-pipeline repair loop already reviewed (${repairRounds.length} round(s), verdict=${lastRound.core.parsed.verdict}) — self-fetch skipped`,
          );
        } else {
        try {
          send("step", { step: "review", status: "started", message: "Running peer review of the final article..." });
          const reviewRes = await fetch(`${req.nextUrl.origin}/api/ai/review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "review", articleId: article.id }),
            signal: AbortSignal.timeout(120000),
          });
          if (reviewRes.ok) {
            const rv = await reviewRes.json();
            send("step", {
              step: "review",
              status: "done",
              verdict: rv.verdict,
              message: `Peer review saved: ${rv.verdict || "done"}${rv.scores?.overall != null ? ` (overall ${rv.scores.overall}/10)` : ""} — see the Review tab.`,
            });
            log(`review: auto peer review saved (verdict=${rv.verdict}, overall=${rv.scores?.overall ?? "?"})`);
          } else {
            send("step", { step: "review", status: "skipped", message: `Peer review skipped (${reviewRes.status}) — run it manually from the Review tab.` });
            log(`review: auto review FAILED (${reviewRes.status})`);
          }
        } catch (revErr: any) {
          send("step", { step: "review", status: "skipped", message: "Peer review skipped (timeout or LLM error)." });
          log(`review: auto review ERROR: ${String(revErr?.message ?? revErr).slice(0, 100)}`);
        }
        } // end round-59 fallback review fetch

        const totalMs = Date.now() - t0;
        const articleWordCount = countWords(articleContent);
        // round-61 (P2): the run completed — the checkpoints have served
        // their purpose; delete them so the next launch is a fresh run.
        try {
          await db.pipelineCheckpoint.deleteMany({ where: { projectId } });
          log("checkpoint: cleared (run complete)");
        } catch {}

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
            // round-42: citation-planning telemetry
            citationsPlanned: stats.citationPlanned,
            citationCoreCovered: stats.citationCoreCovered,
            citationPlanLLMDriven: stats.citationLLMDriven,
            fullTextsUsed: stats.fullTextsUsed,
            // round-59: auto-repair loop telemetry
            autoRepairRounds: repairTelemetry.reviews,
            autoRepairRevisions: repairTelemetry.revisions,
            autoRepairGuardRejections: repairTelemetry.guardRejections,
            autoRepairTriggered: repairTelemetry.triggered,
            autoRepairDroppedRefs: repairTelemetry.droppedRefs,
            autoRepairStopReason: repairTelemetry.stopReason,
            autoRepairFinalVerdict: repairTelemetry.finalVerdict,
            autoRepairFinalOverall: repairTelemetry.finalOverall,
          },
          message:
            `v2 pipeline complete: ${articleWordCount} words${articleContentZh ? ` + ${countWords(articleContentZh)} Chinese chars` : ""}, ${globalRefs.length} references, ${stats.citationsChecked} citations adversarially verified (${stats.citationsRemoved} removed)` +
            `${repairTelemetry.triggered ? `, ${repairTelemetry.revisions} auto-repair revision(s) applied` : ""}.`,
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
            error: `v2 pipeline failed after ${generatedParagraphs.length} section(s) were saved: ${errMsg.slice(0, 200)}. Partial work was KEPT and checkpointed — relaunch the same topic to RESUME from the last completed section automatically.`,
            partial: true,
            savedSections: generatedParagraphs.length,
            resumable: true,
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
  /** round-57 (P2-2): checks whose verification batch failed even after the
   * retry — their citations were saved UNVERIFIED. Surfaced honestly in the
   * step message and stats instead of being silently swallowed. */
  unverifiedChecks: number;
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
    return { checked: 0, removals: [], flagged: [], removedNums: [], llmCalls: 0, unverifiedChecks: 0 };
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
  let unverifiedChecks = 0;

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

    // round-57 (P2-2): batch-failure handling. Previously a single LLM
    // hiccup on one batch was swallowed by console.warn — those citations
    // shipped UNVERIFIED with no signal to anyone (and a rate-limit abort
    // was swallowed too, so the caller's graceful-skip never fired). Now:
    //   - rate-limit/quota errors PROPAGATE (the caller's existing handler
    //     skips the section gracefully);
    //   - any other failure gets ONE retry after a 3s cool-down;
    //   - a failed-after-retry batch is counted in `unverifiedChecks` so
    //     the caller and stats can surface "saved unverified" honestly.
    const runBatch = async (): Promise<void> => {
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
    };

    try {
      await runBatch();
    } catch (err: any) {
      if (err instanceof RateLimitAbortedError || err instanceof QuotaExhaustedError) {
        throw err; // caller's graceful-skip owns these
      }
      await new Promise((r) => setTimeout(r, 3000));
      try {
        await runBatch();
      } catch (retryErr: any) {
        if (retryErr instanceof RateLimitAbortedError || retryErr instanceof QuotaExhaustedError) {
          throw retryErr;
        }
        unverifiedChecks += batch.length;
        console.warn(
          `[adversarialVerifySection] batch ${Math.floor(b / batchSize) + 1} failed after retry: ${retryErr?.message?.slice(0, 100)} — ${batch.length} citations saved UNVERIFIED`,
        );
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  return {
    checked: checks.length - unverifiedChecks,
    removals,
    flagged,
    removedNums: [...new Set(removals.map((r) => r.n))],
    llmCalls,
    unverifiedChecks,
  };
}
