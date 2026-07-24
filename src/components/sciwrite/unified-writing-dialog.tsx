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
  Sparkles,
  Database,
  Network,
  Filter,
  FileStack,
  AlertCircle,
  ArrowRight,
  Clock,
  FileText,
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

const TAB_CONFIG: { id: WriteTab; icon: any; color: string; gradient: string }[] = [
  { id: "outline", icon: ListTree, color: "amber", gradient: "from-amber-500/20 to-amber-600/5" },
  { id: "gather", icon: Radar, color: "emerald", gradient: "from-emerald-500/20 to-emerald-600/5" },
  { id: "paragraph", icon: PenLine, color: "sky", gradient: "from-sky-500/20 to-sky-600/5" },
  { id: "compose", icon: Layers, color: "violet", gradient: "from-violet-500/20 to-violet-600/5" },
  { id: "full", icon: Zap, color: "rose", gradient: "from-rose-500/20 to-rose-600/5" },
];

const COLOR_CLASSES: Record<string, { text: string; bg: string; border: string; ring: string; gradient: string }> = {
  amber: { text: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30", ring: "ring-amber-500/30", gradient: "from-amber-500/15 to-transparent" },
  emerald: { text: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30", ring: "ring-emerald-500/30", gradient: "from-emerald-500/15 to-transparent" },
  sky: { text: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10", border: "border-sky-500/30", ring: "ring-sky-500/30", gradient: "from-sky-500/15 to-transparent" },
  violet: { text: "text-violet-600 dark:text-violet-400", bg: "bg-violet-500/10", border: "border-violet-500/30", ring: "ring-violet-500/30", gradient: "from-violet-500/15 to-transparent" },
  rose: { text: "text-rose-600 dark:text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/30", ring: "ring-rose-500/30", gradient: "from-rose-500/15 to-transparent" },
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
    if (open) setActiveTab(initialTab);
  }, [open, initialTab]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["project", projectId] });
  const activeConfig = TAB_CONFIG.find((c) => c.id === activeTab)!;
  const colors = COLOR_CLASSES[activeConfig.color];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[92vh] flex flex-col gap-0 p-0 overflow-hidden border-border/60 shadow-2xl">
        {/* Gradient header with icon */}
        <div className={`relative px-6 pt-5 pb-4 border-b border-border/60 shrink-0 bg-gradient-to-br ${colors.gradient}`}>
          <div className="flex items-start gap-3">
            <div className={`h-10 w-10 rounded-xl ${colors.bg} ${colors.border} border flex items-center justify-center shrink-0`}>
              <activeConfig.icon className={`h-5 w-5 ${colors.text}`} />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="flex items-center gap-2 text-base font-semibold">
                {t("unifiedWrite.title")}
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                {t("unifiedWrite.desc")}
              </DialogDescription>
            </div>
          </div>
        </div>

        {/* Tab bar with visual indicators */}
        <div className="px-6 pt-3 pb-2 border-b border-border/40 shrink-0 bg-muted/20">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as WriteTab)}>
            <TabsList className="grid grid-cols-5 h-10 w-full bg-background/60">
              {TAB_CONFIG.map((tab) => {
                const Icon = tab.icon;
                const tabColors = COLOR_CLASSES[tab.color];
                const isActive = activeTab === tab.id;
                return (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    className={`text-[11px] gap-1.5 transition-all relative ${
                      isActive ? `${tabColors.bg} ${tabColors.text}` : "text-muted-foreground"
                    }`}
                  >
                    <Icon className={`h-3.5 w-3.5 ${isActive ? tabColors.text : ""}`} />
                    <span className="hidden sm:inline">{t(`unifiedWrite.tab_${tab.id}`)}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        </div>

        {/* Content area with tab-specific accent border */}
        <div className={`flex-1 min-h-0 overflow-y-auto scroll-academic border-t-2 ${colors.border}`}>
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
      </DialogContent>
    </Dialog>
  );
}

// ==================== Shared UI components ====================
function ConfigCard({ label, children, icon: Icon }: { label: string; children: React.ReactNode; icon?: any }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs flex items-center gap-1.5 font-medium text-foreground/80">
        {Icon && <Icon className="h-3 w-3 text-muted-foreground" />}
        {label}
      </Label>
      {children}
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  loading,
  icon: Icon,
  children,
  color = "primary",
}: {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon: any;
  children: React.ReactNode;
  color?: string;
}) {
  const colorMap: Record<string, string> = {
    primary: "bg-primary text-primary-foreground hover:bg-primary/90",
    emerald: "bg-emerald-600 text-white hover:bg-emerald-700",
    sky: "bg-sky-600 text-white hover:bg-sky-700",
    violet: "bg-violet-600 text-white hover:bg-violet-700",
    rose: "bg-rose-600 text-white hover:bg-rose-700",
    amber: "bg-amber-600 text-white hover:bg-amber-700",
  };
  return (
    <Button
      size="sm"
      className={`gap-1.5 text-xs w-full h-9 ${colorMap[color] || colorMap.primary}`}
      onClick={onClick}
      disabled={disabled}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {children}
    </Button>
  );
}

function InfoBanner({ icon: Icon, text, color = "emerald" }: { icon: any; text: string; color?: string }) {
  const colorMap: Record<string, string> = {
    emerald: "border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400",
    amber: "border-amber-200/60 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400",
    sky: "border-sky-200/60 dark:border-sky-900/40 bg-sky-50/50 dark:bg-sky-950/20 text-sky-700 dark:text-sky-400",
    violet: "border-violet-200/60 dark:border-violet-900/40 bg-violet-50/50 dark:bg-violet-950/20 text-violet-700 dark:text-violet-400",
    rose: "border-rose-200/60 dark:border-rose-900/40 bg-rose-50/50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-400",
  };
  return (
    <div className={`flex items-start gap-2 rounded-lg border p-3 ${colorMap[color] || colorMap.emerald}`}>
      <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      <p className="text-[11px] leading-relaxed">{text}</p>
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
    <div className="px-6 py-5 space-y-4">
      <InfoBanner icon={Sparkles} text={t("unifiedWrite.outlineDesc")} color="amber" />
      <ConfigCard label={t("outline.purpose")} icon={ArrowRight}>
        <textarea
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="e.g. Focus on structural mechanisms and therapeutic implications..."
          className="text-xs min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2.5 focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all resize-none"
        />
      </ConfigCard>

      {loading && (
        <div className="flex flex-col items-center gap-3 py-8">
          <div className="relative">
            <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
            <div className="absolute inset-0 flex items-center justify-center">
              <ListTree className="h-3.5 w-3.5 text-amber-600" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground animate-pulse">{t("outline.generating")}</p>
        </div>
      )}

      {result && (
        <div className="space-y-2 rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 bg-gradient-to-br from-emerald-50/50 to-transparent dark:from-emerald-950/20 p-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">{t("outline.generateOutline")} ✓</span>
          </div>
          <p className="text-xs text-muted-foreground italic leading-relaxed">{result.summary}</p>
          {result.outline?.map((item: any, i: number) => (
            <div key={i} className="rounded-md border border-border/50 bg-background/60 p-2.5 text-[11px] hover:border-amber-500/30 transition-colors">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-muted-foreground bg-muted/40 rounded px-1.5 py-0.5">§{i + 1}</span>
                <Badge variant="outline" className="text-[8px] h-3.5 uppercase">{item.format}</Badge>
                <span className="font-medium flex-1 truncate">{item.title}</span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5 leading-relaxed pl-7">{item.focus?.slice(0, 120)}</p>
            </div>
          ))}
        </div>
      )}

      <ActionButton onClick={run} disabled={loading} loading={loading} icon={ListTree} color="amber">
        {t("outline.generateOutline")}
      </ActionButton>
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
    <div className="px-6 py-5 space-y-4">
      <InfoBanner icon={Radar} text={t("unifiedWrite.gatherDesc")} color="emerald" />

      <div className="rounded-lg bg-gradient-to-br from-emerald-500/10 to-transparent border border-emerald-500/20 p-4">
        <div className="flex items-center gap-1.5 mb-1">
          <FileText className="h-3 w-3 text-emerald-600" />
          <p className="text-[10px] uppercase tracking-wider text-emerald-600 font-semibold">{t("gather.researchTopic")}</p>
        </div>
        <p className="text-sm font-medium leading-snug">{topic}</p>
      </div>

      {loading && (
        <div className="flex flex-col items-center gap-3 py-8">
          <div className="relative">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Database className="h-3.5 w-3.5 text-emerald-600" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground animate-pulse">Gathering sources from multiple databases...</p>
        </div>
      )}

      {result && (
        <div className="space-y-2 rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 bg-gradient-to-br from-emerald-50/50 to-transparent dark:from-emerald-950/20 p-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">{t("gather.organize")} ✓</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{result.plan}</p>
          {result.addedResults?.length > 0 && (
            <div className="flex items-center gap-2 mt-2">
              <Database className="h-3.5 w-3.5 text-emerald-600" />
              <span className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
                {result.addedResults.length} sources gathered
              </span>
            </div>
          )}
        </div>
      )}

      <ActionButton onClick={run} disabled={loading} loading={loading} icon={Radar} color="emerald">
        {t("gather.startGathering")}
      </ActionButton>
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
        topic, projectId, format: format as any, scenario: scenario as any,
        focus, language, field,
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
    <div className="px-6 py-5 space-y-4">
      <InfoBanner icon={PenLine} text={t("unifiedWrite.paragraphDesc")} color="sky" />

      <div className="grid grid-cols-2 gap-3">
        <ConfigCard label={t("topic.formatLabel")} icon={Layers}>
          <Select value={format} onValueChange={setFormat}>
            <SelectTrigger className="text-xs h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PARAGRAPH_FORMATS.map((f) => <SelectItem key={f.id} value={f.id} className="text-xs">{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </ConfigCard>
        <ConfigCard label={t("topic.scenarioLabel")} icon={Network}>
          <Select value={scenario} onValueChange={setScenario}>
            <SelectTrigger className="text-xs h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PARAGRAPH_SCENARIOS.map((s) => <SelectItem key={s.id} value={s.id} className="text-xs">{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </ConfigCard>
      </div>

      <ConfigCard label={t("topic.focusLabel")} icon={Sparkles}>
        <input
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder="e.g. focus on PAM-dependent unwinding mechanism"
          className="text-xs h-9 w-full rounded-md border border-input bg-background px-3 focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 transition-all"
        />
      </ConfigCard>

      <ConfigCard label={t("topic.languageLabel")}>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger className="text-xs h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="English" className="text-xs">{t("topic.langEnglish")}</SelectItem>
            <SelectItem value="中文" className="text-xs">{t("topic.langChinese")}</SelectItem>
            <SelectItem value="both" className="text-xs">{t("topic.langBoth")}</SelectItem>
          </SelectContent>
        </Select>
      </ConfigCard>

      {loading && (
        <div className="flex flex-col items-center gap-3 py-6">
          <div className="relative">
            <Loader2 className="h-8 w-8 animate-spin text-sky-500" />
            <div className="absolute inset-0 flex items-center justify-center">
              <PenLine className="h-3.5 w-3.5 text-sky-600" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground animate-pulse">{t("topic.researching")}</p>
        </div>
      )}

      <ActionButton onClick={run} disabled={loading} loading={loading} icon={PenLine} color="sky">
        {t("topic.generate")}
      </ActionButton>
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
      const projectData = await api.getProject(projectId);
      const paraIds = (projectData.project?.paragraphs || []).map((p: any) => p.id);
      await api.aiCompose({ projectId, title, paragraphIds: paraIds, depth });
      onInvalidate();
      toast.success(t("toast.articleComposed"));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="px-6 py-5 space-y-4">
      <InfoBanner icon={Layers} text={t("unifiedWrite.composeDesc")} color="violet" />

      <ConfigCard label={t("compose.articleTitle")} icon={FileText}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="text-xs h-9 w-full rounded-md border border-input bg-background px-3 focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all"
        />
      </ConfigCard>

      <ConfigCard label={t("compose.depth")} icon={Layers}>
        <div className="grid grid-cols-3 gap-2">
          {(["shallow", "standard", "deep"] as const).map((d) => {
            const isActive = depth === d;
            const labels: Record<string, string> = {
              shallow: t("compose.shallow"),
              standard: t("compose.standard"),
              deep: t("compose.deep"),
            };
            return (
              <button
                key={d}
                onClick={() => setDepth(d)}
                className={`text-[10px] px-2 py-2.5 rounded-md border transition-all ${
                  isActive
                    ? "border-violet-500 bg-violet-500/10 text-violet-600 dark:text-violet-400 font-medium ring-2 ring-violet-500/20"
                    : "border-border hover:bg-muted/40 text-muted-foreground"
                }`}
              >
                {labels[d]}
              </button>
            );
          })}
        </div>
      </ConfigCard>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground rounded-md bg-muted/30 p-2.5">
        <Layers className="h-3.5 w-3.5 text-violet-500" />
        <span className="font-medium">{paragraphCount}</span>
        <span>{t("compose.paragraphOrder")}</span>
      </div>

      {paragraphCount < 2 && (
        <InfoBanner icon={AlertCircle} text={t("compose.noParagraphs")} color="amber" />
      )}

      {loading && (
        <div className="flex flex-col items-center gap-3 py-6">
          <div className="relative">
            <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Layers className="h-3.5 w-3.5 text-violet-600" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground animate-pulse">{t("compose.composing")}</p>
        </div>
      )}

      <ActionButton onClick={run} disabled={loading || paragraphCount < 2} loading={loading} icon={Layers} color="violet">
        {t("compose.compose")}
      </ActionButton>
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
    { id: "gather", label: t("oneClick.stepGather"), icon: Database, color: "emerald" },
    { id: "curate", label: t("oneClick.stepCurate"), icon: Filter, color: "teal" },
    { id: "relationships", label: t("oneClick.stepRelationships"), icon: Network, color: "sky" },
    { id: "plan", label: t("oneClick.stepPlan"), icon: ListTree, color: "amber" },
    { id: "generate", label: t("oneClick.stepGenerate"), icon: PenLine, color: "violet" },
    { id: "compose", label: t("oneClick.stepCompose"), icon: FileStack, color: "rose" },
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
    <div className="px-6 py-5 space-y-4">
      <InfoBanner icon={Zap} text={t("unifiedWrite.fullDesc")} color="rose" />

      {/* Feature chips */}
      <div className="grid grid-cols-2 gap-2">
        {[
          { icon: Database, text: t("oneClick.forceRegather"), color: "emerald" },
          { icon: PenLine, text: t("oneClick.chunkedGen"), color: "violet" },
        ].map((chip, i) => {
          const chipColors = COLOR_CLASSES[chip.color];
          return (
            <div key={i} className={`flex items-center gap-1.5 rounded-md border ${chipColors.border} ${chipColors.bg} p-2`}>
              <chip.icon className={`h-3 w-3 ${chipColors.text} shrink-0`} />
              <span className={`text-[9px] font-medium ${chipColors.text}`}>{chip.text}</span>
            </div>
          );
        })}
      </div>

      <ConfigCard label={t("oneClick.outputLanguage")}>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger className="text-xs h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="English" className="text-xs">{t("topic.langEnglish")}</SelectItem>
            <SelectItem value="中文" className="text-xs">{t("topic.langChinese")}</SelectItem>
            <SelectItem value="both" className="text-xs">{t("topic.langBoth")}</SelectItem>
          </SelectContent>
        </Select>
      </ConfigCard>

      {/* Word count slider with visual feedback */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs flex items-center gap-1.5 font-medium text-foreground/80">
            <PenLine className="h-3 w-3 text-muted-foreground" />
            {t("oneClick.targetWordCount", { n: formatWords(targetWords) })}
          </Label>
          <span className="text-[10px] text-muted-foreground">{t("oneClick.maxWords")}</span>
        </div>
        <div className="relative">
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
        </div>
        <div className="flex justify-between text-[9px] text-muted-foreground">
          <span>2,000</span>
          <span className="font-medium text-primary">{formatWords(targetWords)} words</span>
          <span>50,000</span>
        </div>
        {/* Word tier indicator */}
        <div className="flex items-center gap-1.5">
          <div className={`h-1 flex-1 rounded-full transition-colors ${targetWords >= 2000 ? "bg-emerald-400" : "bg-muted"}`} />
          <div className={`h-1 flex-1 rounded-full transition-colors ${targetWords >= 8000 ? "bg-sky-400" : "bg-muted"}`} />
          <div className={`h-1 flex-1 rounded-full transition-colors ${targetWords >= 20000 ? "bg-violet-400" : "bg-muted"}`} />
          <div className={`h-1 flex-1 rounded-full transition-colors ${targetWords >= 35000 ? "bg-rose-400" : "bg-muted"}`} />
          <span className="text-[9px] text-muted-foreground ml-1 shrink-0 font-medium">
            {targetWords < 8000 ? "Short" : targetWords < 20000 ? "Medium" : targetWords < 35000 ? "Long" : "Comprehensive"}
          </span>
        </div>
      </div>

      {/* Progress timeline */}
      {isRunning && (
        <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/[0.02] p-3">
          {/* Overall progress bar */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-primary">
                {currentStep >= 0 && currentStep < STEPS.length
                  ? `Step ${currentStep + 1}/${STEPS.length}: ${STEPS[currentStep].label}`
                  : "Processing..."}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {Math.round(((currentStep + 1) / STEPS.length) * 100)}%
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary to-primary/70 transition-all duration-500 ease-out"
                style={{ width: `${((currentStep + 1) / STEPS.length) * 100}%` }}
              />
            </div>
          </div>

          {/* Step timeline */}
          <div className="space-y-1">
            {STEPS.map((step, i) => {
              const isDone = currentStep > i;
              const isActive = currentStep === i;
              const StepIcon = step.icon;
              const stepColors = COLOR_CLASSES[step.color];
              return (
                <div
                  key={step.id}
                  className={`flex items-center gap-2.5 rounded-md border p-2 transition-all ${
                    isDone
                      ? "border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/30 dark:bg-emerald-950/10"
                      : isActive
                      ? `${stepColors.border} ${stepColors.bg} ring-1 ring-primary/20`
                      : "border-border/40 opacity-50"
                  }`}
                >
                  <div className={`h-6 w-6 rounded-md flex items-center justify-center shrink-0 transition-all ${
                    isDone ? "bg-emerald-100 dark:bg-emerald-950/40" : isActive ? stepColors.bg : "bg-muted/40"
                  }`}>
                    {isDone ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                    ) : isActive ? (
                      <Loader2 className="h-3 w-3 animate-spin text-primary" />
                    ) : (
                      <StepIcon className="h-3 w-3 text-muted-foreground" />
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
      )}

      {/* Result */}
      {result && (
        <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 bg-gradient-to-br from-emerald-50/60 to-teal-50/30 dark:from-emerald-950/20 dark:to-teal-950/10 p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            </div>
            <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">{t("oneClick.generatedTitle")}</span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-md bg-background/40 p-2">
              <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400">{result.stats?.sourcesGathered || 0}</p>
              <p className="text-[8px] uppercase text-muted-foreground">{t("oneClick.sourcesGathered")}</p>
            </div>
            <div className="rounded-md bg-background/40 p-2">
              <p className="text-lg font-bold text-violet-700 dark:text-violet-400">{result.stats?.sectionsPlanned || 0}</p>
              <p className="text-[8px] uppercase text-muted-foreground">{t("oneClick.sectionsWritten")}</p>
            </div>
            <div className="rounded-md bg-background/40 p-2">
              <p className="text-lg font-bold text-rose-700 dark:text-rose-400">{result.stats?.articleWordCount || 0}</p>
              <p className="text-[8px] uppercase text-muted-foreground">{t("oneClick.totalWords")}</p>
            </div>
          </div>
        </div>
      )}

      <ActionButton onClick={run} disabled={isRunning} loading={isRunning} icon={Zap} color="rose">
        {t("oneClick.generateBtn")}
      </ActionButton>
    </div>
  );
}
