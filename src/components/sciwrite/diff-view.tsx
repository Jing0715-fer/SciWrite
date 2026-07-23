"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { GitCompare, ArrowRight, Check } from "lucide-react";
import { MarkdownCitations } from "./markdown-citations";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  before: string;
  after: string;
  title?: string;
}

interface DiffSegment {
  type: "same" | "added" | "removed";
  text: string;
}

/**
 * Simple word-level diff using LCS.
 */
function computeDiff(before: string, after: string): DiffSegment[] {
  const beforeWords = before.split(/(\s+)/);
  const afterWords = after.split(/(\s+)/);
  const n = beforeWords.length;
  const m = afterWords.length;

  // LCS DP table
  const dp: number[][] = Array(n + 1)
    .fill(null)
    .map(() => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (beforeWords[i] === afterWords[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  let current: DiffSegment | null = null;

  const push = (type: DiffSegment["type"], text: string) => {
    if (!text) return;
    if (current && current.type === type) {
      current.text += text;
    } else {
      if (current) segments.push(current);
      current = { type, text };
    }
  };

  while (i < n && j < m) {
    if (beforeWords[i] === afterWords[j]) {
      push("same", beforeWords[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("removed", beforeWords[i]);
      i++;
    } else {
      push("added", afterWords[j]);
      j++;
    }
  }
  while (i < n) {
    push("removed", beforeWords[i]);
    i++;
  }
  while (j < m) {
    push("added", afterWords[j]);
    j++;
  }
  if (current) segments.push(current);
  return segments;
}

export function DiffView({ open, onOpenChange, before, after, title }: Props) {
  const diff = React.useMemo(() => computeDiff(before, after), [before, after]);
  const addedCount = diff
    .filter((s) => s.type === "added")
    .reduce((sum, s) => sum + s.text.split(/\s+/).filter(Boolean).length, 0);
  const removedCount = diff
    .filter((s) => s.type === "removed")
    .reduce((sum, s) => sum + s.text.split(/\s+/).filter(Boolean).length, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 text-base">
            <GitCompare className="h-4 w-4 text-primary" />
            Revision Comparison
          </DialogTitle>
          <DialogDescription className="text-xs">
            {title || "Before vs. after AI revision"}
            <span className="ml-2 inline-flex items-center gap-2">
              <span className="text-rose-600">-{removedCount}w</span>
              <span className="text-emerald-600">+{addedCount}w</span>
            </span>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-6 py-4">
            {/* Inline diff view */}
            <p className="prose-academic text-sm leading-relaxed whitespace-pre-wrap break-words m-0">
              {diff.map((seg, idx) => {
                if (seg.type === "added") {
                  return (
                    <span
                      key={idx}
                      className="bg-emerald-100/70 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200 rounded px-0.5"
                    >
                      {seg.text}
                    </span>
                  );
                }
                if (seg.type === "removed") {
                  return (
                    <span
                      key={idx}
                      className="bg-rose-100/70 dark:bg-rose-950/40 text-rose-900 dark:text-rose-200 line-through rounded px-0.5"
                    >
                      {seg.text}
                    </span>
                  );
                }
                return <span key={idx}>{seg.text}</span>;
              })}
            </p>

            {/* Side-by-side view */}
            <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-lg border border-rose-200/60 dark:border-rose-900/40 overflow-hidden">
                <div className="px-3 py-1.5 bg-rose-50/50 dark:bg-rose-950/20 border-b border-rose-200/60 dark:border-rose-900/40">
                  <span className="text-[10px] uppercase tracking-wider text-rose-700 dark:text-rose-400 font-semibold">
                    Before
                  </span>
                </div>
                <div className="p-3 max-h-64 overflow-y-auto scroll-academic">
                  <MarkdownCitations content={before} className="text-[11px]" />
                </div>
              </div>
              <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 overflow-hidden">
                <div className="px-3 py-1.5 bg-emerald-50/50 dark:bg-emerald-950/20 border-b border-emerald-200/60 dark:border-emerald-900/40">
                  <span className="text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400 font-semibold">
                    After
                  </span>
                </div>
                <div className="p-3 max-h-64 overflow-y-auto scroll-academic">
                  <MarkdownCitations content={after} className="text-[11px]" />
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
