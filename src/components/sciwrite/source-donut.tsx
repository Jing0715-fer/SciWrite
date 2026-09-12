"use client";

import * as React from "react";

/**
 * SourceDonut — a small SVG donut chart showing the distribution of
 * data sources by type (pubmed, uniprot, rcsb, ncbi, blast, web, manual).
 * Renders inline above the database query panel in the Research task.
 */
const SOURCE_COLORS: Record<string, string> = {
  pubmed: "oklch(0.58 0.16 162)",
  crossref: "oklch(0.58 0.16 162)",
  uniprot: "oklch(0.62 0.12 185)",
  rcsb: "oklch(0.7 0.14 85)",
  ncbi: "oklch(0.58 0.18 30)",
  blast: "oklch(0.55 0.16 300)",
  web: "oklch(0.55 0.16 230)",
  manual: "oklch(0.6 0.01 250)",
};

const SOURCE_LABELS: Record<string, string> = {
  pubmed: "PubMed",
  crossref: "Crossref",
  uniprot: "UniProt",
  rcsb: "RCSB",
  ncbi: "NCBI",
  blast: "BLAST",
  web: "Web",
  manual: "Manual",
};

export function SourceDonut({
  sources,
  activeType,
  onSelectType,
}: {
  sources: { source: string; _count?: number }[] | { type?: string; sourceType?: string }[];
  activeType?: string | null;
  onSelectType?: (type: string | null) => void;
}) {
  const [hoveredType, setHoveredType] = React.useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = React.useState({ x: 0, y: 0 });

  // Normalize input: accept both {source} and {type} shapes
  const counts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sources as any[]) {
      const type = s.source || s.type || s.sourceType || "manual";
      map.set(type, (map.get(type) || 0) + 1);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1]);
  }, [sources]);

  const total = counts.reduce((s, [, c]) => s + c, 0);

  if (total === 0) return null;

  // Donut geometry — enlarged from 48 to 64 so the center number + label
  // don't overlap (262 + "sources" was unreadable at 48px).
  const size = 64;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  // Pre-compute cumulative offsets so we don't mutate during render
  const segments = counts.map(([type, count], i) => {
    const fraction = count / total;
    const dash = fraction * circumference;
    const offset = counts.slice(0, i).reduce((s, [, c]) => s + (c / total) * circumference, 0);
    return { type, count, dash, offset };
  });

  return (
    <div className="canvas-donut-wrap">
      <svg
        className="canvas-donut-svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${total} sources across ${counts.length} types`}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="color-mix(in oklch, var(--muted-foreground) 15%, transparent)"
          strokeWidth={stroke}
        />
        {segments.map(({ type, count, dash, offset }) => {
          const isActive = activeType === type;
          const isHovered = hoveredType === type;
          const isDimmed = activeType !== null && activeType !== undefined && !isActive;
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          return (
            <circle
              key={type}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={SOURCE_COLORS[type] || SOURCE_COLORS.manual}
              strokeWidth={isActive || isHovered ? stroke + 2 : stroke}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              opacity={isDimmed ? 0.3 : 1}
              style={{ cursor: onSelectType ? "pointer" : "default", transition: "opacity 0.2s, stroke-width 0.2s" }}
              onClick={() => onSelectType?.(isActive ? null : type)}
              onMouseEnter={(e) => { setHoveredType(type); setTooltipPos({ x: e.clientX, y: e.clientY }); }}
              onMouseMove={(e) => setTooltipPos({ x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHoveredType(null)}
            />
          );
        })}
        <text
          x={size / 2}
          y={size / 2 + 1}
          textAnchor="middle"
          dominantBaseline="middle"
          className="canvas-donut-center-value"
        >
          {total}
        </text>
        <text
          x={size / 2}
          y={size / 2 + 12}
          textAnchor="middle"
          dominantBaseline="middle"
          className="canvas-donut-center-label"
        >
          sources
        </text>
      </svg>
      <div className="canvas-donut-legend">
        {counts.map(([type, count]) => {
          const isActive = activeType === type;
          const isDimmed = activeType !== null && activeType !== undefined && !isActive;
          return (
            <button
              key={type}
              onClick={() => onSelectType?.(isActive ? null : type)}
              className={`canvas-donut-legend-item ${isActive ? "canvas-donut-legend-item-active" : ""}`}
              style={{ opacity: isDimmed ? 0.4 : 1, cursor: onSelectType ? "pointer" : "default" }}
              title={`Filter by ${SOURCE_LABELS[type] || type}`}
            >
              <span
                className="canvas-donut-legend-dot"
                style={{ background: SOURCE_COLORS[type] || SOURCE_COLORS.manual }}
              />
              {SOURCE_LABELS[type] || type}
              <span className="canvas-donut-legend-count">{count}</span>
            </button>
          );
        })}
        {activeType && (
          <button
            onClick={() => onSelectType?.(null)}
            className="canvas-donut-clear"
            title="Clear filter"
          >
            Clear filter
          </button>
        )}
      </div>
      {/* Hover tooltip — shows source type + count + percentage */}
      {hoveredType && (() => {
        const hCount = counts.find(([t]) => t === hoveredType)?.[1] || 0;
        const hPct = total > 0 ? Math.round((hCount / total) * 100) : 0;
        return (
          <div
            className="canvas-donut-tooltip"
            style={{
              position: "fixed",
              left: tooltipPos.x + 12,
              top: tooltipPos.y + 12,
              pointerEvents: "none",
              zIndex: 50,
            }}
          >
            <span
              className="canvas-donut-tooltip-dot"
              style={{ background: SOURCE_COLORS[hoveredType] || SOURCE_COLORS.manual }}
            />
            <span className="canvas-donut-tooltip-label">{SOURCE_LABELS[hoveredType] || hoveredType}</span>
            <span className="canvas-donut-tooltip-count">{hCount}</span>
            <span className="canvas-donut-tooltip-pct">{hPct}%</span>
          </div>
        );
      })()}
    </div>
  );
}
