"use client";

import * as React from "react";
import {
  Type,
  PenLine,
  Quote,
  Target,
  MessageSquare,
  Check,
} from "lucide-react";
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

const WORD_GOAL_PRESETS = [500, 1000, 2000, 5000, 10000, 20000, 50000];
const fmt = (n: number) => n.toLocaleString();

/**
 * ProgressTracker — redesigned as a horizontal "progress rail".
 *
 * Architectural change: instead of a 5-card grid + separate progress bar,
 * the metrics are now integrated INTO a single segmented rail. Each
 * segment is a metric with its own mini progress bar underneath. The
 * word-goal segment is clickable to open the goal selector inline.
 * This is a fundamentally different visual structure — one connected
 * instrument panel rather than discrete cards.
 */
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
  const hasAnnotations = unresolvedAnnotations > 0 || resolvedAnnotations > 0;
  const totalAnnotations = unresolvedAnnotations + resolvedAnnotations;
  const resolvedPct = totalAnnotations > 0 ? (resolvedAnnotations / totalAnnotations) * 100 : 0;

  const applyCustomGoal = () => {
    const n = Math.round(Number(customGoal));
    if (customGoal.trim() !== "" && Number.isFinite(n) && n >= 100) {
      onWordGoalChange?.(n);
      setCustomGoal("");
      setShowGoalSelector(false);
    }
  };

  return (
    <div className="shrink-0 border-b hairline">
      {/* The rail — segmented metric bar */}
      <div className="atlas-progress-rail">
        <TooltipProvider delayDuration={200}>
          {/* Words segment — clickable to open goal selector */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setShowGoalSelector((v) => !v)}
                className="atlas-progress-segment text-left focus-ring rounded-md"
                aria-label={`${t("insights.wordsLabel")}: ${fmt(totalWords)} / ${fmt(wordGoal)}`}
              >
                <div className="flex items-center gap-1">
                  <Type className="h-3 w-3 text-primary shrink-0" />
                  <span className="atlas-progress-label">{t("insights.wordsLabel")}</span>
                  {goalMet && <Check className="h-2.5 w-2.5 text-primary ml-auto" />}
                </div>
                <div className="flex items-baseline gap-0.5">
                  <span className="atlas-progress-value">{fmt(totalWords)}</span>
                  <span className="atlas-progress-unit">/ {fmt(wordGoal)}w</span>
                </div>
                <div className="atlas-progress-bar-wrap">
                  <div
                    className="atlas-progress-bar-fill"
                    style={{ width: `${wordProgress}%` }}
                  />
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[10px]">
              {t("progress.setWordGoalTitle")}
            </TooltipContent>
          </Tooltip>

          {/* Paragraphs segment */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="atlas-progress-segment">
                <div className="flex items-center gap-1">
                  <PenLine className="h-3 w-3 text-primary shrink-0" />
                  <span className="atlas-progress-label">{t("workspace.paragraphs")}</span>
                </div>
                <div className="flex items-baseline gap-0.5">
                  <span className="atlas-progress-value">{fmt(totalParagraphs)}</span>
                  <span className="atlas-progress-unit">paras</span>
                </div>
                <div className="atlas-progress-bar-wrap">
                  <div
                    className="atlas-progress-bar-fill"
                    style={{ width: `${Math.min(100, totalParagraphs * 5)}%` }}
                  />
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[10px]">
              {totalParagraphs} paragraphs drafted
            </TooltipContent>
          </Tooltip>

          {/* Citations segment */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="atlas-progress-segment">
                <div className="flex items-center gap-1">
                  <Quote className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0" />
                  <span className="atlas-progress-label">{t("insights.citationsLabel")}</span>
                </div>
                <div className="flex items-baseline gap-0.5">
                  <span className="atlas-progress-value">{fmt(totalCitations)}</span>
                  <span className="atlas-progress-unit">refs</span>
                </div>
                <div className="atlas-progress-bar-wrap">
                  <div
                    className="atlas-progress-bar-fill"
                    style={{ width: `${Math.min(100, totalCitations * 4)}%` }}
                  />
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[10px]">
              Inline citations across all paragraphs
            </TooltipContent>
          </Tooltip>

          {/* Coverage segment */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="atlas-progress-segment">
                <div className="flex items-center gap-1">
                  <Target className="h-3 w-3 text-primary shrink-0" />
                  <span className="atlas-progress-label">{t("structure.coverage")}</span>
                </div>
                <div className="flex items-baseline gap-0.5">
                  <span className="atlas-progress-value">{citationCoverage}</span>
                  <span className="atlas-progress-unit">%</span>
                </div>
                <div className="atlas-progress-bar-wrap">
                  <div
                    className="atlas-progress-bar-fill"
                    style={{ width: `${citationCoverage}%` }}
                  />
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[10px]">
              % of paragraphs with at least one citation
            </TooltipContent>
          </Tooltip>

          {/* Annotations segment — only if any exist */}
          {hasAnnotations && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="atlas-progress-segment">
                  <div className="flex items-center gap-1">
                    <MessageSquare
                      className={`h-3 w-3 shrink-0 ${unresolvedAnnotations > 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}
                    />
                    <span className="atlas-progress-label">{t("para.annotations")}</span>
                  </div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="atlas-progress-value">{unresolvedAnnotations}</span>
                    <span className="atlas-progress-unit">/ {resolvedAnnotations} res</span>
                  </div>
                  <div className="atlas-progress-bar-wrap">
                    <div
                      className="atlas-progress-bar-fill"
                      style={{ width: `${resolvedPct}%` }}
                    />
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[10px]">
                {unresolvedAnnotations} unresolved · {resolvedAnnotations} resolved
              </TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>
      </div>

      {/* Goal selector — inline drawer below the rail */}
      {showGoalSelector && (
        <div className="px-4 py-3 border-t hairline flex items-center gap-1 flex-wrap acad-fade-in">
          <span className="eyebrow mr-1">{t("progress.goal")}</span>
          {WORD_GOAL_PRESETS.map((g) => (
            <button
              key={g}
              onClick={() => {
                onWordGoalChange?.(g);
                setShowGoalSelector(false);
              }}
              className={`atlas-tab ${wordGoal === g ? "atlas-tab-active" : ""}`}
            >
              {fmt(g)}
            </button>
          ))}
          <span className="flex items-center gap-1 ml-1">
            <input
              value={customGoal}
              onChange={(e) => setCustomGoal(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyCustomGoal();
              }}
              placeholder={t("progress.customGoalPlaceholder")}
              inputMode="numeric"
              aria-label={t("progress.customGoalPlaceholder")}
              className="w-16 text-[10px] px-2 py-1 rounded-md border hairline bg-background text-foreground tabular-nums focus-ring"
            />
            <button
              onClick={applyCustomGoal}
              className="atlas-tab"
            >
              {t("progress.setCustomGoal")}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
