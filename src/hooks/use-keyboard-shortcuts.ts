"use client";

import * as React from "react";

/**
 * useKeyboardShortcuts — register keyboard shortcuts via a handler map.
 *
 * Each shortcut is defined by:
 *  - key: the KeyboardEvent.key (e.g. "k", "Escape", "Enter", "f")
 *  - mod: "cmd" (Meta), "ctrl" (Control), "shift", or "none"
 *  - handler: called when the shortcut is pressed
 *  - preventDefault: whether to call e.preventDefault() (default: true)
 *  - enabled: whether the shortcut is currently active (default: true)
 *
 * The hook attaches a single keydown listener to window and dispatches
 * to the matching handler. Shortcuts are checked in order; first match wins.
 *
 * Usage:
 *   useKeyboardShortcuts([
 *     { key: "k", mod: "cmd", handler: () => setSearchOpen(true) },
 *     { key: "Escape", mod: "none", handler: () => setSearchOpen(false) },
 *   ]);
 */
export interface KeyboardShortcut {
  key: string;
  mod: "cmd" | "ctrl" | "shift" | "none";
  handler: () => void;
  preventDefault?: boolean;
  enabled?: boolean;
}

/**
 * Options for the hook itself (separate from individual shortcut options).
 */
export interface KeyboardShortcutsOptions {
  /**
   * When true, the listener is registered in the CAPTURE phase (before
   * bubble-phase listeners on the same element). This lets this hook's
   * shortcuts take priority over other window-level listeners that were
   * registered earlier (e.g. a global Command Palette handler).
   *
   * When a capture-phase handler calls e.stopPropagation(), bubble-phase
   * listeners on the same element will NOT fire.
   *
   * Default: false
   */
  capture?: boolean;
}

export function useKeyboardShortcuts(
  shortcuts: KeyboardShortcut[],
  options?: KeyboardShortcutsOptions
) {
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if focus is in an input/textarea UNLESS the shortcut
      // is Escape (which should always close things) or explicitly allowed.
      const target = e.target as HTMLElement;
      const isInputLike =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      for (const sc of shortcuts) {
        if (sc.enabled === false) continue;

        // Skip input-context shortcuts when typing, except Escape and
        // Cmd/Ctrl combos (global shortcuts like Cmd+K must still work in
        // inputs). r37 fix: the previous condition (`sc.mod !== "none"`)
        // let plain-letter shortcuts (s/v/h/1-9/Delete) bypass this guard
        // entirely — typing in a text field swallowed the keystroke AND
        // fired the shortcut (e.g. "Delete" popped the delete-article
        // confirmation while editing).
        if (
          isInputLike &&
          sc.key !== "Escape" &&
          sc.mod !== "cmd" &&
          sc.mod !== "ctrl"
        ) {
          continue;
        }

        // Check modifier
        const modMatch =
          (sc.mod === "cmd" && (e.metaKey || e.ctrlKey)) ||
          (sc.mod === "ctrl" && e.ctrlKey) ||
          (sc.mod === "shift" && e.shiftKey && !e.metaKey && !e.ctrlKey) ||
          (sc.mod === "none" && !e.metaKey && !e.ctrlKey && !e.shiftKey);

        if (!modMatch) continue;

        // Check key (case-insensitive for letters)
        const keyMatch =
          e.key.toLowerCase() === sc.key.toLowerCase() ||
          e.key === sc.key;

        if (!keyMatch) continue;

        // Match found — fire handler
        if (sc.preventDefault !== false) {
          e.preventDefault();
          // stopImmediatePropagation prevents other listeners on the SAME
          // element from firing (both capture and bubble phase on window).
          // This is critical for overriding global shortcuts like Cmd+K.
          e.stopImmediatePropagation();
        }
        sc.handler();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, {
      capture: options?.capture ?? false,
    });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, {
        capture: options?.capture ?? false,
      });
  }, [shortcuts, options?.capture]);
}

/**
 * Format a keyboard shortcut for display.
 * Returns a human-readable string like "⌘K", "Ctrl+F", "Esc", "Shift+Enter".
 */
export function formatShortcut(sc: { key: string; mod: string }): string {
  const isMac =
    typeof navigator !== "undefined" &&
    (navigator.platform?.toLowerCase().includes("mac") ||
      navigator.userAgent?.toLowerCase().includes("mac"));
  const modKey =
    sc.mod === "cmd"
      ? isMac
        ? "⌘"
        : "Ctrl+"
      : sc.mod === "ctrl"
      ? "Ctrl+"
      : sc.mod === "shift"
      ? "Shift+"
      : "";
  const keyDisplay =
    sc.key === "Escape"
      ? "Esc"
      : sc.key === "Enter"
      ? "↵"
      : sc.key.length === 1
      ? sc.key.toUpperCase()
      : sc.key;
  return modKey + keyDisplay;
}
