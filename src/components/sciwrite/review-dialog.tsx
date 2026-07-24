"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Gavel,
  Loader2,
  Star,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Wand2,
  RotateCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  articleId: string | null;
  articleTitle?: string;
}

const VERDICT_STYLES: Record<string, { label: string; color: string; icon: string }> = {
  accept: { label: "review.accept", color: "emerald", icon: "CheckCircle2" },
  "minor-revision": { label: "review.minorRevision", color: "amber", icon: "AlertTriangle" },
  "major-revision": { label: "review.majorRevision", color: "rose", icon: "XCircle" },
  reject: { label: "review.reject", color: "rose", icon: "XCircle" },
};

const SCORE_KEYS = [
  "novelty",
  "significance",
  "clarity",
  "methodology",
  "citations",
  "overall",
] as const;

export function ReviewDialog({ open, onOpenChange, articleId, articleTitle }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [reviewData, setReviewData] = React.useState<any>(null);
  const [autoRounds, setAutoRounds] = React.useState(2);
  const [iterationLog, setIterationLog] = React.useState<any[]>([]);

  React.useEffect(() => {
    if (open) {
      setReviewData(null);
      setIterationLog([]);
    }
  }, [open]);

  const reviewMut = useMutation({
    mutationFn: () => api.aiReview({ mode: "review", articleId: articleId! }),
    onSuccess: (data) => {
      setReviewData(data);
      toast.success(t("toast.reviewCompleted"));
      qc.invalidateQueries({ queryKey: ["articles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reviseMut = useMutation({
    mutationFn: () =>
      api.aiReview({ mode: "revise", articleId: articleId!, reviewId: reviewData.review.id }),
    onSuccess: (data) => {
      toast.success(t("toast.articleRevised"));
      qc.invalidateQueries({ queryKey: ["articles"] });
      qc.invalidateQueries({ queryKey: ["project"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const autoIterateMut = useMutation({
    mutationFn: () =>
      api.aiReview({ mode: "auto-iterate", articleId: articleId!, rounds: autoRounds }),
    onSuccess: (data) => {
      setIterationLog(data.results || []);
      setReviewData(data.results?.[0] || null);
      toast.success(t("toast.autoIterateComplete", { n: data.rounds }));
      qc.invalidateQueries({ queryKey: ["articles"] });
      qc.invalidateQueries({ queryKey: ["project"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const verdict = reviewData?.verdict;
  const verdictMeta = verdict ? VERDICT_STYLES[verdict] : null;
  const scores = reviewData?.scores || reviewData?.review || {};

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Gavel className="h-4 w-4 text-primary" />
            {t("review.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {articleTitle || t("review.desc")}
            <span className="ml-1 text-muted-foreground/70">
              {t("review.inspired")}
            </span>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-6 py-4 min-h-[300px]">
            {/* Controls */}
            <div className="flex items-center gap-2 mb-4 flex-wrap">
              <Button
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => reviewMut.mutate()}
                disabled={reviewMut.isPending || !articleId}
              >
                {reviewMut.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Gavel className="h-3.5 w-3.5" />
                )}
                {t("review.runReview")}
              </Button>

              <div className="flex items-center gap-1.5">
                <Select value={String(autoRounds)} onValueChange={(v) => setAutoRounds(Number(v))}>
                  <SelectTrigger className="h-7 w-16 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <SelectItem key={n} value={String(n)} className="text-xs">
                        {n} {t("review.round")}{n > 1 ? t("review.rounds") : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs"
                  onClick={() => autoIterateMut.mutate()}
                  disabled={autoIterateMut.isPending || !articleId}
                >
                  {autoIterateMut.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCw className="h-3.5 w-3.5" />
                  )}
                  {t("review.autoIterate")}
                </Button>
              </div>
            </div>

            {/* Loading skeleton */}
            {(reviewMut.isPending || autoIterateMut.isPending) && !reviewData && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span>{autoIterateMut.isPending ? t("review.iterating") : t("review.reviewing")}</span>
                </div>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />
                ))}
              </div>
            )}

            {/* Review results */}
            {reviewData && (
              <div className="space-y-4">
                {/* Verdict banner */}
                {verdictMeta && (
                  <div
                    className={`rounded-lg border p-3 ${
                      verdict === "accept"
                        ? "border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/50 dark:bg-emerald-950/20"
                        : verdict === "minor-revision"
                        ? "border-amber-200/60 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-950/20"
                        : "border-rose-200/60 dark:border-rose-900/40 bg-rose-50/50 dark:bg-rose-950/20"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {verdict === "accept" ? (
                        <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                      ) : verdict === "reject" ? (
                        <XCircle className="h-5 w-5 text-rose-600" />
                      ) : (
                        <AlertTriangle className="h-5 w-5 text-amber-600" />
                      )}
                      <span
                        className={`text-sm font-semibold ${
                          verdict === "accept"
                            ? "text-emerald-700 dark:text-emerald-400"
                            : verdict === "reject"
                            ? "text-rose-700 dark:text-rose-400"
                            : "text-amber-700 dark:text-amber-400"
                        }`}
                      >
                        {t("review.verdict")}: {verdictMeta ? t(verdictMeta.label as any) : verdict}
                      </span>
                      {reviewData.review?.round && (
                          <Badge variant="outline" className="text-[9px] h-4 ml-auto">
                          {t("review.round")} {reviewData.review.round}
                        </Badge>
                      )}
                    </div>
                  </div>
                )}

                {/* Scores */}
                {scores && (
                  <div className="space-y-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
                      <Star className="h-3 w-3" /> {t("review.dimensionScores")}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {SCORE_KEYS.map((key) => {
                        const label = t(`review.${key}` as any);
                        const val = scores[key];
                        if (val === undefined || val === null) return null;
                        const pct = (val / 10) * 100;
                        const color =
                          val >= 8
                            ? "text-emerald-600"
                            : val >= 6
                            ? "text-amber-600"
                            : "text-rose-600";
                        return (
                          <div key={key} className="rounded-md border border-border/50 p-2">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[10px] text-muted-foreground">{label}</span>
                              <span className={`text-sm font-bold ${color}`}>{val}/10</span>
                            </div>
                            <Progress value={pct} className={`h-1.5 ${val >= 8 ? "[&>div]:bg-emerald-500" : val >= 6 ? "[&>div]:bg-amber-500" : "[&>div]:bg-rose-500"}`} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Summary */}
                {reviewData.review?.summary && (
                  <div className="rounded-md border border-border/50 p-2.5">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                      {t("review.summary")}
                    </p>
                    <p className="text-xs leading-relaxed">{reviewData.review.summary}</p>
                  </div>
                )}

                {/* Strengths & Weaknesses */}
                {reviewData.review && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <ReviewList
                      title={t("review.strengths")}
                      items={safeParse(reviewData.review.strengths)}
                      icon={<TrendingUp className="h-3 w-3" />}
                      color="emerald"
                    />
                    <ReviewList
                      title={t("review.weaknesses")}
                      items={safeParse(reviewData.review.weaknesses)}
                      icon={<TrendingDown className="h-3 w-3" />}
                      color="rose"
                    />
                  </div>
                )}

                {/* Suggestions */}
                {reviewData.review && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] uppercase tracking-wider text-primary font-semibold flex items-center gap-1">
                      <Wand2 className="h-3 w-3" /> {t("review.revisionSuggestions")}
                    </p>
                    {safeParse(reviewData.review.suggestions).map((s: any, i: number) => (
                      <div
                        key={i}
                        className="rounded-md border border-primary/20 bg-primary/[0.03] p-2"
                      >
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <Badge variant="outline" className="text-[8px] h-3.5 uppercase">
                            {s.section || t("review.general")}
                          </Badge>
                        </div>
                        <p className="text-[11px] text-rose-600 dark:text-rose-400 mb-0.5">
                          <span className="font-semibold">{t("review.issue")}:</span> {s.issue}
                        </p>
                        <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                          <span className="font-semibold">{t("review.fix")}:</span> {s.fix}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Iteration log */}
                {iterationLog.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                      {t("review.iterationLog")}
                    </p>
                    {iterationLog.map((r, i) => (
                      <div key={i} className="flex items-center gap-2 text-[10px] rounded-md bg-muted/30 px-2 py-1">
                        <span className="font-mono text-muted-foreground">R{r.round}</span>
                        <Badge variant="outline" className="text-[8px] h-3.5 uppercase">
                          {r.phase}
                        </Badge>
                        {r.phase === "review" && r.verdict && (
                          <span className="text-muted-foreground">{t(`review.${r.verdict}` as any)}</span>
                        )}
                        {r.phase === "revise" && (
                          <span className="text-emerald-600">{t("review.revised")} ✓</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!reviewData && !reviewMut.isPending && !autoIterateMut.isPending && (
              <div className="text-center py-12">
                <div className="h-14 w-14 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center mb-3">
                  <Gavel className="h-7 w-7 text-primary" />
                </div>
                <h3 className="text-sm font-semibold">{t("review.title")}</h3>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                  {t("review.emptyDesc")}
                </p>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        {reviewData && verdict !== "accept" && (
          <div className="px-6 py-3 border-t border-border/60 flex items-center justify-between gap-2 shrink-0 bg-card">
            <span className="text-[10px] text-muted-foreground">
              {t("review.reviseDesc")}
            </span>
            <Button
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => reviseMut.mutate()}
              disabled={reviseMut.isPending}
            >
              {reviseMut.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wand2 className="h-3.5 w-3.5" />
              )}
              {t("review.reviseArticle")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReviewList({
  title,
  items,
  icon,
  color,
}: {
  title: string;
  items: string[];
  icon: React.ReactNode;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    emerald: "border-emerald-200/50 dark:border-emerald-900/30 bg-emerald-50/30 dark:bg-emerald-950/10 text-emerald-700 dark:text-emerald-400",
    rose: "border-rose-200/50 dark:border-rose-900/30 bg-rose-50/30 dark:bg-rose-950/10 text-rose-700 dark:text-rose-400",
  };
  return (
    <div className={`rounded-md border p-2 ${colorMap[color] || "border-border/50"}`}>
      <p className="text-[10px] uppercase tracking-wider font-semibold flex items-center gap-1 mb-1">
        {icon} {title}
      </p>
      <ul className="space-y-1">
        {items.slice(0, 4).map((item, i) => (
          <li key={i} className="text-[10px] leading-relaxed flex items-start gap-1">
            <span className="mt-0.5 shrink-0">•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function safeParse(raw: string): any[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
