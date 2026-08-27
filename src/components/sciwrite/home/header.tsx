"use client";

import {
  FlaskConical,
  BookOpenText,
  PenLine,
  Layers,
  BarChart3,
  Sparkles,
  Cpu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/sciwrite/theme-toggle";
import { LanguageToggle } from "@/components/sciwrite/language-toggle";
import { ThemeSwitcher } from "@/components/sciwrite/theme-switcher";
import { useI18n } from "@/lib/i18n";

export function Header({
  project,
  onOpenWrite,
  onOpenCompose,
  onOpenGather,
  onOpenInsights,
  onOpenOutline,
  onOpenOneClick,
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
  return (
    <header className="glass-toolbar shrink-0 px-4 py-2.5 flex items-center gap-3 relative z-30">
      <div className="flex items-center gap-2.5">
        <div className="brand-tile h-9 w-9 rounded-xl flex items-center justify-center">
          <FlaskConical className="h-4.5 w-4.5 text-primary-foreground" />
        </div>
        <div className="leading-none">
          <h1 className="text-sm font-bold tracking-tight flex items-baseline gap-1.5">
            <span className="font-serif-text">{t("app.title")}</span>
            <span className="text-primary/50 text-xs">·</span>
            <span className="text-muted-foreground font-normal text-xs">{t("app.subtitle")}</span>
          </h1>
          <p className="text-[10px] text-muted-foreground mt-1 tracking-wide">
            {t("app.tagline")}
          </p>
        </div>
      </div>

      <div className="h-7 w-px bg-border/70 mx-1.5 hidden sm:block" />

      <div className="flex-1 min-w-0 hidden sm:block">
        {project ? (
          <div className="flex items-center gap-2 min-w-0 group">
            <span className="inline-flex items-center justify-center h-6 w-6 rounded-md bg-primary/10 text-primary shrink-0">
              <BookOpenText className="h-3.5 w-3.5" />
            </span>
            <span className="text-xs font-semibold truncate">{project.title}</span>
            <span className="text-[10px] text-muted-foreground/80 truncate hidden md:inline">
              — {project.topic}
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground italic">{t("app.noProject")}</span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {project && (
          <>
            <Badge variant="outline" className="text-[9px] h-5 gap-1 bg-card/60 border-border/70 font-medium tabular-nums">
              <PenLine className="h-2.5 w-2.5 text-primary" />
              {paragraphCount}
            </Badge>
            <Badge variant="outline" className="text-[9px] h-5 gap-1 bg-card/60 border-border/70 font-medium tabular-nums">
              <Layers className="h-2.5 w-2.5 text-primary" />
              {articleCount}
            </Badge>
            <div className="h-5 w-px bg-border/60 mx-0.5 hidden lg:block" />
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs gap-1.5 hover:bg-muted/60"
              onClick={onOpenInsights}
              title={t("app.insightsTitle")}
            >
              <BarChart3 className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">{t("app.insights")}</span>
            </Button>
            {/* Unified AI Writing Hub button */}
            <Button
              size="sm"
              className="btn-gradient-primary h-8 text-xs gap-1.5 text-primary-foreground font-medium"
              onClick={onOpenWrite}
              title={t("app.unifiedWriteTitle")}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("app.unifiedWrite")}</span>
            </Button>
            <div className="h-5 w-px bg-border/60 mx-0.5 hidden sm:block" />
          </>
        )}
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
