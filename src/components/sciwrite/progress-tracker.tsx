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

const WORD_GOAL_PRESETS = [500, 1000, 2000, 3000, 5000];

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
  const wordProgress = wordGoal > 0 ? Math.min(100, (totalWords / wordGoal) * 100) : 0;
  const goalMet = totalWords >= wordGoal;

  return (
    <div className="px-5 py-2.5 border-b border-border/60 bg-gradient-to-r from-muted/30 to-transparent">
      <div className="flex items-center gap-4 flex-wrap">
        {/* Word count goal tracker */}
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
              <Type className="h-3 w-3" />
              {t("progress.writingProgress")}
            </span>
            <button
              onClick={() => setShowGoalSelector((v) => !v)}
              className="text-[10px] font-mono text-muted-foreground hover:text-primary transition-colors"
              title={t("progress.setWordGoalTitle")}
            >
              {totalWords} / {wordGoal}w
              {goalMet && <span className="ml-1 text-emerald-600">✓</span>}
            </button>
          </div>
          <Progress
            value={wordProgress}
            className={`h-1.5 ${goalMet ? "[&>div]:bg-emerald-500" : ""}`}
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
                  className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
                    wordGoal === g
                      ? "bg-primary/10 text-primary font-semibold"
                      : "bg-muted/50 text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Stat pills */}
        <div className="flex items-center gap-2.5 text-[10px]">
          <StatPill
            icon={<PenLine className="h-2.5 w-2.5" />}
            label={t("progress.paragraphsPill")}
            value={totalParagraphs}
            color="emerald"
          />
          <StatPill
            icon={<Quote className="h-2.5 w-2.5" />}
            label={t("progress.citationsPill")}
            value={totalCitations}
            color="amber"
          />
          <StatPill
            icon={<Target className="h-2.5 w-2.5" />}
            label={t("progress.coveragePill")}
            value={`${citationCoverage}%`}
            color="teal"
          />
          {(unresolvedAnnotations > 0 || resolvedAnnotations > 0) && (
            <StatPill
              icon={<MessageSquare className="h-2.5 w-2.5" />}
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
    emerald: "text-emerald-600 dark:text-emerald-400",
    teal: "text-teal-600 dark:text-teal-400",
    amber: "text-amber-600 dark:text-amber-400",
    rose: "text-rose-600 dark:text-rose-400",
  };
  return (
    <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-muted/40">
      <span className={colorMap[color] || "text-muted-foreground"}>{icon}</span>
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold ${colorMap[color] || "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}
