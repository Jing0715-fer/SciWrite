"use client";

import * as React from "react";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  CircleAlert,
  CircleX,
  TrendingUp,
  FileText,
  BookOpen,
  AlertTriangle,
  Sparkles,
  Wand2,
  CheckCircle2,
  RotateCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
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
import { useI18n, type TranslationKey } from "@/lib/i18n";

interface ParagraphHealthReport {
  paragraphId: string;
  title: string;
  format: string;
  order: number;
  wordCount: number;
  refCount: number;
  citationCount: number;
  blockingCount: number;
  warningCount: number;
  topFindings: {
    n: number;
    verdict: string;
    reason: string;
    score?: number;
  }[];
}

interface ArticleHealthReport {
  articleId: string;
  title: string;
  wordCount: number;
  createdAt: string;
  totalCitations: number;
  totalReferences: number;
  summary: {
    ok: number;
    outOfRange: number;
    missing: number;
    suspect: number;
    unsupported: number;
    orphan: number;
    duplicate: number;
    mismatch: number;
    blockingErrors: number;
  };
  numberingIntegrityOk: boolean;
}

interface HealthAggregate {
  totalParagraphs: number;
  totalArticles: number;
  totalCitations: number;
  totalReferences: number;
  totalBlocking: number;
  totalWarnings: number;
  paragraphsClean: number;
  paragraphsIssues: number;
  healthScore: number;
  grade: string;
}

interface HealthReport {
  project: { id: string; title: string; topic: string };
  paragraphs: ParagraphHealthReport[];
  articles: ArticleHealthReport[];
  aggregate: HealthAggregate;
  worstOffenders: ParagraphHealthReport[];
}

const GRADE_COLORS: Record<string, string> = {
  A: "text-emerald-700 dark:text-emerald-300 border-emerald-300/60 bg-gradient-to-br from-emerald-50/70 to-transparent dark:from-emerald-950/25",
  B: "text-lime-700 dark:text-lime-300 border-lime-300/60 bg-gradient-to-br from-lime-50/70 to-transparent dark:from-lime-950/25",
  C: "text-amber-700 dark:text-amber-300 border-amber-300/60 bg-gradient-to-br from-amber-50/70 to-transparent dark:from-amber-950/25",
  D: "text-orange-700 dark:text-orange-300 border-orange-300/60 bg-gradient-to-br from-orange-50/70 to-transparent dark:from-orange-950/25",
  F: "text-red-700 dark:text-red-300 border-red-300/60 bg-gradient-to-br from-red-50/70 to-transparent dark:from-red-950/25",
};

// Grade → i18n key; the label itself is resolved via t() at render time
// so it follows the active locale.
const GRADE_LABEL_KEYS: Record<string, TranslationKey> = {
  A: "citationHealth.gradeA",
  B: "citationHealth.gradeB",
  C: "citationHealth.gradeC",
  D: "citationHealth.gradeD",
  F: "citationHealth.gradeF",
};

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
      const res = await fetch(`/api/projects/${projectId}/citation-health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as HealthReport;
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
      const healthRes = await fetch(
        `/api/paragraphs/${paragraphId}/validate-citations`
      );
      const beforeData = healthRes.ok ? await healthRes.json() : null;
      const before = beforeData?.missingCount ?? 0;

      const fixRes = await fetch(
        `/api/paragraphs/${paragraphId}/auto-fix-citations`,
        { method: "POST" }
      );
      if (!fixRes.ok) throw new Error(`auto-fix HTTP ${fixRes.status}`);
      const fixData = await fixRes.json();

      // Re-validate to get the after count.
      const afterRes = await fetch(
        `/api/paragraphs/${paragraphId}/validate-citations`
      );
      const afterData = afterRes.ok ? await afterRes.json() : null;
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
        const res = await fetch(`/api/paragraphs/${paragraphId}/regenerate`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(`regenerate HTTP ${res.status}`);
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
          const res = await fetch(`/api/paragraphs/${p.paragraphId}/regenerate`, {
            method: "POST",
          });
          if (!res.ok) throw new Error(`regenerate HTTP ${res.status}`);
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
                hasBlocking && "animate-pulse"
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
      <div className="flex items-center gap-2 text-[10px]">
        <span className="surface-card rounded-md px-2 py-0.5 flex items-center gap-1 transition-all hover:shadow-md hover:border-primary/30">
          <FileText className="h-3 w-3 text-primary" />
          <span className="font-serif-text font-semibold tabular-nums text-foreground">{agg.totalCitations}</span>
          <span className="text-muted-foreground">{t("citationHealth.statCitations")}</span>
        </span>
        <span className="surface-card rounded-md px-2 py-0.5 flex items-center gap-1 transition-all hover:shadow-md hover:border-primary/30">
          <BookOpen className="h-3 w-3 text-teal-600 dark:text-teal-400" />
          <span className="font-serif-text font-semibold tabular-nums text-foreground">{agg.totalReferences}</span>
          <span className="text-muted-foreground">{t("citationHealth.statRefs")}</span>
        </span>
        {agg.totalBlocking > 0 ? (
          <span className="surface-card rounded-md px-2 py-0.5 flex items-center gap-1 transition-all hover:shadow-md hover:border-rose-400/50">
            <CircleX className="h-3 w-3 text-red-600 dark:text-red-400" />
            <span className="font-serif-text font-semibold tabular-nums text-foreground">{agg.totalBlocking}</span>
            <span className="text-muted-foreground">{t("citationHealth.statBlocking")}</span>
          </span>
        ) : (
          <span className="surface-card rounded-md px-2 py-0.5 flex items-center gap-1 transition-all hover:shadow-md hover:border-emerald-400/50">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            <span className="font-serif-text font-semibold text-emerald-700 dark:text-emerald-400">
              {t("citationHealth.zeroBlocking")}
            </span>
          </span>
        )}
        {agg.totalWarnings > 0 && (
          <span className="surface-card rounded-md px-2 py-0.5 flex items-center gap-1 transition-all hover:shadow-md hover:border-amber-400/50">
            <AlertTriangle className="h-3 w-3 text-amber-600 dark:text-amber-400" />
            <span className="font-serif-text font-semibold tabular-nums text-foreground">{agg.totalWarnings}</span>
            <span className="text-muted-foreground">{t("citationHealth.statWarnings")}</span>
          </span>
        )}
      </div>

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
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1 font-serif-text glass-subtle rounded-md px-2 py-1">
                <TrendingUp className="h-3 w-3 text-primary" />
                {t("citationHealth.worstOffenders")}
              </p>
              {report.worstOffenders.length === 0 ? (
                <div className="surface-card rounded-md py-2 px-2 flex items-center gap-2">
                  <div className="h-5 w-5 rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 flex items-center justify-center ring-academic">
                    <CheckCircle2 className="h-3 w-3" />
                  </div>
                  <p className="text-[11px] text-muted-foreground font-serif-text">
                    {t("citationHealth.allClean")}
                  </p>
                </div>
              ) : (
                <div className="space-y-1 max-h-44 overflow-y-auto scroll-academic">
                  {report.worstOffenders.map((p) => {
                    const isFixingThis = fixingParagraphId === p.paragraphId;
                    const isRegenerating = regeneratingParagraphId === p.paragraphId;
                    return (
                    <div
                      key={p.paragraphId}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-[11px] cursor-pointer transition-all shadow-xs hover:shadow-md",
                        isFixingThis
                          ? "border-amber-400/70 bg-amber-50/60 dark:bg-amber-950/25 ring-1 ring-amber-300/40"
                          : isRegenerating
                          ? "border-primary/50 bg-primary/[0.06] dark:bg-primary/[0.08] ring-1 ring-primary/30"
                          : p.blockingCount > 0
                          ? "border-red-300/60 bg-red-50/40 dark:bg-red-950/15 hover:border-red-400/60"
                          : "border-amber-300/60 bg-amber-50/40 dark:bg-amber-950/15 hover:border-amber-400/60"
                      )}
                      onClick={() => !isFixingThis && !isRegenerating && onJumpParagraph?.(p.paragraphId)}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="font-mono text-[9px] text-muted-foreground tabular-nums">
                          §{p.order + 1}
                        </span>
                        <span className="font-medium truncate flex-1 min-w-0 font-serif-text">
                          {p.title}
                        </span>
                        {p.blockingCount > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] badge-rose"
                          >
                            {t("citationHealth.blkCount", { n: p.blockingCount })}
                          </Badge>
                        )}
                        {p.warningCount > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] badge-amber"
                          >
                            {t("citationHealth.warnCount", { n: p.warningCount })}
                          </Badge>
                        )}
                        <span className="text-[9px] text-muted-foreground shrink-0 tabular-nums">
                          {t("citationHealth.citRefCount", {
                            cit: p.citationCount,
                            ref: p.refCount,
                          })}
                        </span>
                        {/* Per-paragraph "Fix this" button — only for paragraphs
                            with blocking findings. Stops propagation so the
                            row click (jump to paragraph) doesn't fire. */}
                        {p.blockingCount > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-1.5 text-[9px] gap-0.5 shrink-0 text-amber-700 dark:text-amber-400 hover:bg-amber-100/60 dark:hover:bg-amber-950/40 hover:shadow-sm transition-all"
                            disabled={fixing || isFixingThis || isRegenerating}
                            onClick={(e) => {
                              e.stopPropagation();
                              fixSingleParagraph(p.paragraphId);
                            }}
                            title={t("citationHealth.fixThisTitle")}
                          >
                            {isFixingThis ? (
                              <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            ) : (
                              <Wand2 className="h-2.5 w-2.5" />
                            )}
                            {isFixingThis ? "…" : t("citationHealth.fix")}
                          </Button>
                        )}
                        {/* Per-paragraph "Regenerate" button — re-writes the
                            paragraph content via LLM using the current
                            reference list. Stronger than "Fix" (which only
                            adds references): regenerate produces fresh body
                            text with correct [n] citations. Shown for any
                            paragraph with findings (blocking OR warnings). */}
                        {(p.blockingCount > 0 || p.warningCount > 0) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-1.5 text-[9px] gap-0.5 shrink-0 text-primary/70 dark:text-primary/60 hover:bg-primary/10 hover:text-primary hover:shadow-sm transition-all"
                            disabled={fixing || isFixingThis || isRegenerating}
                            onClick={(e) => {
                              e.stopPropagation();
                              regenerateParagraph(p.paragraphId);
                            }}
                            title={t("citationHealth.regenThisTitle")}
                          >
                            {isRegenerating ? (
                              <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            ) : (
                              <RotateCw className="h-2.5 w-2.5" />
                            )}
                            {isRegenerating ? "…" : t("citationHealth.regen")}
                          </Button>
                        )}
                      </div>
                      {p.topFindings.length > 0 && (
                        <div className="space-y-0.5">
                          {p.topFindings.map((f, i) => (
                            <div
                              key={i}
                              className="text-[10px] text-muted-foreground leading-snug flex gap-1"
                            >
                              <span
                                className={cn(
                                  "font-mono font-semibold shrink-0 tabular-nums",
                                  f.verdict === "out-of-range" ||
                                    f.verdict === "missing"
                                    ? "text-red-600 dark:text-red-400"
                                    : "text-amber-600 dark:text-amber-400"
                                )}
                              >
                                [{f.n}]
                              </span>
                              <span className="truncate">{f.reason}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Article audits */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1 font-serif-text glass-subtle rounded-md px-2 py-1">
                <Sparkles className="h-3 w-3 text-primary" />
                {t("citationHealth.articleAudits")}
              </p>
              {report.articles.length === 0 ? (
                <div className="surface-card rounded-md py-2 px-2 flex items-center gap-2">
                  <div className="h-5 w-5 rounded-md bg-muted/40 text-muted-foreground flex items-center justify-center">
                    <BookOpen className="h-3 w-3" />
                  </div>
                  <p className="text-[11px] text-muted-foreground font-serif-text">
                    {t("citationHealth.noArticles")}
                  </p>
                </div>
              ) : (
                <div className="space-y-1 max-h-44 overflow-y-auto scroll-academic">
                  {report.articles.map((a) => (
                    <div
                      key={a.articleId}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-[11px] transition-all shadow-xs hover:shadow-md",
                        a.summary.blockingErrors > 0
                          ? "border-red-300/60 bg-red-50/40 dark:bg-red-950/15 hover:border-red-400/60"
                          : a.summary.suspect + a.summary.unsupported > 0
                          ? "border-amber-300/60 bg-amber-50/40 dark:bg-amber-950/15 hover:border-amber-400/60"
                          : "border-emerald-300/60 bg-emerald-50/40 dark:bg-emerald-950/15 hover:border-emerald-400/60"
                      )}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="font-medium truncate flex-1 min-w-0 font-serif-text">
                          {a.title}
                        </span>
                        <span className="text-[9px] text-muted-foreground shrink-0 tabular-nums">
                          {t("citationHealth.wordsCount", { n: a.wordCount })}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <Badge
                          variant="outline"
                          className="h-3.5 px-1 text-[8px] badge-slate"
                        >
                          {t("citationHealth.citCount", { n: a.totalCitations })}
                        </Badge>
                        <Badge
                          variant="outline"
                          className="h-3.5 px-1 text-[8px] badge-slate"
                        >
                          {t("citationHealth.refCount", { n: a.totalReferences })}
                        </Badge>
                        {a.summary.blockingErrors > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] badge-rose"
                          >
                            {t("citationHealth.blockingCount", {
                              n: a.summary.blockingErrors,
                            })}
                          </Badge>
                        )}
                        {a.summary.missing > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] badge-rose"
                          >
                            {t("citationHealth.missingCount", {
                              n: a.summary.missing,
                            })}
                          </Badge>
                        )}
                        {a.summary.suspect > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] badge-teal"
                          >
                            {t("citationHealth.suspectCount", {
                              n: a.summary.suspect,
                            })}
                          </Badge>
                        )}
                        {a.summary.unsupported > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] badge-amber"
                          >
                            {t("citationHealth.unsupCount", {
                              n: a.summary.unsupported,
                            })}
                          </Badge>
                        )}
                        {!a.numberingIntegrityOk && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] badge-rose"
                          >
                            {t("citationHealth.numberingDrift")}
                          </Badge>
                        )}
                        {a.summary.orphan > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] badge-amber"
                          >
                            {t("citationHealth.orphanCount", {
                              n: a.summary.orphan,
                            })}
                          </Badge>
                        )}
                        {a.summary.blockingErrors === 0 &&
                          a.summary.suspect === 0 &&
                          a.summary.unsupported === 0 && (
                            <Badge
                              variant="outline"
                              className="h-3.5 px-1 text-[8px] badge-emerald"
                            >
                              {t("citationHealth.cleanBadge")}
                            </Badge>
                          )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Confirmation dialog for "Regenerate all" — rewriting all paragraphs is
          destructive (replaces the current body text), so we double-confirm.
          Shows the count of paragraphs that will be regenerated. */}
      <AlertDialog open={confirmRegen} onOpenChange={setConfirmRegen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base font-serif-text tracking-tight">
              <RotateCw className="h-5 w-5 text-primary shrink-0" />
              {t("citationHealth.regenConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-relaxed space-y-2">
              <span className="block">
                {t("citationHealth.regenBodyPrefix")}{" "}
                <strong className="text-foreground font-serif-text">
                  {t("citationHealth.regenParagraphsCount", {
                    n:
                      report?.worstOffenders.filter(
                        (p) => p.blockingCount > 0 || p.warningCount > 0
                      ).length || 0,
                  })}
                </strong>{" "}
                {t("citationHealth.regenBodySuffix")}
              </span>
              <span className="block text-amber-600 dark:text-amber-400">
                ⚠ {t("citationHealth.regenWarning")}
              </span>
              <span className="block text-muted-foreground text-xs">
                {t("citationHealth.regenNote")}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="text-xs gap-1.5 btn-gradient-primary text-primary-foreground hover:shadow-md transition-all"
              onClick={(e) => {
                e.preventDefault();
                setConfirmRegen(false);
                runBatchRegenerate();
              }}
            >
              <RotateCw className="h-3.5 w-3.5" />
              {t("citationHealth.regenerateAll")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
