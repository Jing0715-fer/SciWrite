"use client";

import * as React from "react";
import { Quote, AlertCircle, CheckCircle2 } from "lucide-react";

/**
 * CitationHeatmap — a per-paragraph citation density visualization.
 * Renders a grid of cells, one per paragraph, colored by citation count:
 * - 0 citations → muted (needs attention)
 * - 1-2 → light primary tint
 * - 3-5 → medium primary
 * - 6+ → strong primary
 * Each cell shows the paragraph number + citation count. Hover shows tooltip.
 * Below: a summary row with totals (paragraphs, citations, avg, coverage).
 */
export function CitationHeatmap({
  paragraphs,
  onJumpParagraph,
}: {
  paragraphs: any[];
  onJumpParagraph?: (id: string) => void;
}) {
  const stats = React.useMemo(() => {
    const counts = paragraphs.map((p) => {
      const content = p.content || "";
      const matches = content.match(
        /\[(\d{1,3}(?:[,\-–\s]\d{1,3})*|[A-Z]{2,12}:\s?[^\]\n]{1,60})\]/g
      );
      return {
        id: p.id,
        index: 0, // filled below
        count: matches?.length || 0,
        wordCount: p.wordCount || 0,
      };
    });
    counts.forEach((c, i) => (c.index = i + 1));
    const totalCitations = counts.reduce((s, c) => s + c.count, 0);
    const citedCount = counts.filter((c) => c.count > 0).length;
    const coverage = paragraphs.length > 0 ? Math.round((citedCount / paragraphs.length) * 100) : 0;
    const avg = paragraphs.length > 0 ? (totalCitations / paragraphs.length).toFixed(1) : "0";
    const maxCount = Math.max(0, ...counts.map((c) => c.count));
    return { counts, totalCitations, citedCount, coverage, avg, maxCount };
  }, [paragraphs]);

  if (paragraphs.length === 0) {
    return (
      <div className="canvas-heatmap-empty">
        <AlertCircle className="h-10 w-10 text-muted-foreground/40 mb-2" />
        <p className="text-sm font-medium text-muted-foreground">No paragraphs to visualize</p>
        <p className="text-xs text-muted-foreground/70 mt-1">Draft some paragraphs first to see citation density.</p>
      </div>
    );
  }

  return (
    <div className="canvas-heatmap">
      {/* Summary stats */}
      <div className="canvas-heatmap-summary">
        <div className="canvas-heatmap-stat">
          <div className="canvas-heatmap-stat-label">Paragraphs</div>
          <div className="canvas-heatmap-stat-value">{paragraphs.length}</div>
        </div>
        <div className="canvas-heatmap-stat">
          <div className="canvas-heatmap-stat-label">Citations</div>
          <div className="canvas-heatmap-stat-value">{stats.totalCitations}</div>
        </div>
        <div className="canvas-heatmap-stat">
          <div className="canvas-heatmap-stat-label">Avg / para</div>
          <div className="canvas-heatmap-stat-value">
            {stats.avg}
            <span className="canvas-heatmap-stat-unit">refs</span>
          </div>
        </div>
        <div className="canvas-heatmap-stat">
          <div className="canvas-heatmap-stat-label">Coverage</div>
          <div className="canvas-heatmap-stat-value">
            {stats.coverage}
            <span className="canvas-heatmap-stat-unit">%</span>
          </div>
        </div>
        <div className="canvas-heatmap-stat">
          <div className="canvas-heatmap-stat-label">Max in para</div>
          <div className="canvas-heatmap-stat-value">{stats.maxCount}</div>
        </div>
      </div>

      {/* Heatmap grid */}
      <div className="canvas-heatmap-grid">
        {stats.counts.map((c) => {
          const intensity = getIntensity(c.count);
          return (
            <button
              key={c.id}
              onClick={() => onJumpParagraph?.(c.id)}
              className="canvas-heatmap-cell"
              style={{ backgroundColor: intensity.bg, borderColor: intensity.border }}
              title={`§${c.index}: ${c.count} citation${c.count !== 1 ? "s" : ""} · ${c.wordCount} words`}
            >
              <span className="canvas-heatmap-cell-num" style={{ color: intensity.text }}>
                §{c.index}
              </span>
              <span className="canvas-heatmap-cell-count" style={{ color: intensity.subtext }}>
                {c.count} ref{c.count !== 1 ? "s" : ""}
              </span>
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="canvas-heatmap-legend">
        <span>Density:</span>
        <div className="canvas-heatmap-scale">
          {SCALE.map((s, i) => (
            <span
              key={i}
              className="canvas-heatmap-scale-cell"
              style={{ backgroundColor: s.bg }}
              title={s.label}
            />
          ))}
        </div>
        <span className="text-[10px]">0 → {stats.maxCount}+ citations</span>
        <Quote className="h-3 w-3 text-primary ml-auto" />
      </div>
    </div>
  );
}

interface Intensity {
  bg: string;
  border: string;
  text: string;
  subtext: string;
}

interface ScaleEntry {
  label: string;
  bg: string;
}

// Color scale using color-mix with the live --primary so it follows the theme.
// 0 → muted background (needs attention), 1-2 → faint, 3-5 → medium, 6+ → strong.
const SCALE: ScaleEntry[] = [
  { label: "0 citations", bg: "color-mix(in oklch, var(--muted-foreground) 8%, transparent)" },
  { label: "1-2", bg: "color-mix(in oklch, var(--primary) 12%, var(--card))" },
  { label: "3-5", bg: "color-mix(in oklch, var(--primary) 28%, var(--card))" },
  { label: "6+", bg: "color-mix(in oklch, var(--primary) 50%, var(--card))" },
];

function getIntensity(count: number): Intensity {
  if (count === 0) {
    return {
      bg: "color-mix(in oklch, var(--muted-foreground) 6%, transparent)",
      border: "color-mix(in oklch, var(--muted-foreground) 25%, transparent)",
      text: "var(--muted-foreground)",
      subtext: "color-mix(in oklch, var(--muted-foreground) 70%, transparent)",
    };
  }
  if (count <= 2) {
    return {
      bg: "color-mix(in oklch, var(--primary) 12%, var(--card))",
      border: "color-mix(in oklch, var(--primary) 25%, transparent)",
      text: "var(--primary)",
      subtext: "color-mix(in oklch, var(--primary) 75%, transparent)",
    };
  }
  if (count <= 5) {
    return {
      bg: "color-mix(in oklch, var(--primary) 28%, var(--card))",
      border: "color-mix(in oklch, var(--primary) 40%, transparent)",
      text: "var(--primary)",
      subtext: "color-mix(in oklch, var(--primary) 85%, transparent)",
    };
  }
  return {
    bg: "color-mix(in oklch, var(--primary) 50%, var(--card))",
    border: "var(--primary)",
    text: "var(--primary-foreground)",
    subtext: "color-mix(in oklch, var(--primary-foreground) 80%, transparent)",
  };
}
