"use client";

import * as React from "react";
import {
  ScrollText,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  ScanSearch,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface AuditVerdict {
  n: number;
  sentence: string;
  refTitle: string;
  verdict: "yes" | "no" | "partial";
  confidence?: number;
  reason: string;
}

interface AuditCorrection {
  oldN: number;
  newN: number | "$REF";
  reason: string;
}

interface AuditReport {
  id: string;
  paragraphId: string;
  paragraphTitle?: string;
  paragraphOrder?: number;
  trigger: string;
  checkedCount: number;
  issueCount: number;
  fixedCount: number;
  bodyUpdated: boolean;
  contentHash?: string;
  createdAt: string;
  report: {
    message?: string;
    checked?: number;
    issues?: number;
    fixed?: number;
    bodyUpdated?: boolean;
    trigger?: string;
    verdicts?: AuditVerdict[];
    mismatches?: AuditVerdict[];
    lowConfidenceMismatches?: AuditVerdict[];
    corrections?: AuditCorrection[];
    beforeBody?: string;
    afterBody?: string;
  };
}

export function AuditReportViewer({ projectId }: { projectId: string }) {
  const [reports, setReports] = React.useState<AuditReport[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());

  const fetchReports = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/audit-reports?limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setReports(data.reports || []);
    } catch (err: any) {
      setError(err?.message || "Failed to load audit reports.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  React.useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading audit reports...
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-2 text-[11px] text-red-600 dark:text-red-400">
        {error}
      </div>
    );
  }

  if (reports.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-muted-foreground text-center">
        <ScanSearch className="h-5 w-5 mx-auto opacity-40 mb-1" />
        No audit reports yet. Reports are created automatically after
        generation, or when you click the "Audit" button on a paragraph.
      </div>
    );
  }

  const autoCount = reports.filter((r) => r.trigger === "auto").length;
  const manualCount = reports.filter((r) => r.trigger === "manual").length;
  const totalIssues = reports.reduce((s, r) => s + r.issueCount, 0);
  const totalFixed = reports.reduce((s, r) => s + r.fixedCount, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-[10px] text-muted-foreground px-2.5 py-1.5 rounded-lg bg-muted/20 border border-border/30">
        <ScrollText className="h-3.5 w-3.5 text-primary" />
        <span className="font-semibold text-foreground">{reports.length} audit runs</span>
        <Badge variant="outline" className="h-4 px-1.5 text-[8px] rounded-md">
          {autoCount} auto
        </Badge>
        <Badge variant="outline" className="h-4 px-1.5 text-[8px] rounded-md">
          {manualCount} manual
        </Badge>
        <span className="text-amber-600 dark:text-amber-400">
          {totalIssues} issues found
        </span>
        <span className="text-emerald-600 dark:text-emerald-400">
          {totalFixed} auto-fixed
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[9px] gap-0.5 ml-auto"
          onClick={() =>
            window.open(`/api/projects/${projectId}/audit-reports/export`, "_blank")
          }
          title="Export all audit reports as CSV"
        >
          <Download className="h-2.5 w-2.5" />
          CSV
        </Button>
      </div>

      <div className="space-y-1 max-h-[400px] overflow-y-auto scroll-academic">
        {reports.map((r) => {
          const expanded = expandedIds.has(r.id);
          const report = r.report;
          const verdicts = report.verdicts || [];
          const mismatches = report.mismatches || [];
          const corrections = report.corrections || [];
          const date = new Date(r.createdAt);
          const dateStr = date.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });

          return (
            <Collapsible
              key={r.id}
              open={expanded}
              onOpenChange={() => toggleExpand(r.id)}
              className={cn(
                "rounded-md border px-2 py-1.5 text-[11px] transition-colors",
                r.trigger === "auto"
                  ? "border-violet-300/40 dark:border-violet-700/50 bg-violet-50/30 dark:bg-violet-950/10"
                  : "border-border/60 bg-card/50"
              )}
            >
              <CollapsibleTrigger asChild>
                <button className="w-full flex items-center gap-1.5 text-left">
                  {expanded ? (
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0" />
                  )}
                  <span className="font-mono text-[9px] text-muted-foreground shrink-0">
                    {dateStr}
                  </span>
                  {r.trigger === "auto" ? (
                    <Badge
                      variant="outline"
                      className="h-3.5 px-1 text-[8px] border-violet-300/60 dark:border-violet-700/50 text-violet-700 dark:text-violet-400"
                    >
                      auto
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="h-3.5 px-1 text-[8px] border-blue-300/60 dark:border-blue-700/50 text-blue-700 dark:text-blue-400"
                    >
                      manual
                    </Badge>
                  )}
                  <span className="font-medium truncate flex-1 min-w-0">
                    {r.paragraphTitle || `§${(r.paragraphOrder ?? 0) + 1}`}
                  </span>
                  {r.issueCount > 0 ? (
                    <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400 shrink-0">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      {r.issueCount}
                    </span>
                  ) : (
                    <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400 shrink-0">
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      0
                    </span>
                  )}
                  {r.fixedCount > 0 && (
                    <span className="text-emerald-600 dark:text-emerald-400 shrink-0">
                      ✓{r.fixedCount}
                    </span>
                  )}
                  <span className="text-[9px] text-muted-foreground shrink-0">
                    {r.checkedCount} checked
                  </span>
                </button>
              </CollapsibleTrigger>

              <CollapsibleContent>
                <div className="mt-2 pt-2 border-t border-border/30 space-y-2">
                  {mismatches.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[9px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide">
                        Mismatches ({mismatches.length})
                      </p>
                      {mismatches.map((mm, i) => {
                        const isLowConf = (mm.confidence || 50) < 70;
                        return (
                        <div
                          key={i}
                          className={cn(
                            "rounded px-1.5 py-1 text-[10px]",
                            isLowConf
                              ? "bg-orange-50/50 dark:bg-orange-950/20 ring-1 ring-orange-300/30 dark:ring-orange-700/50"
                              : "bg-amber-50/40 dark:bg-amber-950/15"
                          )}
                        >
                          <div className="flex items-center gap-1 mb-0.5 flex-wrap">
                            <span className="font-mono font-semibold text-amber-700 dark:text-amber-400">
                              [{mm.n}]
                            </span>
                            <Badge
                              variant="outline"
                              className="h-3 px-0.5 text-[7px] uppercase"
                            >
                              {mm.verdict}
                            </Badge>
                            {mm.confidence !== undefined && (
                              <span className={cn(
                                "text-[7px] font-mono px-1 rounded",
                                mm.confidence >= 70
                                  ? "text-emerald-600 dark:text-emerald-400 bg-emerald-50/40 dark:bg-emerald-950/15"
                                  : "text-orange-600 dark:text-orange-400 bg-orange-50/40 dark:bg-orange-950/15"
                              )}>
                                {mm.confidence}%
                              </span>
                            )}
                            {isLowConf && (
                              <Badge
                                variant="outline"
                                className="h-3 px-0.5 text-[7px] uppercase border-orange-300/60 dark:border-orange-700/50 text-orange-700 dark:text-orange-400"
                              >
                                manual review
                              </Badge>
                            )}
                          </div>
                          <p className="text-muted-foreground leading-snug">
                            <span className="text-foreground/70">Claim:</span>{" "}
                            {mm.sentence.slice(0, 150)}
                            {mm.sentence.length > 150 ? "..." : ""}
                          </p>
                          <p className="text-muted-foreground/80 leading-snug mt-0.5">
                            <span className="text-foreground/70">Ref:</span>{" "}
                            {mm.refTitle.slice(0, 100)}
                          </p>
                          <p className="text-amber-700 dark:text-amber-400 leading-snug mt-0.5">
                            {mm.reason}
                          </p>
                        </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Body diff — show before/after when body was updated */}
                  {report.beforeBody && report.afterBody && (
                    <div className="space-y-1">
                      <p className="text-[9px] font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wide">
                        Body Changes (diff)
                      </p>
                      <div className="rounded border border-border/40 overflow-hidden text-[9px]">
                        <div className="bg-red-50/40 dark:bg-red-950/15 px-1.5 py-0.5 border-b border-border/30">
                          <span className="text-red-600 dark:text-red-400 font-mono">- Before:</span>
                        </div>
                        <pre className="px-1.5 py-1 text-red-700 dark:text-red-400 whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
                          {report.beforeBody}
                        </pre>
                        <div className="bg-emerald-50/40 dark:bg-emerald-950/15 px-1.5 py-0.5 border-y border-border/30">
                          <span className="text-emerald-600 dark:text-emerald-400 font-mono">+ After:</span>
                        </div>
                        <pre className="px-1.5 py-1 text-emerald-700 dark:text-emerald-400 whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
                          {report.afterBody}
                        </pre>
                      </div>
                    </div>
                  )}

                  {corrections.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[9px] font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">
                        Corrections ({corrections.length})
                      </p>
                      {corrections.map((c, i) => (
                        <div
                          key={i}
                          className="rounded bg-emerald-50/40 dark:bg-emerald-950/15 px-1.5 py-1 text-[10px] flex items-center gap-1"
                        >
                          <span className="font-mono font-semibold text-red-500 line-through">
                            [{c.oldN}]
                          </span>
                          <span className="text-muted-foreground">→</span>
                          <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                            [{c.newN}]
                          </span>
                          <span className="text-muted-foreground truncate">
                            {c.reason}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {verdicts.length > 0 && (
                    <details className="text-[10px]">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        All verdicts ({verdicts.length})
                      </summary>
                      <div className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                        {verdicts.map((v, i) => (
                          <div key={i} className="flex items-start gap-1">
                            <span className="font-mono font-semibold shrink-0">
                              [{v.n}]
                            </span>
                            {v.verdict === "yes" ? (
                              <CheckCircle2 className="h-2.5 w-2.5 text-emerald-500 shrink-0 mt-0.5" />
                            ) : v.verdict === "no" ? (
                              <XCircle className="h-2.5 w-2.5 text-red-500 shrink-0 mt-0.5" />
                            ) : (
                              <AlertTriangle className="h-2.5 w-2.5 text-amber-500 shrink-0 mt-0.5" />
                            )}
                            <span className="text-muted-foreground truncate">
                              {v.reason}
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  <div className="flex items-center gap-2 text-[9px] text-muted-foreground/70 pt-1 border-t border-border/20">
                    {r.bodyUpdated && (
                      <Badge
                        variant="outline"
                        className="h-3 px-1 text-[7px] border-emerald-300/60 dark:border-emerald-700/50 text-emerald-700 dark:text-emerald-400"
                      >
                        body updated
                      </Badge>
                    )}
                    {r.contentHash && (
                      <span className="font-mono">
                        hash: {r.contentHash}
                      </span>
                    )}
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}
