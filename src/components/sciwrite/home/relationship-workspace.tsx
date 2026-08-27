"use client";

import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Network,
  Loader2,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";

export function RelationshipWorkspace({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  // First try to load saved analysis from DB
  const { data: savedRel } = useQuery({
    queryKey: ["saved-relationships", projectId],
    queryFn: () => api.getSavedRelationships(projectId),
    enabled: !!projectId,
    staleTime: Infinity,
  });
  const { data: freshRel, isLoading: loading, error: relError } = useQuery({
    queryKey: ["source-relationships", projectId],
    queryFn: async () => {
      const res = await fetch("/api/ai/source-relationships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text.slice(0, 200) || t("workspace.analysisFailedError", { status: res.status }));
      }
      const data = await res.json();
      qc.invalidateQueries({ queryKey: ["saved-relationships", projectId] });
      return data;
    },
    enabled: false, // Only on manual trigger
  });
  const relMut = useMutation({
    mutationFn: () =>
      fetch("/api/ai/source-relationships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text.slice(0, 200) || t("workspace.analysisFailedError", { status: res.status }));
        }
        return res.json();
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["saved-relationships", projectId] });
      toast.success(t("toast.relAnalysisComplete"));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const relData = freshRel || (savedRel && !savedRel.notFound ? savedRel : null);

  return (
    <ScrollArea className="flex-1 min-h-0 scroll-academic">
      <div className="px-5 py-4 max-w-2xl mx-auto">
        {relMut.isPending && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        )}
        {relError && !relMut.isPending && (
          <div className="text-center py-12">
            <Network className="h-10 w-10 mx-auto opacity-40 mb-3" />
            <p className="text-xs text-destructive mb-3">{(relError as Error).message}</p>
            <Button size="sm" className="gap-1.5 text-xs" onClick={() => relMut.mutate()}>
              <Network className="h-3.5 w-3.5" /> {t("workspace.retryBtn")}
            </Button>
          </div>
        )}
        {!relMut.isPending && !relError && !relData && (
          <div className="text-center py-12">
            <Network className="h-10 w-10 mx-auto opacity-40 mb-3" />
            <p className="text-xs font-medium text-muted-foreground mb-1">{t("workspace.noRelData")}</p>
            <p className="text-[10px] text-muted-foreground mb-4">{t("workspace.noRelDataHint")}</p>
            <Button size="sm" className="gap-1.5 text-xs" onClick={() => relMut.mutate()}>
              <Network className="h-3.5 w-3.5" /> {t("workspace.analyzeBtn")}
            </Button>
          </div>
        )}
        {!relMut.isPending && !relError && relData?.skipped && (
          <div className="text-center py-12">
            <Network className="h-10 w-10 mx-auto opacity-40 mb-3" />
            <p className="text-xs text-muted-foreground">{relData.message}</p>
          </div>
        )}
        {!relMut.isPending && !relError && relData && !relData.skipped && (
          <div className="space-y-3">
            {relData.summary && (
              <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
                <p className="text-[10px] uppercase tracking-wider text-primary font-semibold mb-1">{t("workspace.relSummaryLabel")}</p>
                <p className="text-xs leading-relaxed">{relData.summary}</p>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border border-border/50 p-2 text-center">
                <p className="text-lg font-bold">{relData.nodes?.length || 0}</p>
                <p className="text-[9px] uppercase text-muted-foreground">{t("workspace.sources")}</p>
              </div>
              <div className="rounded-md border border-border/50 p-2 text-center">
                <p className="text-lg font-bold">{relData.edges?.length || 0}</p>
                <p className="text-[9px] uppercase text-muted-foreground">{t("workspace.connections")}</p>
              </div>
              <div className="rounded-md border border-border/50 p-2 text-center">
                <p className="text-lg font-bold">{relData.themes?.length || 0}</p>
                <p className="text-[9px] uppercase text-muted-foreground">{t("workspace.themes")}</p>
              </div>
            </div>
            {relData.themes?.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{t("workspace.thematicClusters")}</p>
                {relData.themes.map((t: any, i: number) => (
                  <div key={i} className="rounded-md border border-border/50 p-2.5">
                    <span className="text-xs font-semibold">{t.name}</span>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{t.description}</p>
                  </div>
                ))}
              </div>
            )}
            {relData.keyInsights?.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-wider text-primary font-semibold">{t("workspace.keyInsights")}</p>
                {relData.keyInsights.map((insight: string, i: number) => (
                  <div key={i} className="flex items-start gap-1.5 text-[11px]">
                    <CheckCircle2 className="h-3 w-3 text-primary mt-0.5 shrink-0" />
                    <span>{insight}</span>
                  </div>
                ))}
              </div>
            )}
            {relData.contradictions?.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-wider text-rose-600 font-semibold">{t("workspace.contradictions")}</p>
                {relData.contradictions.map((c: any, i: number) => (
                  <div key={i} className="rounded-md border border-rose-200/50 bg-rose-50/30 p-2">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <AlertTriangle className="h-3 w-3 text-rose-600" />
                      <Badge variant="outline" className="text-[8px] h-3.5">{c.sourceLabels?.join(" vs ") || ""}</Badge>
                    </div>
                    <p className="text-[10px] text-muted-foreground">{c.description}</p>
                  </div>
                ))}
              </div>
            )}
            <Button size="sm" variant="outline" className="gap-1.5 text-xs w-full" onClick={() => relMut.mutate()}>
              <Network className="h-3.5 w-3.5" /> {t("workspace.reanalyzeBtn")}
            </Button>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
