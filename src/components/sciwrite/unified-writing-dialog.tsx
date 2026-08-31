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
  AlertTriangle,
  Trash2,
  ArrowRight,
  FileText,
  Languages,
  Terminal,
  Clock,
  Settings,
  ChevronDown,
  Microscope,
  Target,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
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
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { PromptTemplateManager } from "./prompt-template-manager";
import { api } from "@/lib/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  /** Fired when a full-article generation starts — carries the pipeline's
   *  targetWords so the workspace progress bar can track the REAL goal
   *  instead of a stale hard-coded one (round 26). */
  onGenerationTargetWords?: (targetWords: number) => void;
}

const TAB_CONFIG: { id: WriteTab; icon: any }[] = [
  { id: "outline", icon: ListTree },
  { id: "gather", icon: Radar },
  { id: "paragraph", icon: PenLine },
  { id: "compose", icon: Layers },
  { id: "full", icon: Zap },
];

export function UnifiedWritingDialog({
  open,
  onOpenChange,
  projectId,
  topic,
  field,
  paragraphCount,
  initialTab = "outline",
  onGenerationTargetWords,
}: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = React.useState<WriteTab>(initialTab);
  // Track whether the Full Article tab is actively running its pipeline.
  // When true, the dialog widens so the streaming log can sit in its own
  // independent panel to the RIGHT of the main content — without squeezing
  // the main column's width. The main column stays at its natural max-w-5xl
  // width at all times so its content scrolls predictably.
  const [isFullArticleRunning, setIsFullArticleRunning] = React.useState(false);

  React.useEffect(() => {
    if (open) setActiveTab(initialTab);
  }, [open, initialTab]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["project", projectId] });
  const activeConfig = TAB_CONFIG.find((c) => c.id === activeTab)!;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={[
          // When the full-article pipeline is running, widen the dialog so
          // the streaming-log panel can sit beside the main content as an
          // independent column.
          //   Not running → max-w-5xl (64rem): main column only.
          //   Running     → max-w-7xl (80rem): main column (~60rem) +
          //                                     log panel (20rem).
          // (The Dialog component no longer carries a default sm:max-w-lg
          // that would override these — see ui/dialog.tsx.)
          isFullArticleRunning ? "max-w-7xl" : "max-w-5xl",
          // Only the Full Article tab gets a concrete h-[92vh]: its root is
          // absolutely positioned (absolute inset-0) and needs a real height
          // to fill. Every other tab lets its content define the dialog height
          // (capped by max-h-[92vh]) so short forms don't leave a tall empty
          // void below the primary action — the dialog hugs its content.
          activeTab === "full" ? "h-[92vh]" : "",
          "max-h-[92vh] flex flex-col gap-0 p-0 overflow-hidden rounded-xl border-border/60 shadow-xl",
        ].join(" ")}
      >
        {/* Header — clean single primary accent */}
        <div className="relative px-5 sm:px-6 pt-5 pb-4 border-b border-border/60 shrink-0 bg-gradient-to-br from-primary/[0.06] via-transparent to-transparent">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 ring-academic">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="flex items-center gap-2 font-serif-text text-lg font-semibold leading-snug tracking-tight">
                {t("unifiedWrite.title")}
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5 leading-relaxed">
                {t("unifiedWrite.desc")}
              </DialogDescription>
            </div>
          </div>
        </div>

        {/* Tab bar — segmented strip of filled primary-tint pills (the
            .tab-pill language from globals.css) so the active tab reads
            instantly instead of relying on a subtle underline tint. */}
        <div className="px-5 sm:px-6 pt-3 pb-3 border-b border-border/40 shrink-0 bg-muted/20">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as WriteTab)}>
            <TabsList className="flex w-full h-auto items-center gap-1 bg-muted/40 rounded-lg p-1">
              {TAB_CONFIG.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    className={`h-8 flex-1 px-3 text-[11px] rounded-md gap-1.5 transition-all ${
                      isActive ? "tab-pill" : "tab-pill-inactive"
                    }`}
                  >
                    <Icon className="size-3.5" />
                    <span className="hidden sm:inline">{t(`unifiedWrite.tab_${tab.id}`)}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        </div>

        {/* Content area — flex-1 so it fills remaining dialog height after the
            header + tab bar. min-h-0 is critical: without it the flex child
            would grow to fit its content instead of being constrained by the
            dialog's height (h-[92vh] on the Full Article tab, content-driven
            with a max-h-[92vh] cap everywhere else), and overflow-y-auto
            wouldn't trigger.
            For the Full Article tab we use `relative` (no overflow-y-auto)
            because FullArticleTab positions itself with `absolute inset-0`
            and manages its own internal scrolling (main column + log panel
            scroll independently). For all other tabs we use overflow-y-auto
            so their content scrolls when it exceeds the available height. */}
        <div className={`flex-1 min-h-0 overflow-hidden relative ${activeTab === "full" ? "" : "overflow-y-auto scroll-academic"}`}>
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
            <FullArticleTab
              projectId={projectId}
              topic={topic}
              field={field}
              paragraphCount={paragraphCount}
              onInvalidate={invalidate}
              onRunningChange={setIsFullArticleRunning}
              onGenerationTargetWords={onGenerationTargetWords}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==================== Shared UI components ====================
function ConfigCard({ label, children, icon: Icon, hint }: { label: string; children: React.ReactNode; icon?: any; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="eyebrow flex items-center gap-1.5">
        {Icon && <Icon className="h-3 w-3 text-muted-foreground" />}
        {label}
        {hint && <span className="text-[9px] font-normal normal-case tracking-normal text-muted-foreground/70 ml-1">{hint}</span>}
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
}: {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon: any;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="sm"
      className="btn-gradient-primary gap-1.5 text-[13px] w-full h-10 text-primary-foreground transition-all"
      onClick={onClick}
      disabled={disabled}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {children}
    </Button>
  );
}

function InfoBanner({ icon: Icon, text }: { icon: any; text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/[0.04] p-3">
      <Icon className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
      <p className="text-[11px] leading-relaxed text-foreground/70">{text}</p>
    </div>
  );
}

function LoadingState({ icon: Icon, text }: { icon: any; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8">
      <div className="relative">
        <Loader2 className="h-8 w-8 animate-spin text-primary/30" />
        <div className="absolute inset-0 flex items-center justify-center">
          <Icon className="h-3.5 w-3.5 text-primary" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground animate-pulse">{text}</p>
    </div>
  );
}

function SuccessCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 bg-gradient-to-br from-emerald-50/50 to-transparent dark:from-emerald-950/20 p-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">{title}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * Shared progress bar + live log component for all LLM tasks.
 * Shows a progress bar with current status message + a scrollable live log.
 */
function TaskProgress({
  logs,
  currentMessage,
}: {
  logs: { event: string; message: string; time: string }[];
  currentMessage?: string;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/[0.02] p-3">
      {/* Current status */}
      {currentMessage && (
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span className="text-[11px] font-medium text-primary">{currentMessage}</span>
        </div>
      )}
      {/* Progress bar (indeterminate animation) */}
      <div className="h-1.5 rounded-full bg-primary/10 overflow-hidden relative">
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-primary/40 to-transparent animate-shimmer" style={{
          backgroundSize: "200% 100%",
          animation: "shimmer 1.5s infinite linear",
        }} />
      </div>
      {/* Live log */}
      {logs.length > 0 && (
        <div className="rounded-md border border-border/40 bg-muted/20 p-2 max-h-32 overflow-y-auto scroll-academic space-y-0.5">
          {logs.slice(-8).map((log, i) => (
            <p key={i} className="text-[9px] text-muted-foreground font-mono leading-relaxed">
              <span className="text-primary/70">[{log.time}]</span>{" "}
              <span className="text-foreground/60">{log.message}</span>
            </p>
          ))}
        </div>
      )}
      <style>{`
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
      `}</style>
    </div>
  );
}

/** Hook to manage streaming task state (logs, loading, result) */
function useStreamingTask() {
  const [loading, setLoading] = React.useState(false);
  const [logs, setLogs] = React.useState<{ event: string; message: string; time: string }[]>([]);
  const [currentMessage, setCurrentMessage] = React.useState<string>("");

  const startTask = async (
    streamFn: (onEvent: (event: string, data: any) => void) => Promise<any>,
    onSuccess?: (data: any) => void,
    onError?: (err: Error) => void
  ) => {
    setLoading(true);
    setLogs([]);
    setCurrentMessage("Starting...");
    try {
      const result = await streamFn((event, data) => {
        if (data.message) {
          const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
          setLogs((prev) => [...prev, { event, message: data.message, time }]);
          setCurrentMessage(data.message);
        }
      });
      setCurrentMessage("");
      onSuccess?.(result);
      return result;
    } catch (err: any) {
      setCurrentMessage("");
      onError?.(err);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  return { loading, logs, currentMessage, startTask, setLoading };
}

// ==================== Outline Tab ====================
function OutlineTab({ projectId, topic, field, onInvalidate }: { projectId: string; topic: string; field?: string; onInvalidate: () => void }) {
  const { t } = useI18n();
  const [purpose, setPurpose] = React.useState("");
  const [result, setResult] = React.useState<any>(null);
  const { loading, logs, currentMessage, startTask } = useStreamingTask();

  const run = async () => {
    setResult(null);
    try {
      const data = await startTask(
        (onEvent) => api.aiOutlineStream({ projectId, purpose }, onEvent),
        (data) => {
          setResult(data);
          onInvalidate();
          toast.success(t("toast.outlineGenerated"));
        },
        (err) => toast.error(err.message)
      );
      return data;
    } catch {}
  };

  return (
    <div className="px-5 sm:px-6 py-5 space-y-4">
      <InfoBanner icon={Sparkles} text={t("unifiedWrite.outlineDesc")} />
      <ConfigCard label={t("outline.purpose")} icon={ArrowRight}>
        <textarea
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="e.g. Focus on structural mechanisms and therapeutic implications..."
          className="min-h-[100px] w-full rounded-lg border border-border bg-background p-3 text-sm leading-relaxed placeholder:text-muted-foreground/70 transition-all resize-none focus-visible:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/25"
        />
      </ConfigCard>

      {loading && <TaskProgress logs={logs} currentMessage={currentMessage} />}

      {result && (
        <SuccessCard title={`${t("outline.generateOutline")} ✓`}>
          <p className="text-xs text-muted-foreground italic leading-relaxed">{result.summary}</p>
          {result.outline?.map((item: any, i: number) => (
            <div key={i} className="rounded-md border border-border/50 bg-background/60 p-2.5 text-[11px] hover:border-primary/30 transition-colors">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground bg-muted rounded-md px-1.5 py-0.5">§{i + 1}</span>
                <Badge variant="outline" className="text-[8px] h-3.5 uppercase">{item.format}</Badge>
                <span className="font-medium flex-1 truncate">{item.title}</span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5 leading-relaxed pl-7">{item.focus?.slice(0, 120)}</p>
            </div>
          ))}
        </SuccessCard>
      )}

      <ActionButton onClick={run} disabled={loading} loading={loading} icon={ListTree}>
        {t("outline.generateOutline")}
      </ActionButton>
    </div>
  );
}

// ==================== Gather Tab ====================
function GatherTab({ projectId, topic, field, onInvalidate }: { projectId: string; topic: string; field?: string; onInvalidate: () => void }) {
  const { t } = useI18n();
  const [result, setResult] = React.useState<any>(null);
  const { loading, logs, currentMessage, startTask } = useStreamingTask();

  const run = async () => {
    setResult(null);
    try {
      await startTask(
        (onEvent) => api.aiGatherStream({ projectId, topic, field, mode: "organize", runQueries: true }, onEvent),
        (data) => {
          setResult(data);
          onInvalidate();
          toast.success(t("toast.sourcesGathered", { n: data.addedResults?.length || 0 }));
        },
        (err) => toast.error(err.message)
      );
    } catch {}
  };

  return (
    <div className="px-5 sm:px-6 py-5 space-y-4">
      <InfoBanner icon={Radar} text={t("unifiedWrite.gatherDesc")} />

      <div className="rounded-lg bg-primary/[0.04] border border-primary/15 p-4">
        <div className="flex items-center gap-1.5 mb-1">
          <FileText className="h-3 w-3 text-primary" />
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">{t("gather.researchTopic")}</p>
        </div>
        <p className="text-sm font-medium leading-snug">{topic}</p>
      </div>

      {loading && <TaskProgress logs={logs} currentMessage={currentMessage} />}

      {result && (
        <SuccessCard title={`${t("gather.organize")} ✓`}>
          <p className="text-xs text-muted-foreground leading-relaxed">{result.plan}</p>
          {result.addedResults?.length > 0 && (
            <div className="mt-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-primary/10 dark:bg-primary/20 text-primary text-[9px] font-semibold uppercase tracking-wide tabular-nums">
              <Database className="h-3 w-3 shrink-0" />
              {result.addedResults.length} sources gathered
            </div>
          )}
        </SuccessCard>
      )}

      <ActionButton onClick={run} disabled={loading} loading={loading} icon={Radar}>
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
  const { loading, logs, currentMessage, startTask } = useStreamingTask();

  const run = async () => {
    try {
      await startTask(
        (onEvent) => api.aiWriteStream({
          topic, projectId, format: format as any, scenario: scenario as any,
          focus, language, field,
        }, onEvent),
        () => {
          onInvalidate();
          toast.success(t("toast.paragraphGenerated"));
          setFocus("");
        },
        (err) => toast.error(err.message)
      );
    } catch {}
  };

  return (
    <div className="px-5 sm:px-6 py-5 space-y-4">
      <InfoBanner icon={PenLine} text={t("unifiedWrite.paragraphDesc")} />

      <div className="grid grid-cols-2 gap-3">
        <ConfigCard label={t("topic.formatLabel")} icon={Layers}>
          <Select value={format} onValueChange={setFormat}>
            <SelectTrigger className="text-xs h-9 rounded-lg border-border bg-background focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:border-primary/40"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PARAGRAPH_FORMATS.map((f) => <SelectItem key={f.id} value={f.id} className="text-xs">{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </ConfigCard>
        <ConfigCard label={t("topic.scenarioLabel")} icon={Network}>
          <Select value={scenario} onValueChange={setScenario}>
            <SelectTrigger className="text-xs h-9 rounded-lg border-border bg-background focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:border-primary/40"><SelectValue /></SelectTrigger>
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
          className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm placeholder:text-muted-foreground/70 transition-all focus-visible:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/25"
        />
      </ConfigCard>

      <ConfigCard label={t("topic.languageLabel")}>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger className="text-xs h-9 rounded-lg border-border bg-background focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:border-primary/40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="English" className="text-xs">{t("topic.langEnglish")}</SelectItem>
            <SelectItem value="中文" className="text-xs">{t("topic.langChinese")}</SelectItem>
            <SelectItem value="both" className="text-xs">{t("topic.langBoth")}</SelectItem>
          </SelectContent>
        </Select>
      </ConfigCard>

      {loading && <TaskProgress logs={logs} currentMessage={currentMessage} />}

      <ActionButton onClick={run} disabled={loading} loading={loading} icon={PenLine}>
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
  const { loading, logs, currentMessage, startTask } = useStreamingTask();

  const run = async () => {
    if (paragraphCount < 2) {
      toast.error(t("compose.noParagraphs"));
      return;
    }
    try {
      const projectData = await api.getProject(projectId);
      const paraIds = (projectData.project?.paragraphs || []).map((p: any) => p.id);
      await startTask(
        (onEvent) => api.aiComposeStream({ projectId, title, paragraphIds: paraIds, depth }, onEvent),
        () => {
          onInvalidate();
          toast.success(t("toast.articleComposed"));
        },
        (err) => toast.error(err.message)
      );
    } catch {}
  };

  return (
    <div className="px-5 sm:px-6 py-5 space-y-4">
      <InfoBanner icon={Layers} text={t("unifiedWrite.composeDesc")} />

      <ConfigCard label={t("compose.articleTitle")} icon={FileText}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm transition-all focus-visible:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/25"
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
                className={`h-9 w-full text-[11px] rounded-md transition-all ${
                  isActive ? "tab-pill" : "tab-pill-inactive"
                }`}
              >
                {labels[d]}
              </button>
            );
          })}
        </div>
      </ConfigCard>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground rounded-lg bg-muted/40 px-3 py-2.5">
        <Layers className="h-3.5 w-3.5 text-primary/70" />
        <span className="font-semibold tabular-nums text-foreground">{paragraphCount}</span>
        <span>{t("compose.paragraphOrder")}</span>
      </div>

      {paragraphCount < 2 && (
        <InfoBanner icon={AlertCircle} text={t("compose.noParagraphs")} />
      )}

      {loading && <TaskProgress logs={logs} currentMessage={currentMessage} />}

      <ActionButton onClick={run} disabled={loading || paragraphCount < 2} loading={loading} icon={Layers}>
        {t("compose.compose")}
      </ActionButton>
    </div>
  );
}

// ==================== Full Article Tab ====================
function FullArticleTab({ projectId, topic, field, paragraphCount, onInvalidate, onRunningChange, onGenerationTargetWords }: { projectId: string; topic: string; field?: string; paragraphCount: number; onInvalidate: () => void; onRunningChange?: (running: boolean) => void; onGenerationTargetWords?: (targetWords: number) => void }) {
  const { t } = useI18n();
  const [language, setLanguage] = React.useState("English");
  const [targetWords, setTargetWords] = React.useState(5000);
  // v2 evidence-grounded pipeline — default ON. "v1" keeps the legacy
  // one-pass numbering pipeline for comparison.
  const [pipeline, setPipeline] = React.useState<"v1" | "v2">("v2");
  const [currentStep, setCurrentStep] = React.useState(-1);
  const [stepProgress, setStepProgress] = React.useState<Record<string, string>>({});
  const [result, setResult] = React.useState<any>(null);
  const [streamLog, setStreamLog] = React.useState<any[]>([]);
  const [livePreview, setLivePreview] = React.useState<string>("");
  const [confirmClearOpen, setConfirmClearOpen] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  // Advanced tuning parameters — defaults match the backend's defaults so
  // leaving the panel collapsed produces identical behavior to before.
  const [maxDbQueries, setMaxDbQueries] = React.useState(25);
  const [maxWebSearchQueries, setMaxWebSearchQueries] = React.useState(8);
  const [sectionRefTopN, setSectionRefTopN] = React.useState(20);
  const [sectionDsTopN, setSectionDsTopN] = React.useState(15);
  const [maxTokens, setMaxTokens] = React.useState(16384);
  // Prompt template selection — lets the user pick a saved template whose
  // instruction is appended to the section-generation prompt.
  const [selectedTemplateId, setSelectedTemplateId] = React.useState<string>("");
  const [templateManagerOpen, setTemplateManagerOpen] = React.useState(false);
  const logEndRef = React.useRef<HTMLDivElement>(null);
  const logScrollRef = React.useRef<HTMLDivElement>(null);

  // Load available prompt templates for the template selector dropdown
  const { data: templateData } = useQuery({
    queryKey: ["prompt-templates", "generate"],
    queryFn: () => api.listPromptTemplates("generate"),
  });
  const templates = templateData?.templates || [];

  const isBothMode = language === "both";
  // round-27: the v2 evidence-grounded pipeline ALWAYS writes English first
  // (its citation-key machinery is English-first by design), so "中文" and
  // "both" BOTH mean "generate English → translate to 中文" in v2. The old
  // code hard-forced language="English" for v2 and the Chinese half was
  // silently dropped — bilingual users never got the translation.
  const v2Bilingual = pipeline === "v2" && (isBothMode || language === "中文");
  // Whether THIS run will include a translate stage (drives estimates, the
  // strategy panel and the step list). v1 only translates in "both" mode;
  // v2 translates in "both" AND "中文" mode.
  const willTranslate = pipeline === "v2" ? v2Bilingual : isBothMode;

  const STEPS = React.useMemo(() => {
    if (pipeline === "v2") {
      const base = [
        { id: "gather", label: t("oneClick.stepGather"), icon: Database },
        { id: "curate", label: t("oneClick.stepCurate"), icon: Filter },
        { id: "plan", label: t("oneClick.stepPlan"), icon: ListTree },
        { id: "analyze", label: t("oneClick.stepAnalyze") || "Analyze Evidence", icon: Microscope },
        { id: "allocate", label: t("oneClick.stepAllocate") || "Allocate Evidence", icon: Target },
        { id: "generate", label: t("oneClick.stepGenerate"), icon: PenLine },
        { id: "verify", label: t("oneClick.stepVerify") || "Adversarial Verify", icon: ShieldCheck },
        { id: "compose", label: t("oneClick.stepCompose"), icon: FileStack },
      ];
      // round-27: v2 translates AFTER compose (sections already carry final
      // global citation numbers), so the translate step comes last.
      return v2Bilingual
        ? [...base, { id: "translate", label: t("oneClick.stepTranslate"), icon: Languages }]
        : base;
    }
    const base = [
      { id: "gather", label: t("oneClick.stepGather"), icon: Database },
      { id: "curate", label: t("oneClick.stepCurate"), icon: Filter },
      { id: "relationships", label: t("oneClick.stepRelationships"), icon: Network },
      { id: "plan", label: t("oneClick.stepPlan"), icon: ListTree },
      { id: "generate", label: t("oneClick.stepGenerate"), icon: PenLine },
      ...(isBothMode
        ? [{ id: "translate", label: t("oneClick.stepTranslate"), icon: Languages }]
        : []),
      { id: "compose", label: t("oneClick.stepCompose"), icon: FileStack },
    ];
    return base;
  }, [t, isBothMode, pipeline, v2Bilingual]);

  // Auto-scroll the right-side log panel to bottom when new entries arrive
  React.useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [streamLog, livePreview]);

  const isRunning = currentStep >= 0 && currentStep < STEPS.length;

  // Notify the parent dialog whenever the running state changes, so the
  // dialog can widen to accommodate the independent right-side log panel
  // without squeezing the main column.
  React.useEffect(() => {
    onRunningChange?.(isRunning);
  }, [isRunning, onRunningChange]);

  const run = async () => {
    // If the project already has paragraphs or articles, show a confirmation
    // dialog before proceeding — the generation pipeline clears ALL existing
    // data (paragraphs, articles, data sources, references, annotations).
    if (paragraphCount > 0) {
      setConfirmClearOpen(true);
      return;
    }
    await doGenerate();
  };

  const doGenerate = async () => {
    setConfirmClearOpen(false);
    setCurrentStep(0);
    setStepProgress({});
    setResult(null);
    setStreamLog([]);
    setLivePreview("");
    // Report the real generation target so the workspace progress bar
    // tracks THIS run's goal (round 26 — no more fixed 1000w bar).
    onGenerationTargetWords?.(targetWords);
    try {
      const streamFn = pipeline === "v2" ? api.aiGenerateFullV2Stream : api.aiGenerateFullStream;
      const data = await streamFn(
        {
          projectId,
          // round-27: pass the REAL language choice to v2 too — the backend
          // now runs a translate stage for "both" (and "中文", which v2 maps
          // to English-first + translation since its evidence pipeline is
          // English-only). Previously this was hard-forced to "English" and
          // the Chinese half of bilingual runs was silently dropped.
          language,
          targetWords,
          ...(pipeline === "v2"
            ? { maxDbQueries, maxWebSearchQueries, maxTokens }
            : { maxDbQueries, maxWebSearchQueries, sectionRefTopN, sectionDsTopN, maxTokens }),
          // Pass the selected template's instruction to customize section
          // generation. Empty string = no custom instruction (default behavior).
          promptInstruction: (() => {
            if (!selectedTemplateId || selectedTemplateId === "none") return "";
            const tpl = templates.find((t: any) => t.id === selectedTemplateId);
            return tpl?.instruction || "";
          })(),
        },
        (event, data) => {
          const stepMap: Record<string, number> = {};
          STEPS.forEach((s, i) => { stepMap[s.id] = i; });
          // The backend sends { event: "step", step: "gather", status: "started" }
          // So we need to check data.step (not event, which is always "step")
          if (stepMap[data.step] !== undefined && data.status === "started") {
            setCurrentStep(stepMap[data.step]);
          }
          if (data.message) {
            setStreamLog((prev) => {
              const next = [...prev, { event, ...data, ts: Date.now() }];
              return next.length > 500 ? next.slice(-500) : next;
            });
            // round-27: key the per-step progress line by data.step (the
            // step indicator reads stepProgress[step.id]); the old
            // `[event]` key was always the literal "step" so the live line
            // under the active step never rendered.
            if (data.step) {
              setStepProgress((prev) => ({ ...prev, [data.step]: data.message }));
            }
          }
          // When the batch citation audit completes, show a toast notification
          // so the user knows the audit ran and what it found/fixed.
          if (data.step === "audit" && data.status === "done") {
            const checked = data.auditChecked || 0;
            const issues = data.auditIssues || 0;
            const fixed = data.auditFixed || 0;
            if (issues > 0) {
              toast.info(
                `Citation audit: ${checked} checked, ${issues} issues found, ${fixed} auto-fixed.`,
                { duration: 8000 }
              );
            } else {
              toast.success(
                `Citation audit: all ${checked} citations passed verification.`,
                { duration: 5000 }
              );
            }
          }
          // round-27: streaming previews arrive as { event: "step", step:
          // "generate"|"translate", status: "streaming", accumulatedTail } —
          // the old code tested `event === "generate"` which never matched
          // (event is always "step"), so the live preview stayed empty for
          // the whole run. Match on data.step instead.
          if (data.step === "generate" && data.status === "streaming" && data.accumulatedTail) {
            setLivePreview(data.accumulatedTail);
          } else if (data.step === "translate" && data.status === "streaming" && data.accumulatedTail) {
            setLivePreview(data.accumulatedTail);
          } else if (data.status === "started") {
            setLivePreview("");
          }
        }
      );
      setCurrentStep(STEPS.length);
      setResult(data);
      setLivePreview("");
      onInvalidate();
      // round-27: v1 sends { stats: { articleWordCount, referencesSaved } },
      // v2 sends both the stats block (added round-27) and flat
      // { wordCount, references } — read whichever shape this pipeline
      // returned so the toast never says "0 words" on success.
      const doneWords = data?.stats?.articleWordCount || data?.wordCount || 0;
      const doneRefs = data?.stats?.referencesSaved || data?.references || 0;
      toast.success(t("toast.oneClickGenerated", { words: doneWords, refs: doneRefs }));
    } catch (e: any) {
      setLivePreview("");
      toast.error(e.message);
    } finally {
      setCurrentStep(-1);
    }
  };

  const formatWords = (n: number) => n.toLocaleString();

  return (
    // Layout: when running, the outer flex row places the main column (which
    // keeps its full natural width and scrolls internally) next to an
    // independent streaming-log panel on the right. The log panel is a sibling
    // element with its own border, header, and scroll area — it does NOT share
    // the main column's width budget. When not running, only the main column
    // is rendered and it occupies the full dialog width.
    // Root: absolute inset-0 fills the content area (which is `relative`)
    // exactly. This gives the flex row a concrete height equal to the
    // content area's height, so the main column's overflow-y-auto triggers
    // correctly when content exceeds the dialog's max-h-[92vh].
    <div className="absolute inset-0 flex">
      {/* Main column: config + progress + results.
          Always flex-1 so its width never changes when the log panel
          appears/disappears. min-w-0 + overflow-y-auto ensure the
          column scrolls internally when its content exceeds the available
          height, instead of overflowing the dialog bounds. */}
      <div className="flex-1 min-w-0 overflow-y-auto scroll-academic px-5 sm:px-6 py-5 flex flex-col gap-4">
      <InfoBanner icon={Zap} text={t("unifiedWrite.fullDesc")} />

      {/* Pipeline selector — v2 evidence-grounded (default) vs v1 legacy */}
      <ConfigCard label={t("oneClick.pipelineLabel") || "Generation Pipeline"}>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setPipeline("v2")}
            className={`rounded-lg border p-2.5 text-left transition-all ${
              pipeline === "v2"
                ? "border-primary/60 bg-primary/[0.06] ring-academic"
                : "border-border hover:border-primary/30 hover:bg-muted/40"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <ShieldCheck className={`h-3.5 w-3.5 ${pipeline === "v2" ? "text-primary" : "text-muted-foreground"}`} />
              <span className="text-xs font-semibold">{t("oneClick.pipelineV2") || "v2 · Evidence-Grounded"}</span>
              {pipeline === "v2" && <Badge className="ml-auto h-4 px-1 text-[8px] bg-primary">DEFAULT</Badge>}
            </div>
            <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
              {t("oneClick.pipelineV2Desc") ||
                "Analyze sources → extract evidence claims → allocate to sections → write with structural citation keys → adversarially verify every citation. Highest citation accuracy."}
            </p>
          </button>
          <button
            type="button"
            onClick={() => setPipeline("v1")}
            className={`rounded-lg border p-2.5 text-left transition-all ${
              pipeline === "v1"
                ? "border-primary/60 bg-primary/[0.06] ring-academic"
                : "border-border hover:border-primary/30 hover:bg-muted/40"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <PenLine className={`h-3.5 w-3.5 ${pipeline === "v1" ? "text-primary" : "text-muted-foreground"}`} />
              <span className="text-xs font-semibold">{t("oneClick.pipelineV1") || "v1 · Standard"}</span>
            </div>
            <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
              {t("oneClick.pipelineV1Desc") ||
                "Legacy pipeline: relationship analysis + per-section keyword filtering + LLM-written numeric citations."}
            </p>
          </button>
        </div>
      </ConfigCard>

      {pipeline === "v2" && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-start gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
                {t("oneClick.v2AccuracyTitle") || "Citation accuracy guarantees (v2)"}
              </p>
              <ul className="text-[10px] text-muted-foreground leading-relaxed list-disc ml-3 space-y-0.5">
                <li>{t("oneClick.v2AccuracyKeyed") || "The model never writes citation numbers — structural {{Rn}} keys are converted to numbers by code"}</li>
                <li>{t("oneClick.v2AccuracyEvidence") || "Writing draws on evidence claims extracted from each source (analyze → allocate → write)"}</li>
                <li>{t("oneClick.v2AccuracyVerify") || "Every citation is adversarially verified against the reference's own abstract before saving"}</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Feature chips — unified brand-tint chip language */}
      <div className="flex flex-wrap gap-1.5">
        <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-primary/10 dark:bg-primary/20 text-primary text-[9px] font-semibold uppercase tracking-wide">
          <Database className="h-3 w-3 shrink-0" />
          {t("oneClick.forceRegather")}
        </div>
        <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-primary/10 dark:bg-primary/20 text-primary text-[9px] font-semibold uppercase tracking-wide">
          <PenLine className="h-3 w-3 shrink-0" />
          {t("oneClick.chunkedGen")}
        </div>
      </div>

      <ConfigCard label={t("oneClick.outputLanguage")}>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger className="text-xs h-9 rounded-lg border-border bg-background focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:border-primary/40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="English" className="text-xs">{t("topic.langEnglish")}</SelectItem>
            <SelectItem value="中文" className="text-xs">{t("topic.langChinese")}</SelectItem>
            <SelectItem value="both" className="text-xs">{t("topic.langBoth")}</SelectItem>
          </SelectContent>
        </Select>
      </ConfigCard>

      {/* Bilingual strategy info — shown when the run will produce a Chinese
          half ("both" in either pipeline, or "中文" in v2 which maps to
          English-first + translation) */}
      {willTranslate && (
        <div className="rounded-lg border border-fuchsia-200/60 dark:border-fuchsia-900/40 bg-fuchsia-50/40 dark:bg-fuchsia-950/20 p-3">
          <div className="flex items-start gap-2">
            <Languages className="h-3.5 w-3.5 text-fuchsia-600 dark:text-fuchsia-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fuchsia-700 dark:text-fuchsia-400">
                {t("oneClick.bothStrategyTitle")}
              </p>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                {t("oneClick.bothStrategyDesc")}
              </p>
              <ol className="text-[10px] text-muted-foreground leading-relaxed list-decimal ml-3 space-y-0.5">
                <li>Generate English full article (sections 1→N)</li>
                <li>{pipeline === "v2" ? "Compose + verify the English article with global citation numbers" : "Translate each section EN → 中文 (one by one)"}</li>
                <li>{pipeline === "v2" ? "Translate every section EN → 中文 (citations [n] preserved verbatim)" : "Compose bilingual article with shared references"}</li>
                {pipeline === "v2" && <li>Compose bilingual article with shared references</li>}
              </ol>
            </div>
          </div>
        </div>
      )}

      {/* Word count slider with visual feedback */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="eyebrow flex items-center gap-1.5">
            <PenLine className="h-3 w-3 text-muted-foreground" />
            {t("oneClick.targetWordCount", { n: formatWords(targetWords) })}
          </Label>
          <span className="text-[10px] text-muted-foreground">{t("oneClick.maxWords")}</span>
        </div>
        <div className="relative pt-1">
          <Slider
            min={2000}
            max={50000}
            step={1000}
            value={[targetWords]}
            onValueChange={(vals) => setTargetWords(vals[0])}
            className="w-full"
          />
        </div>
        <div className="flex justify-between text-[9px] text-muted-foreground tabular-nums">
          <span>2,000</span>
          <span className="font-semibold text-primary">{formatWords(targetWords)} words</span>
          <span>50,000</span>
        </div>
        {/* Word tier indicator — unified primary */}
        <div className="flex items-center gap-1.5">
          <div className={`h-1 flex-1 rounded-full transition-colors ${targetWords >= 2000 ? "bg-primary/60" : "bg-muted"}`} />
          <div className={`h-1 flex-1 rounded-full transition-colors ${targetWords >= 8000 ? "bg-primary/60" : "bg-muted"}`} />
          <div className={`h-1 flex-1 rounded-full transition-colors ${targetWords >= 20000 ? "bg-primary/60" : "bg-muted"}`} />
          <div className={`h-1 flex-1 rounded-full transition-colors ${targetWords >= 35000 ? "bg-primary/60" : "bg-muted"}`} />
          <span className="text-[9px] text-muted-foreground ml-1 shrink-0 font-medium">
            {targetWords < 8000 ? "Short" : targetWords < 20000 ? "Medium" : targetWords < 35000 ? "Long" : "Comprehensive"}
          </span>
        </div>
      </div>

      {/* Estimated cost & time panel — sky-themed */}
      <div className="rounded-lg border border-sky-200/60 dark:border-sky-900/40 bg-sky-50/40 dark:bg-sky-950/20 p-3 space-y-2">
        <div className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400 shrink-0" />
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-700 dark:text-sky-400 flex-1">
            {t("oneClick.estimates") || "Estimated cost & duration"}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md bg-background/50 dark:bg-background/30 p-2 text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">
              {t("oneClick.estTime") || "Time"}
            </p>
            <p className="text-sm font-bold tabular-nums text-sky-700 dark:text-sky-400">
              {(() => {
                const genSec = (targetWords / 100) * 1.2 * 1.3 + 60;
                const transSec = willTranslate ? (targetWords / 100) * 0.6 * 1.3 : 0;
                const total = Math.max(2, Math.round((genSec + transSec) / 60));
                return `${Math.max(1, Math.round(total * 0.7))}–${Math.round(total * 1.4)}m`;
              })()}
            </p>
          </div>
          <div className="rounded-md bg-background/50 dark:bg-background/30 p-2 text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">
              {t("oneClick.estTokens") || "Tokens"}
            </p>
            <p className="text-sm font-bold tabular-nums text-violet-700 dark:text-violet-400">
              ~{(() => {
                const genTok = (targetWords * 1.4) / 1000;
                const transTok = willTranslate ? (targetWords * 2.0) / 1000 : 0;
                return Math.round((genTok + transTok) * 10) / 10;
              })()}k
            </p>
          </div>
          <div className="rounded-md bg-background/50 dark:bg-background/30 p-2 text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">
              {t("oneClick.estCalls") || "LLM calls"}
            </p>
            <p className="text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
              ~{(() => {
                const sections = Math.max(5, Math.ceil(targetWords / 600));
                return 4 + sections + (willTranslate ? sections : 0);
              })()}
            </p>
          </div>
        </div>
        <div className="space-y-1 pt-1 border-t border-sky-200/30 dark:border-sky-900/30">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">{t("oneClick.estSources") || "Sources to gather"}:</span>
            <span className="font-medium tabular-nums text-foreground/80">~{Math.min(50, Math.max(15, Math.floor(targetWords / 150)))}</span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">{t("oneClick.estSections") || "Sections to write"}:</span>
            <span className="font-medium tabular-nums text-foreground/80">~{Math.max(5, Math.ceil(targetWords / 600))}</span>
          </div>
          {willTranslate && (
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground">{t("oneClick.estTranslate") || "Sections to translate"}:</span>
              <span className="font-medium tabular-nums text-fuchsia-700 dark:text-fuchsia-400">~{Math.max(5, Math.ceil(targetWords / 600))} (EN → 中文)</span>
            </div>
          )}
        </div>
        <p className="text-[9px] text-muted-foreground/70 italic">
          {t("oneClick.estimatesDisclaimer") || "Estimates only — actual time depends on LLM provider load and source availability."}
        </p>
      </div>

      {/* Advanced settings — collapsible panel for tuning gathering + filtering.
          Collapsed by default so casual users see the same clean UI as before.
          Expanded reveals sliders/inputs for the parameters that were previously
          hard-coded in the backend (maxDbQueries, maxWebSearchQueries,
          sectionRefTopN, sectionDsTopN, maxTokens). */}
      <div className="rounded-lg border border-border/60 bg-muted/20">
        <button
          type="button"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="w-full flex items-center justify-between px-3 py-2 text-left"
        >
          <div className="flex items-center gap-1.5">
            <Settings className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] font-semibold text-foreground/80">
              {t("oneClick.advancedSettings") || "Advanced settings"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!advancedOpen && (
              <span className="text-[9px] text-muted-foreground/70">
                {t("oneClick.advancedHint") || "Tune gathering & reference filtering"}
              </span>
            )}
            <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
          </div>
        </button>
        {advancedOpen && (
          <div className="px-3 pb-3 pt-1 border-t border-border/40 space-y-3">
            {/* Helper: renders a numeric input with label + hint. Value 0
                means "no upper limit" (shown as ∞ in the input). Unlike a
                slider, the input lets users type exact values directly and
                supports 0 for unlimited without dragging to the far left. */}
            {(() => {
              const NumField = (props: {
                label: string;
                hint: string;
                value: number;
                min: number;
                max: number;
                placeholder?: string;
                onChange: (v: number) => void;
              }) => {
                const isUnlimited = props.value === 0;
                return (
                  <div className="space-y-1">
                    <Label className="eyebrow flex items-center justify-between">
                      <span>{props.label}</span>
                      {isUnlimited && (
                        <span className="text-[9px] font-mono font-semibold text-fuchsia-600 dark:text-fuchsia-400">∞ unlimited</span>
                      )}
                    </Label>
                    <input
                      type="number"
                      min={props.min}
                      max={props.max}
                      value={props.value}
                      placeholder={props.placeholder}
                      onChange={(e) => {
                        const v = e.target.value === "" ? 0 : Number(e.target.value);
                        if (!isNaN(v)) props.onChange(v);
                      }}
                      className="w-full h-8 rounded-lg border border-border bg-background px-2.5 text-[11px] font-mono tabular-nums transition-all focus-visible:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/25"
                    />
                    <p className="text-[8px] text-muted-foreground/60">{props.hint}</p>
                  </div>
                );
              };
              return (
                <>
                  {/* Gathering section */}
                  <div className="space-y-2">
                    <p className="eyebrow">
                      {t("oneClick.advGathering") || "Data gathering"}
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <NumField
                        label={t("oneClick.advMaxDbQueries") || "Max database queries"}
                        hint={t("oneClick.advMaxDbQueriesHint") || "PubMed + RCSB + UniProt + NCBI + BLAST combined. 0 = no limit"}
                        value={maxDbQueries} min={0} max={50}
                        onChange={setMaxDbQueries}
                      />
                      <NumField
                        label={t("oneClick.advMaxWebQueries") || "Max web search queries"}
                        hint={t("oneClick.advMaxWebQueriesHint") || "Supplementary web searches. 0 = no limit"}
                        value={maxWebSearchQueries} min={0} max={20}
                        onChange={setMaxWebSearchQueries}
                      />
                    </div>
                  </div>

                  {/* Reference filtering section */}
                  <div className="space-y-2">
                    <p className="eyebrow">
                      {t("oneClick.advRefFiltering") || "Per-section reference filtering"}
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <NumField
                        label={t("oneClick.advRefTopN") || "Top refs per section"}
                        hint={t("oneClick.advRefTopNHint") || "Higher = more refs. 0 = no limit (keep all)"}
                        value={sectionRefTopN} min={0} max={40}
                        onChange={setSectionRefTopN}
                      />
                      <NumField
                        label={t("oneClick.advDsTopN") || "Top data sources per section"}
                        hint={t("oneClick.advDsTopNHint") || "Structural/sequence data. 0 = no limit (keep all)"}
                        value={sectionDsTopN} min={0} max={30}
                        onChange={setSectionDsTopN}
                      />
                    </div>
                  </div>

                  {/* LLM section — maxTokens does NOT support 0 (hard floor 4096) */}
                  <div className="space-y-2">
                    <p className="eyebrow">
                      {t("oneClick.advLlm") || "LLM output"}
                    </p>
                    <div className="space-y-1">
                      <Label className="eyebrow">
                        {t("oneClick.advMaxTokens") || "Max output tokens"}
                      </Label>
                      <input
                        type="number" min={4096} max={32768} step={2048}
                        value={maxTokens}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (!isNaN(v) && v >= 4096) setMaxTokens(v);
                        }}
                        className="w-full h-8 rounded-lg border border-border bg-background px-2.5 text-[11px] font-mono tabular-nums transition-all focus-visible:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/25"
                      />
                      <p className="text-[8px] text-muted-foreground/60">{t("oneClick.advMaxTokensHint") || "Higher allows longer sections but uses more tokens. Minimum 4096."}</p>
                    </div>
                  </div>
                </>
              );
            })()}

            {/* Prompt template selector — lets the user pick a saved template
                whose instruction is appended to section-generation prompts. */}
            <div className="space-y-2">
              <p className="eyebrow">
                {t("template.sectionLabel") || "Prompt Template"}
              </p>
              <div className="flex items-center gap-2">
                <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
                  <SelectTrigger className="text-xs h-8 flex-1 rounded-lg border-border bg-background focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:border-primary/40">
                    <SelectValue placeholder={t("template.selectPlaceholder") || "Default (no custom template)"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none" className="text-xs">
                      {t("template.defaultOption") || "Default (no custom template)"}
                    </SelectItem>
                    {templates.map((tpl: any) => (
                      <SelectItem key={tpl.id} value={tpl.id} className="text-xs">
                        {tpl.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-[10px] h-8 px-2 shrink-0"
                  onClick={() => setTemplateManagerOpen(true)}
                  title={t("template.title") || "Manage Templates"}
                >
                  <Settings className="h-3.5 w-3.5" />
                </Button>
              </div>
              {selectedTemplateId && selectedTemplateId !== "none" && (
                <p className="text-[8px] text-muted-foreground/60">
                  {(() => {
                    const tpl = templates.find((t: any) => t.id === selectedTemplateId);
                    return tpl?.instruction?.slice(0, 80) || "";
                  })()}
                </p>
              )}
            </div>

            {/* Reset button */}
            <div className="flex justify-end pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="text-[10px] h-6 px-2 text-muted-foreground"
                onClick={() => {
                  setMaxDbQueries(25);
                  setMaxWebSearchQueries(8);
                  setSectionRefTopN(20);
                  setSectionDsTopN(15);
                  setMaxTokens(16384);
                }}
              >
                {t("oneClick.advReset") || "Reset to defaults"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Progress timeline */}
      {isRunning && (
        <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/[0.02] p-3">
          {/* Overall progress bar */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold tabular-nums text-primary">
                {currentStep >= 0 && currentStep < STEPS.length
                  ? `Step ${currentStep + 1}/${STEPS.length}: ${STEPS[currentStep].label}`
                  : "Processing..."}
              </span>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {Math.round(((currentStep + 1) / STEPS.length) * 100)}%
              </span>
            </div>
            <Progress
              value={((currentStep + 1) / STEPS.length) * 100}
              className="h-2 progress-glow"
            />
          </div>

          {/* Step timeline */}
          <div className="space-y-1">
            {STEPS.map((step, i) => {
              const isDone = currentStep > i;
              const isActive = currentStep === i;
              const StepIcon = step.icon;
              return (
                <div
                  key={step.id}
                  className={`flex items-center gap-2.5 rounded-md border p-2 transition-all ${
                    isDone
                      ? "border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/30 dark:bg-emerald-950/10"
                      : isActive
                      ? "border-primary/40 bg-primary/[0.05] ring-1 ring-primary/20"
                      : "border-border/40 opacity-50"
                  }`}
                >
                  <div className={`h-6 w-6 rounded-md flex items-center justify-center shrink-0 transition-all ${
                    isDone ? "bg-emerald-100 dark:bg-emerald-950/40" : isActive ? "bg-primary/10" : "bg-muted/40"
                  }`}>
                    {isDone ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
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
                  {isDone && <span className="text-[9px] text-emerald-600 dark:text-emerald-400 font-semibold">✓</span>}
                </div>
              );
            })}
          </div>

          {/* Live preview of streaming content */}
          {/* Live preview removed from left column — shown only in right panel */}

          {/* Inline log removed from left column — shown only in right panel */}
        </div>
      )}

      {/* Result */}
      {result && (
        <SuccessCard title={t("oneClick.generatedTitle")}>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-md bg-background/60 p-2">
              <p className="text-lg font-bold tabular-nums text-primary">{result.stats?.sourcesGathered || result.sourcesGathered || 0}</p>
              <p className="text-[8px] uppercase text-muted-foreground">{t("oneClick.sourcesGathered")}</p>
            </div>
            <div className="rounded-md bg-background/60 p-2">
              <p className="text-lg font-bold tabular-nums text-primary">{result.stats?.sectionsPlanned || result.sections || 0}</p>
              <p className="text-[8px] uppercase text-muted-foreground">{t("oneClick.sectionsWritten")}</p>
            </div>
            <div className="rounded-md bg-background/60 p-2">
              <p className="text-lg font-bold tabular-nums text-foreground">
                {/* round-27: v2's complete event now carries the v1-shaped
                    stats block, but keep flat-field fallbacks so either
                    pipeline shape renders real numbers instead of 0. */}
                {result.hasChinese
                  ? `${result.stats?.articleWordCount || result.wordCount || 0} / ${result.stats?.articleWordCountZh || result.wordCountZh || 0}`
                  : result.stats?.articleWordCount || result.wordCount || 0}
              </p>
              <p className="text-[8px] uppercase text-muted-foreground">
                {result.hasChinese ? "EN words / ZH chars" : t("oneClick.totalWords")}
              </p>
            </div>
          </div>
          {result.hasChinese && (
            <div className="mt-2 flex items-center justify-center gap-1.5 text-[10px] text-fuchsia-700 dark:text-fuchsia-400">
              <Languages className="h-3 w-3" />
              <span>Bilingual article generated — toggle EN/中文 in the article viewer</span>
            </div>
          )}
        </SuccessCard>
      )}

      {/* mt-auto anchors the primary action to the bottom of the tall
          full-article column so the layout reads as a complete action bar
          instead of trailing off into empty space on tall screens. The
          hairline top border gives the action bar a deliberate footer
          weight whether the column is scrolled or anchored. */}
      <div className="mt-auto pt-3 border-t border-border/60">
        <ActionButton onClick={run} disabled={isRunning} loading={isRunning} icon={Zap}>
          {t("oneClick.generateBtn")}
        </ActionButton>
      </div>

      {/* Prompt template manager — create/edit/delete templates */}
      <PromptTemplateManager open={templateManagerOpen} onOpenChange={setTemplateManagerOpen} />

      {/* Confirmation dialog — shown when the project already has paragraphs/articles.
          The generation pipeline clears ALL existing data before re-generating. */}
      <AlertDialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <AlertDialogContent className="max-w-md rounded-xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" />
              {t("oneClick.confirmClearTitle") || "Clear existing data?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-relaxed">
              {t("oneClick.confirmClearDesc") || "This project already has"}{" "}
              <strong className="text-foreground">{paragraphCount}</strong>{" "}
              {t("oneClick.confirmClearParagraphs") || "paragraph(s)"}.
              {" "}
              {t("oneClick.confirmClearWarning") || "Generating a new full article will permanently delete ALL existing paragraphs, articles, data sources, references, and annotations before re-generating from scratch. This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-md border border-amber-200/60 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-950/20 p-3 my-2">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="text-[11px] text-amber-700 dark:text-amber-400 space-y-1">
                <p className="font-semibold">
                  {t("oneClick.confirmClearWillDelete") || "The following will be deleted:"}
                </p>
                <ul className="list-disc ml-4 space-y-0.5 text-muted-foreground">
                  <li>{t("oneClick.confirmClearParagraphsItem") || "All paragraphs (sections)"}</li>
                  <li>{t("oneClick.confirmClearArticlesItem") || "All composed articles"}</li>
                  <li>{t("oneClick.confirmClearSourcesItem") || "All gathered data sources"}</li>
                  <li>{t("oneClick.confirmClearRefsItem") || "All references and annotations"}</li>
                </ul>
              </div>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">
              {t("common.cancel") || "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              className="text-xs gap-1.5 bg-amber-600 hover:bg-amber-700 text-white"
              onClick={() => doGenerate()}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("oneClick.confirmClearBtn") || "Clear & Generate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>

      {/* Independent streaming-log panel — rendered ONLY when the pipeline
          is running. This is a SIBLING of the main column, not a child, so
          it has its own fixed width (w-80 = 20rem) and does NOT eat into the
          main column's width budget. The parent dialog widens to max-w-7xl
          when running to make room for this panel beside the main column.

          The panel is a self-contained card: its own border, header bar with
          title + log count + clear button, a scrollable log area, and a
          sticky live-preview footer that follows the streaming output. */}
      {isRunning && (
        <aside className="w-80 shrink-0 flex flex-col h-full border-l border-border/60 bg-muted/20">
          {/* Panel header — independent title bar */}
          <div className="px-3 py-2.5 border-b border-border/40 shrink-0 flex items-center gap-1.5 bg-muted/40">
            <Terminal className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-wider flex-1 truncate">
              {t("oneClick.detailedLog") || "Detailed log"}
            </span>
            <span className="text-[9px] font-mono text-muted-foreground/70 shrink-0 tabular-nums">
              {streamLog.length}
            </span>
          </div>

          {/* Scrollable log area — grows to fill, scrolls independently */}
          <div
            className="flex-1 min-h-0 overflow-y-auto scroll-academic px-3 py-2 space-y-0.5 font-mono"
            ref={logScrollRef}
          >
            {streamLog.length === 0 && (
              <p className="text-[10px] text-muted-foreground/50 italic py-4 text-center">
                Waiting for pipeline output...
              </p>
            )}
            {streamLog.map((log: any, i: number) => (
              <div key={i} className="text-[9px] leading-relaxed flex gap-1.5">
                <span className="text-muted-foreground/60 shrink-0 tabular-nums">
                  {new Date(log.ts).toLocaleTimeString([], { hour12: false })}
                </span>
                <span className="shrink-0 font-semibold text-primary">[{log.step}]</span>
                {log.status && log.status !== "progress" && (
                  <span className="shrink-0 font-semibold text-muted-foreground">{log.status}</span>
                )}
                <span className="text-foreground/70 break-words">{log.message}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>

          {/* Live preview — sticky at the bottom of the log panel so the
              currently-streaming text is always visible without scrolling */}
          {livePreview && (
            <div className="shrink-0 border-t border-border/40 p-2.5">
              {/* Streaming text sits on a canvas-paper sheet — the
                  "document being born" surface. */}
              <div className="canvas-paper rounded-lg p-3">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <PenLine className="h-3 w-3 text-violet-600 dark:text-violet-400 animate-pulse shrink-0" />
                  <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-violet-700 dark:text-violet-400 flex-1 truncate">
                    {t("oneClick.livePreview") || "Live preview"}
                  </p>
                </div>
                <p className="text-[10px] text-foreground/80 font-mono leading-relaxed max-h-28 overflow-y-auto scroll-academic whitespace-pre-wrap break-words">
                  {livePreview}
                  <span className="inline-block w-1.5 h-3 bg-violet-500 animate-pulse ml-0.5 align-middle" />
                </p>
              </div>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
