"use client";

import * as React from "react";
import { toast } from "sonner";
import { Sparkles, Loader2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
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

/**
 * AI Summary Dialog
 *
 * Generates an AI-powered summary of the article:
 *  - Overall TL;DR (2-3 sentences)
 *  - Per-section one-sentence summaries
 *
 * The summary is generated on-demand when the dialog opens. The user can
 * re-run it with the "Regenerate" button.
 */
export function SummaryDialog({ open, onOpenChange, articleId }: Props) {
  const { t } = useI18n();

  const summarizeMut = useMutation({
    mutationFn: () => api.summarizeArticle(articleId),
    onError: (e: any) => toast.error(e?.message || "Summarization failed"),
  });

  // Auto-run when dialog opens
  React.useEffect(() => {
    if (open && !summarizeMut.data && !summarizeMut.isPending) {
      summarizeMut.mutate();
    }
  }, [open]);

  const data = summarizeMut.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-primary" />
            {t("summary.title") || "AI Summary"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("summary.desc") || "Auto-generated TL;DR and per-section summaries using AI."}
          </DialogDescription>
        </DialogHeader>

        {/* Regenerate button */}
        <div className="px-5 py-2 border-b border-border/40 shrink-0 flex items-center justify-end bg-muted/10">
          <Button
            variant="ghost"
            size="sm"
            className="text-[10px] h-6 gap-1"
            onClick={() => summarizeMut.mutate()}
            disabled={summarizeMut.isPending}
          >
            {summarizeMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {t("summary.regenerate") || "Regenerate"}
          </Button>
        </div>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-5 py-3 space-y-3">
            {summarizeMut.isPending && !data && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            )}

            {data && (
              <>
                {/* Overall TL;DR */}
                {data.overall && (
                  <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
                    <p className="text-[10px] uppercase tracking-wider text-primary font-semibold mb-1.5">
                      TL;DR
                    </p>
                    <p className="text-xs leading-relaxed text-foreground">{data.overall}</p>
                  </div>
                )}

                {/* Per-section summaries */}
                {data.sections?.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                      {t("summary.sectionSummaries") || "Section Summaries"}
                    </p>
                    {data.sections.map((s, i) => (
                      <div key={i} className="rounded-md border border-border/50 bg-muted/20 p-2.5">
                        <div className="flex items-start gap-2">
                          <Badge variant="outline" className="text-[8px] h-3.5 shrink-0 mt-0.5">
                            §{i + 1}
                          </Badge>
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] font-medium text-foreground truncate mb-0.5">
                              {s.title || `Section ${i + 1}`}
                            </p>
                            <p className="text-[10px] text-muted-foreground leading-relaxed">
                              {s.summary}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {!data.overall && (!data.sections || data.sections.length === 0) && (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <FileText className="h-8 w-8 text-muted-foreground/40 mb-2" />
                    <p className="text-xs text-muted-foreground">
                      {t("summary.empty") || "No summary could be generated for this article."}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>

        <div className="px-5 py-3 border-t border-border/60 shrink-0 flex items-center justify-between">
          <span className="text-[9px] text-muted-foreground italic">
            {t("summary.disclaimer") || "AI-generated — verify accuracy before citing."}
          </span>
          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => onOpenChange(false)}>
            {t("common.close") || "Close"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
