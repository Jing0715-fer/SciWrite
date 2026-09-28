"use client";

import * as React from "react";
import {
  History,
  Loader2,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  SkipForward,
  XCircle,
  Activity,
  CircleDashed,
  Trash2,
  FileText,
  RefreshCw,
  RotateCcw,
  Zap,
  Clock,
  FileText as WordsIcon,
  Quote,
  Layers,
  Target,
  ShieldCheck,
  Scissors,
  Wrench,
  Cpu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useI18n, type TranslationKey } from "@/lib/i18n";

/**
 * RunTimelineDialog — round-cs-1 (ClawsGO Science-inspired upgrade).
 *
 * "可追溯、可复现：每个动作都有时间线记录，整次运行可重放" —
 * every pipeline launch is persisted as a TaskRun row (see lib/run-recorder.ts
 * + /api/task-runs), and this dialog REPLAYS any past run: what steps ran,
 * in what order, how long each took, what the run produced, and why it
 * stopped. Also carries the provider/model transparency snapshot taken at
 * launch ("最强模型菜单，倍率透明").
 */

interface TaskStep {
  step: string;
  status: string;
  message?: string;
  ts: number;
  ms?: number;
  progress?: number;
  section?: number;
  total?: number;
}

interface TaskRunRow {
  id: string;
  runId: string;
  pipeline: string;
  topic?: string | null;
  language?: string | null;
  targetWords?: number | null;
  provider?: string | null;
  model?: string | null;
  status: string;
  resumed: boolean;
  steps: TaskStep[];
  stepCount: number;
  stepRollup: { done: number; skipped: number; failed: number };
  summary: {
    articleId?: string;
    wordCount?: number;
    references?: number;
    sections?: number;
    totalMs?: number;
    pipeline?: string;
    hasChinese?: boolean;
    partial?: boolean;
  } | null;
  stats: {
    stats?: Record<string, any>;
    accuracy?: Record<string, any>;
  } | null;
  error?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  articles?: any[];
  onOpenArticle?: (a: any) => void;
}

// Typed key maps for dynamic lookups (all keys exist in both dictionaries).
const STEP_LABEL_KEYS: Record<string, TranslationKey> = {
  init: "timeline.step.init",
  gather: "timeline.step.gather",
  knowledge: "timeline.step.knowledge",
  score: "timeline.step.score",
  curate: "timeline.step.curate",
  plan: "timeline.step.plan",
  // round-cs-2: research gap agent (STEP 3.5) + coherence polish (STEP 8.6)
  gapAgent: "timeline.step.gapAgent",
  analyze: "timeline.step.analyze",
  allocate: "timeline.step.allocate",
  generate: "timeline.step.generate",
  verify: "timeline.step.verify",
  compose: "timeline.step.compose",
  repair: "timeline.step.repair",
  polish: "timeline.step.polish",
  translate: "timeline.step.translate",
  review: "timeline.step.review",
  audit: "timeline.step.audit",
  relationships: "timeline.step.relationships",
  pipeline: "timeline.step.pipeline",
  recovery: "timeline.step.recovery",
};

const STATUS_LABEL_KEYS: Record<string, TranslationKey> = {
  completed: "timeline.status.completed",
  failed: "timeline.status.failed",
  aborted: "timeline.status.aborted",
  running: "timeline.status.running",
};

const STATUS_STYLE: Record<string, { dot: string; chip: string }> = {
  completed: {
    dot: "bg-emerald-500",
    chip: "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/25",
  },
  failed: {
    dot: "bg-rose-500",
    chip: "text-rose-700 dark:text-rose-400 bg-rose-500/10 border-rose-500/25",
  },
  aborted: {
    dot: "bg-amber-500",
    chip: "text-amber-700 dark:text-amber-400 bg-amber-500/10 border-amber-500/25",
  },
  running: {
    dot: "bg-primary animate-pulse",
    chip: "text-primary bg-primary/10 border-primary/25",
  },
};

function StepIcon({ status }: { status: string }) {
  const cls = "h-3 w-3 shrink-0";
  switch (status) {
    case "done":
      return <CheckCircle2 className={`${cls} text-emerald-600 dark:text-emerald-400`} />;
    case "skipped":
      return <SkipForward className={`${cls} text-muted-foreground`} />;
    case "failed":
      return <XCircle className={`${cls} text-rose-600 dark:text-rose-400`} />;
    case "streaming":
      return <Activity className={`${cls} text-primary animate-pulse`} />;
    default:
      return <CircleDashed className={`${cls} text-muted-foreground/70`} />;
  }
}

function fmtDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTime(ts: number | string): string {
  const d = typeof ts === "string" ? new Date(ts) : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function parseProviderSnap(json?: string | null): { generate?: string; review?: string } {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export function RunTimelineDialog({ open, onOpenChange, projectId, articles, onOpenArticle }: Props) {
  const { t } = useI18n();
  const [runs, setRuns] = React.useState<TaskRunRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/task-runs?projectId=${encodeURIComponent(projectId)}&limit=20`);
      if (res.ok) {
        const data = await res.json();
        setRuns(Array.isArray(data.runs) ? data.runs : []);
      } else {
        setRuns([]);
      }
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  React.useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const deleteRun = async (id: string) => {
    try {
      await fetch(`/api/task-runs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setRuns((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    } catch {}
  };

  const stepLabel = (s: string): string => {
    const key = STEP_LABEL_KEYS[s];
    return key ? t(key) : s;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden rounded-xl">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60 bg-gradient-to-r from-primary/5 to-transparent">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <History className="h-4 w-4 text-primary" />
            {t("timeline.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("timeline.subtitle")}
          </DialogDescription>
        </DialogHeader>

        {/* Toolbar */}
        <div className="flex items-center justify-between px-6 py-2 border-b border-border/40">
          <span className="text-[11px] text-muted-foreground">
            {runs && runs.length > 0
              ? t("timeline.runsCount", { n: runs.length })
              : t("timeline.noRunsYet")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] gap-1 focus-ring"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {t("timeline.refresh")}
          </Button>
        </div>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 py-4">
            {loading && !runs && (
              <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground text-xs">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("timeline.loading")}
              </div>
            )}
            {runs && runs.length === 0 && (
              <div className="text-center py-16">
                <History className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
                <p className="text-xs text-muted-foreground max-w-sm mx-auto leading-relaxed">
                  {t("timeline.empty")}
                </p>
              </div>
            )}
            {runs && runs.length > 0 && (
              <div className="flex flex-col gap-2">
                {runs.map((run) => (
                  <RunCard
                    key={run.id}
                    run={run}
                    expanded={expanded === run.id}
                    onToggle={() => setExpanded(expanded === run.id ? null : run.id)}
                    onDelete={() => void deleteRun(run.id)}
                    onOpenArticle={onOpenArticle}
                    article={
                      run.summary?.articleId
                        ? articles?.find((a) => a.id === run.summary?.articleId)
                        : undefined
                    }
                    stepLabel={stepLabel}
                  />
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function RunCard({
  run,
  expanded,
  onToggle,
  onDelete,
  onOpenArticle,
  article,
  stepLabel,
}: {
  run: TaskRunRow;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onOpenArticle?: (a: any) => void;
  article?: any;
  stepLabel: (s: string) => string;
}) {
  const { t } = useI18n();
  const style = STATUS_STYLE[run.status] ?? STATUS_STYLE.running;
  const prov = parseProviderSnap(run.provider);
  const stats = run.stats?.stats ?? {};
  const accuracy = run.stats?.accuracy ?? {};
  const summary = run.summary;
  const achievement =
    typeof stats.achievementRate === "number" ? stats.achievementRate : null;

  return (
    <div
      className={`stat-tile overflow-hidden transition-colors ${
        expanded ? "border-primary/40" : ""
      }`}
    >
      {/* Header row */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-accent/30 focus-ring rounded-[inherit]"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <span className={`h-2 w-2 rounded-full shrink-0 ${style.dot}`} />
        <span
          className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border shrink-0 ${style.chip}`}
        >
          {STATUS_LABEL_KEYS[run.status]
            ? t(STATUS_LABEL_KEYS[run.status])
            : run.status}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground shrink-0">
          {run.pipeline === "v1" ? "v1" : "v2"}
        </span>
        {run.resumed && (
          <span className="text-[10px] text-primary bg-primary/10 px-1.5 py-0.5 rounded shrink-0 inline-flex items-center gap-0.5">
            <RotateCcw className="h-2.5 w-2.5" />
            {t("timeline.resumed")}
          </span>
        )}
        <span className="flex-1 min-w-0 truncate text-[11px] text-foreground/80">
          {run.topic || "—"}
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 hidden sm:inline">
          {summary?.wordCount != null
            ? `${summary.wordCount.toLocaleString()}w · `
            : ""}
          {run.durationMs != null ? fmtDuration(run.durationMs) : fmtAgo(run.startedAt)}
        </span>
        <span className="text-[10px] text-muted-foreground/70 shrink-0 hidden md:inline">
          {fmtAgo(run.startedAt)}
        </span>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border/40 acad-fade-in">
          {/* Outcome stats grid */}
          {summary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              <MiniStat
                icon={<WordsIcon className="h-3 w-3 text-primary" />}
                label={t("timeline.words")}
                value={summary.wordCount?.toLocaleString() ?? "—"}
              />
              <MiniStat
                icon={<Quote className="h-3 w-3 text-amber-600 dark:text-amber-400" />}
                label={t("timeline.references")}
                value={String(summary.references ?? "—")}
              />
              <MiniStat
                icon={<Layers className="h-3 w-3 text-primary" />}
                label={t("timeline.sections")}
                value={String(summary.sections ?? "—")}
              />
              <MiniStat
                icon={<Target className="h-3 w-3 text-primary" />}
                label={t("timeline.achievement")}
                value={achievement != null ? `${achievement}%` : "—"}
              />
              <MiniStat
                icon={<ShieldCheck className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />}
                label={t("timeline.checked")}
                value={
                  accuracy.citationsChecked != null
                    ? String(accuracy.citationsChecked)
                    : "—"
                }
              />
              <MiniStat
                icon={<Scissors className="h-3 w-3 text-rose-600 dark:text-rose-400" />}
                label={t("timeline.removed")}
                value={
                  accuracy.citationsRemoved != null
                    ? String(accuracy.citationsRemoved)
                    : "—"
                }
              />
              <MiniStat
                icon={<Wrench className="h-3 w-3 text-primary" />}
                label={t("timeline.repairRounds")}
                value={
                  accuracy.autoRepairRounds != null
                    ? String(accuracy.autoRepairRounds)
                    : "—"
                }
              />
              <MiniStat
                icon={<Clock className="h-3 w-3 text-muted-foreground" />}
                label={t("timeline.totalTime")}
                value={fmtDuration(run.durationMs ?? summary.totalMs)}
              />
            </div>
          )}

          {/* Provider transparency */}
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <span className="eyebrow inline-flex items-center gap-1">
              <Cpu className="h-3 w-3" />
              {t("timeline.providerSnapshot")}
            </span>
            {prov.generate ? (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/60 border border-border/60">
                {t("timeline.generateRole")}: {prov.generate}
              </span>
            ) : null}
            {prov.review ? (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/60 border border-border/60">
                {t("timeline.reviewRole")}: {prov.review}
              </span>
            ) : null}
            {!prov.generate && !prov.review && (
              <span className="text-[10px] text-muted-foreground">auto</span>
            )}
          </div>

          {/* Error box */}
          {(run.status === "failed" || run.status === "aborted") && run.error && (
            <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2">
              <p className="text-[10px] font-semibold text-rose-700 dark:text-rose-400 uppercase tracking-wide mb-1">
                {STATUS_LABEL_KEYS[run.status]
                  ? t(STATUS_LABEL_KEYS[run.status])
                  : run.status}
              </p>
              <p className="text-[11px] text-foreground/80 break-words leading-relaxed">
                {run.error}
              </p>
            </div>
          )}

          {/* Step timeline (the replay) */}
          <p className="divider-academic mb-2">
            <span>
              {t("timeline.stepsTitle", {
                n: run.stepCount,
                d: run.stepRollup.done,
              })}
            </span>
          </p>
          <ol className="max-h-96 overflow-y-auto pr-1 flex flex-col">
            {run.steps.map((s, i) => {
              const next = run.steps[i + 1];
              const dur =
                typeof s.ms === "number" ? s.ms : next ? next.ts - s.ts : undefined;
              return (
                <li key={`${s.step}-${s.ts}-${i}`} className="flex gap-2 relative pb-3 last:pb-0">
                  {/* connector */}
                  {i < run.steps.length - 1 && (
                    <span
                      className="absolute left-[6px] top-4 bottom-0 w-px bg-border/70"
                      aria-hidden="true"
                    />
                  )}
                  <span className="relative z-10 mt-0.5 bg-card">
                    <StepIcon status={s.status} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[11px] font-medium text-foreground/90">
                        {stepLabel(s.step)}
                        {typeof s.section === "number" && typeof s.total === "number" && (
                          <span className="text-muted-foreground font-normal">
                            {" "}
                            §{s.section}/{s.total}
                          </span>
                        )}
                      </span>
                      {typeof dur === "number" && dur > 0 && (
                        <span className="text-[9px] font-mono text-muted-foreground/80 tabular-nums">
                          {fmtDuration(dur)}
                        </span>
                      )}
                      <span className="text-[9px] font-mono text-muted-foreground/60 tabular-nums ml-auto">
                        {fmtTime(s.ts)}
                      </span>
                    </div>
                    {s.message && (
                      <p className="text-[10px] text-muted-foreground leading-snug break-words mt-0.5">
                        {s.message}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
            {run.steps.length === 0 && (
              <li className="text-[11px] text-muted-foreground py-2">
                {t("timeline.noSteps")}
              </li>
            )}
          </ol>

          {/* Footer actions */}
          <div className="flex items-center gap-2 mt-3 pt-2 border-t border-border/40">
            {summary?.articleId && onOpenArticle && article && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px] gap-1 focus-ring"
                onClick={() => onOpenArticle(article)}
              >
                <FileText className="h-3 w-3" />
                {t("timeline.openArticle")}
                {summary.partial && (
                  <span className="text-amber-600 dark:text-amber-400">
                    ({t("timeline.partial")})
                  </span>
                )}
              </Button>
            )}
            {summary?.hasChinese && (
              <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
                <Zap className="h-3 w-3 text-primary" />
                {t("timeline.bilingual")}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] gap-1 ml-auto text-muted-foreground hover:text-rose-600 focus-ring"
              onClick={onDelete}
              title={t("timeline.deleteRecord")}
            >
              <Trash2 className="h-3 w-3" />
              {t("timeline.deleteRecord")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 px-2 py-1.5">
      <div className="flex items-center gap-1 text-muted-foreground">
        {icon}
        <span className="text-[9px] uppercase tracking-wide font-medium">{label}</span>
      </div>
      <p className="text-sm font-semibold tabular-nums mt-0.5">{value}</p>
    </div>
  );
}
