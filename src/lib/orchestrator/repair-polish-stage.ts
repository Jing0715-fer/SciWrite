/**
 * Repair-polish stage (RT17 route decomposition, seam 5) — extracted
 * verbatim from api/ai/generate-full-v2/route.ts STEP 8.5 → finalization
 * (the block between the title generation and STEP 9 translate).
 *
 * Scope: the auto review & repair loop (review → surgical/scoped revise →
 * deterministic renormalization → heading pinning → revision guard →
 * re-review, bounded at REPAIR_MAX_REVISIONS), the whole-article coherence
 * polish (multi-pass, POLISH_MAX_PASSES), the paragraph global-numbering
 * sync ($transaction), the article row creation, the repair Review rows +
 * repairSummary persistence, the coherence Review row, the final mechanical
 * audit, and the compose:done event.
 *
 * MODULE-LEVEL GOLDEN (RT12/RT13 discipline): compose:done is the LAST event
 * this module emits, and it comes after EVERY DB write in the block.
 *
 * Error asymmetry (RT13 pinned, verbatim):
 *   - paragraph-sync $transaction / article.create: propagate fatally (the
 *     route's outer catch turns them into the resumable partial-work state);
 *   - per-round db.review.create: log-and-continue (ALL later rounds still
 *     attempted);
 *   - repairSummary / coherence Review row: log only.
 *   - repair loop itself: non-fatal catch (repairRounds cleared, telemetry
 *     reset, repair:skipped, pipeline continues);
 *   - polish entry guard (isAborted || disconnected): skipped event, no try;
 *     polish pass errors: non-fatal catch.
 *
 * Identity contracts (shared references, mutated by DESIGN):
 *   - ctx.renumberedContents: elements are REWRITTEN in place when a
 *     repair/polish revision is adopted (paragraph sync reads the finals);
 *   - ctx.globalRefs: re-synced IN PLACE (length=0 + push) after adoption;
 *   - the returned repairRounds array keeps its identity — the route's
 *     review-event gate and the post-complete release clear it in place.
 *
 * The caller passes isClientDisconnected as a GETTER (the route's
 * clientDisconnected is a mutable closure let, mid-stage flips must be
 * observed at the exact points the inline code observed them).
 *
 * VERBATIM MIGRATION NOTE: the body preserves the original route indentation
 * (8-space base inside the old closure) to guarantee zero byte drift in
 * multi-line template literals — the messages are wire payloads.
 */

import {
  actionableFindings,
  distinctCitations,
  renormalizeArticleCitations,
  repairRoundSnapshotOf,
  restoreOriginalHeadings,
  revisionGuard,
  reviseArticleCore,
  reviseArticleScoped,
  reviewArticleCore,
  shouldStopForConvergence,
  splitBodySections,
} from "@/lib/review-engine";
import {
  numericFindingToWeakness,
  sweepNumericClaims,
} from "@/lib/numeric-sweep";
import { buildAuditReport, splitBodyAndReferences } from "@/lib/citation-audit";
import { reviewArticleCoherence, polishArticleCoherence } from "@/lib/coherence-polish";
import { normalizeArticleBodySections, countWords } from "@/lib/writing";
import { REPAIR_MAX_REVISIONS } from "@/lib/v2-config";
import { inferFormat } from "@/lib/generate-full-helpers";
import { STEP } from "@/lib/skill/steps";

export interface RepairPolishCtx {
  projectId: string;
  project: { topic: string };
  maxTokens: number;
  db: any;
  stats: any;
  send: (event: string, data?: any) => void;
  log: (msg: string) => void;
  isAborted: () => boolean;
  isClientDisconnected: () => boolean;
  // ---- STEP 8 compose outputs (inputs) ----
  articleTitle: string;
  articleTitleZh: string | null;
  /** Compose output (body + References). The final value is RETURNED. */
  articleContent: string;
  enTitles: string[];
  /** Same-reference array — elements rewritten in place on adoption. */
  renumberedContents: string[];
  /** Same-reference array — re-synced in place (length=0 + push). */
  globalRefs: any[];
  refList: string;
  journalTemplate: string;
  sections: any[];
  generatedParagraphs: any[];
}

export interface RepairPolishResult {
  /** The created Article row (STEP 9 / complete consume it). */
  article: any;
  /** Terminal article content after repair + polish adoption. */
  articleContent: string;
  /** Final mechanical audit (complete payload accuracy block). */
  audit: ReturnType<typeof buildAuditReport>;
  /** Shared reference — route gates the review event on it and clears it
   * in place at release. */
  repairRounds: any[];
  repairTelemetry: {
    reviews: number;
    revisions: number;
    guardRejections: number;
    droppedRefs: number;
    strippedNumbers: number;
    triggered: boolean;
    stopReason: string;
    finalVerdict: string;
    finalOverall: number | null;
    numericSweep?: any;
  };
}

export async function runRepairPolishStage(ctx: RepairPolishCtx): Promise<RepairPolishResult> {
  const {
    projectId, project, maxTokens, db, stats, send, log,
    isAborted, isClientDisconnected,
    articleTitle, articleTitleZh, enTitles, renumberedContents, globalRefs,
    refList, journalTemplate, sections, generatedParagraphs,
  } = ctx;
  // The inline code read these as closure lets; the module keeps them as
  // locals so every original read/write site is byte-identical.
  const clientDisconnected = () => isClientDisconnected();
  let articleContent = ctx.articleContent;

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
          step: STEP.repair,
          status: "started",
          message: "Auto-review & repair: fact-checking the composed article before translation...",
        });
        try {
          const originalSectionTitles = [...enTitles];
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
          // round-RT3 (R1): previous round's snapshot for the convergence gate.
          let prevRoundSnapshot: import("@/lib/review-engine").RepairRoundSnapshot | null = null;
          for (let round = 1; round <= REPAIR_MAX_REVISIONS + 1; round++) {
            if (clientDisconnected()) {
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
            let act = actionableFindings(rc);

            // ★ round-RT3 (R1): convergence early-exit. The RT2 production
            // spent 3 review rounds where rounds 2-3 bought ~1 finding each
            // and the overall score sat at 6/10 throughout — pure churn.
            // Rule (see shouldStopForConvergence): a round that gained <1
            // overall score, did not shrink the hard findings, and produced
            // no NEW contradiction ends the loop — the remaining issues are
            // disclosed in the Review tab instead of re-revised.
            const roundSnapshot = repairRoundSnapshotOf(rc);
            const convergence = shouldStopForConvergence(prevRoundSnapshot, roundSnapshot);
            if (round > 1 && convergence.stop && act.actionable) {
              repairTelemetry.stopReason = convergence.reason;
              log(`repair: round ${round} EARLY EXIT — ${convergence.reason}`);
              send("step", {
                step: STEP.repair,
                status: "progress",
                round,
                message: `Round ${round}: ${convergence.reason}.`,
              });
              // The round still counts as a REVIEW (persisted + disclosed),
              // just not as a revision trigger.
              repairRounds.push({
                round,
                core: rc,
                actionable: act.actionable,
                trigger: act.trigger,
                reason: act.reason,
                revisedContent: null as string | null,
                guardRejected: null as string[] | null,
                converged: true,
              });
              break;
            }
            prevRoundSnapshot = roundSnapshot;

            // ★ round-RT3 (R6): advisory numeric-coverage sweep — every
            // citation-bearing number+unit sentence is cross-checked
            // against the cited abstracts at ZERO LLM cost. Findings are
            // injected as ADVISORY weaknesses (never a hard trigger: an
            // absent-from-abstract number is a verification gap, not proof
            // of error) so the reviewer/reviser sees them and the Review
            // tab discloses them.
            try {
              const sweep = sweepNumericClaims(
                splitBodyAndReferences(currentContent).body,
                abstractMap,
              );
              (repairTelemetry as any).numericSweep = {
                sentencesExamined: sweep.sentencesExamined,
                covered: sweep.covered,
                gaps: sweep.findings.length,
              };
              if (sweep.findings.length > 0) {
                const numericWeaknesses = sweep.findings.slice(0, 5).map(numericFindingToWeakness);
                log(
                  `repair: numeric sweep — ${sweep.sentencesExamined} numeric sentence(s) examined, ${sweep.covered} covered, ${sweep.findings.length} gap(s) (advisory)`,
                );
                send("step", {
                  step: STEP.repair,
                  status: "progress",
                  round,
                  message: `Numeric coverage sweep: ${sweep.findings.length} value(s) not found in their cited abstract(s) — flagged as advisory for the reviewer.`,
                });
                // Advisory injection into mergedWeaknesses: they ride the
                // revision feedback when a revision is already happening AND
                // the Review tab (which persists mergedWeaknesses) discloses
                // them; they never start a revision round on their own.
                for (const w of numericWeaknesses) {
                  if (rc.mergedWeaknesses.length >= 15) break;
                  rc.mergedWeaknesses.push(w);
                }
              }
            } catch {
              // sweep is best-effort by contract
            }

            // ★ round-64: article-level STRUCTURAL citation hygiene. The
            // ferroptosis production run (round-63) shipped with a 500-word
            // zero-citation section, a near-verbatim redundant section, an
            // introduction citing [1] six times, and a raw RCSB PDB entry in
            // the reference list — none visible to the per-citation checks,
            // and the LLM reviewer rated that article 7/10 anyway. These pure
            // mechanical findings are injected as review weaknesses (the
            // reviser sees them verbatim); sparse-section and malformed-ref
            // additionally escalate to a hard revision trigger because they
            // are objective defects, not style preferences.
            const structuralAudit = buildAuditReport(currentContent, []);
            const structuralFindings = structuralAudit.findings.filter(
              (f: any) =>
                f.verdict === "sparse-section" ||
                f.verdict === "redundant-section" ||
                f.verdict === "overcited-ref" ||
                f.verdict === "malformed-ref",
            );
            const structuralWeaknesses = structuralFindings.map(
              (f: any) => `[STRUCTURAL ${f.verdict}] ${f.reason}`,
            );
            if (structuralFindings.length > 0) {
              const kinds = structuralFindings.map((f: any) => f.verdict).join(", ");
              log(`repair: round ${round} structural citation audit: ${kinds}`);
              send("step", {
                step: STEP.repair,
                status: "progress",
                round,
                message: `Structural citation audit: ${structuralFindings.length} issue(s) (${kinds}).`,
              });
              const hardStructural = structuralFindings.some(
                (f: any) => f.verdict === "sparse-section" || f.verdict === "malformed-ref",
              );
              if (hardStructural && !act.actionable) {
                act = {
                  ...act,
                  actionable: true,
                  trigger: "fact",
                  reason: `structural citation hygiene (${kinds})`,
                };
              }
            }
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
              step: STEP.repair,
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
              send("step", { step: STEP.repair, status: "progress", message: `${repairTelemetry.stopReason}.` });
              break;
            }

            // --- Produce a candidate revision against THIS round's findings ---
            const feedback = {
              round,
              verdict: rc.parsed.verdict || "major-revision",
              summary: rc.parsed.summary || "",
              scores: rc.parsed.scores,
              strengths: rc.parsed.strengths || [],
              weaknesses: [...rc.mergedWeaknesses, ...structuralWeaknesses],
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
                step: STEP.repair,
                status: "progress",
                round,
                message: `Round ${round} revision attempt ${attempt} rejected by mechanical guard (${guard.reasons[0]})${attempt === 1 ? " — retrying with structural feedback..." : ""}`,
              });
            }

            if (candidate === null) {
              repairTelemetry.stopReason = "revision failed the mechanical guard (all attempts)";
              send("step", {
                step: STEP.repair,
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
              step: STEP.repair,
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
            // round-cs-7: the repair revision is a WHOLE-ARTICLE LLM rewrite —
            // it can re-inject per-section reference lists, internal headings,
            // lists, fullwidth punctuation, odd bold and LaTeX delimiters that
            // the per-section pipeline already stripped. Re-run the full
            // per-section normalization gauntlet over the revised body (##
            // section headings stay pinned; citation numbering is untouched).
            // RT6 note: normalizeArticleBodySections stays AS-IS here — it is
            // the CHUNKED combinator (per-##-section, headings pinned,
            // preamble preserved), which is NOT equivalent to running the
            // registered whole-text gate chain over a multi-section body.
            // The gate chain serves single-section/paragraph exits; this
            // whole-article exit keeps the chunked combinator.
            try {
              const rs = splitBodyAndReferences(articleContent);
              const normalizedBody = normalizeArticleBodySections(rs.body);
              articleContent = normalizedBody.trimEnd() + "\n\n" + rs.referencesText.trim();
            } catch (normErr: any) {
              log(`repair: post-revision format renormalization skipped (${normErr?.message?.slice(0, 60)}) — revision kept as-is`);
            }
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
              const origRefLines = refList.split("\n").map((l: string) => l.replace(/^\s*\[\d+\]\s*/, "").trim()).filter(Boolean);
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
            step: STEP.repair,
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
            step: STEP.repair,
            status: "skipped",
            message: `Auto-repair skipped after an error (the composed article is unaffected): ${repairErr?.message?.slice(0, 80) || "LLM error"}.`,
          });
        }

        // ============ STEP 8.6 (round-cs-2): ★ Whole-article coherence polish ============
        // The repair loop (8.5) is CLAIM-scoped: it checks individual facts
        // against individual sources. What it cannot see is the article AS A
        // WHOLE — near-duplicate claims living in two sections, the same
        // quantity stated with two values, a protein renamed mid-article,
        // missing bridges between chapters, and quiet contradictions between
        // sections that were written independently (each saw only a digest of
        // the others). This pass reviews the FULL body for exactly those
        // cross-section defects, then re-edits each affected section WITH its
        // neighbors' edges (context-aware polishing — 不断根据上下文打磨).
        // Mechanical gauntlet after: citation-set preservation (additions
        // forbidden), deterministic renormalization, heading pinning, and the
        // revision guard. Non-fatal: any failure keeps the article exactly as
        // the repair loop left it.
        const polishTelemetry = {
          reviewRan: false,
          findings: 0,
          findingsAddressed: 0,
          revisedSections: 0,
          triggered: false,
          stopReason: "",
        };
        let coherenceReviewRow: {
          verdict: string;
          summary: string;
          weaknesses: string[];
          suggestions: string[];
          revisedContent: string | null;
        } | null = null;
        // round-cs-3 (multi-pass): after a polish is ADOPTED, the revised
        // article is re-reviewed once more — a fix in §2 can contradict §5's
        // untouched text, and single-pass polish structurally cannot notice.
        // The loop stops early on: a clean re-review, an unavailable/rejected
        // polish, or the pass budget (POLISH_MAX_PASSES).
        const POLISH_MAX_PASSES = 2;
        send("step", {
          step: STEP.polish,
          status: "started",
          message: "Coherence pass: reviewing the full article for cross-section issues (repetition, contradictions, terminology drift, broken bridges)...",
        });
        // Storm guard: same rationale as the gap agent — an abort-flagged run
        // must not burn the coherence review's retry budget.
        if (isAborted() || clientDisconnected()) {
          send("step", {
            step: STEP.polish,
            status: "skipped",
            message: `Coherence pass skipped — ${clientDisconnected() ? "client disconnected" : "provider rate-limit abort"}; the article stands as repaired.`,
          });
          log("polish: skipped (rate-limit abort flag set at stage start)");
        } else
        try {
          let pass = 0;
          let totalFindings = 0;
          let totalAddressed = 0;
          const revisedSectionSet = new Set<number>();
          const allWeaknesses: string[] = [];
          const allSuggestions: string[] = [];

          while (pass < POLISH_MAX_PASSES) {
            pass += 1;
            if (pass > 1) {
              if (isAborted() || clientDisconnected()) {
                coherenceReviewRow = {
                  verdict: "accept",
                  summary: `[Coherence pass] ${totalFindings} cross-section finding(s) — ${totalAddressed} addressed in pass 1; re-review skipped (provider abort), pass-1 fixes stand.`,
                  weaknesses: allWeaknesses,
                  suggestions: allSuggestions,
                  revisedContent: articleContent,
                };
                send("step", {
                  step: STEP.polish,
                  status: "done",
                  findings: totalFindings,
                  revisedSections: revisedSectionSet.size,
                  findingsAddressed: totalAddressed,
                  message: `Coherence pass: pass-1 fixes adopted (§${[...revisedSectionSet].map((i2) => i2 + 1).join(", §")}); re-review skipped on provider abort.`,
                });
                break;
              }
              send("step", {
                step: STEP.polish,
                status: "progress",
                message: `Coherence pass ${pass}/${POLISH_MAX_PASSES}: re-reviewing the polished article for remaining or newly exposed cross-section issues...`,
              });
            }

            const coherence = await reviewArticleCoherence(
              projectId,
              { title: articleTitle, content: articleContent },
              { topic: project.topic, maxTokens },
            );
            if (!coherence.ran) {
              polishTelemetry.stopReason = coherence.error
                ? `review unavailable (${coherence.error})`
                : coherence.summary || "not applicable";
              if (pass === 1) {
                send("step", {
                  step: STEP.polish,
                  status: "skipped",
                  message: `Coherence pass skipped: ${polishTelemetry.stopReason}.`,
                });
                log(`polish: skipped — ${polishTelemetry.stopReason}`);
              } else {
                coherenceReviewRow = {
                  verdict: "accept",
                  summary: `[Coherence pass] ${totalFindings} cross-section finding(s) — ${totalAddressed} addressed in pass 1; re-review unavailable, pass-1 fixes stand.`,
                  weaknesses: allWeaknesses,
                  suggestions: allSuggestions,
                  revisedContent: articleContent,
                };
                send("step", {
                  step: STEP.polish,
                  status: "done",
                  findings: totalFindings,
                  revisedSections: revisedSectionSet.size,
                  findingsAddressed: totalAddressed,
                  message: `Coherence pass: pass-1 fixes adopted (§${[...revisedSectionSet].map((i2) => i2 + 1).join(", §")}); re-review unavailable — stopping here.`,
                });
              }
              break;
            }
            if (coherence.findings.length === 0) {
              polishTelemetry.reviewRan = true;
              if (pass === 1) {
                polishTelemetry.stopReason = "article already coherent — no cross-section findings";
                coherenceReviewRow = {
                  verdict: "accept",
                  summary: `[Coherence pass] ${coherence.summary || "No cross-section defects found."}`,
                  weaknesses: [],
                  suggestions: [],
                  revisedContent: null,
                };
                send("step", {
                  step: STEP.polish,
                  status: "done",
                  findings: 0,
                  message: `Coherence pass: ${coherence.summary || "no cross-section defects found"} — the article reads as one connected piece.`,
                });
                log(`polish: clean — ${coherence.summary}`);
              } else {
                coherenceReviewRow = {
                  verdict: "accept",
                  summary: `[Coherence pass ×${pass - 1}] ${totalFindings} cross-section finding(s) polished (§${[...revisedSectionSet].map((i2) => i2 + 1).join(",§")} revised, ${totalAddressed} addressed) — re-review is clean. ${coherence.summary || ""}`.trim(),
                  weaknesses: allWeaknesses,
                  suggestions: allSuggestions,
                  revisedContent: articleContent,
                };
                send("step", {
                  step: STEP.polish,
                  status: "done",
                  findings: totalFindings,
                  revisedSections: revisedSectionSet.size,
                  findingsAddressed: totalAddressed,
                  message: `Coherence pass: ${totalFindings} finding(s) polished in ${pass - 1} pass(es); re-review found no remaining cross-section defects. The article reads as one connected piece.`,
                });
                log(`polish: clean after pass ${pass - 1} (total ${totalFindings} findings, ${totalAddressed} addressed)`);
              }
              break;
            }

            polishTelemetry.reviewRan = true;
            totalFindings += coherence.findings.length;
            polishTelemetry.findings = totalFindings;
            const kinds = [...new Set(coherence.findings.map((f) => f.type))].join(", ");
            send("step", {
              step: STEP.polish,
              status: "progress",
              findings: totalFindings,
              message: `${pass > 1 ? `Pass ${pass}/${POLISH_MAX_PASSES}: ` : ""}${coherence.findings.length} cross-section finding(s) (${kinds}) — polishing the affected sections with full-article context...`,
              detail: coherence.findings
                .map((f) => `[${f.type}] §${f.sections.join(",§")}: ${f.description.slice(0, 110)}`)
                .join("\n"),
            });
            log(`polish[pass ${pass}]: ${coherence.findings.length} finding(s) — ${coherence.findings.map((f) => `${f.type}@§${f.sections.join("/")}`).join(" | ")}`);

            const polish = await polishArticleCoherence(
              projectId,
              { title: articleTitle, content: articleContent },
              coherence.findings,
              {
                topic: project.topic,
                maxTokens,
                onProgress: (m) => send("step", { step: STEP.polish, status: "progress", message: `Coherence polish: ${m}` }),
              },
            );

            const coherenceWeaknesses = coherence.findings.map(
              (f) => `[${f.type}] §${f.sections.join(",§")}: ${f.description}`,
            );
            const coherenceSuggestions = coherence.findings.map(
              (f) => `§${f.sections[f.sections.length - 1]}: ${f.suggestion || "(apply the minimal consistent fix)"}`,
            );
            allWeaknesses.push(...coherenceWeaknesses);
            allSuggestions.push(...coherenceSuggestions);

            if (!polish.ok || !polish.content) {
              polishTelemetry.stopReason = `polish unavailable: ${polish.reason}`;
              if (pass === 1) {
                coherenceReviewRow = {
                  verdict: "minor-revision",
                  summary: `[Coherence pass] ${coherence.findings.length} cross-section finding(s) could not be auto-polished (${polish.reason}) — disclosed for manual attention.`,
                  weaknesses: coherenceWeaknesses,
                  suggestions: coherenceSuggestions,
                  revisedContent: null,
                };
                send("step", {
                  step: STEP.polish,
                  status: "done",
                  findings: coherence.findings.length,
                  revisedSections: 0,
                  message: `Coherence pass: ${coherence.findings.length} finding(s) remain (auto-polish unavailable: ${polish.reason}) — disclosed in the Review tab.`,
                });
              } else {
                coherenceReviewRow = {
                  verdict: "accept",
                  summary: `[Coherence pass] ${totalFindings} cross-section finding(s) across ${pass} pass(es); pass-1 fixes adopted (${totalAddressed} addressed), pass-${pass} findings could not be auto-polished (${polish.reason}) — disclosed for manual attention.`,
                  weaknesses: allWeaknesses,
                  suggestions: allSuggestions,
                  revisedContent: articleContent,
                };
                send("step", {
                  step: STEP.polish,
                  status: "done",
                  findings: totalFindings,
                  revisedSections: revisedSectionSet.size,
                  findingsAddressed: totalAddressed,
                  message: `Coherence pass: pass-1 fixes adopted (§${[...revisedSectionSet].map((i2) => i2 + 1).join(", §")}); ${coherence.findings.length} later finding(s) could not be auto-polished (${polish.reason}) — disclosed in the Review tab.`,
                });
              }
              log(`polish[pass ${pass}]: NOT applied — ${polish.reason}`);
              break;
            }
            // --- Mechanical gauntlet (same philosophy as the repair loop) ---
            // #1 Citation preservation: the polish contract forbids ADDING
            //    citations; removals are legitimate (deduplication) and are
            //    handled by the deterministic renormalizer below.
            const preSplit = splitBodyAndReferences(articleContent);
            const postSplitRaw = splitBodyAndReferences(polish.content);
            const before = distinctCitations(preSplit.body, globalRefs.length);
            const after = distinctCitations(postSplitRaw.body, globalRefs.length);
            const added = [...after].filter((n) => !before.has(n));
            // #2 Deterministic renormalization (orphan drop + renumber).
            const norm = renormalizeArticleCitations(polish.content);
            const postSplit = splitBodyAndReferences(norm.content);
            // #3 Heading pinning (bilingual structure depends on the
            //    original headings — the ZH compose builds from titles).
            //    round-cs-6: pin to the SAME normalized/translated English
            //    headings the composed article body actually uses (enTitles).
            const polishSectionTitles = [...enTitles];
            const pinned = restoreOriginalHeadings(postSplit.body, polishSectionTitles);
            // #4 Revision guard (word/citation floors).
            const guard = pinned ? revisionGuard(articleContent, pinned.trimEnd() + "\n\n" + postSplit.referencesText.trim()) : null;
            // Shared reject framing for pass ≥ 2 (pass-1 fixes stand).
            const priorPassNote =
              pass > 1
                ? `pass-1 fixes adopted (§${[...revisedSectionSet].map((i2) => i2 + 1).join(", §")}); `
                : "";

            if (added.length > 0) {
              polishTelemetry.stopReason = `polish rejected: introduced ${added.length} new citation(s) ([${added.join(",")}]) — citation additions are forbidden`;
              coherenceReviewRow = pass > 1
                ? {
                    verdict: "accept",
                    summary: `[Coherence pass] ${totalFindings} cross-section finding(s) across ${pass} pass(es); pass-1 fixes adopted, pass-${pass} draft REJECTED by the citation-preservation guard — ${coherence.findings.length} finding(s) disclosed for manual attention.`,
                    weaknesses: allWeaknesses,
                    suggestions: allSuggestions,
                    revisedContent: articleContent,
                  }
                : {
                    verdict: "minor-revision",
                    summary: `[Coherence pass] ${coherence.findings.length} finding(s); the polished draft was REJECTED by the citation-preservation guard (it tried to add citations) — disclosed for manual attention.`,
                    weaknesses: coherenceWeaknesses,
                    suggestions: coherenceSuggestions,
                    revisedContent: null,
                  };
              send("step", { step: STEP.polish, status: "done", findings: totalFindings, revisedSections: revisedSectionSet.size, findingsAddressed: totalAddressed, message: `${priorPassNote}Coherence polish rejected by the citation-preservation guard — the pre-polish article stands; findings disclosed in the Review tab.` });
              log(`polish[pass ${pass}]: REJECTED (citation additions: ${added.join(",")})`);
              break;
            }
            if (!pinned) {
              polishTelemetry.stopReason = "polish rejected: heading structure unrepairable";
              coherenceReviewRow = pass > 1
                ? {
                    verdict: "accept",
                    summary: `[Coherence pass] ${totalFindings} cross-section finding(s) across ${pass} pass(es); pass-1 fixes adopted, pass-${pass} draft REJECTED (section-heading mismatch) — ${coherence.findings.length} finding(s) disclosed for manual attention.`,
                    weaknesses: allWeaknesses,
                    suggestions: allSuggestions,
                    revisedContent: articleContent,
                  }
                : {
                    verdict: "minor-revision",
                    summary: `[Coherence pass] ${coherence.findings.length} finding(s); the polished draft was REJECTED (section-heading mismatch) — disclosed for manual attention.`,
                    weaknesses: coherenceWeaknesses,
                    suggestions: coherenceSuggestions,
                    revisedContent: null,
                  };
              send("step", { step: STEP.polish, status: "done", findings: totalFindings, revisedSections: revisedSectionSet.size, findingsAddressed: totalAddressed, message: `${priorPassNote}Coherence polish rejected (heading structure mismatch) — the pre-polish article stands; findings disclosed in the Review tab.` });
              log(`polish[pass ${pass}]: REJECTED (heading mismatch)`);
              break;
            }
            if (!guard?.ok) {
              polishTelemetry.stopReason = `polish rejected by the revision guard: ${(guard?.reasons || ["unknown"]).join("; ")}`;
              coherenceReviewRow = pass > 1
                ? {
                    verdict: "accept",
                    summary: `[Coherence pass] ${totalFindings} cross-section finding(s) across ${pass} pass(es); pass-1 fixes adopted, pass-${pass} draft REJECTED by the revision guard (${(guard?.reasons || []).join("; ")}) — ${coherence.findings.length} finding(s) disclosed for manual attention.`,
                    weaknesses: allWeaknesses,
                    suggestions: allSuggestions,
                    revisedContent: articleContent,
                  }
                : {
                    verdict: "minor-revision",
                    summary: `[Coherence pass] ${coherence.findings.length} finding(s); the polished draft was REJECTED by the revision guard (${(guard?.reasons || []).join("; ")}) — disclosed for manual attention.`,
                    weaknesses: coherenceWeaknesses,
                    suggestions: coherenceSuggestions,
                    revisedContent: null,
                  };
              send("step", { step: STEP.polish, status: "done", findings: totalFindings, revisedSections: revisedSectionSet.size, findingsAddressed: totalAddressed, message: `${priorPassNote}Coherence polish rejected by the revision guard — the pre-polish article stands; findings disclosed in the Review tab.` });
              log(`polish[pass ${pass}]: REJECTED by guard — ${(guard?.reasons || []).join("; ")}`);
              break;
            }

            // --- Adopt the polished article ---
            // round-cs-7: the polish draft is an LLM rewrite of the affected
            // sections — run the per-section format gauntlet over the pinned
            // body BEFORE adopting (same rationale as the repair path), so
            // no reference lists / headings / lists leak back in.
            // RT6 note: normalizeArticleBodySections stays AS-IS here —
            // chunked combinator semantics (headings pinned per section),
            // not equivalent to the whole-text gate chain on a multi-section
            // body. See the repair-adoption block above.
            const polishedBody = normalizeArticleBodySections(pinned);
            const candidate = polishedBody.trimEnd() + "\n\n" + postSplit.referencesText.trim();
            articleContent = candidate;
            polishTelemetry.triggered = true;
            totalAddressed += polish.findingsAddressed;
            polishTelemetry.findingsAddressed = totalAddressed;
            for (const rs of polish.revisedSections) revisedSectionSet.add(rs);
            polishTelemetry.revisedSections = revisedSectionSet.size;
            stats.coherencePolish = {
              findings: totalFindings,
              revisedSections: revisedSectionSet.size,
              triggered: true,
            };

            // Re-derive what downstream stages consume (paragraph sync,
            // translate, ZH references) — repair-adoption pattern, with
            // ref lines matched against the PRE-polish list.
            const finalSecs = splitBodySections(polishedBody);
            if (finalSecs && finalSecs.contents.length === renumberedContents.length) {
              for (let i2 = 0; i2 < renumberedContents.length; i2++) {
                renumberedContents[i2] = finalSecs.contents[i2];
              }
              if (norm.droppedRefs > 0 || norm.renumbered) {
                const preRefBare = preSplit.referencesText
                  .split("\n").map((l: string) => l.trim())
                  .filter((l: string) => /^\[\d+\]\s/.test(l))
                  .map((l: string) => l.replace(/^\s*\[\d+\]\s*/, "").trim());
                const finalRefLines = postSplit.referencesText
                  .split("\n").map((l: string) => l.trim())
                  .filter((l: string) => /^\[\d+\]\s/.test(l));
                const newGlobalRefs: any[] = [];
                for (const fl of finalRefLines) {
                  const bare = fl.replace(/^\s*\[\d+\]\s*/, "").trim();
                  const idx = preRefBare.findIndex((ol) => ol === bare);
                  if (idx >= 0 && idx < globalRefs.length) newGlobalRefs.push(globalRefs[idx]);
                  else break;
                }
                const finalBodyCit = new Set<number>();
                let pcm: RegExpExecArray | null;
                const pcre = /\[(\d+(?:[,\-–\s]\d+)*)\]/g;
                while ((pcm = pcre.exec(postSplit.body)) !== null) {
                  for (const part of pcm[1].split(/[,;]\s*/)) {
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
                if (newGlobalRefs.length === finalRefLines.length && maxFinalCit <= newGlobalRefs.length) {
                  globalRefs.length = 0;
                  globalRefs.push(...newGlobalRefs);
                  log(`polish: globalRefs re-synced to the polished reference list (${globalRefs.length} refs)`);
                } else {
                  log(`polish: reference rematch incomplete (${newGlobalRefs.length}/${finalRefLines.length} lines, maxCit=${maxFinalCit}) — globalRefs kept as pre-polish`);
                }
              }
            } else {
              log(
                `polish: final section split mismatch (${finalSecs?.contents.length ?? "?"} vs ${renumberedContents.length}) — article content adopted, paragraphs keep pre-polish text`,
              );
            }
            log(
              `polish[pass ${pass}]: APPLIED — ${polish.findingsAddressed}/${coherence.findings.length} findings addressed in §${polish.revisedSections.map((i2) => i2 + 1).join(",")} (droppedRefs=${norm.droppedRefs} stripped=${norm.strippedNumbers} renumbered=${norm.renumbered})`,
            );
            if (pass >= POLISH_MAX_PASSES) {
              coherenceReviewRow = {
                verdict: "accept",
                summary: `[Coherence pass ×${pass}] ${totalFindings} cross-section finding(s) — ${totalAddressed} addressed across ${pass} polish pass(es) (§${[...revisedSectionSet].map((i2) => i2 + 1).join(",§")} revised).`,
                weaknesses: allWeaknesses,
                suggestions: allSuggestions,
                revisedContent: candidate,
              };
              send("step", {
                step: STEP.polish,
                status: "done",
                findings: totalFindings,
                revisedSections: revisedSectionSet.size,
                findingsAddressed: totalAddressed,
                message: `Coherence pass complete: ${totalFindings} finding(s) across ${pass} pass(es) — ${totalAddressed} addressed (§${[...revisedSectionSet].map((i2) => i2 + 1).join(", §")} revised; ${norm.droppedRefs} orphaned reference(s) dropped).`,
              });
              break;
            }
            coherenceReviewRow = {
              verdict: "accept",
              summary: `[Coherence pass ${pass}] ${coherence.findings.length} cross-section finding(s) — ${polish.findingsAddressed} addressed by polishing §${polish.revisedSections.map((i2) => i2 + 1).join(",§")}. ${coherence.summary}`,
              weaknesses: allWeaknesses,
              suggestions: allSuggestions,
              revisedContent: candidate,
            };
            send("step", {
              step: STEP.polish,
              status: "progress",
              findings: totalFindings,
              revisedSections: revisedSectionSet.size,
              findingsAddressed: totalAddressed,
              message: `Coherence pass ${pass}: polished §${polish.revisedSections.map((i2) => i2 + 1).join(", §")} (${polish.findingsAddressed} finding(s) addressed) — re-reviewing for remaining or newly exposed issues...`,
            });
            // Loop continues: the next iteration re-reviews the polished text.
          }
        } catch (polishErr: any) {
          // Non-fatal by contract: the article stands exactly as composed /
          // repaired, and the coherence findings are simply not recorded.
          polishTelemetry.stopReason = `pass failed: ${String(polishErr?.message ?? polishErr).slice(0, 120)}`;
          log(`polish: FAILED — ${polishTelemetry.stopReason}`);
          send("step", {
            step: STEP.polish,
            status: "skipped",
            message: `Coherence pass skipped after an error (the article is unaffected): ${polishErr?.message?.slice(0, 80) || "LLM error"}.`,
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

          // round-68: persist the loop OUTCOME on the article row so the
          // Review tab can disclose what was auto-fixed vs why the loop
          // stopped vs what remains outstanding (the review rows alone only
          // show per-round findings — the stop reason and revision count
          // lived exclusively in the SSE step stream before this).
          try {
            await db.article.update({
              where: { id: article.id },
              data: {
                repairSummary: {
                  reviews: repairTelemetry.reviews,
                  revisions: repairTelemetry.revisions,
                  guardRejections: repairTelemetry.guardRejections,
                  droppedRefs: repairTelemetry.droppedRefs,
                  strippedNumbers: repairTelemetry.strippedNumbers,
                  stopReason: repairTelemetry.stopReason || "loop ended",
                  finalVerdict: repairTelemetry.finalVerdict || "",
                  finalOverall: repairTelemetry.finalOverall,
                  scoped: repairRounds
                    .filter((r: any) => Array.isArray(r.scopedSections) && r.scopedSections.length > 0)
                    .map((r: any) => ({ round: r.round, sections: r.scopedSections })),
                  at: new Date().toISOString(),
                },
              },
            });
          } catch (sumErr: any) {
            log(`repair: repairSummary persistence FAILED: ${String(sumErr?.message ?? sumErr).slice(0, 100)}`);
          }
        }

        // round-cs-2: persist the coherence pass as a Review row (after the
        // repair rounds, so the Review tab reads: fact-check rounds →
        // coherence pass). Whatever the pass found — clean, polished, or
        // disclosed-unpolished — is recorded for the user to inspect.
        if (coherenceReviewRow) {
          try {
            const coherenceRound = repairRounds.length > 0
              ? Math.max(...repairRounds.map((r: any) => r.round || 0)) + 1
              : 1;
            await db.review.create({
              data: {
                articleId: article.id,
                round: coherenceRound,
                verdict: coherenceReviewRow.verdict,
                summary: coherenceReviewRow.summary,
                strengths: JSON.stringify([]),
                weaknesses: JSON.stringify(coherenceReviewRow.weaknesses),
                suggestions: JSON.stringify(coherenceReviewRow.suggestions),
                ...(coherenceReviewRow.revisedContent ? { revisedContent: coherenceReviewRow.revisedContent } : {}),
              },
            });
            log(`polish: coherence Review row persisted (round ${coherenceRound}, verdict ${coherenceReviewRow.verdict})`);
          } catch (cohRowErr: any) {
            log(`polish: coherence Review row persistence FAILED: ${String(cohRowErr?.message ?? cohRowErr).slice(0, 100)}`);
          }
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
          step: STEP.compose,
          status: "done",
          message: `Article composed: ${countWords(articleContent)} words, ${globalRefs.length} references.`,
          wordCount: countWords(articleContent),
          references: globalRefs.length,
        });
        log(`compose: article saved (${countWords(articleContent)} words, ${globalRefs.length} refs, audit: ${audit.summary.blockingErrors} blocking, ${audit.summary.suspect + audit.summary.unsupported} topicality warnings)`);
  return { article, articleContent, audit, repairRounds, repairTelemetry };
}
