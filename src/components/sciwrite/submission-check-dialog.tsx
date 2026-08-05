"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Loader2,
  ClipboardCheck,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  FileText,
  Type,
  LayoutList,
  Quote,
  Image as ImageIcon,
  BookOpen,
  Link2,
  PenLine,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { useMutation } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  articleId: string;
}

// ── Module-level helpers (avoid re-creating components during render) ────────

function scoreColor(score: number): string {
  if (score >= 90) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 70) return "text-amber-600 dark:text-amber-400";
  if (score >= 40) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

function scoreStroke(score: number): string {
  if (score >= 90) return "stroke-emerald-500";
  if (score >= 70) return "stroke-amber-500";
  if (score >= 40) return "stroke-orange-500";
  return "stroke-red-500";
}

/** Radial score gauge — large SVG ring with the overall score in the center. */
function RadialScore({ value }: { value: number }) {
  const circumference = 2 * Math.PI * 52;
  const dashOffset = circumference - (value / 100) * circumference;
  return (
    <div className="relative w-36 h-36 shrink-0">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
        <circle
          cx="60"
          cy="60"
          r="52"
          fill="none"
          stroke="currentColor"
          strokeWidth="8"
          className="text-muted/20"
        />
        <circle
          cx="60"
          cy="60"
          r="52"
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className={`${scoreStroke(value)} transition-all duration-1000 ease-out`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-4xl font-bold ${scoreColor(value)}`}>
          {value}
        </span>
        <span className="text-[9px] text-muted-foreground uppercase tracking-wide">
          / 100
        </span>
      </div>
    </div>
  );
}

/** Small summary stat card used in the metrics grid. */
function SummaryStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-2 text-center">
      <div className="text-sm font-bold leading-tight">{value}</div>
      <div className="text-[9px] text-muted-foreground uppercase tracking-wide mt-0.5">
        {label}
      </div>
    </div>
  );
}

/**
 * SubmissionCheckDialog — comprehensive submission-readiness report.
 *
 * Visualizes 8 quality checks as a compliance checklist:
 *  1. Word Count
 *  2. Abstract
 *  3. Section Structure
 *  4. Citation Format
 *  5. Figures & Tables
 *  6. Reference Completeness
 *  7. DOI Coverage
 *  8. Language Quality
 *
 * Each check shows a status icon (pass/warn/fail), summary message, and
 * expandable details. An overall readiness score is displayed as a large
 * radial gauge with a qualitative label.
 *
 * All checks are computed locally (no LLM) for instant feedback.
 */
export function SubmissionCheckDialog({ open, onOpenChange, articleId }: Props) {
  const { t } = useI18n();

  const checkMut = useMutation({
    mutationFn: () => api.submissionCheck(articleId),
    onError: (e: any) => toast.error(e?.message || "Check failed"),
  });

  React.useEffect(() => {
    if (open && !checkMut.data && !checkMut.isPending) {
      checkMut.mutate();
    }
  }, [open]);

  const data = checkMut.data;

  // ── Check icon mapping ─────────────────────────────────────────────────────
  const checkIcon = (id: string): any => {
    const map: Record<string, any> = {
      "word-count": Type,
      abstract: FileText,
      sections: LayoutList,
      citations: Quote,
      figures: ImageIcon,
      references: BookOpen,
      doi: Link2,
      language: PenLine,
    };
    return map[id] || ClipboardCheck;
  };

  const statusIcon = (status: "pass" | "warn" | "fail") => {
    if (status === "pass")
      return <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />;
    if (status === "warn")
      return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />;
    return <XCircle className="h-4 w-4 text-red-500 shrink-0" />;
  };

  const statusBorder = (status: "pass" | "warn" | "fail"): string => {
    if (status === "pass") return "border-l-emerald-400";
    if (status === "warn") return "border-l-amber-400";
    return "border-l-red-400";
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[88vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ClipboardCheck className="h-4 w-4 text-indigo-600" />
            Submission Readiness Check
          </DialogTitle>
          <DialogDescription className="text-xs">
            Pre-submission quality check across 8 dimensions
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1">
          <div className="px-5 py-4 space-y-4">
            {checkMut.isPending && (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
                <p className="text-xs text-muted-foreground">
                  Running submission checks…
                </p>
              </div>
            )}

            {data && (
              <>
                {/* ── Overall score header ─────────────────────────────────── */}
                <div className="flex items-center gap-5 p-4 rounded-xl bg-gradient-to-br from-indigo-50 via-white to-purple-50 dark:from-indigo-950/30 dark:via-card dark:to-purple-950/20 border border-indigo-200/50 dark:border-indigo-800/40">
                  <RadialScore value={data.overallScore} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className={`text-lg font-bold ${scoreColor(data.overallScore)}`}>
                        {data.readyLabel}
                      </h3>
                      {data.ready ? (
                        <Badge className="bg-emerald-500 hover:bg-emerald-500 text-[9px] gap-0.5">
                          <CheckCircle2 className="h-2.5 w-2.5" />
                          READY
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[9px] border-amber-400/60 text-amber-600 gap-0.5">
                          <AlertTriangle className="h-2.5 w-2.5" />
                          NEEDS WORK
                        </Badge>
                      )}
                    </div>
                    <div className="flex gap-4 text-[11px] mb-2">
                      <span className="flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                        <strong>{data.passCount}</strong> passed
                      </span>
                      <span className="flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3 text-amber-500" />
                        <strong>{data.warnCount}</strong> warnings
                      </span>
                      <span className="flex items-center gap-1">
                        <XCircle className="h-3 w-3 text-red-500" />
                        <strong>{data.failCount}</strong> failed
                      </span>
                    </div>
                    {data.journalTemplateName && (
                      <p className="text-[10px] text-muted-foreground">
                        Target journal: <strong>{data.journalTemplateName}</strong>
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[10px] gap-1 self-start"
                    onClick={() => checkMut.mutate()}
                    disabled={checkMut.isPending}
                  >
                    <RefreshCw className="h-3 w-3" />
                    Re-run
                  </Button>
                </div>

                {/* ── Summary metrics grid ─────────────────────────────────── */}
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                  <SummaryStat label="Words" value={data.summary.totalWords.toLocaleString()} />
                  <SummaryStat label="Abstract" value={data.summary.abstractWords || "—"} />
                  <SummaryStat label="Sections" value={`${data.summary.sectionsFound}/${data.summary.sectionsTotal}`} />
                  <SummaryStat label="Refs" value={data.summary.refCount} />
                  <SummaryStat label="Citations" value={data.summary.totalCitations} />
                  <SummaryStat label="DOI" value={`${data.summary.doiCoverage}%`} />
                </div>

                {/* ── Checks checklist ─────────────────────────────────────── */}
                <div>
                  <h3 className="text-xs font-semibold flex items-center gap-1.5 mb-3">
                    <ClipboardCheck className="h-3.5 w-3.5 text-indigo-600" />
                    Compliance Checklist
                  </h3>
                  <div className="space-y-2">
                    {data.checks.map((check) => {
                      const Icon = checkIcon(check.id);
                      return (
                        <div
                          key={check.id}
                          className={`rounded-lg border border-border/60 border-l-4 ${statusBorder(check.status)} p-3 bg-card transition-shadow hover:shadow-sm`}
                        >
                          <div className="flex items-start gap-2.5">
                            <div className="mt-0.5">
                              {statusIcon(check.status)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-xs font-semibold">
                                  {check.label}
                                </span>
                                <Badge
                                  variant="outline"
                                  className={`text-[8px] h-3.5 uppercase ${
                                    check.status === "pass"
                                      ? "border-emerald-300/60 text-emerald-600"
                                      : check.status === "warn"
                                        ? "border-amber-300/60 text-amber-600"
                                        : "border-red-300/60 text-red-600"
                                  }`}
                                >
                                  {check.status}
                                </Badge>
                                {check.severity !== "info" && (
                                  <Badge
                                    variant="outline"
                                    className={`text-[8px] h-3.5 uppercase ${
                                      check.severity === "high"
                                        ? "border-red-400/60 text-red-600"
                                        : check.severity === "medium"
                                          ? "border-amber-400/60 text-amber-600"
                                          : "border-slate-300/60 text-slate-500"
                                    }`}
                                  >
                                    {check.severity}
                                  </Badge>
                                )}
                              </div>
                              <p className="text-[11px] text-muted-foreground mb-1">
                                {check.message}
                              </p>
                              {check.details && check.details.length > 0 && (
                                <ul className="space-y-0.5 mt-1.5">
                                  {check.details.map((d, i) => (
                                    <li
                                      key={i}
                                      className="text-[10px] text-muted-foreground/90 flex gap-1 leading-relaxed"
                                    >
                                      <span className="text-muted-foreground/50">›</span>
                                      <span>{d}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ── Action recommendations ──────────────────────────────── */}
                {data.failCount > 0 && (
                  <div className="rounded-lg border border-red-200/60 dark:border-red-800/40 bg-red-50/40 dark:bg-red-950/10 p-3">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <XCircle className="h-3.5 w-3.5 text-red-500" />
                      <span className="text-xs font-semibold text-red-700 dark:text-red-400">
                        Critical Issues ({data.failCount})
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Fix the failed checks above before submitting. These are
                      likely to result in immediate desk rejection by journal editors.
                    </p>
                  </div>
                )}

                {data.warnCount > 0 && data.failCount === 0 && (
                  <div className="rounded-lg border border-amber-200/60 dark:border-amber-800/40 bg-amber-50/40 dark:bg-amber-950/10 p-3">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                      <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                        Minor Revisions Recommended ({data.warnCount})
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Address the warnings above to improve your submission's
                      chances. The article is technically submittable but could be stronger.
                    </p>
                  </div>
                )}

                {data.failCount === 0 && data.warnCount === 0 && (
                  <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-800/40 bg-emerald-50/40 dark:bg-emerald-950/10 p-3">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                        All Checks Passed
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Your article passes all submission readiness checks. It's
                      ready to submit to your target journal.
                    </p>
                  </div>
                )}

                {/* ── Footer ──────────────────────────────────────────────── */}
                <div className="pt-2 border-t border-border/60">
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    <strong>How the score is calculated:</strong> Starts at 100.
                    Each failed check subtracts 15 points, each warning subtracts
                    5. A bonus of up to 10 points is awarded for high DOI coverage
                    (≥80%) and complete references. All checks run locally for
                    instant feedback — no data is sent to external APIs.
                  </p>
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
