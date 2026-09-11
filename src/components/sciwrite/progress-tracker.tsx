"use client";

import * as React from "react";
import {
  PenLine,
  Type,
  Quote,
  Target,
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
    <div className="glass-subtle border-b hairline shrink-0">
      {/* Section header — eyebrow label + editable word-goal trigger.
          Clicking the count opens the goal-presets selector below the bar. */}
      <div className="panel-section-header flex items-center justify-between gap-2">
        <span className="eyebrow flex items-center gap-1">
          <Type className="h-3 w-3" />
          {t("progress.writingProgress")}
        </span>
        <button
          onClick={() => setShowGoalSelector((v) => !v)}
          className="text-[10px] font-mono text-muted-foreground hover:text-primary transition-colors tabular-nums hover:underline underline-offset-2 flex items-center gap-1 focus-ring rounded-sm px-1"
          title={t("progress.setWordGoalTitle")}
        >
          <span className="text-foreground font-semibold">{fmt(totalWords)}</span>
          <span aria-hidden>/</span>
          <span>{fmt(wordGoal)}w</span>
          {goalMet && <span className="text-primary">✓</span>}
        </button>
      </div>

      {/* Progress bar — animated gradient fill via .progress-glow. */}
      <div className="px-4 pb-3 space-y-2">
        <Progress
          value={wordProgress}
          className={`h-2 bg-primary/10 progress-glow${goalMet ? " progress-done" : ""}`}
        />
        {showGoalSelector && (
          <div className="flex items-center gap-1 flex-wrap">
            <span className="eyebrow mr-1">{t("progress.goal")}</span>
            {WORD_GOAL_PRESETS.map((g) => (
              <button
                key={g}
                onClick={() => {
                  onWordGoalChange?.(g);
                  setShowGoalSelector(false);
                }}
                className={`text-[10px] px-2 py-1 rounded-md tabular-nums transition-all ${
                  wordGoal === g ? "tab-pill" : "tab-pill-inactive"
                }`}
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
                className="text-[10px] px-2 py-1 rounded-md tab-pill-inactive transition-all hover:text-primary"
              >
                {t("progress.setCustomGoal")}
              </button>
            </span>
          </div>
        )}
      </div>

      {/* Stat tile grid — responsive metric chips.
          2 cols mobile, 3 cols sm, 5 cols lg so the row reads as a calm
          metric ladder instead of competing pills. */}
      <div className="px-4 pb-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <StatTile
          icon={<Type className="h-3.5 w-3.5" />}
          label={t("insights.wordsLabel")}
          value={fmt(totalWords)}
          hint={`${fmt(totalWords)} / ${fmt(wordGoal)}w · ${t("progress.setWordGoalTitle")}`}
          onClick={() => setShowGoalSelector((v) => !v)}
        />
        <StatTile
          icon={<PenLine className="h-3.5 w-3.5" />}
          label={t("workspace.paragraphs")}
          value={fmt(totalParagraphs)}
        />
        <StatTile
          icon={<Quote className="h-3.5 w-3.5" />}
          label={t("insights.citationsLabel")}
          value={fmt(totalCitations)}
          accent="amber"
        />
        <StatTile
          icon={<Target className="h-3.5 w-3.5" />}
          label={t("structure.coverage")}
          value={`${citationCoverage}%`}
        />
        {(unresolvedAnnotations > 0 || resolvedAnnotations > 0) && (
          <StatTile
            icon={<MessageSquare className="h-3.5 w-3.5" />}
            label={t("para.annotations")}
            value={`${unresolvedAnnotations}/${resolvedAnnotations}`}
            accent={unresolvedAnnotations > 0 ? "rose" : "emerald"}
            hint={`${unresolvedAnnotations} unresolved · ${resolvedAnnotations} resolved`}
          />
        )}
      </div>
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  accent,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  accent?: "amber" | "rose" | "emerald";
  hint?: string;
  onClick?: () => void;
}) {
  // Theme-aware icon-chip tint. Default = primary token; semantic accents
  // use the sanctioned .badge-* hue families (amber=rcsb/citations,
  // rose=unresolved alerts, emerald=resolved/healthy).
  const accentClass = !accent
    ? "bg-primary/10 text-primary"
    : accent === "amber"
      ? "badge-amber"
      : accent === "rose"
        ? "badge-rose"
        : "badge-emerald";

  const inner = (
    <div className={`flex items-center gap-2 ${onClick ? "cursor-pointer" : ""}`}>
      <span
        className={`h-7 w-7 rounded-md flex items-center justify-center shrink-0 ${accentClass}`}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="eyebrow truncate">{label}</div>
        <div className="text-sm font-semibold tabular-nums text-foreground leading-tight">
          {value}
        </div>
      </div>
    </div>
  );

  const tile = (
    <div className="stat-tile p-2 acad-fade-in">{inner}</div>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          {onClick ? (
            <button
              type="button"
              onClick={onClick}
              className="block text-left w-full focus-ring rounded-md"
              aria-label={hint || label}
            >
              {tile}
            </button>
          ) : (
            <div className="cursor-help">{tile}</div>
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[10px]">
          {hint || label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
