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
  ArrowRight,
  Box,
  Layers,
  FileText,
  Dna,
  FlaskConical,
  Puzzle,
  Globe,
  PenLine,
  Package,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  uniprot: "badge-teal",
  rcsb: "badge-amber",
  ncbi: "badge-rose",
  blast: "badge-violet",
  web: "badge-sky",
  manual: "badge-slate",
};

// Display order for source types (most common first)
const SOURCE_TYPE_ORDER = ["pubmed", "rcsb", "uniprot", "ncbi", "blast", "web", "manual"];

// lucide icon per source type (no emoji icons in the UI — design rule).
const SOURCE_TYPE_ICONS: Record<string, LucideIcon> = {
  pubmed: FileText,
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
      {/* Header — refined floating strip with glass-subtle + icon tile */}
      <div className="glass-subtle flex items-center justify-between px-3 py-2 mt-2 mb-1 shrink-0 rounded-lg border border-border/40">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center h-6 w-6 rounded-md bg-primary/10 text-primary shrink-0">
            <DatabaseIcon className="h-3.5 w-3.5" />
          </div>
          <h3 className="text-[13px] font-semibold tracking-tight font-serif-text text-foreground">
            {t("knowledge.sources")}
          </h3>
          {dataSources.length > 0 && (
            <Badge variant="outline" className="text-[9px] h-4 px-1.5 gap-0.5 font-mono">
              {dataSources.length}
            </Badge>
          )}
          {references.length > 0 && (
            <Badge variant="outline" className="text-[9px] h-4 px-1.5 gap-0.5 text-emerald-700 border-emerald-300/40 bg-emerald-500/5">
              {references.length} refs
            </Badge>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-[10px] gap-1 px-2 border-dashed hover:border-solid transition-all"
          onClick={() => setAddRefOpen(true)}
        >
          <Plus className="h-3 w-3" />
          {t("knowledge.addReference")}
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <SourcesList projectId={projectId} items={dataSources} />
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
      <ScrollArea className="h-full scroll-academic">
        <div className="px-3 py-2">
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
    <div className="flex flex-col h-full overflow-hidden">
      {/* Horizontal type tab bar — shows ALL types + counts at a glance */}
      <div className="px-2 pt-1.5 pb-2 border-b border-border/40 shrink-0 bg-muted/15">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-thin pb-1">
          {/* "All" tab */}
          <button
            onClick={() => setActiveType("all")}
            className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wide transition-all whitespace-nowrap ${
              activeType === "all"
                ? "tab-pill"
                : "tab-pill-inactive"
            }`}
          >
            <FileStack className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span>All</span>
            <span className={`text-[9px] px-1 rounded-full ${
              activeType === "all" ? "bg-primary/20 text-primary" : "bg-muted-foreground/15"
            }`}>
              {items.length}
            </span>
          </button>
          {/* Molcraft fusion: structure dashboard button */}
          {projectId && items.some((d) => d.source === "rcsb") && (
            <button
              onClick={() => setDashboardOpen(true)}
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wide transition-all whitespace-nowrap bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-300 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800 dark:hover:bg-amber-950/50"
              title={t("structure.dashboardTitleFull")}
            >
              <Layers className="h-3 w-3" />
              <span>{t("structure.dashboard")}</span>
            </button>
          )}
          {/* Per-type tabs */}
          {sourceTypes.map((st) => {
            const count = items.filter((d) => d.source === st).length;
            const isActive = activeType === st;
            return (
              <button
                key={st}
                onClick={() => setActiveType(st)}
                className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wide transition-all whitespace-nowrap ${
                  isActive
                    ? `tab-pill ${TYPE_BADGE[st] || "badge-slate"}`
                    : "tab-pill-inactive"
                }`}
              >
                <span className="inline-flex items-center">
                  {React.createElement(SOURCE_TYPE_ICONS[st] ?? SOURCE_TYPE_FALLBACK_ICON, {
                    className: "h-3 w-3",
                    "aria-hidden": true,
                  })}
                </span>
                <span>{st}</span>
                <span className={`text-[9px] px-1 rounded-full ${
                  isActive ? "bg-foreground/15" : "bg-muted-foreground/15"
                }`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        {/* Active filter indicator + batch analyze button */}
        <div className="flex items-center justify-between mt-1 px-0.5 gap-1">
          <span className="text-[9px] text-muted-foreground shrink-0">
            {activeType === "all"
              ? `${filteredItems.length} sources`
              : `${filteredItems.length} ${activeType} sources`}
          </span>
          <div className="flex items-center gap-1 ml-auto">
            {/* Molcraft fusion: batch-analyze all RCSB structures */}
            {items.some((d) => d.source === "rcsb" && d.externalId) && projectId && (
              <Button
                variant="outline"
                size="sm"
                className="h-5 text-[9px] gap-1 px-1.5 border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-950/30"
                onClick={() => batchAnalyzeMut.mutate()}
                disabled={batchAnalyzeMut.isPending || batchProgress.active}
                title={t("structure.batchAnalyzeTitle")}
              >
                {batchAnalyzeMut.isPending || batchProgress.active ? (
                  <>
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    {t("structure.batchAnalyzing", {
                      done: batchProgress.done,
                      total: batchProgress.total,
                    })}
                  </>
                ) : (
                  <>
                    <Layers className="h-2.5 w-2.5" />
                    {t("structure.batchAnalyze")}
                  </>
                )}
              </Button>
            )}
            {activeType !== "all" && (
              <button
                onClick={() => setActiveType("all")}
                className="text-[9px] text-primary hover:underline"
              >
                show all
              </button>
            )}
          </div>
        </div>
      </div>
      {/* Source cards for the active type */}
      <ScrollArea className="flex-1 min-h-0 scroll-academic">
        <div className="px-3 py-2 space-y-2">
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
                deepReadPending={deepReadMut.isPending && deepReadMut.variables === d.id}
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
    </div>
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
  return (
    <div className="surface-card rounded-lg p-2.5 space-y-1 transition-all hover:border-primary/30 hover:shadow-md">
      <div className="flex items-start gap-1.5">
        {d.externalId && (
          <span className="text-[9px] font-mono text-muted-foreground">
            {d.externalId}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {/* Molcraft fusion: Analyze 3D structure button (RCSB sources only) */}
          {isRcsb && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/30"
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
              className="h-6 w-6 text-primary"
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
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
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
            className="h-6 w-6 text-destructive"
            onClick={() => onDelete(d.id)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <p className="text-[11px] font-medium leading-snug line-clamp-2">
        {d.title || d.query}
      </p>
      {/* Show PDB structure association for RCSB sources */}
      {d.source === "rcsb" && d.externalId && (() => {
        let extra: any = null;
        try { extra = d.extra ? JSON.parse(d.extra) : null; } catch {}
        return extra ? (
          <div className="flex flex-wrap gap-1 mt-0.5">
            <span className="badge-amber px-1 py-0.5 rounded text-[8px] font-semibold uppercase">
              PDB:{d.externalId}
            </span>
            {extra.resolution && (
              <span className="text-[8px] text-muted-foreground">
                {extra.resolution}Å
              </span>
            )}
            {extra.method && (
              <span className="text-[8px] text-muted-foreground">
                {extra.method}
              </span>
            )}
            {extra.hasPublication && (
              <span className="text-[8px] text-emerald-600 font-medium">
                {t("knowledge.linkedPublication")}
              </span>
            )}
          </div>
        ) : null;
      })()}
      {/* Molcraft fusion: show computed structural metrics when analyzed */}
      {analyzed && extraObj && (
        <div className="mt-1 rounded-md bg-amber-50/60 dark:bg-amber-950/25 border border-amber-200/50 dark:border-amber-900/40 px-1.5 py-1 space-y-0.5">
          <div className="flex items-center gap-1 text-[8px] font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wider">
            <Box className="h-2.5 w-2.5" />
            {t("knowledge.structureAnalyzed")}
          </div>
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[8px] text-muted-foreground">
            {extraObj.chainCount != null && (
              <span><span className="font-semibold text-foreground">{extraObj.chainCount}</span> ch</span>
            )}
            {extraObj.residueCount != null && (
              <span><span className="font-semibold text-foreground">{extraObj.residueCount}</span> res</span>
            )}
            {extraObj.ligandCount != null && extraObj.ligandCount > 0 && (
              <span><span className="font-semibold text-foreground">{extraObj.ligandCount}</span> lig</span>
            )}
            {extraObj.ramachandranFavouredPct != null && (
              <span><span className="font-semibold text-foreground">{extraObj.ramachandranFavouredPct}%</span> Ramach.</span>
            )}
            {extraObj.bfactorMean != null && (
              <span>B̄=<span className="font-semibold text-foreground">{Math.round(extraObj.bfactorMean)}</span></span>
            )}
            {extraObj.pI != null && (
              <span>pI=<span className="font-semibold text-foreground">{extraObj.pI.toFixed(1)}</span></span>
            )}
            {extraObj.netCharge != null && (
              <span>q=<span className="font-semibold text-foreground">{extraObj.netCharge > 0 ? "+" : ""}{extraObj.netCharge.toFixed(0)}</span></span>
            )}
          </div>
        </div>
      )}
      {(d.authors || d.journal || d.year) && (
        <p className="text-[9px] text-muted-foreground">
          {d.authors && <span>{d.authors}</span>}
          {d.authors && d.year && <span>, </span>}
          {d.year && <span>{d.year}</span>}
          {d.journal && <span> · <em>{d.journal}</em></span>}
        </p>
      )}
      <p className="text-[9px] text-muted-foreground font-mono truncate">
        {t("knowledge.queryLabel")} {d.query}
      </p>
      {d.url && (
        <a
          href={d.url}
          target="_blank"
          rel="noreferrer"
          className="text-[9px] text-primary hover:underline inline-flex items-center gap-0.5"
        >
          <ExternalLink className="h-2.5 w-2.5" /> {d.url.replace(/^https?:\/\//, "").slice(0, 40)}
        </a>
      )}
      {d.summary && (
        <div className="mt-1.5">
          <button
            onClick={() =>
              setExpandedSource(
                expandedSource === d.id ? null : d.id
              )
            }
            className="text-[9px] uppercase tracking-wider text-primary font-semibold flex items-center gap-1 hover:text-primary/80"
          >
            <Microscope className="h-2.5 w-2.5" />
            {t("knowledge.deepRead")}
            {expandedSource === d.id ? (
              <ChevronUp className="h-2.5 w-2.5" />
            ) : (
              <ChevronDown className="h-2.5 w-2.5" />
            )}
          </button>
          {expandedSource === d.id && (
            <div className="mt-1 rounded-md bg-primary/5 dark:bg-primary/10 border border-primary/20 dark:border-primary/20 p-2 text-[10px] leading-relaxed whitespace-pre-wrap font-sans">
              {d.summary}
            </div>
          )}
        </div>
      )}
      {d.pinned && (
        <span className="inline-flex items-center gap-0.5 text-[8px] text-amber-600 font-medium">
          <Pin className="h-2 w-2" /> {t("knowledge.pinned")}
        </span>
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
    <div className="acad-fade-in flex flex-col items-center text-center py-12 text-muted-foreground px-4">
      <div className="ring-academic h-11 w-11 rounded-xl flex items-center justify-center mb-3 bg-card text-primary/70">
        {icon}
      </div>
      <p className="text-xs font-serif-text font-medium tracking-tight">{title}</p>
      <p className="text-[10px] mt-1 leading-relaxed">{hint}</p>
    </div>
  );
}
