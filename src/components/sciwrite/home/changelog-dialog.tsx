"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Sparkles,
  Search,
  Radar,
  PenLine,
  Keyboard,
  PanelRight,
  Wrench,
  Palette,
  type LucideIcon,
} from "lucide-react";

interface ChangelogEntry {
  type: "feature" | "fix" | "style";
  title: string;
  desc: string;
  icon: LucideIcon;
}

const CHANGELOG: { version: string; date: string; entries: ChangelogEntry[] }[] = [
  {
    version: "Canvas v3.4",
    date: "2026-09-12",
    entries: [
      {
        type: "feature",
        title: "Onboarding spotlight tour",
        desc: "First-run guided walkthrough now highlights actual UI elements with a dimming spotlight overlay instead of a static dialog. 7 steps covering tasks, switcher, command palette, context drawer, shortcuts, and themes.",
        icon: Sparkles,
      },
      {
        type: "feature",
        title: "Recent projects quick-access",
        desc: "The project switcher dropdown now shows a 'Recent' row at the top with your 5 most-recently-accessed projects as clickable chips. Faster switching without scrolling the full list.",
        icon: PanelRight,
      },
      {
        type: "feature",
        title: "Query history bar",
        desc: "Research task persists your last 12 database queries as chips. Click to re-run the exact same source+query in one click.",
        icon: Search,
      },
      {
        type: "feature",
        title: "Citation density heatmap",
        desc: "Audit task shows a per-paragraph grid colored by citation count (0→6+). Click any cell to jump to that paragraph in the Draft task.",
        icon: Radar,
      },
      {
        type: "feature",
        title: "Compose wizard",
        desc: "Compose task now shows a paragraph-selection wizard when you have paragraphs but no article yet. Select which paragraphs to include, with live previews.",
        icon: PenLine,
      },
      {
        type: "feature",
        title: "Keyboard shortcuts overlay",
        desc: "Press ? anytime to see all 15 shortcuts in 3 groups. Number keys 1-5 switch tasks; N/G/O/C/F trigger writing actions.",
        icon: Keyboard,
      },
      {
        type: "style",
        title: "4 theme personalities",
        desc: "Emerald (classic academic), Ocean (glassy pills), Sunset (hard offset shadows), Violet (glowing rings). Each theme changes component SHAPES, not just colors.",
        icon: Palette,
      },
    ],
  },
];

const VERSION_KEY = "sciwrite:last-seen-version";
const CURRENT_VERSION = CHANGELOG[0].version;

export function ChangelogDialog({ forceOpen = false }: { forceOpen?: boolean }) {
  const [open, setOpen] = React.useState(false);

  // Allow parent to force-open (e.g. from the Help menu)
  React.useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  React.useEffect(() => {
    try {
      const lastSeen = localStorage.getItem(VERSION_KEY);
      if (lastSeen !== CURRENT_VERSION) {
        // Only show if the user has completed onboarding (not a first-time visitor)
        const onboardingDone = localStorage.getItem("sciwrite:onboarding-completed");
        if (onboardingDone) {
          const timer = setTimeout(() => setOpen(true), 1200);
          return () => clearTimeout(timer);
        } else {
          // First-time visitor — just record the version, don't show changelog
          localStorage.setItem(VERSION_KEY, CURRENT_VERSION);
        }
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  const dismiss = React.useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem(VERSION_KEY, CURRENT_VERSION);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const latest = CHANGELOG[0];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && dismiss()}>
      <DialogContent className="canvas-changelog-dialog">
        <DialogHeader>
          <DialogTitle className="canvas-changelog-title">
            What's New
            <span className="canvas-changelog-version">{latest.version}</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {latest.date}
          </DialogDescription>
        </DialogHeader>

        <div className="canvas-changelog-list">
          {latest.entries.map((entry, i) => {
            const Icon = entry.icon;
            const iconClass =
              entry.type === "feature"
                ? "canvas-changelog-item-icon-feature"
                : entry.type === "fix"
                ? "canvas-changelog-item-icon-fix"
                : "canvas-changelog-item-icon-style";
            const tagClass =
              entry.type === "feature"
                ? "canvas-changelog-tag-feature"
                : entry.type === "fix"
                ? "canvas-changelog-tag-fix"
                : "canvas-changelog-tag-style";
            const tagLabel =
              entry.type === "feature" ? "New" : entry.type === "fix" ? "Fix" : "Style";
            return (
              <div key={i} className="canvas-changelog-item">
                <div className={`canvas-changelog-item-icon ${iconClass}`}>
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <div className="canvas-changelog-item-body">
                  <div className="canvas-changelog-item-title">
                    <span className={`canvas-changelog-tag ${tagClass}`}>{tagLabel}</span>
                    {entry.title}
                  </div>
                  <p className="canvas-changelog-item-desc">{entry.desc}</p>
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button size="sm" onClick={dismiss} className="canvas-cta-btn h-8 gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
