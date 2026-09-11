"use client";

import { useI18n } from "@/lib/i18n";
import { Command } from "lucide-react";

/**
 * Footer — redesigned as a slim status rail.
 *
 * Architectural changes:
 * 1. Reduced to a single line of high-signal status: the live AI indicator
 *    on the left, the database roster on the right. The verbose
 *    citation-syntax help moved into a tooltip.
 * 2. The command palette trigger is now a proper kbd-chip, not a button
 *    masquerading as text.
 */
export function Footer({ onOpenPalette }: { onOpenPalette?: () => void }) {
  const { t } = useI18n();
  return (
    <footer className="atlas-statusbar shrink-0 h-7 px-4 sm:px-6 flex items-center justify-between text-[10px] relative z-20">
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground/80">
          <span className="relative inline-flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-primary/60 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
          </span>
          {t("footer.aiPowered")}
        </span>
        {onOpenPalette && (
          <button
            onClick={onOpenPalette}
            className="hidden sm:inline-flex items-center gap-1 atlas-kbd-chip focus-ring"
            title={t("footer.openPaletteTitle")}
          >
            <Command className="h-2.5 w-2.5" />
            <kbd className="font-mono">K</kbd>
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="hidden md:inline tracking-wide">
          RCSB · UniProt · PubMed · NCBI · BLAST
        </span>
        <span className="opacity-30">·</span>
        <span className="font-mono text-[9px]">
          [n] · [SOURCE:ID]
        </span>
      </div>
    </footer>
  );
}
