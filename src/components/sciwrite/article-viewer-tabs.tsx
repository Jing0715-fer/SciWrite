"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  FileText,
  Layers,
  Gavel,
  Network,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { ExportMenu } from "./export-menu";
import { ReviewDialog } from "./review-dialog";
import { MarkdownCitations } from "./markdown-citations";
import { api } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cleanArticleContent } from "@/lib/writing";

interface Props {
  article: { id: string; title: string; abstract?: string | null; content: string };
  projectId: string;
  onClose: () => void;
}

export function ArticleViewerWithTabs({ article, projectId, onClose }: Props) {
  const { t } = useI18n();
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const qc = useQueryClient();

  // Fetch paragraphs for the Sections tab
  const paragraphsQ = useQuery({
    queryKey: ["article-paragraphs", article.id],
    queryFn: () => api.getProject(projectId),
    enabled: !!article.id,
  });

  const paragraphs = (paragraphsQ.data?.project?.paragraphs || []).filter(
    (p: any) => p.articleParagraph?.some((ap: any) => ap.articleId === article.id) ||
    true // show all if we can't filter
  );

  // Fetch source relationships
  const relQ = useQuery({
    queryKey: ["source-relationships", projectId],
    queryFn: () =>
      fetch(`/api/ai/source-relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      }).then((r) => r.json()),
    enabled: !!projectId,
  });

  // Fetch data sources for relationships view
  const dataSources = paragraphsQ.data?.project?.dataSources || [];

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="text-base font-serif-text">
            {article.title}
          </DialogTitle>
          {article.abstract && (
            <DialogDescription className="text-xs italic mt-1">
              {article.abstract}
            </DialogDescription>
          )}
        </DialogHeader>

        <Tabs defaultValue="composed" className="flex-1 min-h-0 flex flex-col">
          <div className="px-6 py-2 border-b border-border/60 shrink-0 flex items-center justify-between">
            <TabsList className="h-8">
              <TabsTrigger value="sections" className="text-xs gap-1">
                <FileText className="h-3 w-3" />
                {t("articleViewer.sections")}
              </TabsTrigger>
              <TabsTrigger value="composed" className="text-xs gap-1">
                <Layers className="h-3 w-3" />
                {t("articleViewer.composed")}
              </TabsTrigger>
              <TabsTrigger value="review" className="text-xs gap-1">
                <Gavel className="h-3 w-3" />
                {t("articleViewer.review")}
              </TabsTrigger>
              <TabsTrigger value="relationships" className="text-xs gap-1">
                <Network className="h-3 w-3" />
                {t("articleViewer.relationships")}
              </TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => setReviewOpen(true)}
              >
                <Gavel className="h-3.5 w-3.5" />
                {t("articleViewer.aiReview")}
              </Button>
              <ExportMenu type="article" id={article.id} variant="outline" />
            </div>
          </div>

          {/* Sections tab - individual paragraphs */}
          <TabsContent value="sections" className="flex-1 mt-0 min-h-0">
            <ScrollArea className="h-full scroll-academic">
              <div className="px-8 py-5 max-w-3xl mx-auto space-y-4">
                {paragraphs.map((p: any, i: number) => (
                  <div key={p.id} className="rounded-lg border border-border/60 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[10px] font-mono text-muted-foreground">
                        §{String(i + 1).padStart(2, "0")}
                      </span>
                      <Badge variant="outline" className="text-[8px] h-3.5 uppercase">
                        {p.format}
                      </Badge>
                      <span className="text-[9px] text-muted-foreground">
                        {p.wordCount}w
                      </span>
                    </div>
                    <h3 className="text-sm font-semibold mb-2">{p.title}</h3>
                    <MarkdownCitations
                      content={p.content}
                      references={p.references || []}
                      className="text-[13px]"
                    />
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Composed tab - full article */}
          <TabsContent value="composed" className="flex-1 mt-0 min-h-0">
            <ScrollArea className="h-full scroll-academic">
              <div className="px-8 py-5 max-w-3xl mx-auto">
                <MarkdownCitations content={cleanArticleContent(article.content)} className="text-[13.5px]" />
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Review tab - embedded review */}
          <TabsContent value="review" className="flex-1 mt-0 min-h-0">
            <EmbeddedReview articleId={article.id} articleTitle={article.title} />
          </TabsContent>

          {/* Relationships tab - source relationship network */}
          <TabsContent value="relationships" className="flex-1 mt-0 min-h-0">
            <RelationshipView
              data={relQ.data}
              isLoading={relQ.isLoading}
              dataSources={dataSources}
              noDataMessage={t("articleViewer.noRelData")}
              sectionsLabel={t("articleViewer.sources")}
              connectionsLabel={t("articleViewer.connections")}
              themesLabel={t("articleViewer.themes")}
              thematicClustersLabel={t("articleViewer.thematicClusters")}
              summaryLabel={t("articleViewer.relSummary")}
              keyInsightsLabel={t("articleViewer.keyInsights")}
              contradictionsLabel={t("articleViewer.contradictions")}
              sourceConnectionsLabel={t("articleViewer.sourceConnections")}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>

      {reviewOpen && (
        <ReviewDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          articleId={article.id}
          articleTitle={article.title}
        />
      )}
    </Dialog>
  );
}

function EmbeddedReview({ articleId, articleTitle }: { articleId: string; articleTitle: string }) {
  const { t } = useI18n();
  const [reviewData, setReviewData] = React.useState<any>(null);

  const reviewMut = useMutation({
    mutationFn: () => api.aiReview({ mode: "review", articleId }),
    onSuccess: (data) => {
      setReviewData(data);
      toast.success(t("toast.reviewCompleted"));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <ScrollArea className="h-full scroll-academic">
      <div className="px-8 py-5 max-w-2xl mx-auto">
        {!reviewData && !reviewMut.isPending && (
          <div className="text-center py-12">
            <div className="h-14 w-14 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center mb-3">
              <Gavel className="h-7 w-7 text-primary" />
            </div>
            <h3 className="text-sm font-semibold">{t("articleViewer.aiPeerReview")}</h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto mb-4">
              {t("articleViewer.reviewDesc")}
            </p>
            <Button size="sm" className="gap-1.5 text-xs" onClick={() => reviewMut.mutate()}>
              <Gavel className="h-3.5 w-3.5" />
              {t("articleViewer.runReview")}
            </Button>
          </div>
        )}

        {reviewMut.isPending && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        )}

        {reviewData && (
          <div className="space-y-4">
            {/* Verdict */}
            {reviewData.verdict && (
              <div className={`rounded-lg border p-3 ${
                reviewData.verdict === "accept"
                  ? "border-emerald-200/60 bg-emerald-50/50"
                  : "border-amber-200/60 bg-amber-50/50"
              }`}>
                <span className={`text-sm font-semibold ${
                  reviewData.verdict === "accept" ? "text-emerald-700" : "text-amber-700"
                }`}>
                  {reviewData.verdict === "accept" ? t("articleViewer.acceptVerdict") : `⚠ ${reviewData.verdict}`}
                </span>
              </div>
            )}

            {/* Scores */}
            {reviewData.scores && (
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(reviewData.scores).map(([key, val]: [string, any]) => (
                  <div key={key} className="rounded-md border border-border/50 p-2 text-center">
                    <p className="text-sm font-bold">{val}/10</p>
                    <p className="text-[9px] uppercase text-muted-foreground">{key}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Summary */}
            {reviewData.review?.summary && (
              <div className="rounded-md border border-border/50 p-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">{t("articleViewer.summary")}</p>
                <p className="text-xs leading-relaxed">{reviewData.review.summary}</p>
              </div>
            )}

            {/* Strengths & Weaknesses */}
            {reviewData.review && (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-emerald-200/50 bg-emerald-50/30 p-2">
                  <p className="text-[10px] uppercase font-semibold text-emerald-700 mb-1">{t("articleViewer.strengths")}</p>
                  {safeParse(reviewData.review.strengths).map((s: string, i: number) => (
                    <p key={i} className="text-[10px] mb-1">• {s}</p>
                  ))}
                </div>
                <div className="rounded-md border border-rose-200/50 bg-rose-50/30 p-2">
                  <p className="text-[10px] uppercase font-semibold text-rose-700 mb-1">{t("articleViewer.weaknesses")}</p>
                  {safeParse(reviewData.review.weaknesses).map((w: string, i: number) => (
                    <p key={i} className="text-[10px] mb-1">• {w}</p>
                  ))}
                </div>
              </div>
            )}

            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-xs w-full"
              onClick={() => reviewMut.mutate()}
              disabled={reviewMut.isPending}
            >
              <Loader2 className={reviewMut.isPending ? "h-3.5 w-3.5 animate-spin" : "hidden"} />
              {t("articleViewer.rerunReview")}
            </Button>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function RelationshipView({
  data,
  isLoading,
  dataSources,
  noDataMessage,
  sectionsLabel,
  connectionsLabel,
  themesLabel,
  thematicClustersLabel,
  summaryLabel,
  keyInsightsLabel,
  contradictionsLabel,
  sourceConnectionsLabel,
}: {
  data: any;
  isLoading: boolean;
  dataSources: any[];
  noDataMessage: string;
  sectionsLabel: string;
  connectionsLabel: string;
  themesLabel: string;
  thematicClustersLabel: string;
  summaryLabel: string;
  keyInsightsLabel: string;
  contradictionsLabel: string;
  sourceConnectionsLabel: string;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full py-12">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!data || data.error) {
    return (
      <div className="text-center py-12">
        <Network className="h-10 w-10 mx-auto opacity-40 mb-3" />
        <p className="text-xs text-muted-foreground">
          {data?.error || noDataMessage}
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full scroll-academic">
      <div className="px-8 py-5 max-w-2xl mx-auto space-y-4">
        {/* Summary */}
        {data.summary && (
          <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
            <p className="text-[10px] uppercase tracking-wider text-primary font-semibold mb-1">
              {summaryLabel}
            </p>
            <p className="text-xs leading-relaxed">{data.summary}</p>
          </div>
        )}

        {/* Nodes count */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md border border-border/50 p-2 text-center">
            <p className="text-lg font-bold">{data.nodes?.length || dataSources.length}</p>
            <p className="text-[9px] uppercase text-muted-foreground">{sectionsLabel}</p>
          </div>
          <div className="rounded-md border border-border/50 p-2 text-center">
            <p className="text-lg font-bold">{data.edges?.length || 0}</p>
            <p className="text-[9px] uppercase text-muted-foreground">{connectionsLabel}</p>
          </div>
          <div className="rounded-md border border-border/50 p-2 text-center">
            <p className="text-lg font-bold">{data.themes?.length || 0}</p>
            <p className="text-[9px] uppercase text-muted-foreground">{themesLabel}</p>
          </div>
        </div>

        {/* Themes */}
        {data.themes?.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              {thematicClustersLabel}
            </p>
            {data.themes.map((t: any, i: number) => (
              <div key={i} className="rounded-md border border-border/50 p-2.5">
                <div className="flex items-center gap-1.5 mb-1">
                  <Badge variant="outline" className="text-[8px] h-3.5">
                    {t.sourceLabels?.join(", ") || t.sourceIds?.length || "?"}
                  </Badge>
                  <span className="text-xs font-semibold">{t.name}</span>
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {t.description}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Key insights */}
        {data.keyInsights?.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-primary font-semibold">
              {keyInsightsLabel}
            </p>
            {data.keyInsights.map((insight: string, i: number) => (
              <div key={i} className="flex items-start gap-1.5 text-[11px]">
                <CheckCircle2 className="h-3 w-3 text-primary mt-0.5 shrink-0" />
                <span>{insight}</span>
              </div>
            ))}
          </div>
        )}

        {/* Contradictions */}
        {data.contradictions?.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-rose-600 font-semibold">
              {contradictionsLabel}
            </p>
            {data.contradictions.map((c: any, i: number) => (
              <div key={i} className="rounded-md border border-rose-200/50 bg-rose-50/30 p-2">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <AlertTriangle className="h-3 w-3 text-rose-600" />
                  <Badge variant="outline" className="text-[8px] h-3.5">
                    {c.sourceLabels?.join(" vs ") || c.sourceIds?.join(" vs ")}
                  </Badge>
                </div>
                <p className="text-[10px] text-muted-foreground">{c.description}</p>
              </div>
            ))}
          </div>
        )}

        {/* Edges */}
        {data.edges?.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              {sourceConnectionsLabel.replace("{n}", String(data.edges.length))}
            </p>
            {data.edges.slice(0, 20).map((e: any, i: number) => (
              <div key={i} className="flex items-center gap-2 text-[10px] rounded-md bg-muted/20 px-2 py-1">
                <span className="font-mono text-muted-foreground">{e.from}</span>
                <span className="text-primary">→</span>
                <span className="font-mono text-muted-foreground">{e.to}</span>
                <Badge variant="outline" className="text-[7px] h-3 uppercase">
                  {e.type}
                </Badge>
                <span className="text-muted-foreground truncate flex-1">{e.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
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
