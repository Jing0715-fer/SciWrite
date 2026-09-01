"use client";

import * as React from "react";
import { Network, ZoomIn, ZoomOut, Maximize2, Download } from "lucide-react";

/**
 * CitationGraph — interactive SVG graph visualizing source relationships.
 *
 * Features:
 * - Force-directed layout: simple physics simulation (repulsion between
 *   nodes + spring attraction along edges) runs for ~60 iterations on mount
 *   to produce a natural-looking layout. No external graph library needed.
 * - Pan + zoom: mouse wheel to zoom, drag the background to pan.
 *   Reset-view button restores default.
 * - Click a node to select it — emits onNodeClick(sourceIndex) so the
 *   parent can open the data-source detail panel.
 * - Hover a node to highlight its connections + show a tooltip.
 * - Theme-colored nodes with a legend.
 */

interface GraphNode {
  id: string;
  label: string;
  theme?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface GraphEdge {
  source: string;
  target: string;
  label?: string;
}

interface Props {
  data: any;
  dataSources: any[];
  themesLabel: string;
  connectionsLabel: string;
  /** Called when the user clicks a node. Receives the source index (0-based). */
  onNodeClick?: (sourceIndex: number) => void;
}

const THEME_COLORS = [
  "#0d9488", "#dc2626", "#16a34a", "#d97706",
  "#c026d3", "#0891b2", "#ea580c", "#7c3aed",
];

const VIEW_W = 400;
const VIEW_H = 300;

export function CitationGraph({ data, dataSources, themesLabel, connectionsLabel, onNodeClick }: Props) {
  const [hoveredNode, setHoveredNode] = React.useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = React.useState<number | null>(null);
  const [selectedNode, setSelectedNode] = React.useState<string | null>(null);
  // Node search — typing "S1" highlights/pans to that node
  const [searchQuery, setSearchQuery] = React.useState("");
  // Cluster expansion — when dataSources > 30, nodes are grouped by theme
  // into cluster bubbles. Clicking a cluster expands it to show individual
  // nodes. This prevents visual clutter for large graphs.
  const [expandedThemes, setExpandedThemes] = React.useState<Set<string>>(new Set());
  // Pan + zoom state
  const [scale, setScale] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = React.useState(false);
  const dragStart = React.useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const svgRef = React.useRef<SVGSVGElement>(null);

  // Whether to use cluster mode (>30 sources and not all themes expanded)
  const useClusterMode = dataSources.length > 30;

  // Build nodes + edges, then run force-directed layout.
  const { nodes, edges, themeColors } = React.useMemo(() => {
    const themes: string[] = (data?.themes || []).map((t: any) => t.name || "Other");
    const themeMap = new Map<string, string>();
    themes.forEach((t: string, i: number) => {
      themeMap.set(t, THEME_COLORS[i % THEME_COLORS.length]);
    });

    const sourceList = (dataSources || []).slice(0, 50); // Cap at 50 for cluster mode
    const nodeThemeMap = new Map<string, string>();
    (data?.themes || []).forEach((t: any) => {
      const tName = t.name || "Other";
      (t.sourceLabels || []).forEach((label: string) => {
        nodeThemeMap.set(label, tName);
      });
    });

    // In cluster mode (>30 sources), group nodes by theme. Each theme that
    // hasn't been expanded becomes a single cluster node (larger circle with
    // a count label). Expanded themes show their individual nodes.
    const nodeList: GraphNode[] = [];
    if (useClusterMode) {
      // Group sources by theme
      const byTheme = new Map<string, any[]>();
      sourceList.forEach((ds: any, i: number) => {
        const label = `S${i + 1}`;
        const theme = nodeThemeMap.get(label) || "Other";
        if (!byTheme.has(theme)) byTheme.set(theme, []);
        byTheme.get(theme)!.push({ ds, label, idx: i });
      });

      // For each theme: if expanded, add individual nodes; else add a cluster node
      let nodeIdx = 0;
      byTheme.forEach((items, theme) => {
        const isExpanded = expandedThemes.has(theme);
        if (isExpanded) {
          items.forEach((item) => {
            const angle = (nodeIdx / sourceList.length) * 2 * Math.PI;
            nodeList.push({
              id: item.ds.id || item.label,
              label: item.label,
              theme,
              x: VIEW_W / 2 + 80 * Math.cos(angle),
              y: VIEW_H / 2 + 60 * Math.sin(angle),
              vx: 0, vy: 0,
            });
            nodeIdx++;
          });
        } else {
          // Cluster node — represents the whole theme
          const angle = (nodeIdx / byTheme.size) * 2 * Math.PI;
          nodeList.push({
            id: `cluster:${theme}`,
            label: `${items.length}`,
            theme,
            x: VIEW_W / 2 + 80 * Math.cos(angle),
            y: VIEW_H / 2 + 60 * Math.sin(angle),
            vx: 0, vy: 0,
          });
          nodeIdx++;
        }
      });
    } else {
      // Normal mode — all individual nodes
      sourceList.forEach((ds: any, i: number) => {
        const angle = (i / sourceList.length) * 2 * Math.PI;
        const label = `S${i + 1}`;
        const theme = nodeThemeMap.get(label) || "Other";
        if (!themeMap.has(theme)) themeMap.set(theme, THEME_COLORS[themeMap.size % THEME_COLORS.length]);
        nodeList.push({
          id: ds.id || label,
          label,
          theme,
          x: VIEW_W / 2 + 80 * Math.cos(angle),
          y: VIEW_H / 2 + 60 * Math.sin(angle),
          vx: 0, vy: 0,
        });
      });
    }

    // Build edges
    const edgeList: GraphEdge[] = [];
    const labelToId = new Map<string, string>();
    nodeList.forEach((n) => labelToId.set(n.label, n.id));
    const nodeIds = new Set(nodeList.map((n) => n.id));

    (data?.keyConnections || data?.edges || []).forEach((conn: any) => {
      const matches = (conn.description || conn.label || "").match(/S\d+/g);
      if (matches && matches.length >= 2) {
        for (let i = 0; i < matches.length - 1; i++) {
          const sourceId = labelToId.get(matches[i]);
          const targetId = labelToId.get(matches[i + 1]);
          if (sourceId && targetId && sourceId !== targetId) {
            edgeList.push({ source: sourceId, target: targetId, label: (conn.description || "").slice(0, 60) });
          }
        }
      }
      if (conn.source && conn.target) {
        const sId = labelToId.get(conn.source) || conn.source;
        const tId = labelToId.get(conn.target) || conn.target;
        if (nodeIds.has(sId) && nodeIds.has(tId) && sId !== tId) {
          edgeList.push({ source: sId, target: tId, label: conn.label });
        }
      }
    });

    // Force-directed layout: ~60 iterations of repulsion + spring attraction.
    // This is a simplified Fruchterman-Reingold without cooling — fast enough
    // for 30 nodes (< 1ms per iteration).
    const REPULSION = 800; // node-node repulsion strength
    const ATTRACTION = 0.04; // edge spring strength
    const DAMPING = 0.85; // velocity damping per iteration
    const CENTER_PULL = 0.005; // gentle pull toward center to prevent drift
    const MIN_DIST = 25; // minimum node distance to avoid overlap

    for (let iter = 0; iter < 60; iter++) {
      // Reset forces
      nodeList.forEach((n) => { n.vx = 0; n.vy = 0; });

      // Repulsion between all node pairs
      for (let i = 0; i < nodeList.length; i++) {
        for (let j = i + 1; j < nodeList.length; j++) {
          const a = nodeList[i];
          const b = nodeList[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.max(MIN_DIST, Math.sqrt(dx * dx + dy * dy));
          const force = REPULSION / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }

      // Spring attraction along edges
      edgeList.forEach((e) => {
        const s = nodeList.find((n) => n.id === e.source);
        const t = nodeList.find((n) => n.id === e.target);
        if (!s || !t) return;
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const force = ATTRACTION * dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        s.vx += fx; s.vy += fy;
        t.vx -= fx; t.vy -= fy;
      });

      // Center pull + apply velocity with damping
      nodeList.forEach((n) => {
        n.vx += (VIEW_W / 2 - n.x) * CENTER_PULL;
        n.vy += (VIEW_H / 2 - n.y) * CENTER_PULL;
        n.x += n.vx * DAMPING;
        n.y += n.vy * DAMPING;
        // Keep within bounds
        n.x = Math.max(20, Math.min(VIEW_W - 20, n.x));
        n.y = Math.max(20, Math.min(VIEW_H - 20, n.y));
      });
    }

    return { nodes: nodeList, edges: edgeList, themeColors: themeMap };
  }, [data, dataSources]);

  // Zoom via Ctrl+wheel — hooks declared BEFORE the early return below
  // (rules-of-hooks: hooks must not sit behind a conditional return).
  // round-44: wheel-zoom now requires Ctrl (the standard map-style
  // convention) and binds a NATIVE non-passive listener so the Ctrl+wheel
  // preventDefault actually works. Previously every plain wheel tick over
  // the graph zoomed it — React's onWheel is passive (React 17+ root
  // delegation), so the preventDefault() call inside it was a no-op that
  // logged console errors, and plain scrolling over the graph fought the
  // user's intent to scroll the page/panel.
  const wheelHostRef = React.useRef<SVGSVGElement | null>(null);
  React.useEffect(() => {
    const host = wheelHostRef.current ?? svgRef.current;
    if (!host) return;
    const onWheelNative = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel → normal scrolling
      e.preventDefault(); // stop the browser's page-zoom on ctrl+wheel
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setScale((s) => Math.max(0.5, Math.min(3, s * delta)));
    };
    host.addEventListener("wheel", onWheelNative, { passive: false });
    return () => host.removeEventListener("wheel", onWheelNative);
  }, []);

  if (nodes.length === 0) return null;

  const highlightedNodes = new Set<string>();
  if (hoveredNode) {
    highlightedNodes.add(hoveredNode);
    edges.forEach((e) => {
      if (e.source === hoveredNode) highlightedNodes.add(e.target);
      if (e.target === hoveredNode) highlightedNodes.add(e.source);
    });
  }

  const isNodeActive = (id: string) => !hoveredNode || highlightedNodes.has(id);
  const isEdgeActive = (e: GraphEdge) => !hoveredNode || e.source === hoveredNode || e.target === hoveredNode;

  // Pan handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.target === svgRef.current || (e.target as Element).tagName === "rect") {
      setIsDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    }
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPan({
        x: dragStart.current.panX + (e.clientX - dragStart.current.x),
        y: dragStart.current.panY + (e.clientY - dragStart.current.y),
      });
    }
  };
  const handleMouseUp = () => setIsDragging(false);

  const resetView = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  // Node click — emit source index for parent to handle
  const handleNodeClick = (nodeId: string, label: string) => {
    setSelectedNode(nodeId);
    const match = label.match(/S(\d+)/);
    if (match && onNodeClick) {
      onNodeClick(parseInt(match[1], 10) - 1);
    }
  };

  return (
    <div className="rounded-lg border border-border/60 bg-gradient-to-br from-muted/10 to-transparent p-3 space-y-2 transition-all hover:border-primary/30 hover:shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
          <Network className="h-3.5 w-3.5 text-primary" />
          {themesLabel} × {connectionsLabel}
        </p>
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-muted-foreground/60 mr-1">
            {nodes.length} nodes · {edges.length} edges
            {dataSources.length > 30 && ` (+${dataSources.length - 30} hidden)`}
          </span>
          {/* Node search — type "S1" to find and highlight a node */}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              const q = e.target.value.toUpperCase();
              setSearchQuery(q);
              // If the query matches a node label, pan + zoom to it
              const found = nodes.find((n) => n.label.toUpperCase() === q);
              if (found) {
                setScale(1.8);
                setPan({ x: VIEW_W / 2 - found.x * 1.8, y: VIEW_H / 2 - found.y * 1.8 });
                setSelectedNode(found.id);
              }
            }}
            placeholder="S1…"
            className="w-12 h-5 text-[9px] font-mono text-center rounded border border-border/60 bg-background px-1 focus:ring-1 focus:ring-primary/30 focus:border-primary outline-none"
            title="Search node by label (e.g. S1, S2, …)"
          />
          {/* Zoom controls */}
          <button
            onClick={() => setScale((s) => Math.max(0.5, s * 0.8))}
            className="p-1 rounded hover:bg-muted/60 text-muted-foreground"
            title="Zoom out"
          >
            <ZoomOut className="h-3 w-3" />
          </button>
          <span className="text-[9px] font-mono text-muted-foreground w-7 text-center tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale((s) => Math.min(3, s * 1.25))}
            className="p-1 rounded hover:bg-muted/60 text-muted-foreground"
            title="Zoom in"
          >
            <ZoomIn className="h-3 w-3" />
          </button>
          <button
            onClick={resetView}
            className="p-1 rounded hover:bg-muted/60 text-muted-foreground"
            title="Reset view"
          >
            <Maximize2 className="h-3 w-3" />
          </button>
          {/* Export graph as PNG — serializes the SVG to a canvas and downloads */}
          <button
            onClick={() => {
              if (!svgRef.current) return;
              const svg = svgRef.current;
              const svgData = new XMLSerializer().serializeToString(svg);
              const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
              const url = URL.createObjectURL(svgBlob);
              const img = new Image();
              img.onload = () => {
                const canvas = document.createElement("canvas");
                canvas.width = 800;
                canvas.height = 600;
                const ctx = canvas.getContext("2d");
                if (!ctx) return;
                ctx.fillStyle = "white";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, 800, 600);
                canvas.toBlob((blob) => {
                  if (!blob) return;
                  const pngUrl = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = pngUrl;
                  a.download = "citation-graph.png";
                  a.click();
                  URL.revokeObjectURL(pngUrl);
                });
                URL.revokeObjectURL(url);
              };
              img.src = url;
            }}
            className="p-1 rounded hover:bg-muted/60 text-muted-foreground"
            title="Export as PNG"
          >
            <Download className="h-3 w-3" />
          </button>
        </div>
      </div>

      <svg
        ref={(el) => {
          svgRef.current = el;
          wheelHostRef.current = el;
        }}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full h-auto border border-border/30 rounded bg-background/40"
        style={{ maxHeight: "280px", cursor: isDragging ? "grabbing" : "grab" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* Invisible background rect to catch pan clicks */}
        <rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill="transparent" />
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale})`}>
          {/* Edges */}
          {edges.map((e, i) => {
            const source = nodes.find((n) => n.id === e.source);
            const target = nodes.find((n) => n.id === e.target);
            if (!source || !target) return null;
            const active = isEdgeActive(e);
            const isEdgeHovered = hoveredEdge === i;
            // Midpoint for edge label
            const midX = (source.x + target.x) / 2;
            const midY = (source.y + target.y) / 2;
            return (
              <g key={`edge-${i}`}>
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={isEdgeHovered ? "hsl(var(--primary))" : active ? "hsl(var(--primary))" : "hsl(var(--muted-foreground) / 0.15)"}
                  strokeWidth={isEdgeHovered ? 2.5 : active ? 1.5 : 0.8}
                  opacity={isEdgeHovered ? 1 : active ? 0.7 : 0.2}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHoveredEdge(i)}
                  onMouseLeave={() => setHoveredEdge(null)}
                />
                {/* Edge label — shown on hover. Truncated to keep it compact. */}
                {isEdgeHovered && e.label && (
                  <g style={{ pointerEvents: "none" }}>
                    <rect
                      x={midX - 40} y={midY - 8} width={80} height={16}
                      rx={3}
                      fill="hsl(var(--background))"
                      stroke="hsl(var(--border))"
                      strokeWidth={0.5}
                      opacity={0.95}
                    />
                    <text
                      x={midX} y={midY + 3}
                      textAnchor="middle"
                      fontSize={6}
                      fill="hsl(var(--foreground))"
                      className="font-mono"
                    >
                      {e.label.slice(0, 40)}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Nodes */}
          {nodes.map((n) => {
            const color = themeColors.get(n.theme || "Other") || THEME_COLORS[0];
            const active = isNodeActive(n.id);
            const isHovered = hoveredNode === n.id;
            const isSelected = selectedNode === n.id;
            const isCluster = n.id.startsWith("cluster:");
            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                onMouseEnter={() => setHoveredNode(n.id)}
                onMouseLeave={() => setHoveredNode(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isCluster) {
                    // Toggle cluster expansion
                    const theme = n.id.replace("cluster:", "");
                    setExpandedThemes((prev) => {
                      const next = new Set(prev);
                      if (next.has(theme)) next.delete(theme);
                      else next.add(theme);
                      return next;
                    });
                  } else {
                    handleNodeClick(n.id, n.label);
                  }
                }}
                style={{ cursor: "pointer" }}
                opacity={active ? 1 : 0.3}
              >
                {isSelected && !isCluster && (
                  <circle r={12} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.5} strokeDasharray="2 2" />
                )}
                <circle
                  r={isCluster ? (isHovered ? 16 : 13) : isHovered || isSelected ? 8 : 6}
                  fill={color}
                  stroke="hsl(var(--background))"
                  strokeWidth={isCluster ? 2 : 1.5}
                  opacity={isCluster ? 0.6 : 0.85}
                />
                <text
                  x={0}
                  y={isCluster ? 3 : -10}
                  textAnchor="middle"
                  className="font-mono"
                  fontSize={isCluster ? 8 : 7}
                  fontWeight={isCluster ? "bold" : "normal"}
                  fill={isCluster ? "hsl(var(--background))" : "hsl(var(--foreground))"}
                  opacity={isHovered ? 1 : 0.6}
                  style={{ pointerEvents: "none" }}
                >
                  {n.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Legend */}
      {themeColors.size > 0 && (
        <div className="flex flex-wrap gap-2 pt-1 border-t border-border/40">
          {Array.from(themeColors.entries()).map(([theme, color]) => (
            <div key={theme} className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
              <span className="text-[8px] text-muted-foreground">{theme}</span>
            </div>
          ))}
        </div>
      )}

      {/* Hover tooltip */}
      {hoveredNode && (
        <div className="text-[9px] text-muted-foreground bg-muted/40 rounded px-2 py-1">
          <strong className="text-foreground">
            {nodes.find((n) => n.id === hoveredNode)?.label}
          </strong>
          {" → "}
          {[...highlightedNodes].filter((id) => id !== hoveredNode).map((id) =>
            nodes.find((n) => n.id === id)?.label
          ).join(", ") || "no connections"}
        </div>
      )}

      {/* Selected node info */}
      {selectedNode && (
        <div className="text-[9px] text-primary bg-primary/[0.04] rounded px-2 py-1">
          {t_selected(nodes.find(n => n.id === selectedNode)?.label || "")}
        </div>
      )}
    </div>
  );
}

// Helper for selected node display
function t_selected(label: string) {
  return `Selected: ${label} — click again to view source details`;
}
