"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  ListTree,
  Radar,
  PenLine,
  Layers,
  Zap,
  Loader2,
  CheckCircle2,
  X,
  Sparkles,
  Database,
  Network,
  Filter,
  FileStack,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { api } from "@/lib/api-client";
import { JOURNAL_TEMPLATES } from "@/lib/journal-templates";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";
import { PARAGRAPH_FORMATS, PARAGRAPH_SCENARIOS } from "@/lib/constants";

type WriteTab = "outline" | "gather" | "paragraph" | "compose" | "full";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  topic: string;
  field?: string;
  paragraphCount: number;
  initialTab?: WriteTab;
}

const TAB_CONFIG: { id: WriteTab; icon: any; color: string }[] = [
  { id: "outline", icon: ListTree, color: "amber" },
  { id: "gather", icon: Radar, color: "emerald" },
  { id: "paragraph", icon: PenLine, color: "sky" },
  { id: "compose", icon: Layers, color: "violet" },
  { id: "full", icon: Zap, color: "rose" },
];

const STEP_COLORS: Record<string, string> = {
  emerald: "text-emerald-600 bg-emerald-100 dark:bg-emerald-950/40 border-emerald-200/60 dark:border-emerald-900/40",
  teal: "text-teal-600 bg-teal-100 dark:bg-teal-950/40 border-teal-200/60 dark:border-teal-900/40",
  sky: "text-sky-600 bg-sky-100 dark:bg-sky-950/40 border-sky-200/60 dark:border-sky-900/40",
  amber: "text-amber-600 bg-amber-100 dark:bg-amber-950/40 border-amber-200/60 dark:border-amber-900/40",
  violet: "text-violet-600 bg-violet-100 dark:bg-violet-950/40 border-violet-200/60 dark:border-violet-900/40",
  rose: "text-rose-600 bg-rose-100 dark:bg-rose-950/40 border-rose-200/60 dark:border-rose-900/40",
};

export function UnifiedWritingDialog({
  open,
  onOpenChange,
  projectId,
  topic,
  field,
  paragraphCount,
  initialTab = "outline",
}: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = React.useState<WriteTab>(initialTab);

  React.useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
    }
  }, [open, initialTab]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["project", projectId] });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[92vh] flex flex-col gap-0 p-0 overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-5 pb-3 border-b border-border/60 shrink-0 bg-gradient-to-br from-primary/[0.06] via-transparent to-transparent">
          <DialogTitle className="flex items-center gap-2 text-base">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            {t("unifiedWrite.title")}
          </DialogTitle>
          <DialogDescription className="text-xs mt-1 ml-10">
            {t("unifiedWrite.desc")}
          </DialogDescription>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as WriteTab)} className="flex-1 min-h-0 flex flex-col">
          <div className="px-6 pt-3 pb-2 border-b border-border/40 shrink-0">
            <TabsList className="grid grid-cols-5 h-9 w-full">
              {TAB_CONFIG.map((tab) => {
                const Icon = tab.icon;
                return (
                  <TabsTrigger key={tab.id} value={tab.id} className="text-[11px] gap-1">
                    <Icon className="h-3 w-3" />
                    <span className="hidden sm:inline">{t(`unifiedWrite.tab_${tab.id}`)}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto scroll-academic">
            {activeTab === "outline" && (
              <OutlineTab projectId={projectId} topic={topic} field={field} onInvalidate={invalidate} />
            )}
            {activeTab === "gather" && (
              <GatherTab projectId={projectId} topic={topic} field={field} onInvalidate={invalidate} />
            )}
            {activeTab === "paragraph" && (
              <ParagraphTab projectId={projectId} topic={topic} field={field} onInvalidate={invalidate} />
            )}
            {activeTab === "compose" && (
              <ComposeTab projectId={projectId} topic={topic} paragraphCount={paragraphCount} onInvalidate={invalidate} />
            )}
            {activeTab === "full" && (
              <FullArticleTab projectId={projectId} topic={topic} field={field} onInvalidate={invalidate} />
            )}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ==================== Progress Timeline Component ====================
function ProgressTimeline({
  steps,
  currentStep,
  stepProgress,
}: {
  steps: { id: string; label: string; icon: any }[];
  currentStep: number;
  stepProgress: Record<string, string>;
}) {
  return (
    <div className="space-y-2">
      {/* Overall progress bar */}
      <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-semibold text-primary">
            {currentStep >= 0 && currentStep < steps.length
              ? `${currentStep + 1}/${steps.length}: ${steps[currentStep].label}`
              : currentStep >= steps.length
              ? "Complete"
              : "Ready"}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {Math.round(((currentStep + 1) / steps.length) * 100)}%
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-primary to-primary/70 transition-all duration-500"
            style={{ width: `${((currentStep + 1) / steps.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Step timeline */}
      <div className="space-y-1">
        {steps.map((step, i) => {
          const isDone = currentStep > i;
          const isActive = currentStep === i;
          const Icon = step.icon;
          return (
            <div
              key={step.id}
              className={`flex items-center gap-2 rounded-md border p-2 transition-all ${
                isDone
                  ? "border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/30 dark:bg-emerald-950/10"
                  : isActive
                  ? "border-primary/40 bg-primary/[0.05] ring-1 ring-primary/20"
                  : "border-border/40 opacity-50"
              }`}
            >
              <div className={`h-6 w-6 rounded-md flex items-center justify-center shrink-0 ${
                isDone ? "bg-emerald-100 dark:bg-emerald-950/40" : isActive ? "bg-primary/10" : "bg-muted/40"
              }`}>
                {isDone ? (
                  <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                ) : isActive ? (
                  <Loader2 className="h-3 w-3 animate-spin text-primary" />
                ) : (
                  <Icon className="h-3 w-3 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-[10px] font-medium ${
                  isDone ? "text-emerald-700 dark:text-emerald-400" : isActive ? "text-primary" : "text-muted-foreground"
                }`}>
                  {step.label}
                </p>
                {isActive && stepProgress[step.id] && (
                  <p className="text-[9px] text-muted-foreground mt-0.5 truncate">{stepProgress[step.id]}</p>
                )}
              </div>
              {isDone && <span className="text-[9px] text-emerald-600 font-semibold">✓</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ==================== Shared config component ====================
function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

// ==================== Outline Tab ====================
function OutlineTab({ projectId, topic, field, onInvalidate }: { projectId: string; topic: string; field?: string; onInvalidate: () => void }) {
  const { t } = useI18n();
  const [purpose, setPurpose] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<any>(null);

  const run = async () => {
    setLoading(true);
    setResult(null);
    try {
      const data = await api.aiOutline({ projectId, purpose });
      setResult(data);
      onInvalidate();
      toast.success(t("toast.outlineGenerated"));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="px-6 py-4 space-y-3">
      <p className="text-[11px] text-muted-foreground">{t("unifiedWrite.outlineDesc")}</p>
      <ConfigRow label={t("outline.purpose")}>
        <textarea
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="e.g. Focus on structural mechanisms and therapeutic implications..."
          className="text-xs min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2"
        />
      </ConfigRow>
      {loading ? (
        <div className="flex items-center gap-2 py-4">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">{t("outline.generating")}</span>
        </div>
      ) : result ? (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-wider text-emerald-600 font-semibold">{t("outline.generateOutline")} ✓</p>
          <p className="text-xs text-muted-foreground italic">{result.summary}</p>
          {result.outline?.map((item: any, i: number) => (
            <div key={i} className="rounded-md border border-border/50 p-2 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="font-mono text-muted-foreground">§{i + 1}</span>
                <Badge variant="outline" className="text-[8px] h-3.5 uppercase">{item.format}</Badge>
                <span className="font-medium flex-1 truncate">{item.title}</span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">{item.focus?.slice(0, 100)}</p>
            </div>
          ))}
        </div>
      ) : null}
      <Button size="sm" className="gap-1.5 text-xs w-full" onClick={run} disabled={loading}>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListTree className="h-3.5 w-3.5" />}
        {t("outline.generateOutline")}
      </Button>
    </div>
  );
}

// ==================== Gather Tab ====================
function GatherTab({ projectId, topic, field, onInvalidate }: { projectId: string; topic: string; field?: string; onInvalidate: () => void }) {
  const { t } = useI18n();
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<any>(null);

  const run = async () => {
    setLoading(true);
    setResult(null);
    try {
      const data = await api.aiGather({ projectId, topic, field, mode: "organize", runQueries: true });
      setResult(data);
      onInvalidate();
      toast.success(t("toast.sourcesGathered", { n: data.addedResults?.length || 0 }));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="px-6 py-4 space-y-3">
      <p className="text-[11px] text-muted-foreground">{t("unifiedWrite.gatherDesc")}</p>
      <div className="rounded-lg bg-primary/[0.04] border border-primary/20 p-3">
        <p className="text-[10px] uppercase tracking-wider text-primary font-semibold mb-0.5">{t("gather.researchTopic")}</p>
        <p className="text-sm font-medium">{topic}</p>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-4">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">Gathering sources from multiple databases...</span>
        </div>
      ) : result ? (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-wider text-emerald-600 font-semibold">{t("gather.organize")} ✓</p>
          <p className="text-xs text-muted-foreground">{result.plan}</p>
          {result.addedResults?.length > 0 && (
            <p className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
              {result.addedResults.length} sources gathered
            </p>
          )}
        </div>
      ) : null}
      <Button size="sm" className="gap-1.5 text-xs w-full" onClick={run} disabled={loading}>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}
        {t("gather.startGathering")}
      </Button>
    </div>
  );
}

// ==================== Paragraph Tab ====================
function ParagraphTab({ projectId, topic, field, onInvalidate }: { projectId: string; topic: string; field?: string; onInvalidate: () => void }) {
  const { t } = useI18n();
  const [format, setFormat] = React.useState("background");
  const [scenario, setScenario] = React.useState("literature-review");
  const [focus, setFocus] = React.useState("");
  const [language, setLanguage] = React.useState("English");
  const [loading, setLoading] = React.useState(false);

  const run = async () => {
    setLoading(true);
    try {
      await api.aiWrite({
        topic,
        projectId,
        format: format as any,
        scenario: scenario as any,
        focus,
        language,
        field,
      });
      onInvalidate();
      toast.success(t("toast.paragraphGenerated"));
      setFocus("");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="px-6 py-4 space-y-3">
      <p className="text-[11px] text-muted-foreground">{t("unifiedWrite.paragraphDesc")}</p>
      <div className="grid grid-cols-2 gap-3">
        <ConfigRow label={t("topic.formatLabel")}>
          <Select value={format} onValueChange={setFormat}>
            <SelectTrigger className="text-xs h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PARAGRAPH_FORMATS.map((f) => <SelectItem key={f.id} value={f.id} className="text-xs">{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </ConfigRow>
        <ConfigRow label={t("topic.scenarioLabel")}>
          <Select value={scenario} onValueChange={setScenario}>
            <SelectTrigger className="text-xs h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PARAGRAPH_SCENARIOS.map((s) => <SelectItem key={s.id} value={s.id} className="text-xs">{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </ConfigRow>
      </div>
      <ConfigRow label={t("topic.focusLabel")}>
        <input
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder="e.g. focus on PAM-dependent unwinding mechanism"
          className="text-xs h-9 w-full rounded-md border border-input bg-background px-3"
        />
      </ConfigRow>
      <ConfigRow label={t("topic.languageLabel")}>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger className="text-xs h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="English" className="text-xs">{t("topic.langEnglish")}</SelectItem>
            <SelectItem value="中文" className="text-xs">{t("topic.langChinese")}</SelectItem>
            <SelectItem value="both" className="text-xs">{t("topic.langBoth")}</SelectItem>
          </SelectContent>
        </Select>
      </ConfigRow>
      {loading && (
        <div className="flex items-center gap-2 py-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">{t("topic.researching")}</span>
        </div>
      )}
      <Button size="sm" className="gap-1.5 text-xs w-full" onClick={run} disabled={loading}>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PenLine className="h-3.5 w-3.5" />}
        {t("topic.generate")}
      </Button>
    </div>
  );
}

// ==================== Compose Tab ====================
function ComposeTab({ projectId, topic, paragraphCount, onInvalidate }: { projectId: string; topic: string; paragraphCount: number; onInvalidate: () => void }) {
  const { t } = useI18n();
  const [title, setTitle] = React.useState(topic);
  const [depth, setDepth] = React.useState<"shallow" | "standard" | "deep">("deep");
  const [loading, setLoading] = React.useState(false);

  const run = async () => {
    if (paragraphCount < 2) {
      toast.error(t("compose.noParagraphs"));
      return;
    }
    setLoading(true);
    try {
      // Fetch paragraph IDs
      const projectData = await api.getProject(projectId);
      const paraIds = (projectData.project?.paragraphs || []).map((p: any) => p.id);
      await api.aiCompose({
        projectId,
        title,
        paragraphIds: paraIds,
        depth,
      });
      onInvalidate();
      toast.success(t("toast.articleComposed"));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="px-6 py-4 space-y-3">
      <p className="text-[11px] text-muted-foreground">{t("unifiedWrite.composeDesc")}</p>
      <ConfigRow label={t("compose.articleTitle")}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="text-xs h-9 w-full rounded-md border border-input bg-background px-3"
        />
      </ConfigRow>
      <ConfigRow label={t("compose.depth")}>
        <div className="grid grid-cols-3 gap-1.5">
          {(["shallow", "standard", "deep"] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDepth(d)}
              className={`text-[10px] px-2 py-1.5 rounded-md border transition-colors ${
                depth === d ? "border-primary bg-primary/10 text-primary font-medium" : "border-border hover:bg-muted"
              }`}
            >
              {t(`compose.${d}`)}
            </button>
          ))}
        </div>
      </ConfigRow>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <Layers className="h-3 w-3" />
        {paragraphCount} {t("compose.paragraphOrder")}
      </div>
      {paragraphCount < 2 && (
        <div className="rounded-md border border-amber-200/60 bg-amber-50/40 dark:bg-amber-950/20 p-2 text-[10px] text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
          <AlertCircle className="h-3 w-3" />
          {t("compose.noParagraphs")}
        </div>
      )}
      {loading && (
        <div className="flex items-center gap-2 py-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">{t("compose.composing")}</span>
        </div>
      )}
      <Button size="sm" className="gap-1.5 text-xs w-full" onClick={run} disabled={loading || paragraphCount < 2}>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />}
        {t("compose.compose")}
      </Button>
    </div>
  );
}

// ==================== Full Article Tab ====================
function FullArticleTab({ projectId, topic, field, onInvalidate }: { projectId: string; topic: string; field?: string; onInvalidate: () => void }) {
  const { t } = useI18n();
  const [language, setLanguage] = React.useState("English");
  const [targetWords, setTargetWords] = React.useState(5000);
  const [currentStep, setCurrentStep] = React.useState(-1);
  const [stepProgress, setStepProgress] = React.useState<Record<string, string>>({});
  const [result, setResult] = React.useState<any>(null);

  const STEPS = [
    { id: "gather", label: t("oneClick.stepGather"), icon: Database },
    { id: "curate", label: t("oneClick.stepCurate"), icon: Filter },
    { id: "relationships", label: t("oneClick.stepRelationships"), icon: Network },
    { id: "plan", label: t("oneClick.stepPlan"), icon: ListTree },
    { id: "generate", label: t("oneClick.stepGenerate"), icon: PenLine },
    { id: "compose", label: t("oneClick.stepCompose"), icon: FileStack },
  ];

  const run = async () => {
    setCurrentStep(0);
    setStepProgress({});
    setResult(null);
    try {
      const data = await api.aiGenerateFullStream(
        { projectId, language, targetWords },
        (event, data) => {
          const stepMap: Record<string, number> = {
            gather: 0, curate: 1, relationships: 2, plan: 3, generate: 4, compose: 5,
          };
          if (stepMap[event] !== undefined && data.status === "started") {
            setCurrentStep(stepMap[event]);
          }
          if (data.message) {
            setStepProgress((prev) => ({ ...prev, [event]: data.message }));
          }
        }
      );
      setCurrentStep(STEPS.length);
      setResult(data);
      onInvalidate();
      toast.success(t("toast.oneClickGenerated", { words: data.stats?.articleWordCount || 0, refs: data.stats?.referencesSaved || 0 }));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setCurrentStep(-1);
    }
  };

  const formatWords = (n: number) => n.toLocaleString();
  const isRunning = currentStep >= 0 && currentStep < STEPS.length;

  return (
    <div className="px-6 py-4 space-y-3">
      <p className="text-[11px] text-muted-foreground">{t("unifiedWrite.fullDesc")}</p>

      {/* Feature chips */}
      <div className="grid grid-cols-2 gap-1.5">
        <div className="flex items-center gap-1 rounded-md border border-emerald-200/50 dark:border-emerald-900/40 bg-emerald-50/30 dark:bg-emerald-950/10 p-1.5">
          <Database className="h-2.5 w-2.5 text-emerald-600 shrink-0" />
          <span className="text-[9px] font-medium text-emerald-700 dark:text-emerald-400">{t("oneClick.forceRegather")}</span>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-violet-200/50 dark:border-violet-900/40 bg-violet-50/30 dark:bg-violet-950/10 p-1.5">
          <PenLine className="h-2.5 w-2.5 text-violet-600 shrink-0" />
          <span className="text-[9px] font-medium text-violet-700 dark:text-violet-400">{t("oneClick.chunkedGen")}</span>
        </div>
      </div>

      <ConfigRow label={t("oneClick.outputLanguage")}>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger className="text-xs h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="English" className="text-xs">{t("topic.langEnglish")}</SelectItem>
            <SelectItem value="中文" className="text-xs">{t("topic.langChinese")}</SelectItem>
            <SelectItem value="both" className="text-xs">{t("topic.langBoth")}</SelectItem>
          </SelectContent>
        </Select>
      </ConfigRow>

      {/* Word count slider */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t("oneClick.targetWordCount", { n: formatWords(targetWords) })}</Label>
          <span className="text-[10px] text-muted-foreground">{t("oneClick.maxWords")}</span>
        </div>
        <input
          type="range"
          min={2000}
          max={50000}
          step={1000}
          value={targetWords}
          onChange={(e) => setTargetWords(Number(e.target.value))}
          className="w-full h-2 rounded-full appearance-none cursor-pointer"
          style={{
            background: `linear-gradient(to right, hsl(var(--primary)) 0%, hsl(var(--primary)) ${(targetWords - 2000) / 48000 * 100}%, hsl(var(--muted)) ${(targetWords - 2000) / 48000 * 100}%, hsl(var(--muted)) 100%)`,
          }}
        />
        <div className="flex justify-between text-[9px] text-muted-foreground">
          <span>2,000</span>
          <span className="font-medium text-primary">{formatWords(targetWords)}</span>
          <span>50,000</span>
        </div>
      </div>

      {/* Progress or result */}
      {isRunning && (
        <ProgressTimeline steps={STEPS} currentStep={currentStep} stepProgress={stepProgress} />
      )}

      {result && (
        <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 bg-gradient-to-br from-emerald-50/60 to-teal-50/30 dark:from-emerald-950/20 dark:to-teal-950/10 p-3">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">{t("oneClick.generatedTitle")}</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-base font-bold text-emerald-700 dark:text-emerald-400">{result.stats?.sourcesGathered || 0}</p>
              <p className="text-[8px] uppercase text-muted-foreground">{t("oneClick.sourcesGathered")}</p>
            </div>
            <div>
              <p className="text-base font-bold text-violet-700 dark:text-violet-400">{result.stats?.sectionsPlanned || 0}</p>
              <p className="text-[8px] uppercase text-muted-foreground">{t("oneClick.sectionsWritten")}</p>
            </div>
            <div>
              <p className="text-base font-bold text-rose-700 dark:text-rose-400">{result.stats?.articleWordCount || 0}</p>
              <p className="text-[8px] uppercase text-muted-foreground">{t("oneClick.totalWords")}</p>
            </div>
          </div>
        </div>
      )}

      <Button size="sm" className="gap-1.5 text-xs w-full" onClick={run} disabled={isRunning}>
        {isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
        {t("oneClick.generateBtn")}
      </Button>
    </div>
  );
}
