"use client";

import * as React from "react";
import { useTheme } from "next-themes";

// Keyboard shortcuts (defined after paragraphs so it can reference it)
export function useHomeKeyboardShortcuts({
  activeProjectId,
  paragraphs,
  setPaletteOpen,
  setInsightsOpen,
  setUnifiedWriteTab,
  setUnifiedWriteOpen,
}: {
  activeProjectId: string | null;
  paragraphs: any[];
  setPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setInsightsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setUnifiedWriteTab: React.Dispatch<
    React.SetStateAction<"outline" | "gather" | "paragraph" | "compose" | "full">
  >;
  setUnifiedWriteOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const tag = (e.target as HTMLElement)?.tagName;
      const isTyping =
        tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;
      // Cmd/Ctrl+K always opens palette
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // Single-key shortcuts only when not typing and no modifier (except Shift)
      if (isTyping || meta || e.altKey) return;
      if (!activeProjectId) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        setUnifiedWriteTab("paragraph");
        setUnifiedWriteOpen(true);
      } else if (k === "g") {
        e.preventDefault();
        setUnifiedWriteTab("gather");
        setUnifiedWriteOpen(true);
      } else if (k === "i") {
        e.preventDefault();
        setInsightsOpen(true);
      } else if (k === "o") {
        e.preventDefault();
        setUnifiedWriteTab("outline");
        setUnifiedWriteOpen(true);
      } else if (k === "c" && paragraphs.length >= 2) {
        e.preventDefault();
        setUnifiedWriteTab("compose");
        setUnifiedWriteOpen(true);
      } else if (k === "f") {
        e.preventDefault();
        setUnifiedWriteTab("full");
        setUnifiedWriteOpen(true);
      } else if (k === "d") {
        e.preventDefault();
        // Route through next-themes so the ThemeToggle/ThemeSwitcher UI state
        // stays in sync with the actual theme (instead of toggling the `dark`
        // class directly, which desynced next-themes' internal state).
        setTheme(resolvedTheme === "dark" ? "light" : "dark");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeProjectId, paragraphs.length, resolvedTheme, setTheme]);
}
