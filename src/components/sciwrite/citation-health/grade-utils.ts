import type { TranslationKey } from "@/lib/i18n";

// Grade → styling map for the A–F badge.
export const GRADE_COLORS: Record<string, string> = {
  A: "text-emerald-700 dark:text-emerald-300 border-emerald-300/60 bg-gradient-to-br from-emerald-50/70 to-transparent dark:from-emerald-950/25",
  B: "text-lime-700 dark:text-lime-300 border-lime-300/60 bg-gradient-to-br from-lime-50/70 to-transparent dark:from-lime-950/25",
  C: "text-amber-700 dark:text-amber-300 border-amber-300/60 bg-gradient-to-br from-amber-50/70 to-transparent dark:from-amber-950/25",
  D: "text-orange-700 dark:text-orange-300 border-orange-300/60 bg-gradient-to-br from-orange-50/70 to-transparent dark:from-orange-950/25",
  F: "text-red-700 dark:text-red-300 border-red-300/60 bg-gradient-to-br from-red-50/70 to-transparent dark:from-red-950/25",
};

// Grade → i18n key; the label itself is resolved via t() at render time
// so it follows the active locale.
export const GRADE_LABEL_KEYS: Record<string, TranslationKey> = {
  A: "citationHealth.gradeA",
  B: "citationHealth.gradeB",
  C: "citationHealth.gradeC",
  D: "citationHealth.gradeD",
  F: "citationHealth.gradeF",
};
