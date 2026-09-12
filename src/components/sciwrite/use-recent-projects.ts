"use client";

import * as React from "react";

/**
 * useRecentProjects — tracks the most recently accessed project IDs in
 * localStorage so the project switcher can show a quick-access row.
 * Stores up to 5 IDs, most-recent-first, deduplicated.
 */
const STORAGE_KEY = "sciwrite:recent-projects";
const MAX_RECENT = 5;

export function useRecentProjects(activeProjectId: string | null) {
  const [recentIds, setRecentIds] = React.useState<string[]>([]);

  // Load from storage on mount
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setRecentIds(parsed);
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  // When the active project changes, add it to the front of the list
  React.useEffect(() => {
    if (!activeProjectId) return;
    setRecentIds((prev) => {
      const filtered = prev.filter((id) => id !== activeProjectId);
      const next = [activeProjectId, ...filtered].slice(0, MAX_RECENT);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, [activeProjectId]);

  return recentIds;
}
