"use client";

import * as React from "react";
import { api } from "@/lib/api-client";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  CircleAlert,
  Wand2,
  CheckCircle2,
  RotateCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type {
  HealthReport,
} from "./citation-health/types";
import { GRADE_COLORS, GRADE_LABEL_KEYS } from "./citation-health/grade-utils";
import { StatTiles } from "./citation-health/stat-tiles";
import { WorstOffendersList } from "./citation-health/worst-offenders-list";
import { ArticleAuditList } from "./citation-health/article-audit-list";
import { RegenConfirmDialog } from "./citation-health/regen-confirm-dialog";

/**
 * CitationHealthDashboard — a compact, project-level citation-accuracy
 * summary that sits in the workspace header (between ProgressTracker and
 * the workspace tabs).
 *
 * On mount (and on refresh) it calls /api/projects/[id]/citation-health,
 * which runs the inline + post-compose audits across all paragraphs and
 * articles. It surfaces:
 *   - A 0–100 health score with an A–F grade badge
 *   - Counts: total citations, references, blocking errors, warnings
 *   - A progress bar showing % paragraphs that are clean
 *   - A collapsible "worst offenders" list — the 5 paragraphs with the most
 *     findings, each showing its top 3 issues (blocking/warning verdicts)
 *
 * Clicking a worst-offender row scrolls the workspace to that paragraph.
 */
export function CitationHealthDashboard({
  projectId,
  onJumpParagraph,
}: {
  projectId: string;
  onJumpParagraph?: (paragraphId: string) => void;
}) {
  const { t } = useI18n();
  const [report, setReport] = React.useState<HealthReport | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [fixing, setFixing] = React.useState(false);
  const [fixResult, setFixResult] = React.useState<{
    totalFixed: number;
    totalBefore: number;
    paragraphsProcessed: number;
  } | null>(null);
  // Timeout refs so a stale auto-dismiss from a PREVIOUS run can't clear a
  // fresh badge when the user re-runs the batch quickly.
  const fixResultTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const regenResultTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live progress for batch fix: { done, total, currentTitle }.
  const [fixProgress, setFixProgress] = React.useState<{
    done: number;
    total: number;
    currentTitle?: string;
  } | null>(null);
  // Per-paragraph fixing state — supports the "Fix this" button on each
  // worst-offender row.
  const [fixingParagraphId, setFixingParagraphId] = React.useState<string | null>(null);

  const fetchHealth = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // api.getCitationHealth routes through jfetch (timeouts + consistent
      // error surface) — the dashboard previously bypassed the api client
      // with a raw fetch that hung forever on a stuck request.
      const data = (await api.getCitationHealth(projectId)) as HealthReport;
      setReport(data);
      // Auto-expand when there are blocking errors so the user sees them.
      if (data.aggregate.totalBlocking > 0) setOpen(true);
    } catch (err: any) {
      setError(err?.message || t("citationHealth.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Fix a single paragraph by calling the paragraph-level auto-fix endpoint.
  // Used by both the batch loop and the per-paragraph "Fix this" button.
  const fixParagraph = React.useCallback(
    async (paragraphId: string): Promise<{ fixed: number; before: number }> => {
      // Fetch the paragraph's current blocking count (before fix).
      const beforeData = await api
        .validateCitations(paragraphId)
        .catch(() => null);
      const before = beforeData?.missingCount ?? 0;

      await api.autoFixCitations(paragraphId);

      // Re-validate to get the after count.
      const afterData = await api
        .validateCitations(paragraphId)
        .catch(() => null);
      const after = afterData?.missingCount ?? before;
      return { fixed: Math.max(0, before - after), before };
    },
    []
  );

  // Batch auto-fix: iterates all worst-offender paragraphs client-side so we
  // can show live progress (done/total + current paragraph title). This is
  // better than a single batch API call because the user sees incremental
  // progress instead of an opaque spinner for potentially minutes.
  const runBatchAutoFix = React.useCallback(async () => {
    if (!report) return;
    const offenders = report.worstOffenders.filter((p) => p.blockingCount > 0);
    if (offenders.length === 0) return;
    setFixing(true);
    setFixResult(null);
    setFixProgress({ done: 0, total: offenders.length });
    let totalFixed = 0;
    let totalBefore = 0;
    let processed = 0;
    try {
      for (let i = 0; i < offenders.length; i++) {
        const p = offenders[i];
        setFixProgress({
          done: i,
          total: offenders.length,
          currentTitle: p.title,
        });
        setFixingParagraphId(p.paragraphId);
        try {
          const result = await fixParagraph(p.paragraphId);
          totalFixed += result.fixed;
          totalBefore += result.before;
          processed++;
        } catch (err) {
          // Continue with other paragraphs even if one fails.
          console.error(`auto-fix failed for ${p.paragraphId}:`, err);
        }
      }
      setFixResult({
        totalFixed,
        totalBefore,
        paragraphsProcessed: processed,
      });
      // Auto-dismiss after 8s (the comment always promised this — the badge
      // used to persist forever and mask newer results).
      if (fixResultTimer.current) clearTimeout(fixResultTimer.current);
      fixResultTimer.current = setTimeout(() => setFixResult(null), 8_000);
      // Re-fetch health to reflect the fixes.
      await fetchHealth();
    } catch (err: any) {
      setError(err?.message || t("citationHealth.batchFixFailed"));
    } finally {
      setFixing(false);
      setFixProgress(null);
      setFixingParagraphId(null);
    }
  }, [report, fixParagraph, fetchHealth]);

  // Per-paragraph "Fix this" — fixes a single worst-offender in place.
  const fixSingleParagraph = React.useCallback(
    async (paragraphId: string) => {
      setFixingParagraphId(paragraphId);
      try {
        await fixParagraph(paragraphId);
        await fetchHealth();
      } catch (err: any) {
        setError(err?.message || t("citationHealth.fixFailed"));
      } finally {
        setFixingParagraphId(null);
      }
    },
    [fixParagraph, fetchHealth]
  );

  // Per-paragraph "Regenerate" — calls the regenerate endpoint which re-writes
  // the paragraph content via LLM using the current reference list. This is
  // a stronger fix than "Fix" (which only adds references): regenerate
  // produces fresh body text with correct [n] citations. Used when the
  // paragraph content itself is broken (wrong citations, out-of-range, etc.).
  const [regeneratingParagraphId, setRegeneratingParagraphId] = React.useState<string | null>(null);
  const regenerateParagraph = React.useCallback(
    async (paragraphId: string) => {
      setRegeneratingParagraphId(paragraphId);
      try {
        await api.regenerateParagraph(paragraphId);
        await fetchHealth();
      } catch (err: any) {
        setError(err?.message || t("citationHealth.regenFailed"));
      } finally {
        setRegeneratingParagraphId(null);
      }
    },
    [fetchHealth]
  );

  // Batch regenerate — iterates ALL worst-offender paragraphs (those with
  // blocking OR warning findings) client-side, calling regenerate on each.
  // Mirrors runBatchAutoFix but uses the regenerate endpoint. Shows live
  // progress (done/total + current paragraph title). The regenResult badge
  // shows how many paragraphs were processed.
  const [regenProgress, setRegenProgress] = React.useState<{
    done: number;
    total: number;
    currentTitle?: string;
  } | null>(null);
  const [regenResult, setRegenResult] = React.useState<{
    processed: number;
    total: number;
  } | null>(null);
  // Confirmation dialog state for "Regenerate all" — rewriting all
  // paragraphs is a destructive operation, so we double-confirm.
  const [confirmRegen, setConfirmRegen] = React.useState(false);
  const runBatchRegenerate = React.useCallback(async () => {
    if (!report) return;
    // Regenerate ALL paragraphs with findings (blocking OR warnings) —
    // regenerate can fix both by rewriting with better citations.
    const offenders = report.worstOffenders.filter(
      (p) => p.blockingCount > 0 || p.warningCount > 0
    );
    if (offenders.length === 0) return;
    setRegeneratingParagraphId("__batch__"); // sentinel: batch mode active
    setRegenResult(null);
    setRegenProgress({ done: 0, total: offenders.length });
    let processed = 0;
    try {
      for (let i = 0; i < offenders.length; i++) {
        const p = offenders[i];
        setRegenProgress({
          done: i,
          total: offenders.length,
          currentTitle: p.title,
        });
        setRegeneratingParagraphId(p.paragraphId);
        try {
          await api.regenerateParagraph(p.paragraphId);
          processed++;
        } catch (err) {
          console.error(`regenerate failed for ${p.paragraphId}:`, err);
        }
      }
      setRegenResult({ processed, total: offenders.length });
      // Auto-dismiss after 8s — matches the fixResult badge behavior.
      if (regenResultTimer.current) clearTimeout(regenResultTimer.current);
      regenResultTimer.current = setTimeout(() => setRegenResult(null), 8_000);
      await fetchHealth();
    } catch (err: any) {
      setError(err?.message || t("citationHealth.batchRegenFailed"));
    } finally {
      setRegeneratingParagraphId(null);
      setRegenProgress(null);
    }
  }, [report, fetchHealth]);

  React.useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground acad-fade-in">
        <div className="h-5 w-5 rounded-md bg-primary/15 text-primary flex items-center justify-center ring-academic">
          <Loader2 className="h-3 w-3 animate-spin" />
        </div>
        <span className="font-serif-text tracking-tight">{t("citationHealth.loading")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground acad-fade-in">
        <div className="h-5 w-5 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center ring-academic">
          <CircleAlert className="h-3 w-3" />
        </div>
        <span className="font-serif-text tracking-tight">{t("citationHealth.unavailable")}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[10px] hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-400"
          onClick={fetchHealth}
        >
          <RefreshCw className="h-3 w-3" /> {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (!report) return null;

  const agg = report.aggregate;
  const hasBlocking = agg.totalBlocking > 0;
  const hasWarnings = agg.totalWarnings > 0;

  const Icon = hasBlocking ? ShieldX : hasWarnings ? ShieldAlert : ShieldCheck;
  const iconColor = hasBlocking
    ? "text-red-600 dark:text-red-400"
    : hasWarnings
    ? "text-amber-600 dark:text-amber-400"
    : "text-emerald-600 dark:text-emerald-400";

  const cleanPct =
    agg.totalParagraphs > 0
      ? Math.round((agg.paragraphsClean / agg.totalParagraphs) * 100)
      : 100;

  return (
    <div className="px-5 py-2.5 border-b border-border/40 glass-subtle flex items-center gap-3 flex-wrap acad-fade-in relative">
      {/* Grade badge — polished scoreboard tile (surface-card + ring-academic for A) */}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-bold cursor-help transition-all hover:shadow-md hover:scale-[1.02] surface-card",
                GRADE_COLORS[agg.grade],
                agg.grade === "A" && "ring-academic",
                // Blocking findings: static warning ring instead of a constant
                // animate-pulse (was a distracting infinite pulse).
                hasBlocking && "ring-2 ring-amber-500/60"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="font-serif-text text-base leading-none tracking-tight">{agg.grade}</span>
              <span className="font-sans text-[10px] font-medium opacity-80 tabular-nums">
                {agg.healthScore}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[10px]">
            <div className="space-y-0.5">
              <p className="font-semibold">
                {t("citationHealth.tooltipTitle", {
                  label: t(
                    GRADE_LABEL_KEYS[agg.grade] ?? "citationHealth.gradeUnknown"
                  ),
                  score: agg.healthScore,
                })}
              </p>
              <p className="text-muted-foreground">
                {t("citationHealth.gradeFormula")}
              </p>
              <p className="text-muted-foreground">
                {t("citationHealth.gradeScale")}
              </p>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Quick stats — surface-card tiles with hover lift + tabular-nums */}
      <StatTiles agg={agg} />

      {/* Clean progress — refined label typography */}
      <div className="flex items-center gap-2 min-w-[160px] flex-1 max-w-[280px]">
        <Progress
          value={cleanPct}
          className={cn(
            "h-2 flex-1 transition-all",
            cleanPct === 100
              ? "[&>div]:bg-gradient-to-r [&>div]:from-emerald-400 [&>div]:to-emerald-600"
              : cleanPct >= 60
              ? "[&>div]:bg-gradient-to-r [&>div]:from-amber-400 [&>div]:to-amber-600"
              : "[&>div]:bg-gradient-to-r [&>div]:from-red-400 [&>div]:to-red-600"
          )}
        />
        <span className="text-[9px] text-muted-foreground font-serif-text tabular-nums shrink-0 font-medium tracking-tight">
          {t("citationHealth.cleanCount", {
            clean: agg.paragraphsClean,
            total: agg.totalParagraphs,
          })}
        </span>
      </div>

      {/* Expand button */}
      {(report.worstOffenders.length > 0 || report.articles.length > 0) && (
        <Collapsible open={open} onOpenChange={setOpen} className="ml-auto">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] gap-1 glass-subtle rounded-md hover:shadow-sm transition-all">
              {open ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {report.worstOffenders.length > 0
                ? report.worstOffenders.length === 1
                  ? t("citationHealth.offenderOne", {
                      n: report.worstOffenders.length,
                    })
                  : t("citationHealth.offendersMany", {
                      n: report.worstOffenders.length,
                    })
                : t("citationHealth.details")}
            </Button>
          </CollapsibleTrigger>
        </Collapsible>
      )}

      {/* Batch auto-fix button — runs the LLM + database query pipeline to
          resolve missing/out-of-range citations across all offending
          paragraphs. Only shown when there are blocking errors. During the
          fix, shows live progress (done/total) instead of an opaque spinner. */}
      {agg.totalBlocking > 0 && (
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[10px] gap-1 border-amber-300/60 text-amber-700 dark:text-amber-400 hover:bg-amber-50/60 dark:hover:bg-amber-950/30 hover:shadow-sm transition-all"
            disabled={fixing}
            onClick={runBatchAutoFix}
            title={t("citationHealth.autoFixAllTitle")}
          >
            {fixing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Wand2 className="h-3 w-3" />
            )}
            {fixing && fixProgress
              ? t("citationHealth.fixingProgress", {
                  done: fixProgress.done,
                  total: fixProgress.total,
                })
              : t("citationHealth.autoFixAll")}
          </Button>
          {/* Live progress bar during batch fix. */}
          {fixing && fixProgress && (
            <div className="flex items-center gap-1.5 min-w-[80px]">
              <Progress
                value={
                  fixProgress.total > 0
                    ? (fixProgress.done / fixProgress.total) * 100
                    : 0
                }
                className="h-1.5 w-16 [&>div]:bg-amber-500"
              />
              <span className="text-[9px] text-muted-foreground font-mono tabular-nums shrink-0">
                {Math.round(
                  fixProgress.total > 0
                    ? (fixProgress.done / fixProgress.total) * 100
                    : 0
                )}
                %
              </span>
            </div>
          )}
        </div>
      )}

      {/* Fix result badge — shows for 8s after a batch fix completes. */}
      {fixResult && !fixing && (
        <div className="badge-emerald flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md">
          <CheckCircle2 className="h-3 w-3" />
          <span className="tabular-nums">
            {t("citationHealth.fixedAcross", {
              fixed: fixResult.totalFixed,
              before: fixResult.totalBefore,
              paragraphs: fixResult.paragraphsProcessed,
            })}
          </span>
        </div>
      )}

      {/* Batch regenerate button — re-writes ALL worst-offender paragraphs via
          LLM. Stronger than Auto-fix (which only adds references): regenerate
          produces fresh body text with correct [n] citations. Shown when there
          are ANY findings (blocking OR warnings).
          Opens a confirmation dialog first because rewriting all paragraphs is
          a destructive operation (the current body text will be replaced). */}
      {(agg.totalBlocking > 0 || agg.totalWarnings > 0) && (
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[10px] gap-1 border-primary/40 text-primary hover:bg-primary/10 hover:shadow-sm transition-all"
            disabled={fixing || regenProgress !== null}
            onClick={() => setConfirmRegen(true)}
            title={t("citationHealth.regenAllTitle")}
          >
            {regenProgress !== null ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCw className="h-3 w-3" />
            )}
            {regenProgress !== null
              ? t("citationHealth.regenProgress", {
                  done: regenProgress.done,
                  total: regenProgress.total,
                })
              : t("citationHealth.regenerateAll")}
          </Button>
          {/* Live progress bar during batch regenerate. */}
          {regenProgress !== null && (
            <div className="flex items-center gap-1.5 min-w-[80px]">
              <Progress
                value={
                  regenProgress.total > 0
                    ? (regenProgress.done / regenProgress.total) * 100
                    : 0
                }
                className="h-1.5 w-16 [&>div]:bg-primary"
              />
              <span className="text-[9px] text-muted-foreground font-mono tabular-nums shrink-0">
                {Math.round(
                  regenProgress.total > 0
                    ? (regenProgress.done / regenProgress.total) * 100
                    : 0
                )}
                %
              </span>
            </div>
          )}
        </div>
      )}

      {/* Regen result badge — shows after a batch regenerate completes. */}
      {regenResult && regenProgress === null && (
        <div className="badge-emerald flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md">
          <CheckCircle2 className="h-3 w-3" />
          <span className="tabular-nums">
            {t("citationHealth.regeneratedOf", {
              processed: regenResult.processed,
              total: regenResult.total,
            })}
          </span>
        </div>
      )}

      {/* Low-confidence review — opens the Analysis tab's Audit Trail so the
          user can review citations that were flagged but NOT auto-corrected
          (confidence < 70). Only shown when there are warnings. */}
      {agg.totalWarnings > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px] gap-1 text-orange-600 dark:text-orange-400 hover:bg-orange-100/60 dark:hover:bg-orange-950/40 hover:shadow-sm transition-all"
          onClick={() => {
            // Trigger a custom event that the article viewer can listen for
            // to switch to the Analysis → Audit Trail sub-tab.
            window.dispatchEvent(new CustomEvent("open-audit-trail"));
          }}
          title={t("citationHealth.reviewWarningsTitle")}
        >
          <CircleAlert className="h-3 w-3" />
          {t("citationHealth.reviewWarnings", { n: agg.totalWarnings })}
        </Button>
      )}

      {/* Refresh */}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 glass-subtle rounded-md hover:shadow-sm transition-all"
        onClick={fetchHealth}
        title={t("citationHealth.refreshTitle")}
      >
        <RefreshCw className="h-3 w-3" />
      </Button>

      {/* Expanded detail */}
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleContent>
          <div className="w-full mt-2 pt-2 border-t hairline grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* Worst-offending paragraphs */}
            <WorstOffendersList
              offenders={report.worstOffenders}
              fixing={fixing}
              fixingParagraphId={fixingParagraphId}
              regeneratingParagraphId={regeneratingParagraphId}
              onJumpParagraph={onJumpParagraph}
              fixSingleParagraph={fixSingleParagraph}
              regenerateParagraph={regenerateParagraph}
            />

            {/* Article audits */}
            <ArticleAuditList articles={report.articles} />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Confirmation dialog for "Regenerate all" — rewriting all paragraphs is
          destructive (replaces the current body text), so we double-confirm.
          Shows the count of paragraphs that will be regenerated. */}
      <RegenConfirmDialog
        open={confirmRegen}
        onOpenChange={setConfirmRegen}
        offenderCount={
          report?.worstOffenders.filter(
            (p) => p.blockingCount > 0 || p.warningCount > 0
          ).length || 0
        }
        onConfirm={runBatchRegenerate}
      />
    </div>
  );
}
