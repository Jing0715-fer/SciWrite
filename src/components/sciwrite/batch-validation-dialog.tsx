"use client";

import * as React from "react";
import {
  ShieldCheck,
  ShieldAlert,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileText,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api-client";
import { useQuery } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string | null;
}

export function BatchValidationDialog({ open, onOpenChange, projectId }: Props) {
  const { t } = useI18n();
  const { data, isLoading } = useQuery({
    queryKey: ["batch-validate", projectId],
    queryFn: () => api.validateProjectCitations(projectId!),
    enabled: open && !!projectId,
  });

  const agg = data?.aggregate;
  const allClean = agg && agg.totalMissing === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 text-base">
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : allClean ? (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            ) : agg ? (
              <ShieldAlert className="h-4 w-4 text-amber-600" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-primary" />
            )}
            {t("batch.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("batch.desc")}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-6 py-4">
            {isLoading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            )}

            {agg && (
              <div className="space-y-4">
                {/* Aggregate banner */}
                <div
                  className={`rounded-lg border p-4 ${
                    allClean
                      ? "border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/50 dark:bg-emerald-950/20"
                      : "border-amber-200/60 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-950/20"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    {allClean ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-amber-600" />
                    )}
                    <span
                      className={`text-sm font-semibold ${
                        allClean
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-amber-700 dark:text-amber-400"
                      }`}
                    >
                      {allClean
                        ? t("batch.allClean")
                        : t("batch.missingInParagraphs", { missing: agg.totalMissing, paragraphs: agg.paragraphsIssues })}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <AggStat
                      label={t("batch.paragraphsLabel")}
                      value={agg.totalParagraphs}
                      color="slate"
                    />
                    <AggStat
                      label={t("batch.totalMarkersLabel")}
                      value={agg.totalMarkers}
                      color="slate"
                    />
                    <AggStat
                      label={t("validation.validLabel")}
                      value={agg.totalValid}
                      color="emerald"
                    />
                    <AggStat
                      label={t("validation.missingLabel")}
                      value={agg.totalMissing}
                      color="rose"
                    />
                  </div>
                </div>

                {/* Per-paragraph breakdown */}
                <div className="space-y-2">
                  <p className="divider-academic">
                    <span>{t("batch.perParagraph")}</span>
                  </p>
                  {data.paragraphs.map((p: any, i: number) => {
                    const clean = p.missingCount === 0;
                    return (
                      <div
                        key={p.paragraphId}
                        className={`rounded-lg border p-2.5 ${
                          clean
                            ? "border-emerald-200/50 dark:border-emerald-900/30 bg-emerald-50/30 dark:bg-emerald-950/10"
                            : "border-amber-200/60 dark:border-amber-900/40 bg-amber-50/30 dark:bg-amber-950/10"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                            §{String(i + 1).padStart(2, "0")}
                          </span>
                          {clean ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                          ) : (
                            <XCircle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                          )}
                          <span className="text-xs font-medium truncate flex-1">
                            {p.title}
                          </span>
                          <Badge
                            variant="outline"
                            className={`text-[8px] h-4 uppercase shrink-0 ${
                              clean
                                ? "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400"
                                : "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400"
                            }`}
                          >
                            {p.format}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 mt-1.5 pl-6 text-[10px]">
                          <span className="text-muted-foreground">
                            <FileText className="h-2.5 w-2.5 inline mr-0.5" />
                            {p.totalMarkers} {t("batch.markersSuffix")}
                          </span>
                          <span className="text-emerald-600 dark:text-emerald-400">
                            {p.validCount} {t("batch.validSuffix")}
                          </span>
                          {p.missingCount > 0 && (
                            <span className="text-rose-600 dark:text-rose-400">
                              {p.missingCount} {t("batch.missingSuffix")}
                            </span>
                          )}
                          <span className="text-muted-foreground">
                            {p.savedReferenceCount} {t("batch.refsSuffix")}
                          </span>
                          {p.hasCitationsBlock && (
                            <span className="text-sky-600 dark:text-sky-400">
                              {t("batch.aiBlockLabel")}
                            </span>
                          )}
                        </div>
                        {p.missing.length > 0 && (
                          <div className="mt-1.5 pl-6 flex flex-wrap gap-1">
                            {p.missing.slice(0, 8).map((mk: string, mi: number) => (
                              <code
                                key={mi}
                                className="text-[9px] font-mono px-1 py-0.5 rounded bg-rose-100/60 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400"
                              >
                                {mk}
                              </code>
                            ))}
                            {p.missing.length > 8 && (
                              <span className="text-[9px] text-muted-foreground">
                                {t("batch.moreCount", { n: p.missing.length - 8 })}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function AggStat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    emerald: "text-emerald-600 dark:text-emerald-400",
    rose: "text-rose-600 dark:text-rose-400",
    slate: "text-foreground",
  };
  return (
    <div className="text-center">
      <p className={`text-xl font-bold ${colorMap[color] || "text-foreground"}`}>
        {value}
      </p>
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
    </div>
  );
}
