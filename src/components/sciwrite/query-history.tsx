"use client";

import * as React from "react";
import { History, X, RotateCw, Search } from "lucide-react";

/**
 * useQueryHistory — persists recent database queries to localStorage
 * so the user can re-run them with one click. Each entry stores the
 * source, query text, program (for BLAST), result count, and timestamp.
 */
export interface QueryHistoryEntry {
  id: string;
  source: string;
  query: string;
  program?: "blastp" | "blastn";
  resultCount: number;
  timestamp: number;
}

const STORAGE_KEY = "sciwrite:query-history";
const MAX_ENTRIES = 12;

export function useQueryHistory() {
  const [history, setHistory] = React.useState<QueryHistoryEntry[]>([]);

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setHistory(parsed);
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  const persist = React.useCallback((entries: QueryHistoryEntry[]) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      /* storage unavailable */
    }
  }, []);

  const addEntry = React.useCallback(
    (entry: Omit<QueryHistoryEntry, "id" | "timestamp">) => {
      setHistory((prev) => {
        // Deduplicate: if the same source+query exists, remove the old one
        const filtered = prev.filter(
          (e) => !(e.source === entry.source && e.query === entry.query && e.program === entry.program)
        );
        const newEntry: QueryHistoryEntry = {
          ...entry,
          id: `${entry.source}-${entry.query}-${Date.now()}`,
          timestamp: Date.now(),
        };
        const next = [newEntry, ...filtered].slice(0, MAX_ENTRIES);
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const removeEntry = React.useCallback(
    (id: string) => {
      setHistory((prev) => {
        const next = prev.filter((e) => e.id !== id);
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const clearAll = React.useCallback(() => {
    setHistory([]);
    persist([]);
  }, [persist]);

  return { history, addEntry, removeEntry, clearAll };
}

/**
 * QueryHistoryBar — renders the recent-queries strip below the search row.
 * Each chip shows the source badge + query snippet + result count.
 * Click re-runs; X removes.
 */
export function QueryHistoryBar({
  history,
  onRerun,
  onRemove,
  onClear,
}: {
  history: QueryHistoryEntry[];
  onRerun: (entry: QueryHistoryEntry) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  if (history.length === 0) return null;
  return (
    <div className="canvas-history-bar">
      <div className="canvas-history-header">
        <History className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="canvas-history-title">Recent queries</span>
        <span className="canvas-history-count">{history.length}</span>
        <button onClick={onClear} className="canvas-history-clear" title="Clear history">
          Clear all
        </button>
      </div>
      <div className="canvas-history-chips">
        {history.map((entry) => (
          <div key={entry.id} className="canvas-history-chip">
            <button
              onClick={() => onRerun(entry)}
              className="canvas-history-chip-body"
              title={`Re-run: ${entry.query}`}
            >
              <span className={`canvas-history-chip-badge ${getSourceBadgeClass(entry.source)}`}>
                {entry.source[0].toUpperCase()}
              </span>
              <span className="canvas-history-chip-query">{entry.query}</span>
              <span className="canvas-history-chip-count">{entry.resultCount}</span>
              <RotateCw className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
            </button>
            <button
              onClick={() => onRemove(entry.id)}
              className="canvas-history-chip-remove"
              aria-label="Remove from history"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function getSourceBadgeClass(source: string): string {
  const map: Record<string, string> = {
    pubmed: "badge-emerald",
    uniprot: "badge-teal",
    rcsb: "badge-amber",
    ncbi: "badge-rose",
    blast: "badge-violet",
    web: "badge-sky",
  };
  return map[source] || "badge-slate";
}
