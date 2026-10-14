/**
 * Planning stage (RT17 route decomposition, seam 4b) — extracted verbatim
 * from api/ai/generate-full-v2/route.ts STEP 3 → STEP 5 (the fresh-run
 * phase block interior between the sources stage and the phase close).
 *
 * Scope: outline + citation-map co-design (plan, with the round-63
 * stormRetry wrapper — 6 attempts × 4-min storm waits), mechanical plan
 * fallback/normalization/CJK title translation, the word-reserve scaling,
 * the round-15 primary-paper coverage backfill (+ post-backfill tier gate
 * + score re-alignment), citation-plan validation, the multi-round research
 * gap agent (identify → targeted research → tier gate → persist → merge →
 * marginal-yield stop), the evidence-bank analysis, and the evidence
 * allocation.
 *
 * What deliberately STAYS in the route:
 *   - the `if (!resume)` phase-block WRAPPER (the resume path assigns the
 *     same hoisted lets from the checkpoint instead);
 *   - the pool checkpoint save right after the phase block (it serializes
 *     the TERMINAL bindings this module returns — splice order is
 *     load-bearing, RT11 discipline);
 *   - STEP 6+ (generate/verify/compose) consume {sections, allocations,
 *     curatedRefs} as returned terminal values.
 *
 * Identity contracts:
 *   - ctx.savedDataSources / ctx.savedReferences are the ROUTE-HOISTED
 *     arrays — the gap agent's persist loop pushes into them;
 *   - curatedRefs/curatedScores arrive as the sources-stage outputs and are
 *     REASSIGNED here (coverage backfill) and PUSHED (gap merge) — the
 *     TERMINAL pool is returned; nothing downstream reads the scores
 *     (verified: last curatedScores consumer is the gap merge itself);
 *   - sections/allocations are re-assigned from the plan/allocate outputs
 *     and returned as terminals.
 *
 * Error semantics (verbatim): plan failure after stormRetry = FATAL (the
 * phase has no try); the gap agent is strictly non-fatal (own catch +
 * storm/disconnect entry guard); analyze/allocate failures propagate to
 * the route's outer catch.
 *
 * VERBATIM MIGRATION NOTE: the body preserves the original route
 * indentation (8-space base inside the old closure) so every multi-line
 * template literal keeps its exact wire bytes.
 */

import {
  ensurePrimaryPaperCoverage,
  safeParseJSON,
} from "@/lib/generate-full-helpers";
import {
  formatScoredRefLine,
  validateSectionCitationPlan,
  synthesizeBackfillScore,
  typicalCitationCount,
  type SourceScore,
} from "@/lib/citation-planner";
import { partitionCitablePool } from "@/lib/source-tier";
import { chatWithSession } from "@/lib/llm-session";
import { isAborted as isAbortedLive } from "@/lib/rate-limiter";
import { STEP } from "@/lib/skill/steps";
import { normalizeSectionTitle } from "@/lib/writing";
import { hasCJKText, translateSectionTitlesToEnglish } from "@/lib/section-title-zh";
import {
  identifyEvidenceGaps,
  runGapResearch,
  GAP_AGENT_MAX_NEW_REFS,
  GAP_AGENT_POOL_CEILING,
} from "@/lib/research-gap";
import {
  extractEvidenceBank,
  allocateEvidenceToSections,
  type EvidenceRefInput,
} from "@/lib/evidence-pipeline";

export interface PlanningStageCtx {
  projectId: string;
  project: { topic: string; field?: string | null };
  targetWords: number;
  maxTokens: number;
  db: any;
  stats: any;
  savedDataSources: any[];
  savedReferences: any[];
  send: (event: string, data?: any) => void;
  log: (msg: string) => void;
  isClientDisconnected: () => boolean;
  // ---- sources-stage outputs (inputs; terminal values returned) ----
  curatedRefs: any[];
  curatedScores: SourceScore[];
  dedupedRefs: any[];
  fullTextProfiles: Map<string, any>;
  fullTexts: Map<string, string>;
}

export interface PlanningStageResult {
  sections: any[];
  allocations: any[];
  curatedRefs: any[];
}

/** Match a gap-research candidate back to its normalized pool ref (by
 * externalId or normalized title — the merge keeps both in sync).
 * (Route-local helper migrated with the seam, verbatim.) */
function titleMatchesGapRef(cand: { externalId?: string | null; title: string }, ref: any): boolean {
  const candExt = String(cand.externalId || "").trim().toLowerCase();
  const refExt = String(ref?.externalId || ref?.url || "").trim().toLowerCase();
  if (candExt && refExt && candExt === refExt) return true;
  const norm = (s: unknown) => String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return norm(cand.title) === norm(ref?.title);
}

export async function runPlanningStage(ctx: PlanningStageCtx): Promise<PlanningStageResult> {
  const {
    projectId, project, targetWords, maxTokens, db, stats,
    savedDataSources, savedReferences, send, log,
    dedupedRefs, fullTextProfiles, fullTexts,
  } = ctx;
  // Closure-style locals: these arrive as ctx values and are reassigned
  // in-place below (coverage backfill / gap merge), keeping every original
  // read/write site byte-identical.
  let curatedRefs = ctx.curatedRefs;
  let curatedScores = ctx.curatedScores;
  let sections: any[] = [];
  let allocations: any[] = [];
  const isAborted = () => isAbortedLive();
  const clientDisconnected = () => ctx.isClientDisconnected();

        // ============ STEP 3: Plan outline + citation map (round-42) ============
        // 先根据主题、长度确定大纲和引用哪些参考文献，再细化内容：the plan
        // now co-designs the outline AND which pool sources each section
        // cites — the allocation stage downstream only refines this map.
        send("step", {
          step: STEP.plan,
          status: "started",
          message: `Planning the outline + citation map for a ${targetWords}-word article from ${curatedRefs.length} scored sources...`,
        });
        const planSystem =
          "You are a senior research advisor who designs publication-ready review outlines. " +
          "Plan sections with target word counts that sum to the total, AND decide which references each section cites. " +
          "Prefer MORE sections with SMALLER targets. " +
          "ALL output — every section title and focus line — MUST be written in ENGLISH: when the research topic is in another language (e.g. Chinese), translate its concepts into English.";
        const scoredPoolLines = curatedRefs
          .slice(0, 40)
          .map((r: any, i: number) => formatScoredRefLine(r, curatedScores[i], i + 1))
          .join("\n");
        const planPrompt = `RESEARCH TOPIC: ${project.topic}
FIELD: ${project.field || "life sciences"}
TARGET TOTAL WORDS: ${targetWords}
CITATION POOL: ${curatedRefs.length} scored sources — the article's citations come ONLY from this pool.
LANGUAGE: The topic above may be written in Chinese or another language. Every "title" and "focus" in your JSON MUST still be written in ENGLISH — never copy Chinese characters into the outline.

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
                step: STEP.plan,
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
          metadata: { step: STEP.plan, targetWords },
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

        // ★ round-cs-6 (语言一致性 + 格式统一): normalize plan titles (strip
        // leading "3." numbering, stray quotes, trailing periods) and
        // translate any CJK titles to English. A Chinese-language topic used
        // to leak Chinese section headings straight into the English article
        // ("夹杂中文") and numbered titles made compose headings inconsistent
        // ("每章格式不统一"). One small batch call; non-fatal.
        for (let si = 0; si < sections.length; si++) {
          sections[si].title = normalizeSectionTitle(String(sections[si].title || "")) || `Section ${si + 1}`;
        }
        if (sections.some((s: any) => hasCJKText(String(s.title || "")))) {
          const cjkCount = sections.filter((s: any) => hasCJKText(String(s.title || ""))).length;
          send("step", {
            step: STEP.plan,
            status: "progress",
            message: `Translating ${cjkCount} Chinese section title(s) to English for the English article...`,
          });
          try {
            const translated = await translateSectionTitlesToEnglish(sections.map((s: any) => String(s.title || "")));
            let fixed = 0;
            translated.forEach((t: string | null, k: number) => {
              if (t && sections[k]) {
                sections[k].title = t;
                fixed++;
              }
            });
            log(`plan: translated ${fixed}/${cjkCount} CJK section titles to English`);
          } catch (titleErr: any) {
            log(`plan: CJK title translation failed (keeping original titles): ${String(titleErr?.message ?? titleErr).slice(0, 80)}`);
          }
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
          step: STEP.plan,
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
          dedupedRefs,
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
              step: STEP.plan,
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
            step: STEP.plan,
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
          step: STEP.plan,
          status: "progress",
          message: `Citation map: ${citationPlanSummary.totalPlanned}/${curatedRefs.length} pool sources cited — ${citationPlanSummary.coreCovered} core retained${citationPlanSummary.toppedUp ? `, ${citationPlanSummary.toppedUp} priority top-up(s)` : ""}${citationPlanSummary.coreMissing ? `, ${citationPlanSummary.coreMissing} core UNCOVERED (sections at capacity)` : ""}.`,
        });
        log(
          `plan: citation map — ${citationPlanSummary.totalPlanned}/${curatedRefs.length} cited, coreCovered=${citationPlanSummary.coreCovered}, coreMissing=${citationPlanSummary.coreMissing}, toppedUp=${citationPlanSummary.toppedUp}`
        );

        // ============ STEP 3.5 (round-cs-2/3): ★ Research Gap Agent (multi-round) ============
        // ClawsGO-inspired autonomous research: the initial gather (STEP 1)
        // runs BEFORE the outline exists, so it cannot know what the outline
        // will later need. This stage re-examines the PLANNED outline against
        // the references actually allocated to each section and, where a
        // section promises evidence no allocated source provides, executes
        // TARGETED supplementary searches (PubMed + web) and merges the
        // survivors into the pool — the way a human writer keeps searching
        // while drafting. Bounded (≤3 gaps, ≤2 queries/gap, ≤6 new refs) and
        // strictly non-fatal: any failure leaves the pool untouched.
        //
        // round-cs-3 (multi-round): after a PRODUCTIVE round merges new refs,
        // the outline is RE-AUDITED against the updated allocations — a
        // round-1 fix can be insufficient (searches missed the right paper)
        // or the now-covered surface can expose deeper gaps. Round 2 only
        // pursues gaps it has NOT already tried (same section + same missing
        // evidence = the same queries = the same misses, so they are skipped)
        // and the whole loop shares one new-refs budget.
        const GAP_AGENT_MAX_ROUNDS = 2;
        send("step", {
          step: STEP.gapAgent,
          status: "started",
          message: "Research gap agent: auditing the outline against the allocated evidence...",
        });
        // Storm guard: if the rate limiter already hoisted the abort flag
        // (account-level 429 storm), the identify call would just burn its
        // 5×≤30s retry budget — skip the stage entirely; the section loop's
        // own abort handling takes over from here.
        if (isAborted() || clientDisconnected()) {
          send("step", {
            step: STEP.gapAgent,
            status: "skipped",
            message: `Gap agent skipped — ${clientDisconnected() ? "client disconnected" : "provider rate-limit abort"}; the pipeline continues with the curated pool.`,
          });
          log("gapAgent: skipped (rate-limit abort flag set at stage start)");
        } else
        try {
          let gapRound = 0;
          let totalGaps = 0;
          let totalQueries = 0;
          let totalMerged = 0;
          let remainingBudget = GAP_AGENT_MAX_NEW_REFS;
          const mergedTitles: string[] = [];
          const pursuedGapKeys = new Set<string>();
          let terminalSent = false;
          let gapStopReason = "";

          while (gapRound < GAP_AGENT_MAX_ROUNDS) {
            gapRound += 1;
            if (gapRound > 1) {
              if (isAborted() || clientDisconnected()) {
                gapStopReason = "provider abort before re-audit";
                break;
              }
              if (remainingBudget <= 0) {
                gapStopReason = "new-reference budget exhausted";
                break;
              }
              send("step", {
                step: STEP.gapAgent,
                status: "progress",
                message: `Gap agent round ${gapRound}/${GAP_AGENT_MAX_ROUNDS}: re-auditing the outline against the updated evidence allocations...`,
              });
            }

            const gapIdentify = await identifyEvidenceGaps(
              projectId,
              sections,
              curatedRefs,
              project.topic,
              project.field || "life sciences",
              { maxTokens },
            );
            const poolBudget = Math.max(0, GAP_AGENT_POOL_CEILING - curatedRefs.length);
            const gapBudget = Math.min(remainingBudget, poolBudget);

            // round ≥ 2: only pursue gaps not already attempted in an earlier
            // round — identical gaps get identical queries and identical
            // misses, so re-running them burns budget for nothing.
            const freshGaps =
              gapRound === 1
                ? gapIdentify.gaps
                : gapIdentify.gaps.filter((g: any) => {
                    const key = `${g.sectionIndex}::${String(g.gap).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80)}`;
                    return !pursuedGapKeys.has(key);
                  });
            for (const g of gapIdentify.gaps) {
              pursuedGapKeys.add(
                `${g.sectionIndex}::${String(g.gap).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80)}`,
              );
            }

            if (freshGaps.length === 0) {
              if (gapRound === 1) {
                send("step", {
                  step: STEP.gapAgent,
                  status: "done",
                  gapsFound: 0,
                  message: gapIdentify.llmError
                    ? `Gap agent: identification unavailable (${gapIdentify.llmError}) — pool unchanged.`
                    : `Gap audit clean: every section's focus is supported by its allocated references — no supplementary retrieval needed.`,
                });
                log(`gapAgent: no gaps identified${gapIdentify.llmError ? ` (identify error: ${gapIdentify.llmError})` : ""}`);
              } else {
                stats.gapAgent = { gaps: totalGaps, queries: totalQueries, newRefs: totalMerged };
                send("step", {
                  step: STEP.gapAgent,
                  status: "done",
                  gapsFound: totalGaps,
                  queriesRun: totalQueries,
                  newRefs: totalMerged,
                  message: `Gap agent: round 2 re-audit found no new evidence gaps — round-1 coverage stands (${totalMerged} reference(s) merged).`,
                  detail: mergedTitles.join("\n"),
                });
                log(`gapAgent: round-2 re-audit clean (${totalGaps} gaps, ${totalQueries} queries, ${totalMerged} refs total)`);
              }
              terminalSent = true;
              break;
            }
            if (gapBudget <= 0) {
              stats.gapAgent = { gaps: totalGaps, queries: totalQueries, newRefs: totalMerged };
              send("step", {
                step: STEP.gapAgent,
                status: "done",
                gapsFound: totalGaps,
                queriesRun: totalQueries,
                newRefs: totalMerged,
                message:
                  gapRound === 1
                    ? `Gap agent found ${freshGaps.length} gap(s) but the curated pool is at the analyze ceiling (${curatedRefs.length} refs) — no room for additions.`
                    : `Gap agent: ${freshGaps.length} new gap(s) identified but the addition budget is spent (${totalMerged} merged) — stopping here.`,
              });
              log(`gapAgent: ${freshGaps.length} gap(s) but budget/ceiling reached (pool ${curatedRefs.length})`);
              terminalSent = true;
              break;
            }
            send("step", {
              step: STEP.gapAgent,
              status: "progress",
              gapsFound: totalGaps + freshGaps.length,
              message: `${gapRound > 1 ? `Round ${gapRound}: ` : ""}${freshGaps.length} evidence gap(s) identified${gapIdentify.mechanicalGaps > 0 ? ` (${gapIdentify.mechanicalGaps} section(s) with zero allocated refs)` : ""} — running targeted searches...`,
              detail: freshGaps.map((g: any) => `§${g.sectionIndex + 1} ${g.sectionTitle}: ${g.gap}`).join("\n"),
            });
            const gapResearch = await runGapResearch(projectId, project.topic, freshGaps, [...dedupedRefs, ...curatedRefs], {
              maxNewRefs: gapBudget,
              maxTokens,
              onProgress: (m) => send("step", { step: STEP.gapAgent, status: "progress", message: `Gap agent${gapRound > 1 ? ` [round ${gapRound}]` : ""}: ${m}` }),
            });
            totalGaps += freshGaps.length;
            totalQueries += gapResearch.queriesRun;

            if (gapResearch.candidates.length === 0) {
              if (gapRound === 1) {
                send("step", {
                  step: STEP.gapAgent,
                  status: "done",
                  gapsFound: totalGaps,
                  queriesRun: totalQueries,
                  newRefs: 0,
                  message: `Gap agent ran ${gapResearch.queriesRun} supplementary search(es) but every result was a duplicate or off-topic — pool unchanged.`,
                });
              } else {
                stats.gapAgent = { gaps: totalGaps, queries: totalQueries, newRefs: totalMerged };
                send("step", {
                  step: STEP.gapAgent,
                  status: "done",
                  gapsFound: totalGaps,
                  queriesRun: totalQueries,
                  newRefs: totalMerged,
                  message: `Gap agent: round ${gapRound} searches found nothing new — round-1 merges stand (${totalMerged} reference(s)).`,
                });
              }
              log(`gapAgent[round ${gapRound}]: 0 new refs (${gapResearch.queriesRun} queries, ${gapResearch.rejected.length} rejected)`);
              terminalSent = true;
              break;
            }
            // Score the newcomers (coverage-backfill pattern: a gap-filled
            // ref is deliberately core) so downstream score consumers stay
            // aligned with the pool array.
            let newRefs: any[] = gapResearch.candidates.map((c) => ({
              type: c.source === "web" ? "web" : "pubmed",
              externalId: c.externalId || c.url,
              title: c.title,
              authors: c.authors || null,
              journal: c.journal || null,
              year: c.year || null,
              url: c.url || null,
              doi: c.doi || null,
              abstract: c.abstract || null,
              extra: c.extra,
            }));
            let newScores = newRefs.map((r) => ({ ...synthesizeBackfillScore(r), reason: "gap-agent backfill — fills an outline evidence gap" }));

            // The tier gate faces web candidates too (the same
            // hospital/news/encyclopedia junk the STEP 2.2 gate rejects).
            const gapTier = partitionCitablePool(newRefs, newScores as any);
            if (gapTier.dropped.length > 0 && !gapTier.fellBackToUnfiltered) {
              log(
                `gapAgent: tier gate dropped ${gapTier.dropped.length} non-primary web source(s) — ` +
                  gapTier.dropped.map((d) => `[${d.reason}] ${String(d.ref?.title || "").slice(0, 50)}`).join(" | "),
              );
              newRefs = gapTier.keptRefs;
              newScores = gapTier.keptScores;
            }

            // Persist (Data panel + References table) — same shape as gather.
            for (let ni = 0; ni < newRefs.length; ni++) {
              const c = gapResearch.candidates.find(
                (x) => titleMatchesGapRef(x, newRefs[ni]),
              );
              const nr = newRefs[ni];
              try {
                const ds = await db.dataSource.create({
                  data: {
                    projectId,
                    source: c?.source || "pubmed",
                    query: c?.queryUsed || "gap-agent supplementary search",
                    rawJson: JSON.stringify({ items: [{ ...nr, gatherMethod: "gap-agent" }] }),
                    title: nr.title,
                    externalId: nr.externalId || null,
                    url: nr.url || null,
                    authors: nr.authors || null,
                    journal: nr.journal || null,
                    year: nr.year || null,
                    doi: nr.doi || null,
                    abstract: nr.abstract || null,
                    extra: nr.extra ? JSON.stringify(nr.extra) : null,
                    pinned: true,
                  },
                });
                savedDataSources.push(ds);
                const ref = await db.reference.create({
                  data: {
                    type: c?.source === "web" ? "web" : "pubmed",
                    externalId: nr.externalId || nr.url,
                    title: nr.title,
                    authors: nr.authors || null,
                    journal: nr.journal || null,
                    year: nr.year || null,
                    url: nr.url || null,
                    doi: nr.doi || null,
                    abstract: nr.abstract || null,
                    projectId,
                  },
                });
                savedReferences.push(ref);
              } catch (persistErr: any) {
                log(`gapAgent: persist failed for "${String(nr.title).slice(0, 50)}": ${String(persistErr?.message ?? persistErr).slice(0, 100)}`);
              }
            }

            // Merge: append to the curated pool + extend the target
            // sections' citation maps (new indices continue after the pool).
            // NOTE: gapIndex indexes into `freshGaps` (the array the research
            // stage received), not gapIdentify.gaps.
            const baseIndex = curatedRefs.length;
            for (let ni = 0; ni < newRefs.length; ni++) {
              curatedRefs.push(newRefs[ni]);
              newScores[ni].index = baseIndex + ni + 1;
              curatedScores.push(newScores[ni]);
              mergedTitles.push(`[${baseIndex + ni + 1}] ${String(newRefs[ni].title).slice(0, 70)}`);
              const gi = gapResearch.candidates.find(
                (x) => titleMatchesGapRef(x, newRefs[ni]),
              )?.gapIndex;
              if (gi != null && freshGaps[gi]) {
                const target = sections[freshGaps[gi].sectionIndex];
                if (target && Array.isArray(target.refIndices) && target.refIndices.length < 12) {
                  target.refIndices.push(baseIndex + ni + 1);
                } else if (target) {
                  if (!Array.isArray(target.refIndices)) target.refIndices = [];
                  if (target.refIndices.length < 12) target.refIndices.push(baseIndex + ni + 1);
                }
              }
            }
            totalMerged += newRefs.length;
            remainingBudget = Math.max(0, remainingBudget - newRefs.length);
            stats.gapAgent = {
              gaps: totalGaps,
              queries: totalQueries,
              newRefs: totalMerged,
            };

            if (gapRound >= GAP_AGENT_MAX_ROUNDS) {
              send("step", {
                step: STEP.gapAgent,
                status: "done",
                gapsFound: totalGaps,
                queriesRun: totalQueries,
                newRefs: totalMerged,
                message: `Gap agent: ${totalGaps} gap(s) → ${totalQueries} targeted search(es) across ${gapRound} round(s) → ${totalMerged} new reference(s) merged into the pool and allocated to their sections.`,
                detail: mergedTitles.join("\n"),
              });
              log(
                `gapAgent: done — ${totalGaps} gaps → ${totalQueries} queries → ${totalMerged} refs merged (${mergedTitles.join(" | ")})`,
              );
              terminalSent = true;
              break;
            }
            // round-RT2 (agent-controlled gathering — marginal-yield stop):
            // before committing a second round, measure whether round 1
            // actually moved the needle. A round that merged < 2 refs or left
            // coverage essentially unchanged says the same queries would
            // re-run the same misses — stop instead of burning budget.
            {
              const { assessTopicCoverage, shouldContinueGathering } = await import("@/lib/gather-coverage");
              const cov = assessTopicCoverage(
                project.topic,
                curatedRefs.map((r: any) => ({ title: r.title, abstract: r.abstract })),
              );
              const verdict = shouldContinueGathering({
                assessment: cov,
                newRefsLastRound: newRefs.length,
                poolSize: curatedRefs.length,
                poolCeiling: GAP_AGENT_POOL_CEILING,
              });
              if (!verdict.continue) {
                stats.gapAgent = { gaps: totalGaps, queries: totalQueries, newRefs: totalMerged };
                send("step", {
                  step: STEP.gapAgent,
                  status: "done",
                  gapsFound: totalGaps,
                  queriesRun: totalQueries,
                  newRefs: totalMerged,
                  message: `Gap agent: stopping after round ${gapRound} — ${verdict.reason} (${totalMerged} reference(s) merged).`,
                  detail: mergedTitles.join("\n"),
                });
                log(`gapAgent: early stop after round ${gapRound} — ${verdict.reason}`);
                terminalSent = true;
                break;
              }
            }
            send("step", {
              step: STEP.gapAgent,
              status: "progress",
              gapsFound: totalGaps,
              queriesRun: totalQueries,
              newRefs: totalMerged,
              message: `Gap agent round ${gapRound}: merged ${newRefs.length} new reference(s) (${totalMerged} total) — re-auditing the outline before the analyze stage...`,
              detail: mergedTitles.join("\n"),
            });
            log(
              `gapAgent[round ${gapRound}]: merged ${newRefs.length} refs (total ${totalMerged}) — re-auditing`,
            );
            // Loop continues: the next round re-audits coverage with the
            // updated allocations and only pursues genuinely new gaps.
          }
          if (!terminalSent) {
            // The loop exited via a pre-audit break (storm/budget) after a
            // productive round — emit the aggregate terminal event here.
            stats.gapAgent = { gaps: totalGaps, queries: totalQueries, newRefs: totalMerged };
            send("step", {
              step: STEP.gapAgent,
              status: "done",
              gapsFound: totalGaps,
              queriesRun: totalQueries,
              newRefs: totalMerged,
              message: `Gap agent: ${totalGaps} gap(s) → ${totalQueries} search(es) → ${totalMerged} reference(s) merged; further rounds stopped (${gapStopReason}).`,
              detail: mergedTitles.join("\n"),
            });
            log(`gapAgent: stopped after round ${gapRound} — ${gapStopReason} (${totalMerged} refs merged)`);
          }
        } catch (gapErr: any) {
          // Non-fatal by contract: the pipeline continues with the pool as
          // curation built it.
          log(`gapAgent: FAILED — ${String(gapErr?.message ?? gapErr).slice(0, 160)}`);
          send("step", {
            step: STEP.gapAgent,
            status: "skipped",
            message: `Gap agent skipped after an error (the pipeline continues unchanged): ${gapErr?.message?.slice(0, 80) || "LLM error"}.`,
          });
        }

        // ============ STEP 4: ★ Analyze — extract evidence bank ============
        // round-42: full texts ride along — refs whose full text was fetched
        // get a ~900-char excerpt in the analysis prompt, so their extracted
        // claims come from the COMPLETE article, deeper than abstract-only
        // refs (能获取到全文的一定要看全文).
        send("step", {
          step: STEP.analyze,
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
          step: STEP.analyze,
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
        send("step", { step: STEP.allocate, status: "started", message: "Allocating references + evidence to sections per the citation map..." });

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
          step: STEP.allocate,
          status: "done",
          message: `Allocated references to ${allocations.length} sections (avg ${Math.round(allocations.reduce((s, a) => s + a.refIndices.length, 0) / Math.max(1, allocations.length))} refs/section${hasPreallocation ? ", from the plan's citation map" : ""}).`,
          detail: allocations.map((a, i) => `§${i + 1}: ${a.refIndices.length} refs, ${a.evidence.length} claims (${a.rationale})`).join("\n"),
        });
        log(`allocate: ${JSON.stringify(allocations.map(a => a.refIndices.length))}${hasPreallocation ? " (plan-preallocated)" : ""}`);
  return { sections, allocations, curatedRefs };
}
