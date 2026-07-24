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
  Filter,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  { id: "gather", labelKey: "oneClick.stepGather" as const, icon: Database, color: "emerald" },
  { id: "curate", labelKey: "oneClick.stepCurate" as const, icon: Filter, color: "teal" },
  { id: "relationships", labelKey: "oneClick.stepRelationships" as const, icon: Network, color: "sky" },
  { id: "plan", labelKey: "oneClick.stepPlan" as const, icon: ListTree, color: "amber" },
  { id: "generate", labelKey: "oneClick.stepGenerate" as const, icon: PenLine, color: "violet" },
  { id: "compose", labelKey: "oneClick.stepCompose" as const, icon: FileStack, color: "rose" },
];

const STEP_COLORS: Record<string, { bg: string; text: string; border: string; done: string }> = {
  emerald: { bg: "bg-emerald-100 dark:bg-emerald-950/40", text: "text-emerald-600", border: "border-emerald-200/60 dark:border-emerald-900/40", done: "text-emerald-700 dark:text-emerald-400" },
  teal: { bg: "bg-teal-100 dark:bg-teal-950/40", text: "text-teal-600", border: "border-teal-200/60 dark:border-teal-900/40", done: "text-teal-700 dark:text-teal-400" },
  sky: { bg: "bg-sky-100 dark:bg-sky-950/40", text: "text-sky-600", border: "border-sky-200/60 dark:border-sky-900/40", done: "text-sky-700 dark:text-sky-400" },
  amber: { bg: "bg-amber-100 dark:bg-amber-950/40", text: "text-amber-600", border: "border-amber-200/60 dark:border-amber-900/40", done: "text-amber-700 dark:text-amber-400" },
  violet: { bg: "bg-violet-100 dark:bg-violet-950/40", text: "text-violet-600", border: "border-violet-200/60 dark:border-violet-900/40", done: "text-violet-700 dark:text-violet-400" },
  rose: { bg: "bg-rose-100 dark:bg-rose-950/40", text: "text-rose-600", border: "border-rose-200/60 dark:border-rose-900/40", done: "text-rose-700 dark:text-rose-400" },
};

export function OneClickGenerateDialog({ open, onOpenChange, projectId, topic }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [journalTemplate, setJournalTemplate] = React.useState("generic");
  const [language, setLanguage] = React.useState("English");
  const [targetWords, setTargetWords] = React.useState(5000);
  const [result, setResult] = React.useState<any>(null);
  const [currentStep, setCurrentStep] = React.useState(-1);
  const [stepProgress, setStepProgress] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (open) {
      setResult(null);
      setCurrentStep(-1);
      setStepProgress({});
    }
  }, [open]);

  const [streamLog, setStreamLog] = React.useState<any[]>([]);

  const generateMut = useMutation({
    mutationFn: async () => {
      setCurrentStep(0);
      setStreamLog([]);
      setStepProgress({});
      const data = await api.aiGenerateFullStream(
        { projectId, journalTemplate, language, targetWords },
        (event, data) => {
          const stepMap: Record<string, number> = {
            gather: 0,
            curate: 1,
            relationships: 2,
            plan: 3,
            generate: 4,
            compose: 5,
          };
          if (stepMap[event] !== undefined && data.status === "started") {
            setCurrentStep(stepMap[event]);
          }
          if (data.message) {
            setStreamLog((prev) => [...prev, { event, ...data }]);
            setStepProgress((prev) => ({ ...prev, [event]: data.message }));
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
    onError: (e: Error) => toast.error(e.message),
  });

  const formatWords = (n: number) => n.toLocaleString();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[92vh] flex flex-col gap-0 p-0">
        {/* Header with gradient */}
        <div className="relative px-6 pt-5 pb-4 border-b border-border/60 shrink-0 bg-gradient-to-br from-primary/[0.06] via-transparent to-transparent">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Zap className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="flex items-center gap-2 text-base">
                {t("oneClick.title")}
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                {t("oneClick.desc")}
              </DialogDescription>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-6 py-4 space-y-4">
            {/* Configuration */}
            {!generateMut.isPending && !result && (
              <div className="space-y-4">
                {/* Topic card */}
                <div className="rounded-lg bg-primary/[0.04] border border-primary/20 p-3.5">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Sparkles className="h-3 w-3 text-primary" />
                    <p className="text-[10px] uppercase tracking-wider text-primary font-semibold">
                      {t("oneClick.researchTopic")}
                    </p>
                  </div>
                  <p className="text-sm font-medium leading-snug">{topic}</p>
                </div>

                {/* Feature highlights */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <FeatureChip icon={Database} text={t("oneClick.forceRegather")} color="emerald" />
                  <FeatureChip icon={Network} text={t("oneClick.multiMethod")} color="sky" />
                  <FeatureChip icon={ListTree} text={t("oneClick.noFormatSelect")} color="amber" />
                  <FeatureChip icon={PenLine} text={t("oneClick.chunkedGen")} color="violet" />
                </div>

                {/* Settings grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs flex items-center gap-1">
                      <FileStack className="h-3 w-3" />
                      {t("oneClick.journalTemplate")}
                    </Label>
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
                    <Label className="text-xs flex items-center gap-1">
                      <Sparkles className="h-3 w-3" />
                      {t("oneClick.outputLanguage")}
                    </Label>
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

                {/* Word count slider with visual feedback */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs flex items-center gap-1">
                      <PenLine className="h-3 w-3" />
                      {t("oneClick.targetWordCount", { n: formatWords(targetWords) })}
                    </Label>
                    <span className="text-[10px] text-muted-foreground">
                      {t("oneClick.maxWords")}
                    </span>
                  </div>
                  <div className="relative">
                    <input
                      type="range"
                      min={2000}
                      max={50000}
                      step={1000}
                      value={targetWords}
                      onChange={(e) => setTargetWords(Number(e.target.value))}
                      className="w-full h-2 rounded-full appearance-none cursor-pointer bg-muted
                        [&::-webkit-slider-thumb]:appearance-none
                        [&::-webkit-slider-thumb]:h-4
                        [&::-webkit-slider-thumb]:w-4
                        [&::-webkit-slider-thumb]:rounded-full
                        [&::-webkit-slider-thumb]:bg-primary
                        [&::-webkit-slider-thumb]:shadow-md
                        [&::-webkit-slider-thumb]:cursor-pointer
                        [&::-moz-range-thumb]:h-4
                        [&::-moz-range-thumb]:w-4
                        [&::-moz-range-thumb]:rounded-full
                        [&::-moz-range-thumb]:bg-primary
                        [&::-moz-range-thumb]:border-none
                        [&::-moz-range-thumb]:cursor-pointer"
                      style={{
                        background: `linear-gradient(to right, hsl(var(--primary)) 0%, hsl(var(--primary)) ${(targetWords - 2000) / 48000 * 100}%, hsl(var(--muted)) ${(targetWords - 2000) / 48000 * 100}%, hsl(var(--muted)) 100%)`,
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-[9px] text-muted-foreground">
                    <span>2,000</span>
                    <span className="font-medium text-primary">{formatWords(targetWords)} words</span>
                    <span>50,000</span>
                  </div>
                  {/* Word count tier indicator */}
                  <div className="flex items-center gap-1.5">
                    <div className={`h-1 flex-1 rounded-full ${targetWords >= 2000 ? "bg-emerald-400" : "bg-muted"}`} />
                    <div className={`h-1 flex-1 rounded-full ${targetWords >= 8000 ? "bg-sky-400" : "bg-muted"}`} />
                    <div className={`h-1 flex-1 rounded-full ${targetWords >= 20000 ? "bg-violet-400" : "bg-muted"}`} />
                    <div className={`h-1 flex-1 rounded-full ${targetWords >= 35000 ? "bg-rose-400" : "bg-muted"}`} />
                    <span className="text-[9px] text-muted-foreground ml-1 shrink-0">
                      {targetWords < 8000 ? "Short" : targetWords < 20000 ? "Medium" : targetWords < 35000 ? "Long" : "Comprehensive"}
                    </span>
                  </div>
                </div>

                {/* Warning notice */}
                <div className="rounded-lg border border-amber-200/60 dark:border-amber-900/40 bg-amber-50/40 dark:bg-amber-950/20 p-3">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[10px] text-amber-700 dark:text-amber-400 font-semibold mb-0.5">
                        {t("oneClick.important")}
                      </p>
                      <p className="text-[10px] text-muted-foreground leading-relaxed">
                        {t("oneClick.importantDesc")}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Progress indicator — vertical timeline */}
            {generateMut.isPending && (
              <div className="space-y-3">
                {/* Overall progress bar */}
                <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold text-primary">
                      {currentStep >= 0 && currentStep < STEPS.length
                        ? `Step ${currentStep + 1} of ${STEPS.length}: ${t(STEPS[currentStep].labelKey)}`
                        : "Processing..."}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {Math.round(((currentStep + 1) / STEPS.length) * 100)}%
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-primary to-primary/70 transition-all duration-500"
                      style={{ width: `${((currentStep + 1) / STEPS.length) * 100}%` }}
                    />
                  </div>
                </div>

                {/* Step timeline */}
                <div className="space-y-1.5">
                  {STEPS.map((step, i) => {
                    const isDone = currentStep > i;
                    const isActive = currentStep === i;
                    const Icon = step.icon;
                    const colors = STEP_COLORS[step.color];
                    return (
                      <div
                        key={step.id}
                        className={`flex items-center gap-2.5 rounded-lg border p-2.5 transition-all ${
                          isDone
                            ? `${colors.border} bg-emerald-50/30 dark:bg-emerald-950/10`
                            : isActive
                            ? `${colors.border} bg-primary/[0.05] ring-1 ring-primary/20`
                            : "border-border/40 opacity-50"
                        }`}
                      >
                        <div
                          className={`h-7 w-7 rounded-lg flex items-center justify-center shrink-0 transition-all ${
                            isDone
                              ? colors.bg
                              : isActive
                              ? "bg-primary/10"
                              : "bg-muted/40"
                          }`}
                        >
                          {isDone ? (
                            <CheckCircle2 className={`h-3.5 w-3.5 ${colors.text}`} />
                          ) : isActive ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                          ) : (
                            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p
                            className={`text-[11px] font-medium ${
                              isDone
                                ? colors.done
                                : isActive
                                ? "text-primary"
                                : "text-muted-foreground"
                            }`}
                          >
                            {t(step.labelKey)}
                          </p>
                          {isActive && stepProgress[step.id] && (
                            <p className="text-[9px] text-muted-foreground mt-0.5 truncate">
                              {stepProgress[step.id]}
                            </p>
                          )}
                        </div>
                        {isDone && (
                          <span className={`text-[9px] font-semibold ${colors.done}`}>
                            {t("oneClick.done")}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Live log */}
                {streamLog.length > 0 && (
                  <div className="rounded-md border border-border/40 bg-muted/20 p-2 max-h-28 overflow-y-auto scroll-academic space-y-0.5">
                    {streamLog.slice(-6).map((log, i) => (
                      <p key={i} className="text-[9px] text-muted-foreground font-mono leading-relaxed">
                        <span className="text-primary">[{log.event}]</span>{" "}
                        <span className="text-foreground/70">{log.message}</span>
                      </p>
                    ))}
                  </div>
                )}

                <p className="text-[10px] text-muted-foreground text-center italic">
                  {t("oneClick.streamingHint")}
                </p>
              </div>
            )}

            {/* Result */}
            {result && (
              <div className="space-y-3">
                {/* Success banner */}
                <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 bg-gradient-to-br from-emerald-50/60 to-teal-50/30 dark:from-emerald-950/20 dark:to-teal-950/10 p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    </div>
                    <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                      {t("oneClick.generatedTitle")}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <ResultStat
                      label={t("oneClick.sourcesGathered")}
                      value={result.stats?.sourcesGathered || 0}
                      color="emerald"
                    />
                    <ResultStat
                      label={t("oneClick.curatedRefs")}
                      value={result.stats?.curatedReferences || result.stats?.referencesSaved || 0}
                      color="teal"
                    />
                    <ResultStat
                      label={t("oneClick.sectionsWritten")}
                      value={result.stats?.sectionsPlanned || 0}
                      color="violet"
                    />
                    <ResultStat
                      label={t("oneClick.totalWords")}
                      value={result.stats?.articleWordCount || 0}
                      color="rose"
                    />
                  </div>
                </div>

                {/* Generated sections list */}
                {result.sections && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
                      <ListTree className="h-3 w-3" />
                      {t("oneClick.generatedSections")}
                    </p>
                    <div className="space-y-1 max-h-48 overflow-y-auto scroll-academic">
                      {result.sections.map((s: any, i: number) => (
                        <div
                          key={i}
                          className="flex items-center gap-2 rounded-md border border-border/40 p-2 text-[11px] hover:bg-muted/30 transition-colors"
                        >
                          <span className="font-mono text-muted-foreground w-6 shrink-0">§{i + 1}</span>
                          <span className="font-medium truncate flex-1">{s.title}</span>
                          <Badge variant="outline" className="text-[8px] h-3.5 uppercase shrink-0">
                            {s.format || "section"}
                          </Badge>
                          <span className="text-muted-foreground shrink-0">{s.wordCount}w</span>
                        </div>
                      ))}
                    </div>
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

function FeatureChip({ icon: Icon, text, color }: { icon: any; text: string; color: string }) {
  const colorMap: Record<string, string> = {
    emerald: "border-emerald-200/50 dark:border-emerald-900/40 bg-emerald-50/30 dark:bg-emerald-950/10 text-emerald-700 dark:text-emerald-400",
    sky: "border-sky-200/50 dark:border-sky-900/40 bg-sky-50/30 dark:bg-sky-950/10 text-sky-700 dark:text-sky-400",
    amber: "border-amber-200/50 dark:border-amber-900/40 bg-amber-50/30 dark:bg-amber-950/10 text-amber-700 dark:text-amber-400",
    violet: "border-violet-200/50 dark:border-violet-900/40 bg-violet-50/30 dark:bg-violet-950/10 text-violet-700 dark:text-violet-400",
  };
  return (
    <div className={`flex items-center gap-1.5 rounded-md border p-1.5 ${colorMap[color] || colorMap.emerald}`}>
      <Icon className="h-3 w-3 shrink-0" />
      <span className="text-[9px] font-medium leading-tight">{text}</span>
    </div>
  );
}

function ResultStat({ label, value, color }: { label: string; value: number; color: string }) {
  const colorMap: Record<string, string> = {
    emerald: "text-emerald-700 dark:text-emerald-400",
    teal: "text-teal-700 dark:text-teal-400",
    violet: "text-violet-700 dark:text-violet-400",
    rose: "text-rose-700 dark:text-rose-400",
  };
  return (
    <div className="text-center">
      <p className={`text-xl font-bold ${colorMap[color] || colorMap.emerald}`}>{value}</p>
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}
