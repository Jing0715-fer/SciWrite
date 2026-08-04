"use client";

import * as React from "react";
import {
  BarChart3,
  FileText,
  BookOpen,
  Database as DatabaseIcon,
  Layers,
  MessageSquare,
  TrendingUp,
  Target,
  Loader2,
  Quote,
  Type,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { BatchValidationDialog } from "./batch-validation-dialog";
import { useI18n } from "@/lib/i18n";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { useQuery } from "@tanstack/react-query";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
}

const SOURCE_COLOR: Record<string, string> = {
  pubmed: "bg-emerald-500",
  uniprot: "bg-teal-500",
  rcsb: "bg-amber-500",
  ncbi: "bg-rose-500",
  blast: "bg-violet-500",
  web: "bg-sky-500",
  manual: "bg-slate-400",
};

const STATUS_COLOR: Record<string, string> = {
  draft: "bg-slate-400",
  annotated: "bg-amber-500",
  revising: "bg-sky-500",
  revised: "bg-emerald-500",
  finalized: "bg-teal-500",
};

export function InsightsDialog({ open, onOpenChange, projectId }: Props) {
  const { t } = useI18n();
  const [batchValidateOpen, setBatchValidateOpen] = React.useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["insights", projectId],
    queryFn: () => api.getInsights(projectId),
    enabled: open && !!projectId,
  });

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4 text-primary" />
            {t("insights.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("insights.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto scroll-academic">
            <div className="px-6 py-4">
              {isLoading && (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              )}
              {data && (
                <div className="space-y-5">
                {/* Stat cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                  <StatCard
                    icon={<FileText className="h-3.5 w-3.5" />}
                    label={t("insights.paragraphsLabel")}
                    value={data.stats.totalParagraphs}
                    color="emerald"
                  />
                  <StatCard
                    icon={<Type className="h-3.5 w-3.5" />}
                    label={t("insights.wordsLabel")}
                    value={data.stats.totalWords}
                    color="teal"
                  />
                  <StatCard
                    icon={<Quote className="h-3.5 w-3.5" />}
                    label={t("insights.citationsLabel")}
                    value={data.stats.totalCitations}
                    color="amber"
                  />
                  <StatCard
                    icon={<Layers className="h-3.5 w-3.5" />}
                    label={t("insights.articlesLabel")}
                    value={data.stats.totalArticles}
                    color="violet"
                  />
                </div>

                {/* Citation coverage */}
                <div className="rounded-lg border border-border/60 p-3.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold flex items-center gap-1.5">
                      <Target className="h-3.5 w-3.5 text-primary" />
                      {t("insights.citationCoverage")}
                    </span>
                    <span className="text-sm font-bold text-primary">
                      {data.stats.citationCoverage}%
                    </span>
                  </div>
                  <Progress
                    value={data.stats.citationCoverage}
                    className="h-2"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {data.stats.totalParagraphs - Math.round(
                      (data.stats.citationCoverage / 100) * data.stats.totalParagraphs
                    )}{" "}
                    {t("insights.paragraphs")} {data.stats.totalParagraphs} {t("insights.paragraphsLack")}
                  </p>
                </div>

                {/* Annotations status */}
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="rounded-lg border border-amber-200/60 dark:border-amber-900/40 bg-amber-50/40 dark:bg-amber-950/20 p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <MessageSquare className="h-3.5 w-3.5 text-amber-600" />
                      <span className="text-[10px] uppercase tracking-wide font-semibold text-amber-700 dark:text-amber-400">
                        {t("insights.unresolved")}
                      </span>
                    </div>
                    <p className="text-2xl font-bold text-amber-700 dark:text-amber-400">
                      {data.stats.annotations.unresolved}
                    </p>
                    <p className="text-[9px] text-muted-foreground">{t("insights.annotations")}</p>
                  </div>
                  <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-950/20 p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <MessageSquare className="h-3.5 w-3.5 text-emerald-600" />
                      <span className="text-[10px] uppercase tracking-wide font-semibold text-emerald-700 dark:text-emerald-400">
                        {t("insights.resolved")}
                      </span>
                    </div>
                    <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">
                      {data.stats.annotations.resolved}
                    </p>
                    <p className="text-[9px] text-muted-foreground">{t("insights.annotations")}</p>
                  </div>
                </div>

                {/* Distributions */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <DistributionChart
                    title={t("insights.paragraphStatus")}
                    data={data.distributions.status}
                    colorMap={STATUS_COLOR}
                  />
                  <DistributionChart
                    title={t("insights.paragraphFormat")}
                    data={data.distributions.format}
                    colorMap={{
                      background: "bg-slate-400",
                      intro: "bg-emerald-500",
                      methods: "bg-teal-500",
                      results: "bg-amber-500",
                      discussion: "bg-rose-500",
                      conclusion: "bg-violet-500",
                      abstract: "bg-sky-500",
                    }}
                  />
                  <DistributionChart
                    title={t("insights.dataSources")}
                    data={data.distributions.source}
                    colorMap={SOURCE_COLOR}
                  />
                  <DistributionChart
                    title={t("insights.referenceTypes")}
                    data={data.distributions.referenceType}
                    colorMap={SOURCE_COLOR}
                  />
                </div>

                {/* Avg words */}
                <div className="rounded-lg border border-border/60 p-3 flex items-center gap-3">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  <div className="flex-1">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t("insights.avgWords")}
                    </p>
                    <p className="text-sm font-semibold">
                      {data.stats.avgWordsPerParagraph} {t("insights.wordsUnit")}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t("insights.totalReferences")}
                    </p>
                    <p className="text-sm font-semibold">
                      {data.stats.totalReferences}
                    </p>
                  </div>
                </div>

                {/* Timeline */}
                {data.timeline.length > 0 && (
                  <div className="space-y-2">
                    <p className="divider-academic">
                      <span>{t("insights.writingTimeline")}</span>
                    </p>
                    <div className="space-y-1.5">
                      {data.timeline.map((item: any, i: number) => (
                        <div
                          key={item.id}
                          className="flex items-center gap-2 rounded-md border border-border/50 px-2.5 py-1.5"
                        >
                          <span className="text-[10px] font-mono text-muted-foreground w-6">
                            §{String(i + 1).padStart(2, "0")}
                          </span>
                          <span
                            className={`h-2 w-2 rounded-full ${
                              STATUS_COLOR[item.status] || "bg-slate-400"
                            }`}
                          />
                          <span className="text-[11px] font-medium truncate flex-1">
                            {item.title}
                          </span>
                          <span className="text-[9px] text-muted-foreground">
                            {item.wordCount}w · {item.citations}{t("insights.citSuffix")}
                          </span>
                          <span className="text-[9px] text-muted-foreground">
                            {new Date(item.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Articles */}
                {data.articles.length > 0 && (
                  <div className="space-y-2">
                    <p className="divider-academic">
                      <span>{t("insights.composedArticles")}</span>
                    </p>
                    <div className="space-y-1.5">
                      {data.articles.map((a: any) => (
                        <div
                          key={a.id}
                          className="flex items-center gap-2 rounded-md border border-border/50 px-2.5 py-1.5"
                        >
                          <Layers className="h-3 w-3 text-primary shrink-0" />
                          <span className="text-[11px] font-medium truncate flex-1">
                            {a.title}
                          </span>
                          <span className="text-[9px] text-muted-foreground">
                            {a.paragraphCount}¶
                          </span>
                          <span className="text-[9px] text-muted-foreground">
                            {new Date(a.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {/* Footer with batch citation audit */}
        <div className="px-6 py-3 border-t border-border/60 flex items-center justify-between gap-2 shrink-0">
          <span className="text-[10px] text-muted-foreground">
            {t("insights.auditDesc")}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => setBatchValidateOpen(true)}
          >
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            {t("insights.auditAll")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    <BatchValidationDialog
      open={batchValidateOpen}
      onOpenChange={setBatchValidateOpen}
      projectId={projectId}
    />
    </>
  );
}

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    emerald: "border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400",
    teal: "border-teal-200/60 dark:border-teal-900/40 bg-teal-50/40 dark:bg-teal-950/20 text-teal-700 dark:text-teal-400",
    amber: "border-amber-200/60 dark:border-amber-900/40 bg-amber-50/40 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400",
    violet: "border-violet-200/60 dark:border-violet-900/40 bg-violet-50/40 dark:bg-violet-950/20 text-violet-700 dark:text-violet-400",
  };
  return (
    <div className={`rounded-lg border p-2.5 ${colorMap[color]}`}>
      <div className="flex items-center gap-1 mb-1 opacity-80">{icon}</div>
      <p className="text-xl font-bold leading-none">{value}</p>
      <p className="text-[9px] uppercase tracking-wide mt-1 opacity-70">{label}</p>
    </div>
  );
}

function DistributionChart({
  title,
  data,
  colorMap,
}: {
  title: string;
  data: Record<string, number>;
  colorMap: Record<string, string>;
}) {
  const { t } = useI18n();
  const entries = Object.entries(data);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (entries.length === 0 || total === 0) {
    return (
      <div className="rounded-lg border border-border/60 p-3">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">
          {title}
        </p>
        <p className="text-[11px] text-muted-foreground italic">{t("insights.noData")}</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">
        {title}
      </p>
      {/* Stacked bar */}
      <div className="flex h-2 rounded-full overflow-hidden mb-2.5 bg-muted/40">
        {entries.map(([key, val]) => (
          <div
            key={key}
            className={colorMap[key] || "bg-slate-400"}
            style={{ width: `${(val / total) * 100}%` }}
            title={`${key}: ${val}`}
          />
        ))}
      </div>
      {/* Legend */}
      <div className="space-y-1">
        {entries.map(([key, val]) => (
          <div key={key} className="flex items-center gap-1.5 text-[10px]">
            <span
              className={`h-2 w-2 rounded-full ${colorMap[key] || "bg-slate-400"}`}
            />
            <span className="capitalize flex-1">{key}</span>
            <span className="font-mono text-muted-foreground">{val}</span>
            <span className="text-muted-foreground">
              ({Math.round((val / total) * 100)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
