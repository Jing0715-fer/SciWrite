"use client";

// "Worst offenders" paragraph list for the citation-health dashboard's
// expanded detail section. Extracted verbatim from
// citation-health-dashboard.tsx (round 6-c split); prop names intentionally
// match the original closure variables to keep the JSX byte-identical.

import { TrendingUp, CheckCircle2, Loader2, Wand2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { ParagraphHealthReport } from "./types";

export function WorstOffendersList({
  offenders,
  fixing,
  fixingParagraphId,
  regeneratingParagraphId,
  onJumpParagraph,
  fixSingleParagraph,
  regenerateParagraph,
}: {
  offenders: ParagraphHealthReport[];
  fixing: boolean;
  fixingParagraphId: string | null;
  regeneratingParagraphId: string | null;
  onJumpParagraph?: (paragraphId: string) => void;
  fixSingleParagraph: (paragraphId: string) => void;
  regenerateParagraph: (paragraphId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1 font-serif-text glass-subtle rounded-md px-2 py-1">
        <TrendingUp className="h-3 w-3 text-primary" />
        {t("citationHealth.worstOffenders")}
      </p>
      {offenders.length === 0 ? (
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
          {offenders.map((p) => {
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
  );
}
