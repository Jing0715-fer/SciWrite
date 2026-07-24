"use client";

import * as React from "react";
import {
  Lightbulb,
  ChevronRight,
  ChevronDown,
  PenLine,
  Quote,
  Type,
  Target,
  BookOpen,
  CheckCircle2,
  X,
} from "lucide-react";
import { PARAGRAPH_FORMATS, PARAGRAPH_SCENARIOS } from "@/lib/constants";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n";

interface Props {
  format?: string;
  scenario?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const FORMAT_TIPS: Record<string, { titleKey: TranslationKey; tips: string[] }> = {
  abstract: {
    titleKey: "tips.formatTitle.abstract",
    tips: [
      "Keep it under 250 words — be concise and self-contained.",
      "Structure: background → aim → method → key result → implication.",
      "Avoid citations; the abstract should stand alone.",
      "Write it last, after all other sections are finalized.",
    ],
  },
  intro: {
    titleKey: "tips.formatTitle.intro",
    tips: [
      "Start broad (context) then narrow to your specific question.",
      "Clearly state the knowledge gap your work addresses.",
      "End with a clear aim or hypothesis statement.",
      "Cite seminal works [n] to establish the field.",
    ],
  },
  background: {
    titleKey: "tips.formatTitle.background",
    tips: [
      "Synthesize — don't just list prior work; show how studies relate.",
      "Group references by theme or chronology for narrative flow.",
      "Use transitions: 'Building on...', 'In contrast...', 'More recently...'.",
      "Every claim needs a citation [n] or [SOURCE:ID].",
    ],
  },
  methods: {
    titleKey: "tips.formatTitle.methods",
    tips: [
      "Be reproducible — include enough detail for others to replicate.",
      "Cite databases/tools: [PDB:1A3N], [UniProt:P04637], [PMID:xxx].",
      "Use past tense for completed procedures.",
      "Specify versions, parameters, and software where relevant.",
    ],
  },
  results: {
    titleKey: "tips.formatTitle.results",
    tips: [
      "Report findings objectively — save interpretation for Discussion.",
      "Use past tense: 'We found that...', 'The structure revealed...'.",
      "Reference figures/tables: '(Fig. 1)', '(Table 2)'.",
      "Cite supporting evidence: [n] for each quantitative claim.",
    ],
  },
  discussion: {
    titleKey: "tips.formatTitle.discussion",
    tips: [
      "Interpret results — don't just repeat them.",
      "Compare with prior work: 'Consistent with [n], we found...'.",
      "Acknowledge limitations honestly.",
      "End with future directions or broader implications.",
    ],
  },
  conclusion: {
    titleKey: "tips.formatTitle.conclusion",
    tips: [
      "Summarize key takeaways in 2-3 sentences.",
      "State the broader significance of the findings.",
      "Avoid introducing new data or citations.",
      "Connect back to the aim stated in the Introduction.",
    ],
  },
};

const SCENARIO_TIPS: Record<string, { titleKey: TranslationKey; tips: string[] }> = {
  "literature-review": {
    titleKey: "tips.scenarioTitle.literatureReview",
    tips: [
      "Organize thematically, not paper-by-paper.",
      "Identify trends, controversies, and gaps.",
      "Use citation density to show where the field is active.",
    ],
  },
  "protein-structure": {
    titleKey: "tips.scenarioTitle.proteinStructure",
    tips: [
      "Reference PDB entries explicitly: [PDB:1A3N].",
      "Describe resolution, method (X-ray/cryo-EM), and key residues.",
      "Relate structure to function with specific domain descriptions.",
    ],
  },
  "sequence-analysis": {
    titleKey: "tips.scenarioTitle.sequenceAnalysis",
    tips: [
      "Cite UniProt accessions: [UniProt:P04637].",
      "Mention alignment tools, E-values, and identity thresholds.",
      "Connect sequence conservation to functional implications.",
    ],
  },
  mechanism: {
    titleKey: "tips.scenarioTitle.mechanism",
    tips: [
      "Build a logical causal chain: A → B → C.",
      "Support each step with structural or experimental evidence.",
      "Use precise verbs: 'catalyzes', 'stabilizes', 'occludes'.",
    ],
  },
  comparative: {
    titleKey: "tips.scenarioTitle.comparative",
    tips: [
      "Use a clear comparison framework (table or structured prose).",
      "Highlight both similarities AND differences.",
      "Avoid value judgments unless backed by data.",
    ],
  },
  clinical: {
    titleKey: "tips.scenarioTitle.clinical",
    tips: [
      "Define jargon for a broader audience.",
      "Reference clinical trial IDs or patient cohorts where applicable.",
      "Connect mechanistic findings to therapeutic implications.",
    ],
  },
  custom: {
    titleKey: "tips.scenarioTitle.custom",
    tips: [
      "Maintain academic register and precise terminology.",
      "Ensure every factual claim has a citation.",
      "Keep one main idea per paragraph for readability.",
    ],
  },
};

const GENERAL_TIPS = [
  "One idea per paragraph — 180-320 words is the sweet spot.",
  "Every factual claim MUST have a citation [n] or [SOURCE:ID].",
  "Use third person, past tense for results/methods.",
  "Avoid hedging words ('may', 'might') unless genuinely uncertain.",
  "Read aloud to check flow — if you stumble, rewrite.",
];

export function WritingTipsPanel({ format, scenario, open, onOpenChange }: Props) {
  const { t } = useI18n();
  const [expandedSection, setExpandedSection] = React.useState<string | null>(
    "format"
  );

  if (!open) return null;

  const formatMeta = PARAGRAPH_FORMATS.find((f) => f.id === format);
  const scenarioMeta = PARAGRAPH_SCENARIOS.find((s) => s.id === scenario);
  const fmtTips = format ? FORMAT_TIPS[format] : null;
  const scnTips = scenario ? SCENARIO_TIPS[scenario] : null;

  return (
    <div className="absolute right-0 top-14 bottom-0 w-72 bg-card/95 backdrop-blur border-l border-border/60 shadow-lg z-30 flex flex-col acad-fade-in">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-border/60 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <div className="h-6 w-6 rounded-md bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center">
            <Lightbulb className="h-3.5 w-3.5 text-amber-600" />
          </div>
          <div>
            <p className="text-xs font-semibold leading-none">{t("tips.title")}</p>
            <p className="text-[9px] text-muted-foreground mt-0.5">
              {t("tips.contextual")}
            </p>
          </div>
        </div>
        <button
          onClick={() => onOpenChange(false)}
          className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/60"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scroll-academic px-3 py-2.5 space-y-2.5">
        {/* Current context */}
        {(formatMeta || scenarioMeta) && (
          <div className="rounded-md bg-primary/[0.05] border border-primary/20 p-2 space-y-0.5">
            <p className="text-[9px] uppercase tracking-wider text-primary font-semibold">
              {t("tips.currentContext")}
            </p>
            {formatMeta && (
              <p className="text-[10px] text-foreground/80">
                {t("tips.formatLabel")} <span className="font-semibold">{formatMeta.label}</span>
              </p>
            )}
            {scenarioMeta && (
              <p className="text-[10px] text-foreground/80">
                {t("tips.scenarioLabel")} <span className="font-semibold">{scenarioMeta.label}</span>
              </p>
            )}
          </div>
        )}

        {/* Format-specific tips */}
        {fmtTips && (
          <TipSection
            id="format"
            icon={<PenLine className="h-3 w-3" />}
            title={t(fmtTips.titleKey)}
            tips={fmtTips.tips}
            expanded={expandedSection === "format"}
            onToggle={() =>
              setExpandedSection(
                expandedSection === "format" ? null : "format"
              )
            }
          />
        )}

        {/* Scenario-specific tips */}
        {scnTips && (
          <TipSection
            id="scenario"
            icon={<Target className="h-3 w-3" />}
            title={t(scnTips.titleKey)}
            tips={scnTips.tips}
            expanded={expandedSection === "scenario"}
            onToggle={() =>
              setExpandedSection(
                expandedSection === "scenario" ? null : "scenario"
              )
            }
          />
        )}

        {/* General tips */}
        <TipSection
          id="general"
          icon={<BookOpen className="h-3 w-3" />}
          title={t("tips.general")}
          tips={GENERAL_TIPS}
          expanded={expandedSection === "general"}
          onToggle={() =>
            setExpandedSection(
              expandedSection === "general" ? null : "general"
            )
          }
        />

        {/* Citation format reference */}
        <TipSection
          id="citations"
          icon={<Quote className="h-3 w-3" />}
          title={t("tips.citationFormat")}
          tips={[
            t("tips.citeNumeric"),
            t("tips.citePmid"),
            t("tips.citePdb"),
            t("tips.citeUniprot"),
            t("tips.citeAutoBlock"),
          ]}
          expanded={expandedSection === "citations"}
          onToggle={() =>
            setExpandedSection(
              expandedSection === "citations" ? null : "citations"
            )
          }
        />

        {/* Word count guidance */}
        <TipSection
          id="wordcount"
          icon={<Type className="h-3 w-3" />}
          title={t("tips.wordCount")}
          tips={[
            t("tips.wordAbstract"),
            t("tips.wordIntro"),
            t("tips.wordBackground"),
            t("tips.wordMethods"),
            t("tips.wordResults"),
            t("tips.wordDiscussion"),
          ]}
          expanded={expandedSection === "wordcount"}
          onToggle={() =>
            setExpandedSection(
              expandedSection === "wordcount" ? null : "wordcount"
            )
          }
        />
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-border/60 shrink-0">
        <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
          <CheckCircle2 className="h-2.5 w-2.5 text-emerald-500" />
          <span>{t("tips.adapt")}</span>
        </div>
      </div>
    </div>
  );
}

function TipSection({
  icon,
  title,
  tips,
  expanded,
  onToggle,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  tips: string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-muted/40 transition-colors"
      >
        <span className="text-amber-600">{icon}</span>
        <span className="text-[11px] font-semibold flex-1 text-left">{title}</span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="px-2 pb-2 pt-0.5 space-y-1">
          {tips.map((tip, i) => (
            <div
              key={i}
              className="flex items-start gap-1.5 text-[10px] leading-relaxed text-foreground/75"
            >
              <span className="text-amber-500 mt-0.5 shrink-0">•</span>
              <span>{tip}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
