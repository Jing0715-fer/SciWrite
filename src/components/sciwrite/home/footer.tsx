"use client";

import { useI18n } from "@/lib/i18n";

export function Footer({ onOpenPalette }: { onOpenPalette?: () => void }) {
  const { t } = useI18n();
  return (
    <footer className="glass-toolbar glass-footer shrink-0 px-4 py-1.5 flex items-center justify-between text-[10px] text-foreground/70 relative z-20">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span className="relative inline-flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          {t("footer.aiPowered")}
        </span>
        <span className="hidden sm:inline opacity-40">·</span>
        <span className="hidden sm:inline text-muted-foreground">
          {t("footer.citations")} <code className="font-mono text-[9px] text-foreground/60">[n]</code> / <code className="font-mono text-[9px] text-foreground/60">[SOURCE:ID]</code>
        </span>
      </div>
      <div className="flex items-center gap-2">
        {onOpenPalette && (
          <button
            onClick={onOpenPalette}
            className="hidden md:inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/60 bg-card/40 hover:bg-muted/60 hover:border-border transition-colors"
            title={t("footer.openPaletteTitle")}
          >
            <kbd className="font-mono text-[9px] font-semibold text-foreground/80">⌘K</kbd>
            <span className="text-muted-foreground">{t("footer.commands")}</span>
          </button>
        )}
        <span className="hidden md:inline text-muted-foreground/80">RCSB · UniProt · PubMed · NCBI · BLAST</span>
        <span className="opacity-40">·</span>
        <span className="font-medium">{t("app.title")}</span>
      </div>
    </footer>
  );
}
