"use client";

import * as React from "react";
import { Palette, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Fixed identity colors for each theme option — these swatches represent
// the theme choices themselves (like logos), so they intentionally stay
// constant regardless of the currently active theme.
const THEMES = [
  { id: "default", label: "Emerald", swatch: "#0d9488" },
  { id: "ocean", label: "Ocean", swatch: "#3b82f6" },
  { id: "sunset", label: "Sunset", swatch: "#f97316" },
  { id: "violet", label: "Violet", swatch: "#8b5cf6" },
] as const;

const STORAGE_KEY = "sciwrite-theme";

export function ThemeSwitcher() {
  const [current, setCurrent] = React.useState<string>("default");
  const [open, setOpen] = React.useState(false);

  const applyTheme = React.useCallback((themeId: string) => {
    const root = document.documentElement;
    if (themeId === "default") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", themeId);
    }
  }, []);

  React.useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) || "default";
    setCurrent(saved);
    applyTheme(saved);
  }, [applyTheme]);

  const handleSelect = (themeId: string) => {
    setCurrent(themeId);
    applyTheme(themeId);
    localStorage.setItem(STORAGE_KEY, themeId);
    setOpen(false);
  };

  const activeTheme = THEMES.find((t) => t.id === current) ?? THEMES[0];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full relative"
          title="Theme color"
          aria-label={`Theme color: ${activeTheme.label}. Click to change.`}
          aria-expanded={open}
        >
          <Palette className="h-4 w-4" />
          <span
            aria-hidden
            className="absolute bottom-1 right-1 h-2 w-2 rounded-full border border-background/80"
            style={{ backgroundColor: activeTheme.swatch }}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 p-1.5">
        <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Theme color
        </p>
        <div role="radiogroup" aria-label="Theme color" className="flex flex-col gap-0.5">
          {THEMES.map((t) => {
            const isActive = current === t.id;
            return (
              <button
                key={t.id}
                role="radio"
                aria-checked={isActive}
                onClick={() => handleSelect(t.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-left transition-colors cursor-pointer",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-foreground/80 hover:bg-muted hover:text-foreground"
                )}
              >
                <span
                  aria-hidden
                  className="h-3 w-3 rounded-full shrink-0 border border-black/10 dark:border-white/10"
                  style={{ backgroundColor: t.swatch }}
                />
                <span className="flex-1">{t.label}</span>
                {isActive && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
