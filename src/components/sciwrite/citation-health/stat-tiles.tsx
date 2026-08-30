"use client";

// Quick-stat tiles for the citation-health dashboard header row.
// Extracted verbatim from citation-health-dashboard.tsx (round 6-c split).

import { FileText, BookOpen, CircleX, AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { HealthAggregate } from "./types";

export function StatTiles({ agg }: { agg: HealthAggregate }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="surface-card rounded-md px-2 py-0.5 flex items-center gap-1 transition-all hover:shadow-md hover:border-primary/30">
        <FileText className="h-3 w-3 text-primary" />
        <span className="font-serif-text font-semibold tabular-nums text-foreground">{agg.totalCitations}</span>
        <span className="text-muted-foreground">{t("citationHealth.statCitations")}</span>
      </span>
      <span className="surface-card rounded-md px-2 py-0.5 flex items-center gap-1 transition-all hover:shadow-md hover:border-primary/30">
        <BookOpen className="h-3 w-3 text-primary" />
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
  );
}
