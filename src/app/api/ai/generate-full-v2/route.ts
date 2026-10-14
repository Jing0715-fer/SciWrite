import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { webSearchCacheStats } from "@/lib/web-search-cache";
// RT5 skill framework: the fixed article format contract (ordered gate
// chain) replaces per-exit hand-assembled sanitize/enforce/CJK sequences.
import { applyFormatContract } from "@/lib/skill/format-contract";
// RT7: step literals reference the shared namespace — a typo now fails tsc.
import { STEP } from "@/lib/skill/steps";
// RT7: per-skill degraded counts ride the complete-event stats block.
import { getSkillDegradedCounts, getSkillStats, resetSkillTelemetry } from "@/lib/skill/telemetry-collector";
// RT9: session-context cost telemetry (per-taskType assembled-prompt sizes).
import { getSessionContextStats, resetSessionContextStats } from "@/lib/session-context-stats";
import { chatWithSession, chatWithSessionStream, clearSession } from "@/lib/llm-session";
// RT9 (route decomposition, seam 3): the fresh-run gather stage (STEP 1 +
// 1.2) is a stage module — events/stats/hoisted-array contract preserved.
import { runGatherStage } from "@/lib/orchestrator/gather-stage";
// RT17 (route decomposition, seam 4a): STEP 1.5 → 2.5 (knowledge → score →
// curate → tier gate → fulltext) is a stage module — events/stats/hoisted-
// array contract preserved.
import { runSourcesStage } from "@/lib/orchestrator/sources-stage";
// RT17 (route decomposition, seam 5): the repair loop + coherence polish +
// finalization (paragraph sync / article save / review rows / compose:done)
// is a stage module — error asymmetry and event order pinned by tests.
import { runRepairPolishStage } from "@/lib/orchestrator/repair-polish-stage";
// RT17 (route decomposition, seam 4b): plan + coverage backfill + gap
// agent + analyze + allocate is a stage module (fresh-run phase interior).
import { runPlanningStage } from "@/lib/orchestrator/planning-stage";
// RT17 (route decomposition, seam 6): the section generation loop +
// pipelined adversarial verify is a stage module (hard-exit + digest
// derivation + working-set GC contracts documented there).
import { runGenerateLoop } from "@/lib/orchestrator/generate-loop";
// RT17 (route decomposition, seam 8): the compose stage (renumber + dedup +
// orphan filter + title) is a stage module feeding the repair-polish stage.
import { runComposeStage } from "@/lib/orchestrator/compose-stage";
import { buildReferenceList, citationNumbersOf } from "@/lib/compose-transforms";
import {
  countWords,
} from "@/lib/writing";
import {
  retranslateTitleZhWithGlossary,
} from "@/lib/article-title";
import {
  translateSectionTitles,
} from "@/lib/section-title-zh";
import { PipelineProgressTracker } from "@/lib/progress-tracker";
import { runWatch } from "@/lib/run-watch";
import {
  inferFormat,
  safeParseJSON,
} from "@/lib/generate-full-helpers";
import {
  preFlightQuotaCheck,
  isAborted,
  setAbort,
} from "@/lib/rate-limiter";
// RT9 (route decomposition, seam 2): compose-stage pure text transforms
// (global renumber / OOR strip / orphan remap / ref lists / drift check).
// round-cs-1 (ClawsGO-inspired "可追溯可复现"): persist a replayable
// per-step timeline for every pipeline launch — see lib/run-recorder.ts.
import { TaskRunRecorder } from "@/lib/run-recorder";

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

/**
 * RT-2 fix (storm pre-flight): ONE minimal probe call (max_tokens 8) before
 * the pipeline starts. A launch during a 429 storm previously burned the
 * full 5-attempt backoff chain (~3 min) on the gather query-planning call,
 * then hit the FATAL path — which rolls back the snapshot, so even the
 * gathered sources were lost. The user saw: click → 3 minutes of nothing →
 * hard error → empty project. Now: 429 storm → 503 in ~1s with an honest
 * message (and setAbort, so re-clicks within the abort TTL cost ZERO
 * provider calls). Non-429 probe errors (timeout, 5xx blips) do NOT block
 * the launch — the pipeline's own stage handling covers those. Only the
 * zai-sdk default provider is probed (a CLI/API provider selection has its
 * own endpoints with different limits).
 */
async function providerStorming(): Promise<string | null> {
  try {
    const { getSelectedProvider } = await import("@/lib/llm-selection");
    const selected = getSelectedProvider("generate");
    if (selected && selected !== "zai-sdk" && selected !== "auto") return null;
  } catch {
    // selection unavailable — probe the default provider anyway
  }
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    await zai.chat.completions.create({
      messages: [{ role: "user", content: "Reply with the single word: OK" }],
      max_tokens: 8,
    });
    return null;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/429|rate.?limit|too many requests/i.test(msg)) {
      return "provider throttled (429 storm)";
    }
    return null;
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as GenerateFullV2Body;
  const projectId = body.projectId;

  if (!projectId) {
    return Response.json({ error: "Missing 'projectId'." }, { status: 400 });
  }

  // RT-2: fast-fail a storm launch (see providerStorming). This runs BEFORE
  // the stream starts, so a plain JSON error response is fine — the UI's
  // error path handles non-OK JSON.
  try {
    preFlightQuotaCheck("generate-full-v2:pre-flight");
  } catch (e: any) {
    return Response.json(
      { error: `Pipeline not started: ${e?.message?.slice(0, 140) || "quota/abort guard"}` },
      { status: 503 },
    );
  }
  if (isAborted()) {
    return Response.json(
      { error: "Pipeline not started: a recent rate-limit abort is still active — retry in a few minutes." },
      { status: 503 },
    );
  }
  const stormReason = await providerStorming();
  if (stormReason) {
    setAbort(`pre-flight: ${stormReason}`);
    return Response.json(
      {
        error:
          `${stormReason} — the pipeline was NOT started (no sources were cleared, nothing was consumed). ` +
          "Provider storms typically clear within minutes to hours; retry shortly.",
      },
      { status: 503 },
    );
  }

  const encoder = new TextEncoder();
  // FIX (client-disconnect waste): the ReadableStream previously had no
  // cancel() handler, so when the browser closed the SSE connection the
  // pipeline kept running for up to 30 minutes — LLM calls + DB writes for
  // an audience of zero. cancel() now starts a grace watcher (round-cs-8,
  // see below) which flips this flag only when the wire has been dead for
  // several minutes AND no client has watched the run timeline in that
  // window; the section loop checks the flag at every iteration boundary
  // and skips all remaining work.
  let clientDisconnected = false;
  // round-cs-1: run-timeline recorder (assigned after the project/config
  // are known — every event funnelled through send() is appended to its
  // persisted stepsJson so the run can be replayed later).
  let recorder: TaskRunRecorder | null = null;
  // round-cs-3: cleared by the stream's cancel() handler (browser dropped
  // the SSE connection) so the keepalive pump stops with the stream.
  let cancelKeepalive: (() => void) | null = null;
  // round-cs-8: disconnect GRACE. The wire dropping is often transient
  // (proxy idle-cut, gateway timeout, dev-server HMR restart, tab refresh)
  // and the UI now recovers by polling /api/task-runs — those polls touch
  // the run-watch registry, proving a client is still watching. So cancel()
  // no longer flips clientDisconnected immediately; instead it starts a
  // watch: the flag only turns true once BOTH the wire has been dead for
  // DISCONNECT_GRACE_MS AND nobody has watched this project's run timeline
  // within that window. Existing skip-on-disconnect logic downstream is
  // untouched — it just observes the flag, which now carries the "really
  // gone" verdict instead of the "wire hiccup" one.
  const DISCONNECT_GRACE_MS = 4 * 60_000;
  let disconnectWatchTimer: ReturnType<typeof setInterval> | null = null;
  let disconnectedAt = 0;
  const startDisconnectWatch = () => {
    if (disconnectWatchTimer) return;
    disconnectedAt = Date.now();
    disconnectWatchTimer = setInterval(() => {
      if (clientDisconnected || !disconnectedAt) {
        if (disconnectWatchTimer) { clearInterval(disconnectWatchTimer); disconnectWatchTimer = null; }
        return;
      }
      const wireDeadFor = Date.now() - disconnectedAt;
      const lastWatch = runWatch.since(projectId);
      const watchedRecently = Date.now() - lastWatch < DISCONNECT_GRACE_MS;
      if (wireDeadFor >= DISCONNECT_GRACE_MS && !watchedRecently) {
        clientDisconnected = true;
        // (logger lives inside start(); console is fine for this one-line verdict)
        try { console.log(`[generate-full-v2] client disconnect confirmed after ${Math.round(wireDeadFor / 1000)}s grace (no timeline watcher) — remaining work will be skipped`); } catch {}
      }
    }, 30_000);
    if (typeof (disconnectWatchTimer as any).unref === "function") (disconnectWatchTimer as any).unref();
  };
  const stopDisconnectWatch = () => {
    if (disconnectWatchTimer) { clearInterval(disconnectWatchTimer); disconnectWatchTimer = null; }
  };
  const stream = new ReadableStream({
    async start(controller) {
      let isClosed = false;
      const rawSend = (event: string, data: any) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event, ...data })}\n\n`));
          lastWireAt = Date.now();
        } catch {
          isClosed = true;
        }
      };
      // round-cs-3 (SSE keepalive): silent stages (e.g. the knowledge LLM
      // batches, plan, long section writes) used to leave the connection
      // data-less for many minutes — proxies/browsers can time an idle SSE
      // stream out, and the user sees a frozen run. A bare "ping" event every
      // 20s of silence keeps the wire alive; clients ignore events they don't
      // know (no step / no message / no progress), and the recorder never
      // sees it (rawSend bypasses send()).
      let lastWireAt = Date.now();
      const keepalive = setInterval(() => {
        if (isClosed || clientDisconnected) return;
        if (Date.now() - lastWireAt >= 20_000) {
          rawSend("ping", { t: Date.now() });
        }
      }, 5_000);
      if (typeof (keepalive as any).unref === "function") (keepalive as any).unref();
      cancelKeepalive = () => clearInterval(keepalive);
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
        { step: STEP.gather, weight: 2.2 },
        { step: STEP.knowledge, weight: 1.4 },
        { step: STEP.score, weight: 0.9 },
        { step: STEP.curate, weight: 0.7 },
        { step: STEP.plan, weight: 0.9 },
        // round-cs-2: gap agent between plan and analyze — usually quick
        // (≤3 gaps × ≤2 searches), occasionally skipped.
        { step: STEP.gapAgent, weight: 0.6 },
        { step: STEP.analyze, weight: 1.1 },
        { step: STEP.allocate, weight: 0.2 },
        // generate+verify interleave PER SECTION — consecutive loop phases
        // share one family region so the bar sweeps forward through the
        // whole loop instead of bouncing between two step slots.
        { step: STEP.generate, unitWeight: 2 },
        { step: STEP.verify, unitWeight: 0.9 },
        { step: STEP.compose, weight: 0.5 },
        // round-59: auto review & repair between compose and translate —
        // external fact-check + peer review + surgical revision run BEFORE
        // the Chinese half exists (the final EN text is translated once).
        { step: STEP.repair, weight: 1.2 },
        // round-cs-2: whole-article coherence polish after the repair loop.
        { step: STEP.polish, weight: 0.9 },
        ...(trackerBothMode ? [{ step: STEP.translate, unitWeight: 0.75 }] : []),
      ]);
      const send = (event: string, data: any) => {
        // round-cs-8: decorate FIRST, then record + send. The recorder used
        // to observe the RAW payload (before the progress value was
        // attached), so the persisted timeline — and any client recovering
        // from it via /api/task-runs polling after a wire drop — carried no
        // progress values. Recording the decorated event keeps the wire and
        // the timeline byte-identical.
        let out = data;
        if (event === "step" && data && typeof data === "object") {
          const progress = progressTracker.onEvent(data);
          if (progress != null) {
            out = { ...data, progress };
          }
        }
        if (event === "complete") progressTracker.finish();
        // round-cs-1: observe everything that goes on the wire (observer
        // only — swallowed errors can never break the pipeline).
        try { recorder?.onEvent(event, out); } catch {}
        rawSend(event, out);
      };
      const safeClose = () => {
        if (isClosed) return;
        isClosed = true;
        clearInterval(keepalive);
        stopDisconnectWatch();
        try { controller.close(); } catch {}
      };

      const t0 = Date.now();
      // RT7: the skill telemetry aggregate is per-run (module-level state) —
      // reset it here so the complete-event stats describe THIS run only.
      resetSkillTelemetry();
      // RT9: same per-run reset for the assembled-prompt size aggregate
      // (session-context cost telemetry — RT8 backlog #5).
      resetSessionContextStats();
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
        // round-cs-6: Chinese-leak retry telemetry
        cjkLeakRetries: 0,
        // round-cs-7: uniform-format retry telemetry
        formatRetries: 0,
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
        // round-RT2: coverage-driven gather telemetry
        gatherCoverage: null as null | {
          ratio: number;
          uncovered: number;
          weak: number;
          facets: number;
        },
        gatherTopUpNewItems: 0,
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
        // round-cs-2: research gap agent telemetry (STEP 3.5)
        gapAgent: null as { gaps: number; queries: number; newRefs: number } | null,
        // round-cs-2: coherence polish telemetry (STEP 8.6)
        coherencePolish: null as { findings: number; revisedSections: number; triggered: boolean } | null,
        // RT16: storm-recovery telemetry — every bounded recovery wait
        // (gather web-retry / score rescore) records its outcome here for
        // the timeline's recovery badge (incident AND recovery disclosed).
        stormRecovery: [] as import("@/lib/storm-recovery").StormRecoveryEntry[],
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
          step: STEP.init,
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
        // round-RT3 (R2): per-section digest entries (one per generated
        // section, in order) — the pipelined verify refreshes an entry after
        // citation removals land. Declared here (outer scope) so the RESUME
        // path below can populate it before STEP 6 begins.
        const digestEntryTexts: string[] = [];
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

        // round-cs-1: create the persisted timeline row for THIS launch.
        // Note: the TaskRun always gets a FRESH runId — a resumed launch
        // reuses the checkpoint runId for stage bookkeeping, but reusing it
        // here would collide with the interrupted launch's TaskRun row
        // (runId is @unique). `resumed` records the linkage instead.
        recorder = new TaskRunRecorder({
          projectId,
          runId: crypto.randomUUID(),
          pipeline: "v2",
          topic: project.topic,
          language: requestedLanguage,
          targetWords,
          trigger: "manual",
          resumed: !!resume,
        });
        await recorder.start();
        // The init event fired before the recorder existed — replay it so
        // the timeline starts with the run's configuration record.
        recorder.onEvent("step", {
          step: STEP.init,
          status: "done",
          message: `v2 evidence-grounded pipeline initialized. Target: ${targetWords} words${isBothMode ? ". Language: English-first, then translate to 中文" : ""}.`,
        });

        if (resume) {
          // ---- RESTORE PATH: rebuild the in-memory state + DB paragraphs ----
          send("step", {
            step: STEP.gather,
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

          // round-cs-4 (OOM mitigation): a resumed run re-hydrated the FULL
          // citation pool including full texts for sections that are already
          // done — the resumed process started the memory race closer to the
          // OOM cliff than the original run (observed: 9-section run dies at
          // §9, its resume dies at §16 with everything re-loaded). Drop
          // full-text entries no REMAINING section will cite.
          try {
            const firstPending = resume.sectionsDone?.length ?? 0;
            const neededByRemaining = new Set<string>([""]);
            for (let j = firstPending; j < sections.length; j++) {
              for (const n of allocations[j]?.refIndices || []) {
                const ref = curatedRefs[n - 1];
                if (ref) neededByRemaining.add(ref.id || "");
              }
            }
            for (const key of [...fullTexts.keys()]) {
              if (!neededByRemaining.has(key)) fullTexts.delete(key);
            }
          } catch {}

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
              // round-RT3 (R2): keep the entry array in sync (pipelined-verify
              // digest refresh indexes by section).
              digestEntryTexts.push(digestEntry);
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
          step: STEP.gather,
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

        // RT9 (route decomposition, seam 3): the gather stage body now
        // lives in @/lib/orchestrator/gather-stage — same events, same
        // stats fields, same hoisted-array mutation contract. The crash-
        // critical snapshot/force-clear preamble above stays inline (the
        // catch handler must see snapshot/hadPriorWork even if a later
        // gather line throws).
        const gatherOutcome = await runGatherStage({
          projectId,
          project,
          targetWords,
          maxDbQueries,
          maxWebSearchQueries,
          maxTokens,
          db,
          stats,
          savedDataSources,
          savedReferences,
          send,
          log,
          safeClose,
          isAborted,
          isClientDisconnected: () => clientDisconnected,
        });
        if (!gatherOutcome.ok) return;

        // RT17 (route decomposition, seam 4a): STEP 1.5 → 2.5 (knowledge
        // cross-check → score → curate → tier gate → full-text) now lives in
        // @/lib/orchestrator/sources-stage — verbatim migration, zero
        // try/catch (failures propagate to this route's outer catch, exactly
        // as the inline code did). Terminal bindings returned; curatedScores
        // keeps its array identity (planning coverage backfill REBINDS the
        // let, gap-merge PUSHES into the array).
        const sourcesStage = await runSourcesStage({
          projectId,
          project,
          targetWords,
          maxTokens,
          db,
          stats,
          savedDataSources,
          savedReferences,
          send,
          log,
        });
        curatedRefs = sourcesStage.curatedRefs;
        let curatedScores = sourcesStage.curatedScores;
        fullTexts = sourcesStage.fullTexts;
        const fullTextProfiles = sourcesStage.fullTextProfiles;
        const dedupedRefs = sourcesStage.dedupedRefs;

        // RT17 (route decomposition, seam 4b): STEP 3 → 5 (plan + coverage
        // backfill + gap agent + analyze + allocate) now lives in
        // @/lib/orchestrator/planning-stage — verbatim migration inside the
        // fresh-run phase block. Terminal bindings returned; the pool
        // checkpoint below serializes them (splice order load-bearing).
        const planning = await runPlanningStage({
          projectId,
          project,
          targetWords,
          maxTokens,
          db,
          stats,
          savedDataSources,
          savedReferences,
          send,
          log,
          isClientDisconnected: () => clientDisconnected,
          curatedRefs,
          curatedScores,
          dedupedRefs,
          fullTextProfiles,
          fullTexts,
        });
        sections = planning.sections;
        allocations = planning.allocations;
        curatedRefs = planning.curatedRefs;
        } // end fresh-run phase block (round-61 resume wrap)

        // round-61 (P2): pool checkpoint — everything the generate loop needs,
        // serialized after allocate. Written only on fresh runs (a resumed
        // run already has it). Best-effort: a checkpoint failure must never
        // fail the run.
        if (!resume) {
          try {
            // RT8: the pool payload (curatedRefs + full texts + sections +
            // allocations — the largest object graph the run ever strings)
            // was serialized TWICE, once for the create branch and once for
            // the update branch, even though upsert executes only one. Build
            // the string once.
            const poolPayload = JSON.stringify({
              curatedRefs,
              fullTexts: [...fullTexts.entries()],
              sections,
              allocations,
            });
            await db.pipelineCheckpoint.upsert({
              where: { runId_stage: { runId: activeRunId, stage: "pool" } },
              create: {
                projectId,
                runId: activeRunId,
                stage: "pool",
                topic: project.topic,
                payload: poolPayload,
              },
              update: { payload: poolPayload, updatedAt: new Date() },
            });
            log(`checkpoint: pool saved (${curatedRefs.length} refs, ${sections.length} sections, ${fullTexts.size} full texts)`);
          } catch (cpErr: any) {
            log(`checkpoint: pool save FAILED (run continues, resume unavailable): ${String(cpErr?.message ?? cpErr).slice(0, 100)}`);
          }
        }

        // RT17 (route decomposition, seam 6): the section generation loop +
        // pipelined adversarial verify (STEP 6 + 7) now lives in
        // @/lib/orchestrator/generate-loop — verbatim migration. The
        // {ok:false} hard exit (all sections failed) sends error + safeClose
        // inside the module. abortedDueToRateLimit returns as a terminal
        // value (the translate guard reads it — cross-seam CR-B#13).
        let abortedDueToRateLimit = false;
        const generateLoop = await runGenerateLoop({
          projectId,
          project,
          maxTokens,
          db,
          stats,
          send,
          log,
          safeClose,
          isAborted,
          isClientDisconnected: () => clientDisconnected,
          promptInstruction,
          resumeSectionsDone: resume?.sectionsDone ?? null,
          activeRunId,
          sections,
          allocations,
          curatedRefs,
          fullTexts,
          generatedParagraphs,
          sectionsCheckpointData,
        });
        if (!generateLoop.ok) return;
        abortedDueToRateLimit = generateLoop.abortedDueToRateLimit;

        // RT17 (route decomposition, seam 8): STEP 8 (heading uniforming +
        // paragraph reload + global renumber + cross-section dedup + OOR
        // strip + orphan filter + reference list + body assembly + title)
        // now lives in @/lib/orchestrator/compose-stage — verbatim
        // migration. renumberedContents/globalRefs keep shared identities
        // (the repair-polish stage mutates them in place by design).
        const composeStage = await runComposeStage({
          projectId,
          project,
          db,
          stats,
          send,
          log,
          isBothMode,
          sections,
          generatedParagraphs,
        });
        const { enTitles, refList, articleTitle } = composeStage;
        let articleTitleZh = composeStage.articleTitleZh;
        let articleContent = composeStage.articleContent;
        const renumberedContents = composeStage.renumberedContents;
        const globalRefs = composeStage.globalRefs;

        // RT17 (route decomposition, seam 5): STEP 8.5 → finalization
        // (repair loop → coherence polish → paragraph sync → article save →
        // review rows → final audit → compose:done) now lives in
        // @/lib/orchestrator/repair-polish-stage — verbatim migration.
        // compose:done is the module's LAST event and follows every DB write
        // (module-level golden). renumberedContents/globalRefs/repairRounds
        // keep their SHARED references (in-place mutation contracts).
        const repairPolish = await runRepairPolishStage({
          projectId,
          project,
          maxTokens,
          db,
          stats,
          send,
          log,
          isAborted,
          isClientDisconnected: () => clientDisconnected,
          articleTitle,
          articleTitleZh,
          articleContent,
          enTitles,
          renumberedContents,
          globalRefs,
          refList,
          journalTemplate,
          sections,
          generatedParagraphs,
        });
        const article = repairPolish.article;
        articleContent = repairPolish.articleContent;
        const audit = repairPolish.audit;
        const repairRounds = repairPolish.repairRounds;
        const repairTelemetry = repairPolish.repairTelemetry;


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
            step: STEP.translate,
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
          // round-cs-6: translate from the SAME normalized English headings
          // the EN article body uses (enTitles) so the two halves correspond
          // 1:1 — a CJK raw title passes through unchanged (already Chinese).
          const sectionTitles = [...enTitles];

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
              metadata: { step: STEP["translate-glossary"] },
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
            // CR-B#13 fix (mirror of the generate loop's guard): the round-5
            // canary hit a 429 storm exactly at translate — each of the 10
            // sections burned its full backoff chain + abort-waitout (~4.5
            // min) before failing, ~50 min and 100+ provider requests for
            // ZERO output, while the wire had already been dead for 45 min
            // (the canary fetch hit its 100-min cap mid-translate). The
            // generate loop short-circuits on abort/disconnect at every
            // section boundary; the translate loop now does the same.
            if (abortedDueToRateLimit || isAborted() || clientDisconnected) {
              translatedContents.push("");
              send("step", {
                step: STEP.translate,
                status: "skipped",
                section: sectionNum,
                total: generatedParagraphs.length,
                message: `Section ${sectionNum} translation SKIPPED — ${clientDisconnected ? "client disconnected" : "rate-limit storm"}. Remaining sections skipped; EN article stands (retranslate available per-section).`,
              });
              continue;
            }
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
                step: STEP.translate,
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
                      step: STEP.translate,
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
                        step: STEP.translate,
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
                  step: STEP.translate,
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
                  metadata: { step: STEP.translate, section: sectionNum, fallback: true },
                });
              }

              // Sanitize: strip any preamble the LLM may have added despite
              // the prompt, then apply the general section sanitizer.
              zhContent = zhContent
                .replace(/^(以下是|翻译如下|中文翻译：?|译文：?|Translation:?)\s*\n*/i, "")
                .trim();
              // RT5 format contract: sanitizer + uniform-template via the
              // shared ordered chain; language "zh" skips the CJK gate
              // (fullwidth punctuation is correct Chinese typography).
              zhContent = applyFormatContract(zhContent, {
                gates: ["sanitize", "uniform-section"],
                language: "zh",
              }).content;

              // Citation-integrity check (cheap, deterministic): the Chinese
              // section must cite EXACTLY the same global numbers as the
              // English one — otherwise the bilingual halves disagree.
              // RT9 (seam 2): the extractor is now @/lib/compose-transforms.
              const enNums = citationNumbersOf(cleanEn);
              const zhNums = citationNumbersOf(zhContent);
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
                step: STEP.translate,
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
                step: STEP.translate,
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
              step: STEP.translate,
              status: "done",
              message: `Chinese translation FAILED for all ${generatedParagraphs.length} sections — the English article was saved without a Chinese half. You can batch-retranslate from the article viewer.`,
              failed: true,
            });
            log(`translate: all ${generatedParagraphs.length} sections failed — skipping zh compose`);
          } else {
          send("step", {
            step: STEP.translate,
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
            .map(({ c, i }) => `## ${titleZhs[i] || enTitles[i] || `Section ${i + 1}`}\n\n${c}`)
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
          // RT9 (seam 2): shared buildReferenceList — previously a duplicated
          // character-identical builder lived here.
          const zhRefList = buildReferenceList(globalRefs);

          articleContentZh = cleanZhBody + "\n\n## 参考文献\n\n" + zhRefList;

          // Attach the Chinese half to the saved article (the EN half was
          // already persisted above; this UPDATE adds contentZh).
          await db.article.update({
            where: { id: article.id },
            data: { contentZh: articleContentZh },
          });

          send("step", {
            step: STEP.translate,
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
          send("step", { step: STEP.relationships, status: "started", message: "Analyzing source relationships..." });
          const relRes = await fetch(`${req.nextUrl.origin}/api/ai/source-relationships`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId }),
            signal: AbortSignal.timeout(120000),
          });
          if (relRes.ok) {
            const relJson = await relRes.json();
            send("step", {
              step: STEP.relationships,
              status: "done",
              message: `Relationship analysis saved: ${relJson.themes?.length || 0} themes, ${relJson.edges?.length || 0} connections — see the Relationships tab.`,
            });
            log(`relationships: auto analysis saved (${relJson.themes?.length || 0} themes)`);
          } else {
            send("step", { step: STEP.relationships, status: "skipped", message: `Relationship analysis skipped (${relRes.status}) — run it manually from the Relationships tab.` });
            log(`relationships: auto analysis FAILED (${relRes.status})`);
          }
        } catch (relErr: any) {
          send("step", { step: STEP.relationships, status: "skipped", message: "Relationship analysis skipped (timeout or LLM error)." });
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
            step: STEP.review,
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
          send("step", { step: STEP.review, status: "started", message: "Running peer review of the final article..." });
          const reviewRes = await fetch(`${req.nextUrl.origin}/api/ai/review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "review", articleId: article.id }),
            signal: AbortSignal.timeout(120000),
          });
          if (reviewRes.ok) {
            const rv = await reviewRes.json();
            send("step", {
              step: STEP.review,
              status: "done",
              verdict: rv.verdict,
              message: `Peer review saved: ${rv.verdict || "done"}${rv.scores?.overall != null ? ` (overall ${rv.scores.overall}/10)` : ""} — see the Review tab.`,
            });
            log(`review: auto peer review saved (verdict=${rv.verdict}, overall=${rv.scores?.overall ?? "?"})`);
          } else {
            send("step", { step: STEP.review, status: "skipped", message: `Peer review skipped (${reviewRes.status}) — run it manually from the Review tab.` });
            log(`review: auto review FAILED (${reviewRes.status})`);
          }
        } catch (revErr: any) {
          send("step", { step: STEP.review, status: "skipped", message: "Peer review skipped (timeout or LLM error)." });
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

        // round-cs-1: the complete payload is built once so the persisted
        // run timeline records EXACTLY what the client received.
        const completePayload = {
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
            // RT4 P0-2: observability — coverage-driven gathering (RT2 fields
            // that never reached this payload) + web-search cache counters
            // (hits/misses/stores/evictions — previously console-only).
            gatherCoverage: stats.gatherCoverage,
            gatherTopUpNewItems: stats.gatherTopUpNewItems,
            webSearchCache: { hits: webSearchCacheStats.hits, misses: webSearchCacheStats.misses, stores: webSearchCacheStats.stores, evictions: webSearchCacheStats.evictions },
            // RT7 (RT6 backlog #5): per-skill degradation surfacing — a run
            // that quietly degraded three skills no longer looks identical
            // to a fully clean one in the final stats block.
            skillDegraded: getSkillDegradedCounts(),
            skillCalls: getSkillStats().calls,
            // RT16: storm-recovery waits (gather web-retry / score rescore) —
            // incident + recovery disclosed in the timeline's recovery badge.
            stormRecovery: stats.stormRecovery,
            // RT9: cache-hit totals per skill (the collector always had
            // them; they only ever reached the console) + assembled-prompt
            // cost per taskType (chars — the 28K budget unit), so the next
            // context-budget decision is data-driven instead of guessed.
            skillCacheHits: getSkillStats().cacheHits,
            sessionContext: getSessionContextStats(),
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
        };
        send("complete", completePayload);
        // round-cs-1: finalize the persisted run timeline (summary + stats
        // + accuracy — everything the replay UI needs).
        try {
          await recorder?.complete(
            {
              articleId: article.id,
              wordCount: articleWordCount,
              references: globalRefs.length,
              sections: generatedParagraphs.length,
              totalMs,
              pipeline: "v2",
              hasChinese: !!articleContentZh,
            },
            { stats: completePayload.stats, accuracy: completePayload.accuracy },
          );
        } catch {}
        // RT8 (memory ceiling): the run's working set is dead weight now —
        // the SSE stream delivered, the DB holds the paragraphs/references,
        // and the checkpoints were just cleared. On the dev runtime V8 had
        // no pressure to collect any of it (the ~200-item gather arrays, the
        // full-text map, every repair round's full article copies, the
        // evidence bank), so RSS ratcheted run over run — the RT7 E2E
        // re-review then hit the 2.3GB ceiling on that pre-loaded heap.
        // Release + GC hint keeps the long-lived dev server lean.
        try {
          // (dbItems / uniqueItems / evidenceBank are phase-block-scoped and
          // unreachable here — the GC hint below collects them together with
          // the outer-scope sets released explicitly.)
          savedDataSources.length = 0;
          savedReferences.length = 0;
          repairRounds.length = 0;
          fullTexts.clear();
          if (typeof (globalThis as any).gc === "function") {
            try { (globalThis as any).gc(); } catch {}
          }
          log(`post-complete: run working set released [mem ${Math.round(process.memoryUsage().rss / 1048576)}MB]`);
        } catch {}
        safeClose();
      } catch (err: any) {
        const errMsg = String(err?.message ?? err);
        try { slog.error("FATAL", { ms: Date.now() - t0, error: errMsg.slice(0, 300) }); } catch {}
        log(`FATAL: ${errMsg.slice(0, 300)}`);
        // round-cs-1: record the failure on the persisted timeline BEFORE
        // the recovery logic runs (so even a crash during rollback leaves a
        // traceable failed run).
        try { await recorder?.fail(errMsg); } catch {}

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
      // Browser closed the SSE stream (navigate away / refresh / proxy
      // cut). round-cs-8: do NOT treat this as "audience gone" immediately —
      // the drop is often transient and the UI recovers by polling
      // /api/task-runs (each poll touches the run-watch registry). The
      // start() closure observes the verdict through `clientDisconnected`,
      // which the grace watcher flips only if nobody watches for
      // DISCONNECT_GRACE_MS after the drop.
      startDisconnectWatch();
      // round-cs-3: stop the keepalive pump too — nothing left to keep alive.
      cancelKeepalive?.();
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

