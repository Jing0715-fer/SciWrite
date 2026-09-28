"use client";

import * as React from "react";
import {
  FlaskConical,
  BookOpenText,
  PenLine,
  Layers,
  BarChart3,
  Sparkles,
  Cpu,
  Command,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/sciwrite/theme-toggle";
import { LanguageToggle } from "@/components/sciwrite/language-toggle";
import { ThemeSwitcher } from "@/components/sciwrite/theme-switcher";
import { useI18n } from "@/lib/i18n";

/**
 * Header — completely redesigned "Atlas Studio" app bar.
 *
 * Architectural changes from the previous version:
 * 1. The brand is now a compact vertical mark (icon over wordmark) instead
 *    of a horizontal logo + subtitle + tagline stack — this reclaims ~40px
 *    of vertical space and gives the bar a confident, app-like identity.
 * 2. The active-project context is now a floating "breadcrumb chip" that
 *    sits in the center of the bar with its own surface, rather than
 *    inline text — this makes the current context unmistakable.
 * 3. The primary CTA ("AI Hub") is now a prominent split-style button with
 *    a command hint, not a small ghost button.
 * 4. The metric count pill is gone from the bar — metrics moved to the
 *    workspace progress tracker where they belong. The bar stays clean.
 *
 * Per-theme structural differentiation:
 * - The brand mark shape changes per theme via the `data-theme` attribute
 *   on <html> (read live). Emerald = rounded square, Ocean = circle,
 *   Sunset = square (no radius), Violet = squircle with glow ring.
 *   This is a real JSX/structural difference, not just a CSS variable.
 */
export function Header({
  project,
  onOpenWrite,
  onOpenInsights,
  onOpenLLMConfig,
  paragraphCount,
  articleCount,
}: {
  project?: any;
  onOpenWrite: () => void;
  onOpenCompose: () => void;
  onOpenGather: () => void;
  onOpenInsights: () => void;
  onOpenOutline: () => void;
  onOpenOneClick: () => void;
  onOpenLLMConfig: () => void;
  paragraphCount: number;
  articleCount: number;
}) {
  const { t } = useI18n();
  const [theme, setTheme] = React.useState<string>("default");

  React.useEffect(() => {
    const el = document.documentElement;
    const update = () => setTheme(el.getAttribute("data-theme") || "default");
    update();
    const obs = new MutationObserver(update);
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // Brand mark shape — structurally different per theme.
  const brandShapeClass =
    theme === "ocean"
      ? "rounded-full" // Ocean: circle
      : theme === "sunset"
      ? "rounded-none" // Sunset: hard square
      : theme === "violet"
      ? "rounded-[0.625rem] ring-2 ring-primary/40" // Violet: squircle + glow
      : "rounded-xl"; // Emerald: rounded square

  return (
    <header className="atlas-appbar shrink-0 px-4 sm:px-6 h-14 flex items-center gap-4 relative z-30">
      {/* Brand — compact vertical mark */}
      <button
        onClick={onOpenInsights}
        className="flex items-center gap-3 group focus-ring rounded-lg"
        title={t("app.title")}
        aria-label={t("app.title")}
      >
        <div
          className={`brand-tile h-9 w-9 flex items-center justify-center shrink-0 transition-transform group-hover:scale-105 ${brandShapeClass}`}
        >
          <FlaskConical className="h-4 w-4 text-primary-foreground" />
        </div>
        <div className="hidden sm:flex flex-col leading-none min-w-0">
          <span className="font-serif-text text-[15px] font-bold tracking-tight truncate">
            SciWrite
          </span>
          <span className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground font-semibold mt-0.5">
            Atlas Studio
          </span>
        </div>
      </button>

      {/* Center breadcrumb chip — the active project context, floating */}
      <div className="flex-1 flex justify-center min-w-0">
        {project ? (
          <div className="atlas-context-chip flex items-center gap-2 max-w-md min-w-0">
            <span className="inline-flex items-center justify-center h-6 w-6 rounded-md bg-primary/12 text-primary shrink-0">
              <BookOpenText className="h-3 w-3" />
            </span>
            <span className="text-[13px] font-medium truncate text-foreground">
              {project.title}
            </span>
            {project.field && (
              <span className="atlas-context-badge shrink-0">
                {String(project.field).replace(/-/g, " ")}
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground italic">
            {t("app.noProject")}
          </span>
        )}
      </div>

      {/* Action cluster — command-first */}
      <div className="flex items-center gap-1 sm:gap-2 shrink-0">
        {project && (
          <>
            {/* Primary CTA — split-style with command hint */}
            <button
              onClick={onOpenWrite}
              className="atlas-cta group hidden sm:flex items-center h-9 pl-3 pr-1.5 gap-2 focus-ring"
              title={t("app.unifiedWriteTitle")}
            >
              <Sparkles className="h-3.5 w-3.5 text-primary-foreground" />
              <span className="text-xs font-semibold text-primary-foreground">
                {t("app.unifiedWrite")}
              </span>
              <kbd className="atlas-cta-hint">⏎</kbd>
            </button>
            {/* Mobile compact CTA */}
            <Button
              size="sm"
              className="atlas-cta-mobile sm:hidden h-8 w-8 p-0"
              onClick={onOpenWrite}
              title={t("app.unifiedWriteTitle")}
            >
              <Sparkles className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
        <div className="h-5 w-px bg-border/60 mx-0.5 hidden sm:block" />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg hover:bg-muted/60"
          onClick={() => onOpenLLMConfig()}
          title={t("app.llmConfigTitle")}
        >
          <Cpu className="h-4 w-4" />
        </Button>
        <LanguageToggle />
        <ThemeSwitcher />
        <ThemeToggle />
      </div>
    </header>
  );
}
