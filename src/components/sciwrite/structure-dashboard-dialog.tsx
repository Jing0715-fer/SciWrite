"use client";

import * as React from "react";
import {
  Box,
  Loader2,
  RefreshCw,
  Layers,
  Activity,
  ShieldCheck,
  Thermometer,
  Zap,
  Droplets,
  ExternalLink,
  GitCompare,
  Share2,
  GitBranch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n";
import { api } from "@/lib/api-client";
import { ProteinStructureAnalysisDialog } from "./protein-structure-analysis-dialog";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
}

interface DashboardEntry {
  pdbId: string;
  title: string;
  chainCount: number;
  residueCount: number;
  ligandCount: number;
  atomCount: number;
  contextMarkdown: string;
  updatedAt: string;
}

export function StructureDashboardDialog({ open, onOpenChange, projectId }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = React.useState(false);
  const [entries, setEntries] = React.useState<DashboardEntry[]>([]);
  const [detailDialog, setDetailDialog] = React.useState<{
    open: boolean;
    pdbId?: string;
  }>({ open: false });
  const [batchRunning, setBatchRunning] = React.useState(false);
  // Molcraft fusion: pairwise comparison matrix.
  const [matrixData, setMatrixData] = React.useState<any>(null);
  const [matrixLoading, setMatrixLoading] = React.useState(false);
  const [matrixCached, setMatrixCached] = React.useState<boolean | null>(null);
  const [activeTab, setActiveTab] = React.useState("overview");
  const [compareDialog, setCompareDialog] = React.useState<{
    open: boolean;
    pdbId?: string;
    mobilePdbId?: string;
    openCompareTab?: boolean;
  }>({ open: false });

  React.useEffect(() => {
    if (!open || !projectId) return;
    setLoading(true);
    api
      .listProjectStructures(projectId)
      .then((res) => setEntries(res.analyses || []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [open, projectId]);

  async function runBatch() {
    setBatchRunning(true);
    try {
      const res = await api.batchAnalyzeStructures(projectId);
      if (res.total === 0) {
        toast.info(t("structure.batchNoRcsb"));
      } else {
        toast.success(
          t("structure.batchComplete", {
            analyzed: res.analyzed,
            skipped: res.skipped,
            failed: res.failed,
          })
        );
      }
      // Refresh the list.
      const fresh = await api.listProjectStructures(projectId);
      setEntries(fresh.analyses || []);
    } catch (e: any) {
      toast.error(t("toast.batchAnalyzeFailed", { error: e?.message || "unknown" }));
    } finally {
      setBatchRunning(false);
    }
  }

  // Parse key metrics from the contextMarkdown for display.
  function extractMetric(md: string, re: RegExp): string | null {
    const m = md.match(re);
    return m ? m[1] : null;
  }

  // Aggregate stats
  const totalChains = entries.reduce((s, e) => s + e.chainCount, 0);
  const totalResidues = entries.reduce((s, e) => s + e.residueCount, 0);
  const totalLigands = entries.reduce((s, e) => s + e.ligandCount, 0);

  // Compute the pairwise comparison matrix.
  async function computeMatrix(force = false) {
    setMatrixLoading(true);
    if (force) setMatrixData(null);
    try {
      const res = await api.computeComparisonMatrix(projectId, { force });
      setMatrixData(res.matrix);
      setMatrixCached(res.cached ?? false);
      if (res.message) {
        toast.info(res.message);
      } else if (res.cached) {
        toast.success(t("structure.matrixCacheHit"));
      } else if (force) {
        toast.success(t("structure.matrixRecomputed"));
      }
    } catch (e: any) {
      toast.error(e?.message || "Matrix computation failed");
    } finally {
      setMatrixLoading(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-5xl max-h-[92vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-3 border-b">
            <DialogTitle className="flex items-center gap-2 text-lg">
              <Layers className="h-5 w-5 text-amber-600" />
              {t("structure.dashboardTitle")}
              {entries.length > 0 && (
                <Badge variant="secondary" className="ml-1">
                  {entries.length}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {t("structure.dashboardDesc")}
            </DialogDescription>
          </DialogHeader>

          {/* Summary stats + actions */}
          <div className="px-6 py-3 border-b bg-muted/30 flex items-center gap-3 flex-wrap">
            {entries.length > 0 && (
              <div className="flex gap-4 text-[11px]">
                <div className="flex items-center gap-1">
                  <Box className="h-3.5 w-3.5 text-amber-600" />
                  <span className="font-semibold">{entries.length}</span>
                  <span className="text-muted-foreground">structures</span>
                </div>
                <div className="flex items-center gap-1">
                  <Layers className="h-3.5 w-3.5 text-sky-600" />
                  <span className="font-semibold">{totalChains}</span>
                  <span className="text-muted-foreground">chains</span>
                </div>
                <div className="flex items-center gap-1">
                  <Activity className="h-3.5 w-3.5 text-emerald-600" />
                  <span className="font-semibold">{totalResidues}</span>
                  <span className="text-muted-foreground">residues</span>
                </div>
                <div className="flex items-center gap-1">
                  <Box className="h-3.5 w-3.5 text-violet-600" />
                  <span className="font-semibold">{totalLigands}</span>
                  <span className="text-muted-foreground">ligands</span>
                </div>
              </div>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={runBatch}
              disabled={batchRunning}
              className="ml-auto h-7 text-[10px] gap-1 border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400"
            >
              {batchRunning ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {t("structure.batchAnalyze")}
            </Button>
          </div>

          {/* Body with tabs */}
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex-1 flex flex-col min-h-0"
          >
            <TabsList className="mx-6 mt-3 grid grid-cols-4 h-auto">
              <TabsTrigger value="overview" className="text-[11px] gap-1">
                <Layers className="h-3 w-3" />
                {t("structure.overview")}
              </TabsTrigger>
              <TabsTrigger value="matrix" className="text-[11px] gap-1">
                <GitCompare className="h-3 w-3" />
                {t("structure.matrix")}
              </TabsTrigger>
              <TabsTrigger value="network" className="text-[11px] gap-1">
                <Share2 className="h-3 w-3" />
                {t("structure.network")}
              </TabsTrigger>
              <TabsTrigger value="dendrogram" className="text-[11px] gap-1">
                <GitBranch className="h-3 w-3" />
                {t("structure.dendrogram")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden">
          <ScrollArea className="flex-1 min-h-0">
            <div className="px-6 py-4">
              {loading ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Loader2 className="h-8 w-8 animate-spin text-amber-600" />
                  <p className="text-sm text-muted-foreground">Loading…</p>
                </div>
              ) : entries.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Box className="h-12 w-12 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground max-w-md text-center">
                    {t("structure.dashboardEmpty")}
                  </p>
                  <Button
                    size="sm"
                    onClick={runBatch}
                    disabled={batchRunning}
                    className="mt-2"
                  >
                    {batchRunning ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                    ) : (
                      <Layers className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    {t("structure.batchAnalyze")}
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {entries.map((e) => {
                    const md = e.contextMarkdown || "";
                    const method = extractMetric(md, /Method: ([^|]+)/);
                    const resolution = extractMetric(md, /Resolution: ([^|Å]+Å)/);
                    const ramaFav = extractMetric(md, /Favoured \(core\+allowed\): (\S+)%/);
                    const ramaOut = extractMetric(md, /Outliers: (\S+)%/);
                    const bfMean = extractMetric(md, /Mean: ([\d.]+)/);
                    const sasaExp = extractMetric(md, /Exposed: (\S+)%/);
                    const hbonds = extractMetric(md, /Hydrogen bonds[^:]*: (\d+)/);
                    const netCharge = extractMetric(md, /Net charge at pH 7: ([\d.\-+]+)/);
                    const pI = extractMetric(md, /Isoelectric point \(pI\): ([\d.]+)/);
                    const oligomer =
                      e.chainCount <= 1
                        ? "monomer"
                        : e.chainCount === 2
                          ? "dimer"
                          : e.chainCount === 4
                            ? "tetramer"
                            : `${e.chainCount}-mer`;
                    return (
                      <div
                        key={e.pdbId}
                        className="rounded-lg border border-border/60 bg-card p-3 space-y-2 hover:border-amber-300 hover:shadow-sm transition-all cursor-pointer"
                        onClick={() => setDetailDialog({ open: true, pdbId: e.pdbId })}
                      >
                        {/* Header */}
                        <div className="flex items-start gap-2">
                          <Badge
                            variant="secondary"
                            className="font-mono text-[10px] bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 shrink-0"
                          >
                            {e.pdbId}
                          </Badge>
                          <div className="flex-1 min-w-0">
                            <div className="text-[11px] font-medium leading-snug line-clamp-2">
                              {e.title || "untitled"}
                            </div>
                          </div>
                          <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                        </div>

                        {/* Top metrics row */}
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                          <span>
                            <span className="font-semibold text-foreground">{e.chainCount}</span> ch ({oligomer})
                          </span>
                          <span>
                            <span className="font-semibold text-foreground">{e.residueCount}</span> res
                          </span>
                          <span>
                            <span className="font-semibold text-foreground">{e.atomCount}</span> atoms
                          </span>
                          {e.ligandCount > 0 && (
                            <span>
                              <span className="font-semibold text-foreground">{e.ligandCount}</span> lig
                            </span>
                          )}
                          {method && (
                            <span className="truncate max-w-[120px]">
                              {method.trim().slice(0, 20)}
                            </span>
                          )}
                          {resolution && <span className="text-amber-600 font-medium">{resolution.trim()}</span>}
                        </div>

                        {/* Quality + electrostatics row */}
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
                          {ramaFav && (
                            <span className="flex items-center gap-0.5" title="Ramachandran favoured">
                              <ShieldCheck className="h-2.5 w-2.5 text-emerald-600" />
                              <span className="font-semibold">{ramaFav}%</span>
                              <span className="text-muted-foreground">Ramach</span>
                            </span>
                          )}
                          {bfMean && (
                            <span className="flex items-center gap-0.5" title="B-factor mean">
                              <Thermometer className="h-2.5 w-2.5 text-amber-600" />
                              <span className="font-semibold">B̄={Math.round(parseFloat(bfMean))}</span>
                            </span>
                          )}
                          {sasaExp && (
                            <span className="flex items-center gap-0.5" title="SASA exposed %">
                              <Droplets className="h-2.5 w-2.5 text-sky-600" />
                              <span className="font-semibold">{sasaExp}%</span>
                              <span className="text-muted-foreground">exp</span>
                            </span>
                          )}
                          {hbonds && (
                            <span className="flex items-center gap-0.5" title="Hydrogen bonds">
                              <Activity className="h-2.5 w-2.5 text-emerald-600" />
                              <span className="font-semibold">{hbonds}</span>
                              <span className="text-muted-foreground">H-bond</span>
                            </span>
                          )}
                        </div>

                        {/* Charge row */}
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
                          {netCharge && (
                            <span className="flex items-center gap-0.5" title="Net charge at pH 7">
                              <Zap className="h-2.5 w-2.5 text-violet-600" />
                              <span className="font-semibold">
                                q={parseFloat(netCharge) > 0 ? "+" : ""}{Math.round(parseFloat(netCharge))}
                              </span>
                            </span>
                          )}
                          {pI && (
                            <span className="text-muted-foreground">
                              pI=<span className="font-semibold text-foreground">{parseFloat(pI).toFixed(1)}</span>
                            </span>
                          )}
                          {ramaOut && parseFloat(ramaOut) > 5 && (
                            <span className="text-rose-600 font-medium" title="Ramachandran outliers">
                              ⚠ {ramaOut}% outliers
                            </span>
                          )}
                        </div>

                        {/* Updated time */}
                        <div className="text-[9px] text-muted-foreground/70 pt-0.5 border-t border-border/30">
                          {t("structure.cachedAt")}: {new Date(e.updatedAt).toLocaleDateString()}{" "}
                          {new Date(e.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </ScrollArea>
            </TabsContent>
            <TabsContent value="matrix" className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden">
              <ComparisonMatrixTab
                projectId={projectId}
                entries={entries}
                matrixData={matrixData}
                matrixLoading={matrixLoading}
                matrixCached={matrixCached}
                onCompute={() => computeMatrix(false)}
                onForceRecompute={() => computeMatrix(true)}
                onViewPair={(refPdbId, mobPdbId) =>
                  setCompareDialog({ open: true, pdbId: refPdbId, mobilePdbId: mobPdbId, openCompareTab: true })
                }
                t={t}
              />
            </TabsContent>
            <TabsContent value="network" className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden overflow-y-auto">
              <ComparisonNetworkGraph
                entries={entries}
                matrixData={matrixData}
                onViewNode={(pdbId) => setDetailDialog({ open: true, pdbId })}
                t={t}
              />
            </TabsContent>
            <TabsContent value="dendrogram" className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden overflow-y-auto">
              <ComparisonDendrogram
                entries={entries}
                matrixData={matrixData}
                onViewNode={(pdbId) => setDetailDialog({ open: true, pdbId })}
                t={t}
              />
            </TabsContent>
          </Tabs>

          {/* Footer hint */}
          {entries.length > 0 && (
            <div className="px-6 py-2.5 border-t bg-amber-50/50 dark:bg-amber-950/20 text-[10px] text-amber-700 dark:text-amber-400 flex items-center gap-2">
              <Activity className="h-3 w-3 flex-shrink-0" />
              <span className="flex-1">
                {t("structure.dashboardFooter")}
              </span>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      <ProteinStructureAnalysisDialog
        open={detailDialog.open}
        onOpenChange={(v) => setDetailDialog({ open: v })}
        initialPdbId={detailDialog.pdbId}
      />
      {/* Comparison pair dialog */}
      <ProteinStructureAnalysisDialog
        open={compareDialog.open}
        onOpenChange={(v) => setCompareDialog({ open: v })}
        initialPdbId={compareDialog.pdbId}
        initialMobilePdbId={compareDialog.mobilePdbId}
        initialTab={compareDialog.openCompareTab ? "compare" : undefined}
      />
    </>
  );
}

/* ---------------- Comparison Matrix Tab ---------------- */

// Accept the real i18n key type so the provider `t` function is
// assignable (a `key: string` parameter is contravariant-incompatible
// with the union-of-literal-keys signature).
type TFunc = (key: TranslationKey, opts?: any) => string;

function ComparisonMatrixTab({
  projectId,
  entries,
  matrixData,
  matrixLoading,
  matrixCached,
  onCompute,
  onForceRecompute,
  onViewPair,
  t,
}: {
  projectId: string;
  entries: DashboardEntry[];
  matrixData: any;
  matrixLoading: boolean;
  matrixCached: boolean | null;
  onCompute: () => void;
  onForceRecompute: () => void;
  onViewPair: (refPdbId: string, mobPdbId?: string) => void;
  t: TFunc;
}) {
  const [metric, setMetric] = React.useState<"rmsd" | "tmScore" | "identity">("tmScore");

  if (entries.length < 2) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 px-6">
        <GitCompare className="h-12 w-12 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground max-w-md text-center">
          {t("structure.matrixEmpty")}
        </p>
      </div>
    );
  }

  const matrix = matrixData;
  const pdbIds: string[] = matrix?.pdbIds || [];
  const n = matrix?.n || 0;

  // Get the active matrix based on selected metric.
  const activeMatrix: number[][] =
    metric === "rmsd"
      ? matrix?.rmsdMatrix || []
      : metric === "tmScore"
        ? matrix?.tmScoreMatrix || []
        : matrix?.identityMatrix || [];

  // Color function for heatmap cells.
  const colorForValue = (val: number): string => {
    if (val < 0) return "#f3f4f6"; // N/A (failed comparison)
    if (metric === "rmsd") {
      // 0 Å = blue (similar), >15 Å = red (different)
      const t = Math.min(1, val / 15);
      const r = Math.round(30 + t * 225);
      const g = Math.round(80 + t * 50);
      const b = Math.round(200 - t * 150);
      return `rgb(${r}, ${g}, ${b})`;
    } else if (metric === "tmScore") {
      // 1.0 = blue (same fold), 0 = red (different)
      const t = val;
      const r = Math.round(30 + (1 - t) * 225);
      const g = Math.round(80 + (1 - t) * 50);
      const b = Math.round(200 - (1 - t) * 150);
      return `rgb(${r}, ${g}, ${b})`;
    } else {
      // identity: 100% = blue, 0% = red
      const t = val / 100;
      const r = Math.round(30 + (1 - t) * 225);
      const g = Math.round(80 + (1 - t) * 50);
      const b = Math.round(200 - (1 - t) * 150);
      return `rgb(${r}, ${g}, ${b})`;
    }
  };

  const formatValue = (val: number): string => {
    if (val < 0) return "—";
    if (metric === "identity") return `${val.toFixed(0)}%`;
    if (metric === "tmScore") return val.toFixed(2);
    return val.toFixed(1);
  };

  return (
    <div className="px-6 py-4 space-y-3 overflow-y-auto max-h-[60vh]">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("structure.matrixTitle")}
            </span>
            {matrixCached !== null && matrixData && (
              <Badge
                variant="outline"
                className={`text-[8px] py-0 px-1.5 font-normal transition-colors ${
                  matrixCached
                    ? "border-emerald-300 bg-emerald-50/50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400"
                    : "border-sky-300 bg-sky-50/50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-400"
                }`}
                title={matrixCached ? t("structure.matrixCacheHit") : t("structure.matrixRecomputed")}
              >
                {matrixCached ? t("structure.matrixCachedBadge") : t("structure.matrixFreshBadge")}
              </Badge>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground mt-0.5 max-w-xl">
            {t("structure.matrixDesc")}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            onClick={onCompute}
            disabled={matrixLoading}
            className="h-7 text-[10px] gap-1"
          >
            {matrixLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <GitCompare className="h-3 w-3" />
            )}
            {t("structure.matrixRun")}
          </Button>
          {matrix && n > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={onForceRecompute}
              disabled={matrixLoading}
              className="h-7 text-[10px] gap-1"
              title={t("structure.matrixForceRecomputeTitle")}
            >
              <RefreshCw className="h-3 w-3" />
              {t("structure.matrixForceRecompute")}
            </Button>
          )}
        </div>
      </div>

      {/* Metric selector */}
      {matrix && n > 0 && (
        <div className="flex items-center gap-1">
          {(["tmScore", "rmsd", "identity"] as const).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={metric === m ? "default" : "outline"}
              className="h-6 text-[10px]"
              onClick={() => setMetric(m)}
            >
              {m === "tmScore" ? t("structure.matrixTm") : m === "rmsd" ? t("structure.matrixRmsd") : t("structure.matrixIdentity")}
            </Button>
          ))}
        </div>
      )}

      {/* Matrix heatmap */}
      {matrixLoading ? (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-amber-600" />
          <p className="text-sm text-muted-foreground">Computing pairwise comparisons…</p>
          <p className="text-[10px] text-muted-foreground/70">
            Running Kabsch superposition + sequence alignment for all {n > 0 ? (n * (n - 1)) / 2 : "?"} pairs.
          </p>
        </div>
      ) : matrix && n > 0 ? (
        <div className="space-y-3">
          {/* Heatmap table */}
          <div className="overflow-x-auto rounded-lg border">
            <table className="text-[10px] font-mono border-collapse">
              <thead>
                <tr>
                  <th className="p-1.5 border-b border-r bg-muted/50 sticky left-0 z-10"></th>
                  {pdbIds.map((id) => (
                    <th key={id} className="p-1.5 border-b border-r bg-muted/50 text-center min-w-[44px]">
                      <span className="text-[9px] font-semibold text-amber-700 dark:text-amber-400">{id}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pdbIds.map((rowId, i) => (
                  <tr key={rowId}>
                    <td className="p-1.5 border-b border-r bg-muted/50 sticky left-0 z-10">
                      <span className="text-[9px] font-semibold text-amber-700 dark:text-amber-400">{rowId}</span>
                    </td>
                    {pdbIds.map((colId, j) => {
                      const val = activeMatrix[i]?.[j] ?? -1;
                      const isDiagonal = i === j;
                      return (
                        <td
                          key={colId}
                          className="p-1 border-b border-r text-center cursor-pointer hover:ring-2 hover:ring-amber-400 transition-all"
                          style={{
                            backgroundColor: isDiagonal ? "#e5e7eb" : colorForValue(val),
                            color: isDiagonal ? "#9ca3af" : val < 0 ? "#9ca3af" : "white",
                          }}
                          title={
                            isDiagonal
                              ? `${rowId} (self)`
                              : `${rowId} vs ${colId}: ${metric === "tmScore" ? "TM=" : metric === "rmsd" ? "RMSD=" : "identity="}${formatValue(val)}`
                          }
                          onClick={() => {
                            if (!isDiagonal && val >= 0) onViewPair(rowId, colId);
                          }}
                        >
                          {isDiagonal ? "—" : formatValue(val)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Heatmap description */}
          <p className="text-[10px] text-muted-foreground">
            {metric === "rmsd" ? t("structure.matrixHeatmapRmsd") : metric === "tmScore" ? t("structure.matrixHeatmapTm") : t("structure.matrixHeatmapIdentity")}
          </p>

          {/* All pairs list */}
          {matrix.entries && matrix.entries.length > 0 && (
            <div className="rounded-lg border p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
                {t("structure.matrixPairs")}
              </div>
              <p className="text-[10px] text-muted-foreground mb-2">
                {t("structure.matrixPairsDesc")}
              </p>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {[...matrix.entries]
                  .sort((a: any, b: any) => b.tmScore - a.tmScore)
                  .map((e: any, i: number) => {
                    const foldColor =
                      e.foldAssessment === "same-fold"
                        ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                        : e.foldAssessment === "similar-fold"
                          ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                          : e.foldAssessment === "different-fold"
                            ? "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200"
                            : "bg-muted text-muted-foreground";
                    const foldLabel =
                      e.foldAssessment === "same-fold"
                        ? t("structure.matrixSameFold")
                        : e.foldAssessment === "similar-fold"
                          ? t("structure.matrixSimilarFold")
                          : e.foldAssessment === "different-fold"
                            ? t("structure.matrixDifferentFold")
                            : t("structure.matrixInsufficient");
                    return (
                      <button
                        key={i}
                        onClick={() => onViewPair(e.referencePdbId, e.mobilePdbId)}
                        className="w-full flex items-center gap-2 text-[10px] p-1.5 rounded hover:bg-muted/50 transition-colors text-left"
                      >
                        <span className="font-mono font-semibold text-amber-700 dark:text-amber-400 w-20">
                          {e.referencePdbId} ↔ {e.mobilePdbId}
                        </span>
                        <span className="text-muted-foreground">RMSD={e.rmsd < 0 ? "—" : e.rmsd.toFixed(1)}Å</span>
                        <span className="text-muted-foreground">TM={e.tmScore.toFixed(2)}</span>
                        <span className="text-muted-foreground">ident={e.sequenceIdentity.toFixed(0)}%</span>
                        <Badge variant="secondary" className={`text-[8px] ${foldColor} ml-auto`}>
                          {foldLabel}
                        </Badge>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <GitCompare className="h-10 w-10 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">
            Click "{t("structure.matrixRun")}" to compute the pairwise comparison matrix.
          </p>
        </div>
      )}
    </div>
  );
}

/* ---------------- Structure Similarity Network Graph ---------------- */

function ComparisonNetworkGraph({
  entries,
  matrixData,
  onViewNode,
  t,
}: {
  entries: DashboardEntry[];
  matrixData: any;
  onViewNode: (pdbId: string) => void;
  t: TFunc;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [hoverNode, setHoverNode] = React.useState<string | null>(null);
  const [draggingNode, setDraggingNode] = React.useState<string | null>(null);
  const [relayoutTrigger, setRelayoutTrigger] = React.useState(0);
  const nodesRef = React.useRef<Map<string, { x: number; y: number; vx: number; vy: number; pdbId: string; resCount: number; cluster: number }>>(new Map());

  // Detect clusters using union-find on edges (TM >= 0.5 = same fold = same cluster).
  const clusterMap = React.useMemo(() => {
    if (!matrixData || !matrixData.entries) return new Map<string, number>();
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      if (!parent.has(x)) parent.set(x, x);
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      // Path compression.
      let cur = x;
      while (parent.get(cur) !== root) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    // Initialize all nodes as their own cluster.
    if (matrixData.pdbIds) {
      for (const id of matrixData.pdbIds) parent.set(id, id);
    }
    // Union nodes connected by TM >= 0.5 edges (same fold).
    for (const e of matrixData.entries) {
      if (e.tmScore >= 0.5) {
        union(e.referencePdbId, e.mobilePdbId);
      }
    }
    // Assign cluster IDs.
    const clusterIds = new Map<string, number>();
    const rootToCluster = new Map<string, number>();
    let nextCluster = 0;
    for (const id of matrixData.pdbIds || []) {
      const root = find(id);
      if (!rootToCluster.has(root)) {
        rootToCluster.set(root, nextCluster++);
      }
      clusterIds.set(id, rootToCluster.get(root)!);
    }
    return clusterIds;
  }, [matrixData]);

  // Cluster colors (a palette for up to 10 clusters).
  const CLUSTER_COLORS = [
    "#f59e0b", // amber (default)
    "#10b981", // emerald
    "#0ea5e9", // sky
    "#8b5cf6", // violet
    "#ec4899", // pink
    "#14b8a6", // teal
    "#f97316", // orange
    "#6366f1", // indigo
    "#84cc16", // lime
    "#06b6d4", // cyan
  ];

  // Build nodes and edges from matrix data.
  const { nodes, edges } = React.useMemo(() => {
    if (!matrixData || !matrixData.pdbIds || matrixData.pdbIds.length === 0) {
      return { nodes: [] as any[], edges: [] as any[] };
    }
    const pdbIds: string[] = matrixData.pdbIds;
    const nodeArr = pdbIds.map((id) => {
      const entry = entries.find((e) => e.pdbId === id);
      return {
        pdbId: id,
        resCount: entry?.residueCount || 100,
        title: entry?.title || id,
      };
    });
    // Edges: pairs with TM-score >= 0.3
    const edgeArr: any[] = [];
    if (matrixData.entries) {
      for (const e of matrixData.entries) {
        if (e.tmScore >= 0.3) {
          edgeArr.push({
            source: e.referencePdbId,
            target: e.mobilePdbId,
            tmScore: e.tmScore,
            rmsd: e.rmsd,
            identity: e.sequenceIdentity,
            foldAssessment: e.foldAssessment,
          });
        }
      }
    }
    return { nodes: nodeArr, edges: edgeArr };
  }, [matrixData, entries]);

  // Initialize node positions in a circle. Re-runs on relayoutTrigger.
  React.useEffect(() => {
    if (nodes.length === 0) return;
    const map = nodesRef.current;
    map.clear();
    const cx = 250;
    const cy = 200;
    const radius = Math.min(180, 40 + nodes.length * 15);
    nodes.forEach((n, i) => {
      const angle = (i / nodes.length) * 2 * Math.PI + relayoutTrigger * 0.5;
      map.set(n.pdbId, {
        x: cx + Math.cos(angle) * radius + (Math.random() - 0.5) * 20,
        y: cy + Math.sin(angle) * radius + (Math.random() - 0.5) * 20,
        vx: 0,
        vy: 0,
        pdbId: n.pdbId,
        resCount: n.resCount,
        cluster: clusterMap.get(n.pdbId) ?? 0,
      });
    });
  }, [nodes, relayoutTrigger, clusterMap]);

  // Force simulation + render loop. Restarts on relayoutTrigger.
  React.useEffect(() => {
    if (nodes.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let rafId: number;
    let frame = 0; // Reset frame counter on each relayout.

    const render = () => {
      frame++;
      const map = nodesRef.current;
      const W = canvas.width;
      const H = canvas.height;

      // Force simulation (only run for first 200 frames, then settle).
      if (frame < 300) {
        // Repulsion between all node pairs.
        const nodeArr = [...map.values()];
        for (let i = 0; i < nodeArr.length; i++) {
          for (let j = i + 1; j < nodeArr.length; j++) {
            const a = nodeArr[i];
            const b = nodeArr[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const distSq = dx * dx + dy * dy + 0.01;
            const dist = Math.sqrt(distSq);
            const force = 800 / distSq;
            a.vx -= (dx / dist) * force;
            a.vy -= (dy / dist) * force;
            b.vx += (dx / dist) * force;
            b.vy += (dy / dist) * force;
          }
        }
        // Attraction along edges.
        for (const edge of edges) {
          const a = map.get(edge.source);
          const b = map.get(edge.target);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy + 0.01);
          const targetDist = 120 - edge.tmScore * 60; // closer for higher TM
          const force = (dist - targetDist) * 0.02;
          a.vx += (dx / dist) * force;
          a.vy += (dy / dist) * force;
          b.vx -= (dx / dist) * force;
          b.vy -= (dy / dist) * force;
        }
        // Centering force.
        for (const n of nodeArr) {
          n.vx += (W / 2 - n.x) * 0.005;
          n.vy += (H / 2 - n.y) * 0.005;
          // Damping.
          n.vx *= 0.85;
          n.vy *= 0.85;
          // Don't move the dragged node.
          if (draggingNode !== n.pdbId) {
            n.x += n.vx;
            n.y += n.vy;
          }
          // Bounds.
          n.x = Math.max(30, Math.min(W - 30, n.x));
          n.y = Math.max(30, Math.min(H - 30, n.y));
        }
      }

      // Clear.
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#fafafa";
      ctx.fillRect(0, 0, W, H);

      // Draw edges.
      for (const edge of edges) {
        const a = map.get(edge.source);
        const b = map.get(edge.target);
        if (!a || !b) continue;
        const tm = edge.tmScore;
        // Color by fold assessment.
        let color: string;
        if (tm > 0.5) {
          color = `rgba(16, 185, 129, ${0.3 + tm * 0.5})`; // emerald
        } else {
          color = `rgba(245, 158, 11, ${0.3 + tm * 0.4})`; // amber
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1 + tm * 4;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // Draw nodes.
      for (const n of map.values()) {
        const entry = entries.find((e) => e.pdbId === n.pdbId);
        const resCount = entry?.residueCount || 100;
        const radius = Math.max(8, Math.min(20, 8 + Math.sqrt(resCount) * 0.8));
        const isHovered = hoverNode === n.pdbId;
        // Node fill — color by cluster.
        const clusterIdx = n.cluster ?? 0;
        const baseColor = CLUSTER_COLORS[clusterIdx % CLUSTER_COLORS.length];
        // Convert hex to lighter/darker for gradient.
        const lighter = baseColor + "cc"; // ~80% opacity for center
        const darker = baseColor + "99";  // ~60% for edge
        const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, radius);
        grad.addColorStop(0, lighter);
        grad.addColorStop(1, darker);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI);
        ctx.fill();
        // Border.
        ctx.strokeStyle = isHovered ? "#fff" : "#92400e";
        ctx.lineWidth = isHovered ? 2.5 : 1.5;
        ctx.stroke();
        // Label.
        ctx.fillStyle = "#1f2937";
        ctx.font = `${isHovered ? "bold " : ""}10px ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.pdbId, n.x, n.y);
      }

      rafId = requestAnimationFrame(render);
    };
    render();

    return () => cancelAnimationFrame(rafId);
  }, [nodes, edges, entries, hoverNode, draggingNode, relayoutTrigger, CLUSTER_COLORS]);

  // Mouse interaction.
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    const map = nodesRef.current;

    if (draggingNode) {
      const n = map.get(draggingNode);
      if (n) {
        n.x = mx;
        n.y = my;
        n.vx = 0;
        n.vy = 0;
      }
      return;
    }

    // Find hovered node.
    let found: string | null = null;
    for (const n of map.values()) {
      const entry = entries.find((e) => e.pdbId === n.pdbId);
      const resCount = entry?.residueCount || 100;
      const radius = Math.max(8, Math.min(20, 8 + Math.sqrt(resCount) * 0.8));
      const dx = n.x - mx;
      const dy = n.y - my;
      if (dx * dx + dy * dy <= radius * radius) {
        found = n.pdbId;
        break;
      }
    }
    setHoverNode(found);
    canvas.style.cursor = found ? "pointer" : "default";
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (hoverNode) {
      setDraggingNode(hoverNode);
    }
  };

  const handleMouseUp = () => {
    if (draggingNode && !hoverNode) {
      // Was dragging, not a click.
      setDraggingNode(null);
      return;
    }
    if (draggingNode) {
      // Click on a node — open its analysis.
      onViewNode(draggingNode);
      setDraggingNode(null);
    }
  };

  if (!matrixData || !matrixData.pdbIds || matrixData.pdbIds.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 px-6">
        <GitCompare className="h-12 w-12 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground max-w-md text-center">
          {t("structure.networkEmpty")}
        </p>
      </div>
    );
  }

  const totalPossible = (nodes.length * (nodes.length - 1)) / 2;

  return (
    <div className="px-6 py-4 space-y-3">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("structure.networkTitle")}
        </div>
        <p className="text-[10px] text-muted-foreground mt-0.5 max-w-2xl">
          {t("structure.networkDesc")}
        </p>
      </div>

      <div ref={containerRef} className="relative rounded-lg border bg-card overflow-hidden">
        <canvas
          ref={canvasRef}
          width={500}
          height={400}
          className="w-full h-auto block"
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            setHoverNode(null);
            setDraggingNode(null);
          }}
        />
        {/* Hover tooltip */}
        {hoverNode && (
          <div className="absolute top-2 right-2 px-2 py-1 rounded bg-black/80 text-white text-[10px] font-mono pointer-events-none">
            {hoverNode} — {entries.find((e) => e.pdbId === hoverNode)?.residueCount || "?"} res
          </div>
        )}
      </div>

      {/* Legend + stats + re-layout button */}
      <div className="flex items-center justify-between gap-2 flex-wrap text-[10px]">
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground">
            {t("structure.networkEdgeCount", { n: edges.length, total: totalPossible })}
          </span>
          <span className="text-muted-foreground">
            · {new Set(clusterMap.values()).size} {t("structure.networkClusters")}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-0.5 bg-emerald-500" style={{ height: "3px" }} />
            <span className="text-muted-foreground">TM&gt;0.5</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-0.5 bg-amber-500" style={{ height: "2px" }} />
            <span className="text-muted-foreground">0.3-0.5</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: CLUSTER_COLORS[0] }} />
            <span className="text-muted-foreground">{t("structure.networkCluster")}</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-5 text-[9px] gap-1 px-1.5"
            onClick={() => setRelayoutTrigger((v) => v + 1)}
            title={t("structure.networkRelayout")}
          >
            <RefreshCw className="h-2.5 w-2.5" />
            {t("structure.networkRelayout")}
          </Button>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground/70">
        {t("structure.networkClickHint")}
      </p>
    </div>
  );
}

/* ---------------- Structure Similarity Dendrogram ---------------- */

interface DendroNode {
  pdbId?: string;
  children?: DendroNode[];
  height: number; // similarity (TM-score), 1.0 = identical
  isLeaf: boolean;
  leafCount: number;
}

function ComparisonDendrogram({
  entries,
  matrixData,
  onViewNode,
  t,
}: {
  entries: DashboardEntry[];
  matrixData: any;
  onViewNode: (pdbId: string) => void;
  t: TFunc;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [hoverLeaf, setHoverLeaf] = React.useState<string | null>(null);

  // Build the dendrogram tree using UPGMA (average linkage) on TM-score.
  const { tree, leaves } = React.useMemo(() => {
    if (!matrixData || !matrixData.pdbIds || matrixData.pdbIds.length < 2) {
      return { tree: null as DendroNode | null, leaves: [] as string[] };
    }
    const pdbIds: string[] = matrixData.pdbIds;
    const n = pdbIds.length;
    const tmMatrix: number[][] = matrixData.tmScoreMatrix || [];

    // Initialize: each structure is its own cluster (leaf).
    const clusters: DendroNode[] = pdbIds.map((id) => ({
      pdbId: id,
      height: 1,
      isLeaf: true,
      leafCount: 1,
    }));

    // Merge clusters until one remains.
    while (clusters.length > 1) {
      let bestI = 0;
      let bestJ = 1;
      let bestSim = -1; // highest TM-score = most similar
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          // Average linkage: average TM-score between all pairs across clusters.
          const leavesI = getLeaves(clusters[i]).map((l) => pdbIds.indexOf(l.pdbId!));
          const leavesJ = getLeaves(clusters[j]).map((l) => pdbIds.indexOf(l.pdbId!));
          let sum = 0;
          let count = 0;
          for (const a of leavesI) {
            for (const b of leavesJ) {
              sum += tmMatrix[a]?.[b] ?? 0;
              count++;
            }
          }
          const avgSim = count > 0 ? sum / count : 0;
          if (avgSim > bestSim) {
            bestSim = avgSim;
            bestI = i;
            bestJ = j;
          }
        }
      }
      // Merge clusters[bestI] and clusters[bestJ].
      const merged: DendroNode = {
        height: bestSim,
        isLeaf: false,
        leafCount: clusters[bestI].leafCount + clusters[bestJ].leafCount,
        children: [clusters[bestI], clusters[bestJ]],
      };
      // Remove the two merged clusters and add the merged one.
      clusters.splice(bestJ, 1);
      clusters.splice(bestI, 1);
      clusters.push(merged);
    }

    const root = clusters[0] || null;
    const leafArr: string[] = [];
    if (root) collectLeaves(root, leafArr);
    return { tree: root, leaves: leafArr };

    function getLeaves(node: DendroNode): DendroNode[] {
      if (node.isLeaf) return [node];
      const result: DendroNode[] = [];
      if (node.children) {
        for (const c of node.children) result.push(...getLeaves(c));
      }
      return result;
    }
    function collectLeaves(node: DendroNode, arr: string[]) {
      if (node.isLeaf && node.pdbId) {
        arr.push(node.pdbId);
      } else if (node.children) {
        for (const c of node.children) collectLeaves(c, arr);
      }
    }
  }, [matrixData]);

  // Render the dendrogram on canvas.
  React.useEffect(() => {
    if (!tree || leaves.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctxRaw = canvas.getContext("2d");
    if (!ctxRaw) return;
    // Re-bind to a non-nullable const so nested function bodies below
    // (drawNode etc.) keep the narrowed type — TS does not extend control-
    // flow narrowing into closures for `CanvasRenderingContext2D | null`.
    const ctx = ctxRaw;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, W, H);

    const marginL = 50;
    const marginR = 20;
    const marginT = 20;
    const marginB = 40;
    const plotW = W - marginL - marginR;
    const plotH = H - marginT - marginB;

    // X positions for leaves (left to right).
    const leafX = new Map<string, number>();
    const leafSpacing = plotW / Math.max(leaves.length, 1);
    leaves.forEach((id, i) => {
      leafX.set(id, marginL + (i + 0.5) * leafSpacing);
    });

    // Y scale: height 1.0 (top) to 0.0 (bottom). TM-score 1 = identical.
    const yScale = (sim: number) => marginT + (1 - sim) * plotH;

    // Recursively draw the tree.
    function drawNode(node: DendroNode): { x: number; y: number } {
      if (node.isLeaf && node.pdbId) {
        const x = leafX.get(node.pdbId) ?? marginL;
        const y = marginT + plotH; // leaves at the bottom
        // Draw leaf label.
        const isHovered = hoverLeaf === node.pdbId;
        ctx.fillStyle = isHovered ? "#d97706" : "#71717a";
        ctx.font = `${isHovered ? "bold " : ""}9px ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.save();
        ctx.translate(x, marginT + plotH + 4);
        ctx.rotate(-Math.PI / 4);
        ctx.fillText(node.pdbId, 0, 0);
        ctx.restore();
        // Draw vertical line from leaf to its merge height.
        if (node.height < 1) {
          ctx.strokeStyle = "#a8a29e";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x, yScale(node.height));
          ctx.stroke();
        }
        return { x, y: yScale(node.height) };
      }
      // Internal node: draw children first.
      if (!node.children || node.children.length !== 2) return { x: 0, y: 0 };
      const left = drawNode(node.children[0]);
      const right = drawNode(node.children[1]);
      const y = yScale(node.height);
      // Horizontal line connecting the two children at this height.
      ctx.strokeStyle = colorForSim(node.height);
      ctx.lineWidth = 1.5 + node.height * 2;
      ctx.beginPath();
      ctx.moveTo(left.x, left.y);
      ctx.lineTo(left.x, y);
      ctx.lineTo(right.x, y);
      ctx.lineTo(right.x, right.y);
      ctx.stroke();
      // Vertical lines from children up to this height.
      ctx.beginPath();
      ctx.moveTo(left.x, left.y);
      ctx.lineTo(left.x, y);
      ctx.moveTo(right.x, right.y);
      ctx.lineTo(right.x, y);
      ctx.stroke();
      return { x: (left.x + right.x) / 2, y };
    }

    function colorForSim(sim: number): string {
      if (sim > 0.5) return "rgba(16, 185, 129, 0.8)"; // emerald (same fold)
      if (sim > 0.3) return "rgba(245, 158, 11, 0.7)"; // amber (similar)
      return "rgba(244, 63, 94, 0.6)"; // rose (different)
    }

    if (tree) drawNode(tree);

    // Y-axis (similarity scale).
    ctx.strokeStyle = "#d4d4d8";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(marginL, marginT);
    ctx.lineTo(marginL, marginT + plotH);
    ctx.stroke();
    // Y-axis ticks.
    ctx.fillStyle = "#71717a";
    ctx.font = "8px ui-monospace, monospace";
    ctx.textAlign = "right";
    for (let v = 0; v <= 1; v += 0.25) {
      const y = yScale(v);
      ctx.fillText(v.toFixed(2), marginL - 4, y + 3);
      ctx.beginPath();
      ctx.moveTo(marginL - 2, y);
      ctx.lineTo(marginL, y);
      ctx.strokeStyle = "#d4d4d8";
      ctx.stroke();
    }
    // Y-axis label.
    ctx.save();
    ctx.translate(12, marginT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("TM-score (similarity)", 0, 0);
    ctx.restore();
  }, [tree, leaves, hoverLeaf]);

  // Click handler: find nearest leaf.
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const mx = (e.clientX - rect.left) * scaleX;
    // Find nearest leaf by X.
    let nearest: string | null = null;
    let minDist = Infinity;
    for (const [id, x] of leafXEntries) {
      const d = Math.abs(x - mx);
      if (d < minDist) {
        minDist = d;
        nearest = id;
      }
    }
    if (nearest) onViewNode(nearest);
  };

  // Cache leaf X positions for click detection.
  const leafXEntries = React.useMemo(() => {
    if (!tree || leaves.length === 0) return new Map<string, number>();
    const marginL = 50;
    const marginR = 20;
    const W = 500;
    const plotW = W - marginL - marginR;
    const leafSpacing = plotW / Math.max(leaves.length, 1);
    const m = new Map<string, number>();
    leaves.forEach((id, i) => {
      m.set(id, marginL + (i + 0.5) * leafSpacing);
    });
    return m;
  }, [tree, leaves]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const mx = (e.clientX - rect.left) * scaleX;
    let nearest: string | null = null;
    let minDist = Infinity;
    for (const [id, x] of leafXEntries) {
      const d = Math.abs(x - mx);
      if (d < minDist) {
        minDist = d;
        nearest = id;
      }
    }
    setHoverLeaf(nearest);
    canvas.style.cursor = nearest ? "pointer" : "default";
  };

  if (!matrixData || !matrixData.pdbIds || matrixData.pdbIds.length < 2) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 px-6">
        <GitCompare className="h-12 w-12 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground max-w-md text-center">
          {t("structure.dendrogramEmpty")}
        </p>
      </div>
    );
  }

  return (
    <div className="px-6 py-4 space-y-3">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("structure.dendrogramTitle")}
        </div>
        <p className="text-[10px] text-muted-foreground mt-0.5 max-w-2xl">
          {t("structure.dendrogramDesc")}
        </p>
      </div>
      <div className="rounded-lg border bg-card overflow-hidden">
        <canvas
          ref={canvasRef}
          width={500}
          height={350}
          className="w-full h-auto block cursor-pointer"
          onMouseMove={handleMouseMove}
          onClick={handleClick}
          onMouseLeave={() => setHoverLeaf(null)}
        />
      </div>
      {/* Legend */}
      <div className="flex items-center justify-center gap-4 text-[9px]">
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-0.5 bg-emerald-500" style={{ height: "3px" }} />
          <span className="text-muted-foreground">TM&gt;0.5 (same fold)</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-0.5 bg-amber-500" style={{ height: "2px" }} />
          <span className="text-muted-foreground">0.3-0.5 (similar)</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-0.5 bg-rose-500" style={{ height: "1.5px" }} />
          <span className="text-muted-foreground">&lt;0.3 (different)</span>
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground/70 text-center">
        {t("structure.dendrogramClickHint")}
      </p>
    </div>
  );
}
