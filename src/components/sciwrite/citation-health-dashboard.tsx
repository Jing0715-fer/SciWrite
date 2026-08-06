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
  A: "text-emerald-600 dark:text-emerald-400 bg-emerald-100/60 dark:bg-emerald-950/30 border-emerald-300/60",
  B: "text-lime-600 dark:text-lime-400 bg-lime-100/60 dark:bg-lime-950/30 border-lime-300/60",
  C: "text-amber-600 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-950/30 border-amber-300/60",
  D: "text-orange-600 dark:text-orange-400 bg-orange-100/60 dark:bg-orange-950/30 border-orange-300/60",
  F: "text-red-600 dark:text-red-400 bg-red-100/60 dark:bg-red-950/30 border-red-300/60",
};

const GRADE_LABELS: Record<string, string> = {
  A: "Excellent",
  B: "Good",
  C: "Fair",
  D: "Poor",
  F: "Critical",
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
      setError(err?.message || "Failed to load citation health.");
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
      // Re-fetch health to reflect the fixes.
      await fetchHealth();
    } catch (err: any) {
      setError(err?.message || "Batch auto-fix failed.");
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
        setError(err?.message || "Auto-fix failed for this paragraph.");
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
        setError(err?.message || "Regenerate failed for this paragraph.");
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
      await fetchHealth();
    } catch (err: any) {
      setError(err?.message || "Batch regenerate failed.");
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
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Analyzing citation health…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground">
        <CircleAlert className="h-3.5 w-3.5 text-amber-500" />
        Citation health unavailable
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[10px]"
          onClick={fetchHealth}
        >
          <RefreshCw className="h-3 w-3" /> Retry
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
    <div className="px-5 py-1.5 border-b border-border/40 bg-muted/15 flex items-center gap-3 flex-wrap">
      {/* Grade badge */}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-bold cursor-help",
                GRADE_COLORS[agg.grade]
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="font-mono text-sm leading-none">{agg.grade}</span>
              <span className="font-sans text-[10px] font-medium opacity-80">
                {agg.healthScore}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[10px]">
            <div className="space-y-0.5">
              <p className="font-semibold">
                Citation Health: {GRADE_LABELS[agg.grade]} ({agg.healthScore}/100)
              </p>
              <p className="text-muted-foreground">
                Grade = 100 − (5×blocking + 1×warning).
              </p>
              <p className="text-muted-foreground">
                A ≥90 · B ≥70 · C ≥50 · D ≥30 · F &lt;30
              </p>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Quick stats */}
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <FileText className="h-3 w-3" />
          <span className="font-semibold text-foreground/80">{agg.totalCitations}</span>
          citations
        </span>
        <span className="flex items-center gap-1">
          <BookOpen className="h-3 w-3" />
          <span className="font-semibold text-foreground/80">{agg.totalReferences}</span>
          refs
        </span>
        {agg.totalBlocking > 0 && (
          <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
            <CircleX className="h-3 w-3" />
            <span className="font-semibold">{agg.totalBlocking}</span>
            blocking
          </span>
        )}
        {agg.totalWarnings > 0 && (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" />
            <span className="font-semibold">{agg.totalWarnings}</span>
            warnings
          </span>
        )}
      </div>

      {/* Clean progress */}
      <div className="flex items-center gap-2 min-w-[140px] flex-1 max-w-[260px]">
        <Progress
          value={cleanPct}
          className={cn(
            "h-1.5 flex-1",
            cleanPct === 100
              ? "[&>div]:bg-emerald-500"
              : cleanPct >= 60
              ? "[&>div]:bg-amber-500"
              : "[&>div]:bg-red-500"
          )}
        />
        <span className="text-[9px] text-muted-foreground font-mono tabular-nums shrink-0">
          {agg.paragraphsClean}/{agg.totalParagraphs} clean
        </span>
      </div>

      {/* Expand button */}
      {(report.worstOffenders.length > 0 || report.articles.length > 0) && (
        <Collapsible open={open} onOpenChange={setOpen} className="ml-auto">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] gap-1">
              {open ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {report.worstOffenders.length > 0
                ? `${report.worstOffenders.length} offender${
                    report.worstOffenders.length === 1 ? "" : "s"
                  }`
                : "Details"}
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
            className="h-6 px-2 text-[10px] gap-1 border-amber-300/60 text-amber-700 dark:text-amber-400 hover:bg-amber-50/60 dark:hover:bg-amber-950/30"
            disabled={fixing}
            onClick={runBatchAutoFix}
            title="Run the LLM auto-fix on all paragraphs with blocking citation errors"
          >
            {fixing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Wand2 className="h-3 w-3" />
            )}
            {fixing && fixProgress
              ? `Fixing ${fixProgress.done}/${fixProgress.total}…`
              : "Auto-fix all"}
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
        <div className="flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20 px-1.5 py-0.5 rounded">
          <CheckCircle2 className="h-3 w-3" />
          <span>
            Fixed {fixResult.totalFixed}/{fixResult.totalBefore} across{" "}
            {fixResult.paragraphsProcessed} ¶
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
            className="h-6 px-2 text-[10px] gap-1 border-primary/40 text-primary hover:bg-primary/10"
            disabled={fixing || regenProgress !== null}
            onClick={() => setConfirmRegen(true)}
            title="Regenerate ALL paragraphs with citation issues via LLM (re-writes body text with correct [n] citations). Slower but more thorough than Auto-fix. You will be asked to confirm."
          >
            {regenProgress !== null ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCw className="h-3 w-3" />
            )}
            {regenProgress !== null
              ? `Regen ${regenProgress.done}/${regenProgress.total}…`
              : "Regenerate all"}
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
        <div className="flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20 px-1.5 py-0.5 rounded">
          <CheckCircle2 className="h-3 w-3" />
          <span>
            Regenerated {regenResult.processed}/{regenResult.total} ¶
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
          className="h-6 px-2 text-[10px] gap-1 text-orange-600 dark:text-orange-400 hover:bg-orange-100/60 dark:hover:bg-orange-950/40"
          onClick={() => {
            // Trigger a custom event that the article viewer can listen for
            // to switch to the Analysis → Audit Trail sub-tab.
            window.dispatchEvent(new CustomEvent("open-audit-trail"));
          }}
          title="Review low-confidence citation issues that need manual verification"
        >
          <CircleAlert className="h-3 w-3" />
          Review {agg.totalWarnings} warnings
        </Button>
      )}

      {/* Refresh */}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0"
        onClick={fetchHealth}
        title="Re-run citation health check"
      >
        <RefreshCw className="h-3 w-3" />
      </Button>

      {/* Expanded detail */}
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleContent>
          <div className="w-full mt-2 pt-2 border-t border-border/30 grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* Worst-offending paragraphs */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <TrendingUp className="h-3 w-3" />
                Worst-offending paragraphs
              </p>
              {report.worstOffenders.length === 0 ? (
                <p className="text-[11px] text-muted-foreground py-2 px-2 rounded bg-emerald-50/40 dark:bg-emerald-950/15">
                  ✓ All paragraphs pass the citation audit. No blocking errors
                  or warnings.
                </p>
              ) : (
                <div className="space-y-1 max-h-44 overflow-y-auto scroll-academic">
                  {report.worstOffenders.map((p) => {
                    const isFixingThis = fixingParagraphId === p.paragraphId;
                    const isRegenerating = regeneratingParagraphId === p.paragraphId;
                    return (
                    <div
                      key={p.paragraphId}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-[11px] cursor-pointer hover:bg-accent/30 transition-colors",
                        isFixingThis
                          ? "border-amber-400/70 bg-amber-50/60 dark:bg-amber-950/25 ring-1 ring-amber-300/40"
                          : isRegenerating
                          ? "border-primary/50 bg-primary/[0.06] dark:bg-primary/[0.08] ring-1 ring-primary/30"
                          : p.blockingCount > 0
                          ? "border-red-300/50 bg-red-50/40 dark:bg-red-950/15"
                          : "border-amber-300/50 bg-amber-50/40 dark:bg-amber-950/15"
                      )}
                      onClick={() => !isFixingThis && !isRegenerating && onJumpParagraph?.(p.paragraphId)}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="font-mono text-[9px] text-muted-foreground">
                          §{p.order + 1}
                        </span>
                        <span className="font-medium truncate flex-1 min-w-0">
                          {p.title}
                        </span>
                        {p.blockingCount > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] border-red-300/60 text-red-700 dark:text-red-400"
                          >
                            {p.blockingCount} blk
                          </Badge>
                        )}
                        {p.warningCount > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] border-amber-300/60 text-amber-700 dark:text-amber-400"
                          >
                            {p.warningCount} warn
                          </Badge>
                        )}
                        <span className="text-[9px] text-muted-foreground shrink-0">
                          {p.citationCount} cit · {p.refCount} ref
                        </span>
                        {/* Per-paragraph "Fix this" button — only for paragraphs
                            with blocking findings. Stops propagation so the
                            row click (jump to paragraph) doesn't fire. */}
                        {p.blockingCount > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 px-1.5 text-[9px] gap-0.5 shrink-0 text-amber-700 dark:text-amber-400 hover:bg-amber-100/60 dark:hover:bg-amber-950/40"
                            disabled={fixing || isFixingThis || isRegenerating}
                            onClick={(e) => {
                              e.stopPropagation();
                              fixSingleParagraph(p.paragraphId);
                            }}
                            title="Run auto-fix on just this paragraph (adds missing references via LLM + database queries)"
                          >
                            {isFixingThis ? (
                              <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            ) : (
                              <Wand2 className="h-2.5 w-2.5" />
                            )}
                            {isFixingThis ? "…" : "Fix"}
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
                            className="h-5 px-1.5 text-[9px] gap-0.5 shrink-0 text-primary/70 dark:text-primary/60 hover:bg-primary/10 hover:text-primary"
                            disabled={fixing || isFixingThis || isRegenerating}
                            onClick={(e) => {
                              e.stopPropagation();
                              regenerateParagraph(p.paragraphId);
                            }}
                            title="Regenerate this paragraph's content via LLM using the current reference list (re-writes the body with correct [n] citations)"
                          >
                            {isRegenerating ? (
                              <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            ) : (
                              <RotateCw className="h-2.5 w-2.5" />
                            )}
                            {isRegenerating ? "…" : "Regen"}
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
                                  "font-mono font-semibold shrink-0",
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
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <Sparkles className="h-3 w-3" />
                Article audits
              </p>
              {report.articles.length === 0 ? (
                <p className="text-[11px] text-muted-foreground py-2 px-2 rounded bg-muted/30">
                  No composed articles yet. Run Compose to generate one.
                </p>
              ) : (
                <div className="space-y-1 max-h-44 overflow-y-auto scroll-academic">
                  {report.articles.map((a) => (
                    <div
                      key={a.articleId}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-[11px]",
                        a.summary.blockingErrors > 0
                          ? "border-red-300/50 bg-red-50/40 dark:bg-red-950/15"
                          : a.summary.suspect + a.summary.unsupported > 0
                          ? "border-amber-300/50 bg-amber-50/40 dark:bg-amber-950/15"
                          : "border-emerald-300/50 bg-emerald-50/40 dark:bg-emerald-950/15"
                      )}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="font-medium truncate flex-1 min-w-0">
                          {a.title}
                        </span>
                        <span className="text-[9px] text-muted-foreground shrink-0">
                          {a.wordCount}w
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <Badge
                          variant="outline"
                          className="h-3.5 px-1 text-[8px]"
                        >
                          {a.totalCitations} cit
                        </Badge>
                        <Badge
                          variant="outline"
                          className="h-3.5 px-1 text-[8px]"
                        >
                          {a.totalReferences} ref
                        </Badge>
                        {a.summary.blockingErrors > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] border-red-300/60 text-red-700 dark:text-red-400"
                          >
                            {a.summary.blockingErrors} blocking
                          </Badge>
                        )}
                        {a.summary.missing > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] border-red-300/60 text-red-700 dark:text-red-400"
                          >
                            {a.summary.missing} missing
                          </Badge>
                        )}
                        {a.summary.suspect > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] border-amber-300/60 text-amber-700 dark:text-amber-400"
                          >
                            {a.summary.suspect} suspect
                          </Badge>
                        )}
                        {a.summary.unsupported > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] border-amber-300/60 text-amber-700 dark:text-amber-400"
                          >
                            {a.summary.unsupported} unsup
                          </Badge>
                        )}
                        {!a.numberingIntegrityOk && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] border-red-300/60 text-red-700 dark:text-red-400"
                          >
                            numbering drift
                          </Badge>
                        )}
                        {a.summary.orphan > 0 && (
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 text-[8px] border-amber-300/60 text-amber-700 dark:text-amber-400"
                          >
                            {a.summary.orphan} orphan
                          </Badge>
                        )}
                        {a.summary.blockingErrors === 0 &&
                          a.summary.suspect === 0 &&
                          a.summary.unsupported === 0 && (
                            <Badge
                              variant="outline"
                              className="h-3.5 px-1 text-[8px] border-emerald-300/60 text-emerald-700 dark:text-emerald-400"
                            >
                              ✓ clean
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
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <RotateCw className="h-5 w-5 text-primary shrink-0" />
              Regenerate all paragraphs with citation issues?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-relaxed space-y-2">
              <span className="block">
                This will re-write the body text of{" "}
                <strong className="text-foreground">
                  {report?.worstOffenders.filter(
                    (p) => p.blockingCount > 0 || p.warningCount > 0
                  ).length || 0}{" "}
                  paragraph(s)
                </strong>{" "}
                via LLM using their current reference lists.
              </span>
              <span className="block text-amber-600 dark:text-amber-400">
                ⚠ This is a destructive operation — the current paragraph
                content will be replaced with fresh text. Consider using
                "Auto-fix all" first if you only need to add missing references.
              </span>
              <span className="block text-muted-foreground text-xs">
                The regeneration runs the LLM with the project's curated
                references and re-numbers citations by appearance order. Each
                paragraph's reference list is rebuilt to match the new body.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="text-xs gap-1.5"
              onClick={(e) => {
                e.preventDefault();
                setConfirmRegen(false);
                runBatchRegenerate();
              }}
            >
              <RotateCw className="h-3.5 w-3.5" />
              Regenerate all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
