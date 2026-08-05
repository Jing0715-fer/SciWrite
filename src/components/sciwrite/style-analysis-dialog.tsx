"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Loader2,
  PenLine,
  Gauge,
  BookOpen,
  Eye,
  Scissors,
  AlertCircle,
  Lightbulb,
  RefreshCw,
  TrendingUp,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { useMutation } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  articleId: string;
}

// ── Module-level helpers (avoid re-creating components during render) ────────

/** Score → text color class based on quality band. */
function scoreColor(score: number | null): string {
  if (score === null) return "text-muted-foreground";
  if (score >= 80) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 60) return "text-amber-600 dark:text-amber-400";
  if (score >= 40) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

/** Score → qualitative label. */
function scoreLabel(score: number | null): string {
  if (score === null) return "N/A";
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Fair";
  return "Needs work";
}

/** Radial gauge — circular progress ring with score in the center. */
function RadialGauge({
  value,
  label,
  sublabel,
  icon: Icon,
}: {
  value: number | null;
  label: string;
  sublabel?: string;
  icon: any;
}) {
  const pct = value ?? 0;
  const circumference = 2 * Math.PI * 36;
  const dashOffset = circumference - (pct / 100) * circumference;
  return (
    <div className="flex flex-col items-center gap-1.5 p-3 rounded-lg border border-border/60 bg-card hover:shadow-sm transition-shadow">
      <div className="relative w-24 h-24">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 80 80">
          <circle
            cx="40"
            cy="40"
            r="36"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            className="text-muted/30"
          />
          <circle
            cx="40"
            cy="40"
            r="36"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className={`${scoreColor(value)} transition-all duration-700 ease-out`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <Icon className={`h-4 w-4 mb-0.5 ${scoreColor(value)}`} />
          <span className={`text-xl font-bold ${scoreColor(value)}`}>
            {value ?? "—"}
          </span>
        </div>
      </div>
      <div className="text-center">
        <div className="text-[11px] font-semibold">{label}</div>
        {sublabel && (
          <div className="text-[9px] text-muted-foreground">{sublabel}</div>
        )}
        <Badge
          variant="outline"
          className={`mt-1 text-[8px] h-3.5 ${scoreColor(value)} border-current`}
        >
          {scoreLabel(value)}
        </Badge>
      </div>
    </div>
  );
}

/** Metric card — icon + label + value with a tooltip hint. */
function MetricCard({
  icon: Icon,
  label,
  value,
  unit,
  hint,
  accent,
}: {
  icon: any;
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  accent: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border/60 bg-card hover:bg-accent/20 transition-colors cursor-help">
            <div className={`p-1.5 rounded-md ${accent}`}>
              <Icon className="h-3.5 w-3.5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[9px] text-muted-foreground uppercase tracking-wide truncate">
                {label}
              </div>
              <div className="text-sm font-bold leading-tight">
                {value}
                {unit && (
                  <span className="text-[10px] font-normal text-muted-foreground ml-0.5">
                    {unit}
                  </span>
                )}
              </div>
            </div>
          </div>
        </TooltipTrigger>
        {hint && (
          <TooltipContent side="top" className="text-[10px] max-w-[200px]">
            {hint}
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * StyleAnalysisDialog — AI-powered writing style analysis.
 *
 * Visualizes:
 *  - 5 radial score gauges (Readability, Grade Level, Academic Register,
 *    Clarity, Conciseness) with color-coded quality bands.
 *  - 9 quantitative metric cards (words, sentences, avg sentence length,
 *    passive voice %, long sentences, citations, citation density, lexical
 *    diversity, paragraphs).
 *  - Per-section breakdown table with sparkline-style bars.
 *  - LLM-identified style issues with example sentences.
 *  - Actionable improvement suggestions prioritized by impact.
 *
 * The local heuristics (readability, passive voice, etc.) are computed
 * instantly without an LLM call. The LLM adds academic register / clarity /
 * conciseness assessment + qualitative issues + suggestions.
 */
export function StyleAnalysisDialog({ open, onOpenChange, articleId }: Props) {
  const { t } = useI18n();

  const analyzeMut = useMutation({
    mutationFn: () => api.analyzeStyle(articleId),
    onError: (e: any) => toast.error(e?.message || "Style analysis failed"),
  });

  React.useEffect(() => {
    if (open && !analyzeMut.data && !analyzeMut.isPending) {
      analyzeMut.mutate();
    }
  }, [open]);

  const data = analyzeMut.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[88vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <PenLine className="h-4 w-4 text-teal-600" />
            AI Writing Style Analysis
          </DialogTitle>
          <DialogDescription className="text-xs">
            Readability, academic register, and actionable style improvements
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1">
          <div className="px-5 py-4 space-y-5">
            {analyzeMut.isPending && (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
                <p className="text-xs text-muted-foreground">
                  Analyzing writing style…
                </p>
                <p className="text-[10px] text-muted-foreground/70">
                  Computing readability metrics + LLM academic assessment
                </p>
              </div>
            )}

            {data && (
              <>
                {/* ── Score gauges row ──────────────────────────────────────── */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-semibold flex items-center gap-1.5">
                      <Gauge className="h-3.5 w-3.5 text-teal-600" />
                      Style Scores
                    </h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[10px] gap-1"
                      onClick={() => analyzeMut.mutate()}
                      disabled={analyzeMut.isPending}
                    >
                      <RefreshCw className="h-3 w-3" />
                      Re-run
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5">
                    <RadialGauge
                      value={data.readabilityScore}
                      label="Readability"
                      sublabel={data.readabilityLabel}
                      icon={BookOpen}
                    />
                    <RadialGauge
                      value={
                        data.gradeLevel > 0 && data.gradeLevel <= 20
                          ? 100 - data.gradeLevel * 4
                          : null
                      }
                      label="Grade Level"
                      sublabel={`Grade ${data.gradeLevel.toFixed(1)}`}
                      icon={TrendingUp}
                    />
                    <RadialGauge
                      value={data.academicRegister}
                      label="Academic"
                      sublabel="LLM assessed"
                      icon={PenLine}
                    />
                    <RadialGauge
                      value={data.clarity}
                      label="Clarity"
                      sublabel="LLM assessed"
                      icon={Eye}
                    />
                    <RadialGauge
                      value={data.conciseness}
                      label="Conciseness"
                      sublabel="LLM assessed"
                      icon={Scissors}
                    />
                  </div>
                  {data.academicRegister === null && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-2 flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      LLM assessment unavailable — showing local heuristics
                      only. Click Re-run to retry.
                    </p>
                  )}
                </div>

                {/* ── Quantitative metrics ──────────────────────────────────── */}
                <div>
                  <h3 className="text-xs font-semibold flex items-center gap-1.5 mb-3">
                    <FileText className="h-3.5 w-3.5 text-teal-600" />
                    Quantitative Metrics
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                    <MetricCard
                      icon={FileText}
                      label="Total Words"
                      value={data.metrics.totalWords.toLocaleString()}
                      accent="bg-blue-500"
                      hint="Total word count of the article body"
                    />
                    <MetricCard
                      icon={FileText}
                      label="Sentences"
                      value={data.metrics.totalSentences}
                      accent="bg-cyan-500"
                      hint="Number of sentences detected"
                    />
                    <MetricCard
                      icon={TrendingUp}
                      label="Avg Sentence"
                      value={data.metrics.avgSentenceLength}
                      unit="words"
                      accent="bg-teal-500"
                      hint="Average words per sentence. 15-20 is ideal for academic writing."
                    />
                    <MetricCard
                      icon={PenLine}
                      label="Passive Voice"
                      value={data.metrics.passiveVoicePct}
                      unit="%"
                      accent={
                        data.metrics.passiveVoicePct > 30
                          ? "bg-red-500"
                          : data.metrics.passiveVoicePct > 15
                            ? "bg-amber-500"
                            : "bg-emerald-500"
                      }
                      hint="Percentage of sentences using passive voice. Academic writing typically has 10-25%."
                    />
                    <MetricCard
                      icon={AlertCircle}
                      label="Long Sentences"
                      value={data.metrics.longSentences}
                      accent={
                        data.metrics.longSentences > 5
                          ? "bg-orange-500"
                          : "bg-emerald-500"
                      }
                      hint="Sentences over 30 words. These may be hard to read."
                    />
                    <MetricCard
                      icon={BookOpen}
                      label="Citations"
                      value={data.metrics.citations}
                      accent="bg-violet-500"
                      hint="Total inline citation markers [n] in the text"
                    />
                    <MetricCard
                      icon={BookOpen}
                      label="Cite Density"
                      value={data.metrics.citationDensity}
                      unit="/100w"
                      accent="bg-fuchsia-500"
                      hint="Citations per 100 words. Literature reviews typically have 2-5."
                    />
                    <MetricCard
                      icon={TrendingUp}
                      label="Lexical Diversity"
                      value={data.metrics.lexicalDiversity}
                      unit="%"
                      accent="bg-indigo-500"
                      hint="Unique words / total words. Higher = more varied vocabulary. 40-60% is typical."
                    />
                    <MetricCard
                      icon={FileText}
                      label="Paragraphs"
                      value={data.metrics.totalParagraphs}
                      accent="bg-slate-500"
                      hint="Number of paragraphs detected"
                    />
                  </div>
                </div>

                {/* ── Per-section breakdown ─────────────────────────────────── */}
                {data.sections.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold flex items-center gap-1.5 mb-3">
                      <Gauge className="h-3.5 w-3.5 text-teal-600" />
                      Per-Section Breakdown
                    </h3>
                    <div className="rounded-lg border border-border/60 overflow-hidden">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="bg-muted/50 border-b border-border/60">
                            <th className="text-left py-2 px-2.5 font-medium text-muted-foreground">
                              Section
                            </th>
                            <th className="text-right py-2 px-2 font-medium text-muted-foreground">
                              Words
                            </th>
                            <th className="text-right py-2 px-2 font-medium text-muted-foreground">
                              Sentences
                            </th>
                            <th className="text-right py-2 px-2 font-medium text-muted-foreground">
                              Readability
                            </th>
                            <th className="text-right py-2 px-2 font-medium text-muted-foreground">
                              Passive %
                            </th>
                            <th className="text-right py-2 px-2 font-medium text-muted-foreground">
                              Cites
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.sections.map((s, i) => (
                            <tr
                              key={i}
                              className={
                                i % 2 === 0
                                  ? "bg-card"
                                  : "bg-muted/20"
                              }
                            >
                              <td className="py-1.5 px-2.5 font-medium truncate max-w-[180px]">
                                {s.title}
                              </td>
                              <td className="text-right py-1.5 px-2 tabular-nums">
                                {s.words}
                              </td>
                              <td className="text-right py-1.5 px-2 tabular-nums text-muted-foreground">
                                {s.sentences}
                              </td>
                              <td
                                className={`text-right py-1.5 px-2 tabular-nums font-medium ${scoreColor(s.fleschReadingEase)}`}
                              >
                                {s.fleschReadingEase.toFixed(0)}
                              </td>
                              <td className="text-right py-1.5 px-2 tabular-nums">
                                <span
                                  className={
                                    s.passiveVoicePct > 30
                                      ? "text-red-600 font-medium"
                                      : s.passiveVoicePct > 15
                                        ? "text-amber-600"
                                        : "text-emerald-600"
                                  }
                                >
                                  {s.passiveVoicePct}%
                                </span>
                              </td>
                              <td className="text-right py-1.5 px-2 tabular-nums text-muted-foreground">
                                {s.citations}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* ── LLM style issues ──────────────────────────────────────── */}
                {data.issues.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold flex items-center gap-1.5 mb-3">
                      <AlertCircle className="h-3.5 w-3.5 text-orange-600" />
                      Style Issues ({data.issues.length})
                    </h3>
                    <div className="space-y-2">
                      {data.issues.map((issue, i) => (
                        <div
                          key={i}
                          className="rounded-lg border border-border/60 p-3 bg-card"
                        >
                          <div className="flex items-center gap-2 mb-1.5">
                            <Badge
                              variant="outline"
                              className={`text-[8px] h-4 uppercase ${
                                issue.severity === "high"
                                  ? "border-red-300/60 text-red-600"
                                  : issue.severity === "medium"
                                    ? "border-amber-300/60 text-amber-600"
                                    : "border-slate-300/60 text-slate-500"
                              }`}
                            >
                              {issue.severity}
                            </Badge>
                            <span className="text-xs font-semibold">
                              {issue.issue}
                            </span>
                          </div>
                          {issue.example && (
                            <p className="text-[11px] text-muted-foreground italic bg-muted/40 rounded px-2 py-1 mt-1 border-l-2 border-orange-300/60">
                              &ldquo;{issue.example}&rdquo;
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Improvement suggestions ───────────────────────────────── */}
                {data.suggestions.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold flex items-center gap-1.5 mb-3">
                      <Lightbulb className="h-3.5 w-3.5 text-amber-600" />
                      Improvement Suggestions ({data.suggestions.length})
                    </h3>
                    <div className="space-y-2">
                      {data.suggestions.map((s, i) => (
                        <div
                          key={i}
                          className="flex gap-2.5 rounded-lg border border-border/60 p-2.5 bg-gradient-to-r from-amber-50/50 to-transparent dark:from-amber-950/10"
                        >
                          <div
                            className={`mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white ${
                              s.priority === "high"
                                ? "bg-red-500"
                                : s.priority === "medium"
                                  ? "bg-amber-500"
                                  : "bg-slate-400"
                            }`}
                          >
                            {i + 1}
                          </div>
                          <div className="flex-1">
                            <Badge
                              variant="outline"
                              className="text-[8px] h-3.5 mb-1 uppercase text-muted-foreground"
                            >
                              {s.priority}
                            </Badge>
                            <p className="text-[11px] leading-relaxed">
                              {s.suggestion}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Footer note ──────────────────────────────────────────── */}
                <div className="pt-2 border-t border-border/60">
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    <strong>How scores are computed:</strong> Readability uses
                    the Flesch Reading Ease formula (206.835 − 1.015 ×
                    words/sentences − 84.6 × syllables/words). Passive voice %
                    is detected via heuristic pattern matching. Academic
                    Register, Clarity, and Conciseness are LLM-assessed.
                    Metrics are computed locally for instant feedback.
                  </p>
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
