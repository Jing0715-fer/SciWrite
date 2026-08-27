"use client";

// Article-level audit list for the citation-health dashboard's expanded
// detail section. Extracted verbatim from citation-health-dashboard.tsx
// (round 6-c split).

import { Sparkles, BookOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { ArticleHealthReport } from "./types";

export function ArticleAuditList({ articles }: { articles: ArticleHealthReport[] }) {
  const { t } = useI18n();
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1 font-serif-text glass-subtle rounded-md px-2 py-1">
        <Sparkles className="h-3 w-3 text-primary" />
        {t("citationHealth.articleAudits")}
      </p>
      {articles.length === 0 ? (
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
          {articles.map((a) => (
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
  );
}
