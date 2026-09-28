"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Database as DatabaseIcon,
  Trash2,
  ExternalLink,
  Pin,
  PinOff,
  Loader2,
  Plus,
  Microscope,
  ChevronUp,
  ChevronDown,
  FileStack,
  Languages,
  Box,
  Layers,
  FileText,
  Dna,
  FlaskConical,
  Puzzle,
  Globe,
  PenLine,
  Package,
  BookCheck,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AddReferenceDialog } from "./add-reference-dialog";
import { ProteinStructureAnalysisDialog } from "./protein-structure-analysis-dialog";
import { StructureDashboardDialog } from "./structure-dashboard-dialog";
import { useI18n } from "@/lib/i18n";
import { api } from "@/lib/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DataSource, Reference } from "@/lib/types";

const TYPE_BADGE: Record<string, string> = {
  pubmed: "badge-emerald",
  crossref: "badge-emerald",
  uniprot: "badge-teal",
  rcsb: "badge-amber",
  ncbi: "badge-rose",
  blast: "badge-violet",
  web: "badge-sky",
  manual: "badge-slate",
};

// Display order for source types (most common first)
const SOURCE_TYPE_ORDER = ["pubmed", "crossref", "rcsb", "uniprot", "ncbi", "blast", "web", "manual"];

// lucide icon per source type (no emoji icons in the UI — design rule).
const SOURCE_TYPE_ICONS: Record<string, LucideIcon> = {
  pubmed: FileText,
  crossref: BookCheck,
  rcsb: Dna,
  uniprot: FlaskConical,
  ncbi: Puzzle,
  blast: Microscope,
  web: Globe,
  manual: PenLine,
};
const SOURCE_TYPE_FALLBACK_ICON = Package;

export function KnowledgePanel({
  projectId,
  dataSources,
  references,
}: {
  projectId: string | null;
  dataSources: DataSource[];
  references: Reference[];
}) {
  const { t } = useI18n();
  const [addRefOpen, setAddRefOpen] = React.useState(false);
  return (
    <>
      <div className="flex flex-col h-full overflow-hidden">
        {/* ============================================================
            Row 1 — header (.glass-subtle .panel-section-header)
            Mirrors DatabaseQueryPanel's row 1 rhythm exactly: brand-tile
            + eyebrow on the left, primary CTA on the right. Sits at the
            same vertical position so the right column reads as siblings.
            ============================================================ */}
        <div className="atlas-data-header shrink-0">
          <div className="atlas-data-section-title">
            <span className="atlas-data-section-title-icon">
              <DatabaseIcon className="h-3 w-3" />
            </span>
            {t("knowledge.sources")}
            <span className="atlas-rail-count">{dataSources.length}</span>
          </div>
          <Button
            size="sm"
            className="btn-gradient-primary h-7 px-3 gap-1 text-xs font-medium text-primary-foreground shrink-0 focus-ring"
            onClick={() => setAddRefOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("knowledge.addReference")}
          </Button>
        </div>

        {/* ============================================================
            Sources section — takes the majority of the panel.
            SourcesList owns its own tab-bar sub-header (Row 2 rhythm,
            same .panel-section-header padding as DQP Row 2) + the card
            scroll area.
            ============================================================ */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <SourcesList projectId={projectId} items={dataSources} />
        </div>

        {/* ============================================================
            References section — capped at 280px so SourcesList keeps
            the lion's share of the panel. Same .panel-section-header
            rhythm as the sources sub-header so the two sections read
            as siblings within the same right-column panel.
            ============================================================ */}
        <div className="shrink-0 max-h-[280px] min-h-[120px] flex flex-col overflow-hidden border-t hairline">
          <ReferencesList projectId={projectId} items={references} />
        </div>
      </div>
      <AddReferenceDialog
        open={addRefOpen}
        onOpenChange={setAddRefOpen}
        projectId={projectId}
      />
    </>
  );
}

function SourcesList({
  projectId,
  items,
}: {
  projectId: string | null;
  items: DataSource[];
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [activeType, setActiveType] = React.useState<string>("all");
  // Molcraft fusion: structure-analysis dialog state.
  const [structureDialog, setStructureDialog] = React.useState<{
    open: boolean;
    pdbId?: string;
    dataSourceId?: string;
  }>({ open: false });
  // Molcraft fusion: structure dashboard dialog state.
  const [dashboardOpen, setDashboardOpen] = React.useState(false);

  const togglePin = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api.updateDataSource(id, { pinned }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteDataSource(id),
    onSuccess: () => {
      toast.success(t("toast.sourceRemoved"));
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const deepReadMut = useMutation({
    mutationFn: (id: string) => api.deepReadDataSource(id),
    onSuccess: (data) => {
      toast.success(t("toast.deepReadComplete", { n: data.contentLength }));
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  // Molcraft fusion: analyze the 3D structure of an RCSB data source.
  const analyzeStructureMut = useMutation({
    mutationFn: (id: string) => api.analyzeDataSourceStructure(id),
    onSuccess: (data) => {
      toast.success(
        t("toast.structureAnalyzed", {
          pdbId: data.pdbId,
          n: data.chainCount,
          r: data.residueCount,
          l: data.ligandCount,
        })
      );
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) =>
      toast.error(t("toast.structureAnalyzeFailed", { error: e.message })),
  });
  // Molcraft fusion: batch-analyze all unanalyzed RCSB structures.
  const [batchProgress, setBatchProgress] = React.useState<{
    active: boolean;
    done: number;
    total: number;
  }>({ active: false, done: 0, total: 0 });
  const batchAnalyzeMut = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error("No project selected.");
      // Count RCSB sources to estimate progress.
      const rcsbCount = items.filter((d) => d.source === "rcsb" && d.externalId).length;
      setBatchProgress({ active: true, done: 0, total: rcsbCount });
      const res = await api.batchAnalyzeStructures(projectId);
      setBatchProgress({ active: false, done: rcsbCount, total: rcsbCount });
      return res;
    },
    onSuccess: (data) => {
      if (data.total === 0) {
        toast.info(t("structure.batchNoRcsb"));
      } else {
        toast.success(
          t("structure.batchComplete", {
            analyzed: data.analyzed,
            skipped: data.skipped,
            failed: data.failed,
          })
        );
      }
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => {
      setBatchProgress({ active: false, done: 0, total: 0 });
      toast.error(t("toast.batchAnalyzeFailed", { error: e.message }));
    },
  });
  const [expandedSource, setExpandedSource] = React.useState<string | null>(null);

  // Group items by source type, sorted by SOURCE_TYPE_ORDER then alphabetical
  const sourceTypes = [...new Set(items.map((d) => d.source))].sort((a, b) => {
    const ai = SOURCE_TYPE_ORDER.indexOf(a);
    const bi = SOURCE_TYPE_ORDER.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });

  // If the active type is no longer present (e.g. after deletion), reset to "all"
  React.useEffect(() => {
    if (activeType !== "all" && !sourceTypes.includes(activeType)) {
      setActiveType("all");
    }
  }, [activeType, sourceTypes]);

  const filteredItems =
    activeType === "all" ? items : items.filter((d) => d.source === activeType);

  if (items.length === 0) {
    return (
      <ScrollArea className="flex-1 min-h-0 scroll-academic">
        <div className="p-4">
          <EmptyState
            icon={<DatabaseIcon className="h-5 w-5" />}
            title={t("knowledge.noSources")}
            hint={t("knowledge.noSourcesHint")}
          />
        </div>
      </ScrollArea>
    );
  }

  return (
    <>
      {/* ============================================================
          Row 2 — type tab bar (.panel-section-header)
          Sits at exactly the same vertical position as the
          ProjectsSidebar search Input and DatabaseQueryPanel search
          row (QA #2 fix). Two stacked rows: (a) filter tabs +
          Structure Dashboard outline action, (b) result-count eyebrow +
          Batch Analyze outline action.
          ============================================================ */}
      <div className="panel-section-header border-b hairline shrink-0 space-y-2">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-thin">
          {/* "All" tab */}
          <button
            onClick={() => setActiveType("all")}
            className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap transition-all focus-ring ${
              activeType === "all" ? "tab-pill" : "tab-pill-inactive"
            }`}
          >
            <FileStack className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span>All</span>
            <span
              className={`inline-flex items-center justify-center h-3 min-w-3 px-1 rounded-full text-[9px] ${
                activeType === "all"
                  ? "bg-primary/20 text-primary"
                  : "bg-muted-foreground/15"
              }`}
            >
              {items.length}
            </span>
          </button>

          {/* Per-type tabs — each carries its sanctioned .badge-* hue */}
          {sourceTypes.map((st) => {
            const count = items.filter((d) => d.source === st).length;
            const isActive = activeType === st;
            return (
              <button
                key={st}
                onClick={() => setActiveType(st)}
                className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap transition-all focus-ring ${
                  isActive
                    ? `tab-pill ${TYPE_BADGE[st] || "badge-slate"}`
                    : "tab-pill-inactive"
                }`}
              >
                <span className="inline-flex items-center">
                  {React.createElement(
                    SOURCE_TYPE_ICONS[st] ?? SOURCE_TYPE_FALLBACK_ICON,
                    {
                      className: "h-3 w-3",
                      "aria-hidden": true,
                    }
                  )}
                </span>
                <span>{st}</span>
                <span
                  className={`inline-flex items-center justify-center h-3 min-w-3 px-1 rounded-full text-[9px] ${
                    isActive ? "bg-foreground/15" : "bg-muted-foreground/15"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}

          {/* Structure Dashboard — secondary outline action (QA #4 fix:
              was raw bg-amber-50/text-amber-700; now on-brand outline
              with border-primary/40 + text-primary). The amber source-type
              identity still appears on the rcsb tab + PDB:{id} chip. */}
          {projectId && items.some((d) => d.source === "rcsb") && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 h-6 ml-auto px-2 text-[10px] gap-1 border-primary/40 text-primary hover:bg-primary/5 focus-ring"
              onClick={() => setDashboardOpen(true)}
              title={t("structure.dashboardTitleFull")}
            >
              <Layers className="h-3 w-3" />
              <span className="uppercase tracking-wide font-semibold">
                {t("structure.dashboard")}
              </span>
            </Button>
          )}
        </div>

        {/* Active-filter count + Batch Analyze secondary action */}
        <div className="flex items-center justify-between gap-2">
          <span className="eyebrow shrink-0">
            {activeType === "all"
              ? `${filteredItems.length} sources`
              : `${filteredItems.length} ${activeType}`}
          </span>
          <div className="flex items-center gap-2 ml-auto">
            {/* Batch Analyze — secondary outline action (QA #4 fix:
                was raw border-amber-300/text-amber-700; now on-brand
                outline). The amber hue still shows on the rcsb tab +
                analyzed-structure chip below. */}
            {items.some((d) => d.source === "rcsb" && d.externalId) && projectId && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px] gap-1 border-primary/40 text-primary hover:bg-primary/5 focus-ring"
                onClick={() => batchAnalyzeMut.mutate()}
                disabled={batchAnalyzeMut.isPending || batchProgress.active}
                title={t("structure.batchAnalyzeTitle")}
              >
                {batchAnalyzeMut.isPending || batchProgress.active ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t("structure.batchAnalyzing", {
                      done: batchProgress.done,
                      total: batchProgress.total,
                    })}
                  </>
                ) : (
                  <>
                    <Layers className="h-3 w-3" />
                    {t("structure.batchAnalyze")}
                  </>
                )}
              </Button>
            )}
            {activeType !== "all" && (
              <button
                onClick={() => setActiveType("all")}
                className="text-[10px] text-primary hover:underline focus-ring rounded"
              >
                show all
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ============================================================
          Source cards.
          round-36: the Radix display:table wrapper is killed globally
          in globals.css ([data-radix-scroll-area-viewport] > div), so
          long unbreakable tokens can never push cards off-screen.
          ============================================================ */}
      <ScrollArea className="flex-1 min-h-0 scroll-academic">
        <div className="p-3 space-y-2">
          {filteredItems.length === 0 ? (
            <div className="text-center py-6 text-[10px] text-muted-foreground">
              No {activeType} sources.
            </div>
          ) : (
            filteredItems.map((d) => (
              <SourceCard
                key={d.id}
                d={d}
                t={t}
                expandedSource={expandedSource}
                setExpandedSource={setExpandedSource}
                onPin={(id, pinned) => togglePin.mutate({ id, pinned })}
                onDelete={(id) => del.mutate(id)}
                onDeepRead={(id) => deepReadMut.mutate(id)}
                deepReadPending={
                  deepReadMut.isPending && deepReadMut.variables === d.id
                }
                onAnalyzeStructure={(id, pdbId) =>
                  setStructureDialog({ open: true, pdbId, dataSourceId: id })
                }
                analyzeStructurePending={
                  analyzeStructureMut.isPending &&
                  analyzeStructureMut.variables === d.id
                }
              />
            ))
          )}
        </div>
      </ScrollArea>

      {/* Molcraft fusion: protein structure analysis dialog */}
      <ProteinStructureAnalysisDialog
        open={structureDialog.open}
        onOpenChange={(v) => setStructureDialog({ open: v })}
        initialPdbId={structureDialog.pdbId}
        dataSourceId={structureDialog.dataSourceId}
      />
      {/* Molcraft fusion: structure dashboard dialog */}
      {projectId && (
        <StructureDashboardDialog
          open={dashboardOpen}
          onOpenChange={setDashboardOpen}
          projectId={projectId}
        />
      )}
    </>
  );
}

function SourceCard({
  d,
  t,
  expandedSource,
  setExpandedSource,
  onPin,
  onDelete,
  onDeepRead,
  deepReadPending,
  onAnalyzeStructure,
  analyzeStructurePending,
}: {
  d: DataSource;
  t: (key: any, opts?: any) => string;
  expandedSource: string | null;
  setExpandedSource: (id: string | null) => void;
  onPin: (id: string, pinned: boolean) => void;
  onDelete: (id: string) => void;
  onDeepRead: (id: string) => void;
  deepReadPending: boolean;
  onAnalyzeStructure: (id: string, pdbId: string) => void;
  analyzeStructurePending: boolean;
}) {
  // Molcraft fusion: detect whether this RCSB source has been analyzed.
  let extraObj: any = null;
  try {
    extraObj = d.extra ? JSON.parse(d.extra) : null;
  } catch {
    extraObj = null;
  }
  const isRcsb = d.source === "rcsb" && d.externalId;
  const analyzed = isRcsb && extraObj?.analyzed === true;

  const SourceIcon = SOURCE_TYPE_ICONS[d.source] ?? SOURCE_TYPE_FALLBACK_ICON;
  const badgeClass = TYPE_BADGE[d.source] || "badge-slate";

  return (
    <div className="surface-card rounded-lg p-3 space-y-2 transition-all hover:border-primary/30 hover:shadow-md acad-fade-in">
      {/* Row 1: source-type icon chip + externalId + action buttons.
          round-36: externalId can be a full URL for web sources (545/615
          rows measured) — truncate + min-w-0 so the ID slot never pushes
          the action buttons (or the card border) past the panel width. */}
      <div className="flex items-start gap-2">
        {/* Source-type icon chip — sanctioned .badge-* semantic hue.
            Reads the source type at a glance; the same hue appears on
            the tab pill and the source-type dots elsewhere in the UI. */}
        <span
          className={`inline-flex items-center justify-center h-5 w-5 rounded-md ${badgeClass} shrink-0 mt-1`}
        >
          <SourceIcon className="h-3 w-3" aria-hidden="true" />
        </span>

        <div className="flex-1 min-w-0 space-y-1">
          {/* External ID (mono) */}
          {d.externalId && (
            <span className="block text-[10px] font-mono text-muted-foreground truncate min-w-0">
              {d.externalId}
            </span>
          )}

          {/* Title */}
          <p className="text-xs font-medium leading-snug line-clamp-2 break-words">
            {d.title || d.query}
          </p>
        </div>

        {/* Action buttons — pin toggle uses bg-primary/10 + text-primary
            when active (per the design system's sanctioned active state).
            All other actions are ghost + text-primary / text-destructive. */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Molcraft fusion: Analyze 3D structure button (RCSB only) */}
          {isRcsb && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-primary hover:bg-primary/10 focus-ring"
              onClick={() => onAnalyzeStructure(d.id, d.externalId!)}
              disabled={analyzeStructurePending}
              title={t("knowledge.analyzeStructureTitle")}
            >
              {analyzeStructurePending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Box className="h-3 w-3" />
              )}
            </Button>
          )}
          {d.url && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-primary hover:bg-primary/10 focus-ring"
              onClick={() => onDeepRead(d.id)}
              disabled={deepReadPending}
              title={t("knowledge.deepReadTitle")}
            >
              {deepReadPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Microscope className="h-3 w-3" />
              )}
            </Button>
          )}
          {/* Pin toggle: bg-primary/10 text-primary when active */}
          <Button
            variant="ghost"
            size="icon"
            className={`h-6 w-6 transition-colors focus-ring ${
              d.pinned
                ? "bg-primary/10 text-primary hover:bg-primary/15"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            onClick={() => onPin(d.id, !d.pinned)}
            title={d.pinned ? t("knowledge.unpin") : t("knowledge.pin")}
          >
            {d.pinned ? (
              <PinOff className="h-3 w-3" />
            ) : (
              <Pin className="h-3 w-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-destructive hover:bg-destructive/10 focus-ring"
            onClick={() => onDelete(d.id)}
            title={t("knowledge.sources")}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Show PDB structure association for RCSB sources.
          The amber accent is sanctioned by the design system
          (rcsb → badge-amber) — used here for the PDB:{id} chip and the
          "linked publication" indicator (emerald = verified). */}
      {d.source === "rcsb" && d.externalId && (() => {
        let extra: any = null;
        try {
          extra = d.extra ? JSON.parse(d.extra) : null;
        } catch {
          extra = null;
        }
        return extra ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="badge-amber inline-flex items-center justify-center h-4 px-1 rounded text-[9px] font-semibold uppercase tracking-wider">
              PDB:{d.externalId}
            </span>
            {extra.resolution && (
              <span className="text-[9px] text-muted-foreground">
                {extra.resolution}Å
              </span>
            )}
            {extra.method && (
              <span className="text-[9px] text-muted-foreground">
                {extra.method}
              </span>
            )}
            {extra.hasPublication && (
              <span className="badge-emerald inline-flex items-center justify-center h-4 px-1 rounded text-[9px] font-semibold uppercase tracking-wider">
                {t("knowledge.linkedPublication")}
              </span>
            )}
          </div>
        ) : null;
      })()}

      {/* Molcraft fusion: show computed structural metrics when analyzed.
          Theme-neutral muted background + sanctioned badge-amber chip for
          the "structure analyzed" label — amber stays the rcsb/structure
          identity hue, the rest is theme tokens. */}
      {analyzed && extraObj && (
        <div className="rounded-md bg-muted/40 border hairline px-2 py-1 space-y-1">
          <span className="badge-amber inline-flex items-center gap-1 justify-center h-4 px-1 rounded text-[9px] font-semibold uppercase tracking-wider">
            <Box className="h-2.5 w-2.5" aria-hidden="true" />
            {t("knowledge.structureAnalyzed")}
          </span>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] text-muted-foreground">
            {extraObj.chainCount != null && (
              <span>
                <span className="font-semibold text-foreground">
                  {extraObj.chainCount}
                </span>{" "}
                ch
              </span>
            )}
            {extraObj.residueCount != null && (
              <span>
                <span className="font-semibold text-foreground">
                  {extraObj.residueCount}
                </span>{" "}
                res
              </span>
            )}
            {extraObj.ligandCount != null && extraObj.ligandCount > 0 && (
              <span>
                <span className="font-semibold text-foreground">
                  {extraObj.ligandCount}
                </span>{" "}
                lig
              </span>
            )}
            {extraObj.ramachandranFavouredPct != null && (
              <span>
                <span className="font-semibold text-foreground">
                  {extraObj.ramachandranFavouredPct}%
                </span>{" "}
                Ramach.
              </span>
            )}
            {extraObj.bfactorMean != null && (
              <span>
                B̄=
                <span className="font-semibold text-foreground">
                  {Math.round(extraObj.bfactorMean)}
                </span>
              </span>
            )}
            {extraObj.pI != null && (
              <span>
                pI=
                <span className="font-semibold text-foreground">
                  {extraObj.pI.toFixed(1)}
                </span>
              </span>
            )}
            {extraObj.netCharge != null && (
              <span>
                q=
                <span className="font-semibold text-foreground">
                  {extraObj.netCharge > 0 ? "+" : ""}
                  {extraObj.netCharge.toFixed(0)}
                </span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Authors / year / journal */}
      {(d.authors || d.journal || d.year) && (
        <p className="text-[10px] text-muted-foreground break-words">
          {d.authors && <span>{d.authors}</span>}
          {d.authors && d.year && <span>, </span>}
          {d.year && <span>{d.year}</span>}
          {d.journal && (
            <span>
              {" · "}
              <em>{d.journal}</em>
            </span>
          )}
        </p>
      )}

      {/* round-33/35: provenance badges from the LLM-knowledge cross-check.
          Registry-verified gap fills are citable (emerald — PubMed or
          Crossref channel; promoted rows were previously amber unverified
          suggestions); unconfirmed suggestions stay amber and never
          enter the reference pool. All badges use the sanctioned .badge-*
          classes so they pick up theme-aware colors automatically. */}
      {extraObj?.llmSuggested && !extraObj?.unverified && (
        <span className="badge-emerald inline-flex items-center gap-1 justify-center h-4 px-1 rounded text-[9px] font-semibold uppercase tracking-wider">
          <BookCheck className="h-2.5 w-2.5" aria-hidden="true" />
          {extraObj?.promotedFrom === "unverified"
            ? t("knowledge.badgePromoted")
            : d.source === "crossref"
              ? t("knowledge.badgeCrossrefVerified")
              : t("knowledge.badgePubmedVerified")}
        </span>
      )}
      {extraObj?.dbFilled &&
        Array.isArray(extraObj.dbFilled) &&
        extraObj.dbFilled.length > 0 &&
        !extraObj?.llmSuggested && (
          <span className="badge-slate inline-flex items-center gap-1 justify-center h-4 px-1 rounded text-[9px] font-semibold uppercase tracking-wider">
            <DatabaseIcon className="h-2.5 w-2.5" aria-hidden="true" />
            {t("knowledge.badgeDbBackfilled", {
              fields: extraObj.dbFilled.join("/"),
            })}
          </span>
        )}
      {extraObj?.unverified && (
        <div className="rounded-md bg-muted/40 border hairline px-2 py-1 space-y-1">
          <span className="badge-amber inline-flex items-center gap-1 justify-center h-4 px-1 rounded text-[9px] font-semibold uppercase tracking-wider">
            <BookCheck className="h-2.5 w-2.5" aria-hidden="true" />{" "}
            {t("knowledge.badgeUnverified")}
          </span>
          {extraObj.llmReason && (
            <p className="text-[9px] text-muted-foreground leading-snug break-words">
              {String(extraObj.llmReason).slice(0, 140)}
            </p>
          )}
        </div>
      )}

      {/* Query */}
      <p className="text-[10px] text-muted-foreground font-mono truncate">
        {t("knowledge.queryLabel")} {d.query}
      </p>

      {/* URL */}
      {d.url && (
        <a
          href={d.url}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-primary hover:underline inline-flex items-center gap-1 min-w-0 focus-ring rounded"
        >
          <ExternalLink className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
          <span className="truncate min-w-0">
            {d.url.replace(/^https?:\/\//, "").slice(0, 40)}
          </span>
        </a>
      )}

      {/* Deep-read summary */}
      {d.summary && (
        <div className="space-y-1">
          <button
            onClick={() =>
              setExpandedSource(expandedSource === d.id ? null : d.id)
            }
            className="text-[10px] uppercase tracking-wider text-primary font-semibold flex items-center gap-1 hover:text-primary/80 focus-ring rounded"
          >
            <Microscope className="h-2.5 w-2.5" aria-hidden="true" />
            {t("knowledge.deepRead")}
            {expandedSource === d.id ? (
              <ChevronUp className="h-2.5 w-2.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-2.5 w-2.5" aria-hidden="true" />
            )}
          </button>
          {/* break-words so long unbreakable tokens inside the deep-read
              text (URLs, sequence strings) wrap instead of widening the
              card past the panel edge (round-34). */}
          {expandedSource === d.id && (
            <div className="rounded-md bg-primary/5 border border-primary/20 p-2 text-[10px] leading-relaxed whitespace-pre-wrap break-words">
              {d.summary}
            </div>
          )}
        </div>
      )}

      {/* Pinned indicator — primary-tinted label */}
      {d.pinned && (
        <span className="inline-flex items-center gap-1 text-[9px] text-primary font-medium">
          <Pin className="h-2 w-2" aria-hidden="true" /> {t("knowledge.pinned")}
        </span>
      )}
    </div>
  );
}

/* ============================================================
   ReferencesList — the citation library sub-section.
   Mirrors the SourcesList rhythm (sub-header + card scroll area)
   so both halves of the panel read as siblings.
   ============================================================ */
function ReferencesList({
  projectId,
  items,
}: {
  projectId: string | null;
  items: Reference[];
}) {
  const { t } = useI18n();
  void projectId; // projectId reserved for future per-reference actions.

  // Sort: by citationOrder when present (matches document order),
  // otherwise fall back to createdAt.
  const sorted = React.useMemo(() => {
    return [...items].sort((a, b) => {
      const ao = a.citationOrder ?? Number.MAX_SAFE_INTEGER;
      const bo = b.citationOrder ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      const ac = String(a.createdAt ?? "");
      const bc = String(b.createdAt ?? "");
      return ac.localeCompare(bc);
    });
  }, [items]);

  if (items.length === 0) {
    return (
      <>
        {/* Sub-header — .panel-section-header, mirrors DQP Row 2 rhythm */}
        <div className="panel-section-header border-b hairline shrink-0 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex items-center justify-center h-6 w-6 rounded-md bg-primary/10 text-primary shrink-0">
              <Languages className="h-3 w-3" />
            </div>
            <span className="eyebrow truncate">{t("knowledge.refs")}</span>
          </div>
          <div className="stat-tile inline-flex items-center gap-1 px-2 py-1 shrink-0">
            <span className="font-mono text-[11px] tabular-nums font-semibold text-primary">
              {items.length}
            </span>
          </div>
        </div>
        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="p-4">
            <EmptyState
              icon={<Languages className="h-5 w-5" />}
              title={t("knowledge.noRefs")}
              hint={t("knowledge.noRefsHint")}
            />
          </div>
        </ScrollArea>
      </>
    );
  }

  return (
    <>
      {/* Sub-header — .panel-section-header, same rhythm as the sources
          sub-header so both halves of the panel align. */}
      <div className="panel-section-header border-b hairline shrink-0 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center justify-center h-6 w-6 rounded-md bg-primary/10 text-primary shrink-0">
            <Languages className="h-3 w-3" />
          </div>
          <span className="eyebrow truncate">{t("knowledge.refs")}</span>
        </div>
        <div className="stat-tile inline-flex items-center gap-1 px-2 py-1 shrink-0">
          <span className="font-mono text-[11px] tabular-nums font-semibold text-primary">
            {items.length}
          </span>
        </div>
      </div>

      {/* Reference cards — same .surface-card p-3 space-y-2 rhythm as
          SourceCard so the two sections read at the same density. */}
      <ScrollArea className="flex-1 min-h-0 scroll-academic">
        <div className="p-3 space-y-2">
          {sorted.map((r) => (
            <ReferenceCard key={r.id} r={r} t={t} />
          ))}
        </div>
      </ScrollArea>
    </>
  );
}

function ReferenceCard({
  r,
  t,
}: {
  r: Reference;
  t: (key: any, opts?: any) => string;
}) {
  void t; // reserved for future per-reference actions (e.g. copy citation).
  const Icon = SOURCE_TYPE_ICONS[r.type] ?? SOURCE_TYPE_FALLBACK_ICON;
  const badge = TYPE_BADGE[r.type] || "badge-slate";
  const href = r.url || (r.doi ? `https://doi.org/${r.doi}` : null);

  return (
    <div className="surface-card rounded-lg p-3 space-y-2 transition-all hover:border-primary/30 hover:shadow-md acad-fade-in">
      {/* Row 1: type chip + citation key + order */}
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center justify-center h-5 w-5 rounded-md ${badge} shrink-0`}
        >
          <Icon className="h-3 w-3" aria-hidden="true" />
        </span>
        {r.citationKey ? (
          <span className="text-[10px] font-mono text-muted-foreground truncate min-w-0 flex-1">
            [{r.citationKey}]
          </span>
        ) : (
          <span className="text-[10px] font-mono text-muted-foreground truncate min-w-0 flex-1">
            {r.externalId || r.type}
          </span>
        )}
        {r.citationOrder != null && (
          <span className="badge-slate inline-flex items-center justify-center h-5 min-w-5 px-1 rounded text-[10px] font-mono shrink-0">
            {r.citationOrder}
          </span>
        )}
      </div>

      {/* Title */}
      <p className="text-xs font-medium leading-snug line-clamp-2 break-words">
        {r.title}
      </p>

      {/* Authors / year / journal */}
      {(r.authors || r.journal || r.year) && (
        <p className="text-[10px] text-muted-foreground break-words">
          {r.authors && <span>{r.authors}</span>}
          {r.authors && r.year && <span>, </span>}
          {r.year && <span>{r.year}</span>}
          {r.journal && (
            <span>
              {" · "}
              <em>{r.journal}</em>
            </span>
          )}
        </p>
      )}

      {/* DOI / URL — primary-tinted external link */}
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-primary hover:underline inline-flex items-center gap-1 min-w-0 focus-ring rounded"
        >
          <ExternalLink className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
          <span className="truncate min-w-0">
            {r.doi
              ? `doi:${r.doi}`
              : href.replace(/^https?:\/\//, "").slice(0, 40)}
          </span>
        </a>
      )}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="acad-fade-in flex flex-col items-center text-center py-8 text-muted-foreground px-4">
      <div className="ring-academic h-11 w-11 rounded-xl flex items-center justify-center mb-3 bg-card text-primary/70">
        {icon}
      </div>
      <p className="text-xs font-medium tracking-tight">{title}</p>
      <p className="text-[10px] mt-1 leading-relaxed">{hint}</p>
    </div>
  );
}
