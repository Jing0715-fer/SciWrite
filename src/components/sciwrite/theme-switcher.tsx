"use client";

import * as React from "react";
import { Palette, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Theme catalog. Each theme has a differentiated PERSONALITY, not just a
// color: the description tells the user what kind of visual treatment they
// get (glassy / brutalist / luxe / classic). The swatch is a fixed identity
// color so the picker reads consistently regardless of active theme.
const THEMES = [
  {
    id: "default",
    label: "Emerald",
    subtitle: "Academic",
    swatch: "#0d9488",
    blurb: "Crisp hairlines, paper texture, classic editorial.",
  },
  {
    id: "ocean",
    label: "Ocean",
    subtitle: "Aqua",
    swatch: "#3b82f6",
    blurb: "Soft glassmorphism, gradient mesh, pill shapes.",
  },
  {
    id: "sunset",
    label: "Sunset",
    subtitle: "Warm",
    swatch: "#f97316",
    blurb: "Thick borders, hard offset shadows, solid blocks.",
  },
  {
    id: "violet",
    label: "Violet",
    subtitle: "Noir",
    swatch: "#8b5cf6",
    blurb: "Glowing rings, premium gradients, luxe depth.",
  },
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
          className="h-8 w-8 rounded-lg relative"
          title={`Theme: ${activeTheme.label} (${activeTheme.subtitle})`}
          aria-label={`Theme: ${activeTheme.label}. Click to change.`}
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
      <PopoverContent align="end" className="w-64 p-2">
        <p className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Theme — color &amp; style
        </p>
        <div role="radiogroup" aria-label="Theme" className="flex flex-col gap-1">
          {THEMES.map((t) => {
            const isActive = current === t.id;
            return (
              <button
                key={t.id}
                role="radio"
                aria-checked={isActive}
                onClick={() => handleSelect(t.id)}
                className={cn(
                  "flex items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors cursor-pointer",
                  isActive
                    ? "bg-primary/10 ring-1 ring-primary/30"
                    : "hover:bg-muted"
                )}
              >
                <span
                  aria-hidden
                  className="mt-1 h-4 w-4 rounded-md shrink-0 border border-black/10 dark:border-white/10 shadow-sm"
                  style={{ backgroundColor: t.swatch }}
                />
                <span className="flex-1 min-w-0">
                  <span className="flex items-baseline gap-1">
                    <span className="text-xs font-semibold text-foreground">
                      {t.label}
                    </span>
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">
                      {t.subtitle}
                    </span>
                    {isActive && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-primary ml-auto" />
                    )}
                  </span>
                  <span className="block text-[10px] text-muted-foreground leading-snug mt-1">
                    {t.blurb}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
