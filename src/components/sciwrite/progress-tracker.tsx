"use client";

import * as React from "react";
import {
  PenLine,
  Type,
  Quote,
  Target,
  TrendingUp,
  MessageSquare,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/lib/i18n";

interface Props {
  totalWords: number;
  totalParagraphs: number;
  totalCitations: number;
  citationCoverage: number;
  unresolvedAnnotations: number;
  resolvedAnnotations: number;
  wordGoal?: number;
  onWordGoalChange?: (goal: number) => void;
}

// Round 26: the ladder now spans real article scales — the old
// [500..5000] ceiling made every full-article project sit at 100% forever.
const WORD_GOAL_PRESETS = [500, 1000, 2000, 5000, 10000, 20000, 50000];

const fmt = (n: number) => n.toLocaleString();

export function ProgressTracker({
  totalWords,
  totalParagraphs,
  totalCitations,
  citationCoverage,
  unresolvedAnnotations,
  resolvedAnnotations,
  wordGoal = 1000,
  onWordGoalChange,
}: Props) {
  const { t } = useI18n();
  const [showGoalSelector, setShowGoalSelector] = React.useState(false);
  const [customGoal, setCustomGoal] = React.useState("");
  const wordProgress = wordGoal > 0 ? Math.min(100, (totalWords / wordGoal) * 100) : 0;
  const goalMet = totalWords >= wordGoal;

  const applyCustomGoal = () => {
    const n = Math.round(Number(customGoal));
    if (customGoal.trim() !== "" && Number.isFinite(n) && n >= 100) {
      onWordGoalChange?.(n);
      setCustomGoal("");
      setShowGoalSelector(false);
    }
  };

  return (
    <div className="glass-subtle px-5 py-2.5 border-b hairline">
      <div className="flex items-center gap-4 flex-wrap">
        {/* Word count goal tracker */}
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center justify-between mb-1.5">
            <span className="eyebrow flex items-center gap-1">
              <Type className="h-3 w-3" />
              {t("progress.writingProgress")}
            </span>
            <button
              onClick={() => setShowGoalSelector((v) => !v)}
              className="text-[10px] font-mono text-muted-foreground hover:text-primary transition-colors tabular-nums hover:underline underline-offset-2"
              title={t("progress.setWordGoalTitle")}
            >
              {fmt(totalWords)} / {fmt(wordGoal)}w
              {goalMet && <span className="ml-1 text-emerald-600 dark:text-emerald-400">✓</span>}
            </button>
          </div>
          <Progress
            value={wordProgress}
            className={`h-1.5 bg-primary/15 progress-glow${goalMet ? " progress-done" : ""}`}
          />
          {showGoalSelector && (
            <div className="flex items-center gap-1 mt-1.5 flex-wrap">
              <span className="text-[9px] text-muted-foreground">{t("progress.goal")}</span>
              {WORD_GOAL_PRESETS.map((g) => (
                <button
                  key={g}
                  onClick={() => {
                    onWordGoalChange?.(g);
                    setShowGoalSelector(false);
                  }}
                  className={`text-[9px] px-1.5 py-0.5 rounded transition-all tabular-nums ${
                    wordGoal === g
                      ? "tab-pill"
                      : "tab-pill-inactive"
                  }`}
                >
                  {fmt(g)}
                </button>
              ))}
              <span className="flex items-center gap-0.5">
                <input
                  value={customGoal}
                  onChange={(e) => setCustomGoal(e.target.value.replace(/[^\d]/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyCustomGoal();
                  }}
                  placeholder={t("progress.customGoalPlaceholder")}
                  inputMode="numeric"
                  aria-label={t("progress.customGoalPlaceholder")}
                  className="w-16 text-[9px] px-1.5 py-0.5 rounded border border-border/60 bg-background text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-primary/40"
                />
                <button
                  onClick={applyCustomGoal}
                  className="text-[9px] px-1.5 py-0.5 rounded tab-pill-inactive transition-all hover:text-primary"
                >
                  {t("progress.setCustomGoal")}
                </button>
              </span>
            </div>
          )}
        </div>

        {/* Stat strip — one calm chip row instead of competing pills */}
        <div className="surface-card rounded-lg flex items-center divide-x divide-border/60 text-[10px] shrink-0">
          <StatPill
            icon={<PenLine className="h-3 w-3" />}
            label={t("progress.paragraphsPill")}
            value={totalParagraphs}
            color="primary"
          />
          <StatPill
            icon={<Quote className="h-3 w-3" />}
            label={t("progress.citationsPill")}
            value={totalCitations}
            color="amber"
          />
          <StatPill
            icon={<Target className="h-3 w-3" />}
            label={t("progress.coveragePill")}
            value={`${citationCoverage}%`}
            color="primary"
          />
          {(unresolvedAnnotations > 0 || resolvedAnnotations > 0) && (
            <StatPill
              icon={<MessageSquare className="h-3 w-3" />}
              label={t("progress.annotationsPill")}
              value={`${unresolvedAnnotations}!/${resolvedAnnotations}✓`}
              color={unresolvedAnnotations > 0 ? "rose" : "emerald"}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function StatPill({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    primary: "text-primary",
    emerald: "text-emerald-600 dark:text-emerald-400",
    amber: "text-amber-600 dark:text-amber-400",
    rose: "text-rose-600 dark:text-rose-400",
  };
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 px-2.5 py-1 cursor-help">
            <span className={`shrink-0 ${colorMap[color] || "text-muted-foreground"}`}>{icon}</span>
            <span className="font-semibold tabular-nums text-foreground">{value}</span>
            <span className="text-muted-foreground hidden sm:inline">{label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[10px]">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
