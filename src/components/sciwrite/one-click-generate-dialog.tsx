"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Zap,
  Loader2,
  CheckCircle2,
  Database,
  ListTree,
  PenLine,
  FileStack,
  AlertCircle,
  Network,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { JOURNAL_TEMPLATES } from "@/lib/journal-templates";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  topic: string;
}

const STEPS = [
  { id: "gather", labelKey: "oneClick.stepGather" as const, icon: Database },
  { id: "relationships", labelKey: "oneClick.stepRelationships" as const, icon: Network },
  { id: "plan", labelKey: "oneClick.stepPlan" as const, icon: ListTree },
  { id: "generate", labelKey: "oneClick.stepGenerate" as const, icon: PenLine },
  { id: "compose", labelKey: "oneClick.stepCompose" as const, icon: FileStack },
];

export function OneClickGenerateDialog({ open, onOpenChange, projectId, topic }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [journalTemplate, setJournalTemplate] = React.useState("generic");
  const [language, setLanguage] = React.useState("English");
  const [targetWords, setTargetWords] = React.useState(3000);
  const [result, setResult] = React.useState<any>(null);
  const [currentStep, setCurrentStep] = React.useState(-1);

  React.useEffect(() => {
    if (open) {
      setResult(null);
      setCurrentStep(-1);
    }
  }, [open]);

  const [streamLog, setStreamLog] = React.useState<any[]>([]);

  const generateMut = useMutation({
    mutationFn: async () => {
      setCurrentStep(0);
      setStreamLog([]);
      const data = await api.aiGenerateFullStream(
        { projectId, journalTemplate, language, targetWords },
        (event, data) => {
          // Map SSE events to step indices
          const stepMap: Record<string, number> = {
            gather: 0,
            relationships: 1,
            plan: 2,
            generate: 3,
            compose: 4,
          };
          if (stepMap[event] !== undefined && data.status === "started") {
            setCurrentStep(stepMap[event]);
          }
          if (data.message) {
            setStreamLog((prev) => [...prev, { event, ...data }]);
          }
        }
      );
      setCurrentStep(STEPS.length);
      return data;
    },
    onSuccess: (data) => {
      setResult(data);
      toast.success(
        t("toast.oneClickGenerated", {
          words: data.stats?.articleWordCount || 0,
          refs: data.stats?.referencesSaved || 0,
        })
      );
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => {
      toast.error(e.message);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4 text-primary" />
            {t("oneClick.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("oneClick.desc")}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-6 py-4 space-y-4">
            {/* Configuration */}
            {!generateMut.isPending && !result && (
              <div className="space-y-3">
                <div className="rounded-lg bg-primary/[0.04] border border-primary/20 p-3">
                  <p className="text-[11px] text-muted-foreground mb-0.5">{t("oneClick.researchTopic")}</p>
                  <p className="text-sm font-medium">{topic}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("oneClick.journalTemplate")}</Label>
                    <Select value={journalTemplate} onValueChange={setJournalTemplate}>
                      <SelectTrigger className="text-xs h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {JOURNAL_TEMPLATES.map((jt) => (
                          <SelectItem key={jt.id} value={jt.id} className="text-xs">{jt.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("oneClick.outputLanguage")}</Label>
                    <Select value={language} onValueChange={setLanguage}>
                      <SelectTrigger className="text-xs h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="English" className="text-xs">{t("topic.langEnglish")}</SelectItem>
                        <SelectItem value="中文" className="text-xs">{t("topic.langChinese")}</SelectItem>
                        <SelectItem value="both" className="text-xs">{t("topic.langBoth")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("oneClick.targetWordCount", { n: targetWords })}</Label>
                  <input
                    type="range"
                    min={1500}
                    max={10000}
                    step={500}
                    value={targetWords}
                    onChange={(e) => setTargetWords(Number(e.target.value))}
                    className="w-full h-2"
                  />
                  <div className="flex justify-between text-[9px] text-muted-foreground">
                    <span>1,500</span>
                    <span>10,000</span>
                  </div>
                </div>

                <div className="rounded-lg border border-amber-200/60 dark:border-amber-900/40 bg-amber-50/40 dark:bg-amber-950/20 p-3">
                  <p className="text-[10px] text-amber-700 dark:text-amber-400 font-semibold flex items-center gap-1 mb-1">
                    <AlertCircle className="h-3 w-3" />
                    {t("oneClick.important")}
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    {t("oneClick.importantDesc")}
                  </p>
                </div>
              </div>
            )}

            {/* Progress indicator */}
            {generateMut.isPending && (
              <div className="space-y-3">
                {STEPS.map((step, i) => {
                  const isDone = currentStep > i;
                  const isActive = currentStep === i;
                  const Icon = step.icon;
                  return (
                    <div
                      key={step.id}
                      className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                        isDone
                          ? "border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/30 dark:bg-emerald-950/10"
                          : isActive
                          ? "border-primary/40 bg-primary/[0.05]"
                          : "border-border/40 opacity-50"
                      }`}
                    >
                      <div
                        className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${
                          isDone
                            ? "bg-emerald-100 dark:bg-emerald-950/40"
                            : isActive
                            ? "bg-primary/10"
                            : "bg-muted/40"
                        }`}
                      >
                        {isDone ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        ) : isActive ? (
                          <Loader2 className="h-4 w-4 animate-spin text-primary" />
                        ) : (
                          <Icon className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                      <div className="flex-1">
                        <p
                          className={`text-xs font-medium ${
                            isDone
                              ? "text-emerald-700 dark:text-emerald-400"
                              : isActive
                              ? "text-primary"
                              : "text-muted-foreground"
                          }`}
                        >
                          {t(step.labelKey)}
                        </p>
                        {/* Show latest log message for active step */}
                        {isActive && streamLog.length > 0 && (
                          <p className="text-[9px] text-muted-foreground mt-0.5">
                            {streamLog[streamLog.length - 1]?.message}
                          </p>
                        )}
                      </div>
                      {isDone && (
                        <span className="text-[9px] text-emerald-600 font-semibold">{t("oneClick.done")}</span>
                      )}
                    </div>
                  );
                })}

                {/* Live log */}
                {streamLog.length > 0 && (
                  <div className="rounded-md border border-border/40 bg-muted/20 p-2 max-h-32 overflow-y-auto scroll-academic space-y-0.5">
                    {streamLog.slice(-8).map((log, i) => (
                      <p key={i} className="text-[9px] text-muted-foreground font-mono">
                        <span className="text-primary">[{log.event}]</span> {log.message}
                      </p>
                    ))}
                  </div>
                )}

                <p className="text-[10px] text-muted-foreground text-center">
                  {t("oneClick.streamingHint")}
                </p>
              </div>
            )}

            {/* Result */}
            {result && (
              <div className="space-y-3">
                <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/50 dark:bg-emerald-950/20 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                    <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                      {t("oneClick.generatedTitle")}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <ResultStat
                      label={t("oneClick.sourcesGathered")}
                      value={result.stats?.sourcesGathered || 0}
                    />
                    <ResultStat
                      label={t("oneClick.referencesSaved")}
                      value={result.stats?.referencesSaved || 0}
                    />
                    <ResultStat
                      label={t("oneClick.sectionsWritten")}
                      value={result.stats?.sectionsPlanned || 0}
                    />
                    <ResultStat
                      label={t("oneClick.totalWords")}
                      value={result.stats?.articleWordCount || 0}
                    />
                  </div>
                </div>

                {result.sections && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                      {t("oneClick.generatedSections")}
                    </p>
                    {result.sections.map((s: any, i: number) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 rounded-md border border-border/40 p-2 text-[11px]"
                      >
                        <span className="font-mono text-muted-foreground w-6">§{i + 1}</span>
                        <span className="font-medium truncate flex-1">{s.title}</span>
                        <Badge variant="outline" className="text-[8px] h-3.5 uppercase">
                          {s.format}
                        </Badge>
                        <span className="text-muted-foreground">{s.wordCount}w</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-border/60 flex items-center justify-between gap-2 shrink-0 bg-card">
          {!generateMut.isPending && !result && (
            <>
              <span className="text-[10px] text-muted-foreground">
                {t("oneClick.footerHint")}
              </span>
              <Button
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => generateMut.mutate()}
              >
                <Zap className="h-3.5 w-3.5" />
                {t("oneClick.generateBtn")}
              </Button>
            </>
          )}
          {generateMut.isPending && (
            <div className="flex items-center gap-2 ml-auto text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("oneClick.generating")}
            </div>
          )}
          {result && (
            <Button
              size="sm"
              className="gap-1.5 text-xs ml-auto"
              onClick={() => onOpenChange(false)}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t("oneClick.doneBtn")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResultStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400">{value}</p>
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}
