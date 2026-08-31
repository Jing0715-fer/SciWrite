"use client";

import * as React from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Gavel, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { safeParseArr } from "@/lib/parse-utils";

// round-39: one auto-run attempt per article per page session. Module-level
// so switching tabs (which remounts this component) never retries a failed
// auto-run in a loop; a page reload grants exactly one fresh attempt.
const autoReviewAttempts = new Set<string>();

export function EmbeddedReviewWorkspace({ articleId, articleTitle, projectId }: { articleId?: string; articleTitle?: string; projectId: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  // Load saved review from DB on mount
  const { data: savedReview } = useQuery({
    queryKey: ["saved-review", articleId],
    queryFn: () => articleId ? api.getSavedReview(articleId) : Promise.resolve({ notFound: true }),
    enabled: !!articleId,
    staleTime: Infinity,
  });

  const reviewMut = useMutation({
    mutationFn: () => articleId ? api.aiReview({ mode: "review", articleId }) : Promise.reject(new Error("No article")),
    onSuccess: (data) => {
      // Prime the saved-review cache with the fresh result so the tab shows
      // it without a flash; the invalidate then reconciles with the DB row
      // (same content — runReview persisted it before responding).
      qc.setQueryData(["saved-review", articleId], data);
      qc.invalidateQueries({ queryKey: ["saved-review", articleId] });
      toast.success(t("toast.reviewCompleted"));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // round-39: auto-run a review once when the article has no saved review.
  // Previously the Review tab read only the Review table — which NOTHING
  // ever wrote (the generation pipelines never ran a peer review), so the
  // tab was empty after every run and every click. The pipelines now
  // auto-review at completion (round-39 backend); this covers articles
  // composed/generated BEFORE that fix, where no review exists yet.
  React.useEffect(() => {
    if (!articleId || autoReviewAttempts.has(articleId)) return;
    if (
      savedReview &&
      (savedReview as any).notFound &&
      !reviewMut.isPending &&
      !reviewMut.data
    ) {
      autoReviewAttempts.add(articleId);
      reviewMut.mutate();
    }
  }, [articleId, savedReview, reviewMut]);

  // Freshly-run review if available, else the persisted one from DB
  const displayData =
    reviewMut.data ||
    (savedReview && !(savedReview as any).notFound ? savedReview : null);

  return (
    <ScrollArea className="flex-1 min-h-0 scroll-academic">
      <div className="px-5 py-4">
        {!displayData && !reviewMut.isPending && !reviewMut.isError && (
          <div className="text-center py-12">
            <div className="h-14 w-14 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center mb-3">
              <Gavel className="h-7 w-7 text-primary" />
            </div>
            <h3 className="text-sm font-semibold">{t("workspace.peerReviewTitle")}</h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto mb-4">
              {t("workspace.peerReviewDesc")}
            </p>
            <Button size="sm" className="gap-1.5 text-xs" onClick={() => reviewMut.mutate()} disabled={!articleId}>
              <Gavel className="h-3.5 w-3.5" /> {t("workspace.runReviewBtn")}
            </Button>
          </div>
        )}
        {reviewMut.isPending && !displayData && (
          <div className="text-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary mx-auto mb-3" />
            <p className="text-xs text-muted-foreground">
              {t("workspace.reviewAutoRunning")}
            </p>
          </div>
        )}
        {reviewMut.isError && !displayData && !reviewMut.isPending && (
          <div className="text-center py-12">
            <div className="h-14 w-14 mx-auto rounded-2xl bg-destructive/10 flex items-center justify-center mb-3">
              <Gavel className="h-7 w-7 text-destructive" />
            </div>
            <p className="text-xs text-destructive mb-4 max-w-sm mx-auto">
              {(reviewMut.error as Error)?.message?.slice(0, 200)}
            </p>
            <Button size="sm" className="gap-1.5 text-xs" onClick={() => reviewMut.mutate()} disabled={!articleId}>
              <Gavel className="h-3.5 w-3.5" /> {t("workspace.retryBtn") || "Retry"}
            </Button>
          </div>
        )}
        {displayData && !reviewMut.isPending && (
          <div className="space-y-3">
            {displayData.verdict && (
              <div className={`rounded-lg border p-3 ${displayData.verdict === "accept" ? "border-emerald-200/60 dark:border-emerald-800/50 bg-emerald-50/50 dark:bg-emerald-950/20" : "border-amber-200/60 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20"}`}>
                <span className={`text-sm font-semibold ${displayData.verdict === "accept" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>
                  {displayData.verdict === "accept" ? t("workspace.acceptVerdict") : `⚠ ${displayData.verdict}`}
                </span>
              </div>
            )}
            {displayData.scores && (
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(displayData.scores).filter(([, val]: [string, any]) => val != null).map(([key, val]: [string, any]) => (
                  <div key={key} className="rounded-md border border-border/50 p-2 text-center">
                    <p className="text-sm font-bold">{val}/10</p>
                    <p className="text-[9px] uppercase text-muted-foreground">{key}</p>
                  </div>
                ))}
              </div>
            )}
            {displayData.review?.summary && (
              <div className="rounded-md border border-border/50 p-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">{t("workspace.relSummaryLabel")}</p>
                <p className="text-xs leading-relaxed">{displayData.review.summary}</p>
              </div>
            )}
            {displayData.review && (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-emerald-200/50 dark:border-emerald-800/50 bg-emerald-50/30 dark:bg-emerald-950/20 p-2">
                  <p className="text-[10px] uppercase font-semibold text-emerald-700 dark:text-emerald-300 mb-1">{t("workspace.strengths")}</p>
                  {safeParseArr(displayData.review.strengths).map((s: string, i: number) => <p key={i} className="text-[10px] mb-1">• {s}</p>)}
                </div>
                <div className="rounded-md border border-rose-200/50 dark:border-rose-800/50 bg-rose-50/30 dark:bg-rose-950/20 p-2">
                  <p className="text-[10px] uppercase font-semibold text-rose-700 dark:text-rose-300 mb-1">{t("workspace.weaknesses")}</p>
                  {safeParseArr(displayData.review.weaknesses).map((w: string, i: number) => <p key={i} className="text-[10px] mb-1">• {w}</p>)}
                </div>
              </div>
            )}
            <Button size="sm" variant="outline" className="gap-1.5 text-xs w-full" onClick={() => reviewMut.mutate()} disabled={reviewMut.isPending}>
              {reviewMut.isPending && !displayData && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("workspace.rerunReviewBtn")}
            </Button>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
