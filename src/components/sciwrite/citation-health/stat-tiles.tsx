"use client";

// Quick-stat tiles for the citation-health dashboard header row.
// Extracted verbatim from citation-health-dashboard.tsx (round 6-c split).

import { FileText, BookOpen, CircleX, AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { HealthAggregate } from "./types";

export function StatTiles({ agg }: { agg: HealthAggregate }) {
  const { t } = useI18n();
  // One calm surface-card strip with hairline dividers — the same chip
  // language as the ProgressTracker stats (replaces 4 competing tiles).
  return (
    <div className="surface-card rounded-lg flex items-stretch divide-x divide-border/60 text-[10px]">
      <span className="flex items-center gap-1.5 px-2.5 py-1 transition-colors hover:bg-muted/50">
        <FileText className="h-3 w-3 text-primary shrink-0" />
        <span className="font-semibold tabular-nums text-foreground">{agg.totalCitations}</span>
        <span className="text-muted-foreground hidden sm:inline">{t("citationHealth.statCitations")}</span>
      </span>
      <span className="flex items-center gap-1.5 px-2.5 py-1 transition-colors hover:bg-muted/50">
        <BookOpen className="h-3 w-3 text-primary shrink-0" />
        <span className="font-semibold tabular-nums text-foreground">{agg.totalReferences}</span>
        <span className="text-muted-foreground hidden sm:inline">{t("citationHealth.statRefs")}</span>
      </span>
      {agg.totalBlocking > 0 ? (
        <span className="flex items-center gap-1.5 px-2.5 py-1 transition-colors hover:bg-rose-500/10">
          <CircleX className="h-3 w-3 text-red-600 dark:text-red-400 shrink-0" />
          <span className="font-semibold tabular-nums text-red-600 dark:text-red-400">{agg.totalBlocking}</span>
          <span className="text-muted-foreground hidden sm:inline">{t("citationHealth.statBlocking")}</span>
        </span>
      ) : (
        <span className="flex items-center gap-1.5 px-2.5 py-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
          <span className="font-semibold text-emerald-700 dark:text-emerald-400">
            {t("citationHealth.zeroBlocking")}
          </span>
        </span>
      )}
      {agg.totalWarnings > 0 && (
        <span className="flex items-center gap-1.5 px-2.5 py-1 transition-colors hover:bg-amber-500/10">
          <AlertTriangle className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="font-semibold tabular-nums text-amber-700 dark:text-amber-400">{agg.totalWarnings}</span>
          <span className="text-muted-foreground hidden sm:inline">{t("citationHealth.statWarnings")}</span>
        </span>
      )}
    </div>
  );
}
