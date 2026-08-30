"use client";

import * as React from "react";
import {
  Box,
  Loader2,
  RefreshCw,
  Copy,
  Check,
  Search,
  Activity,
  GitBranch,
  Boxes,
  ShieldCheck,
  Thermometer,
  Droplets,
  Network,
  Zap,
  CircleDot,
  Layers3,
  Dna,
  FileText,
  ExternalLink,
  GitCompare,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Optional initial PDB ID to auto-analyze on open. */
  initialPdbId?: string;
  /** Optional dataSourceId — if set, uses analyzeDataSourceStructure. */
  dataSourceId?: string;
  /** Optional second PDB ID for comparison deep-linking (pre-fills Compare tab). */
  initialMobilePdbId?: string;
  /** Optional tab to auto-select on open (e.g. "compare"). */
  initialTab?: string;
}

interface AnalysisData {
  pdbId: string;
  title: string;
  atomCount: number;
  residueCount: number;
  chainCount: number;
  ligandCount: number;
  contextMarkdown: string;
  analysis: any;
  rcsbMetadata?: any;
  updatedAt?: string;
  cached?: boolean;
}

export function ProteinStructureAnalysisDialog({
  open,
  onOpenChange,
  initialPdbId,
  dataSourceId,
  initialMobilePdbId,
  initialTab,
}: Props) {
  const { t } = useI18n();
  const [pdbIdInput, setPdbIdInput] = React.useState(initialPdbId || "");
  const [data, setData] = React.useState<AnalysisData | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState(initialTab || "overview");

  // Auto-analyze on open if initialPdbId provided.
  React.useEffect(() => {
    if (open && initialPdbId && !data) {
      void analyze(initialPdbId);
    }
    if (open && initialTab) {
      setActiveTab(initialTab);
    }
    if (!open) {
      // Reset on close.
      setData(null);
      setError(null);
      setLoading(false);
    }
  }, [open, initialPdbId, initialTab]);

  async function analyze(pdbId: string, force = false) {
    const id = pdbId.trim().toUpperCase();
    if (!id) {
      setError("Please enter a PDB ID.");
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = dataSourceId
        ? await api.analyzeDataSourceStructure(dataSourceId, { force })
        : await api.analyzeStructureById(id, { force });
      setData({
        pdbId: res.pdbId,
        title: res.title,
        atomCount: res.atomCount,
        residueCount: res.residueCount,
        chainCount: res.chainCount,
        ligandCount: res.ligandCount,
        contextMarkdown: res.contextMarkdown,
        analysis: res.analysis,
        rcsbMetadata: res.analysis?.rcsbMetadata,
        updatedAt: res.updatedAt,
        cached: res.cached,
      });
      toast.success(
        t("toast.structureAnalyzed", {
          pdbId: res.pdbId,
          n: res.chainCount,
          r: res.residueCount,
          l: res.ligandCount,
        })
      );
    } catch (e: any) {
      setError(e?.message || "Analysis failed");
      toast.error(
        t("toast.structureAnalyzeFailed", { error: e?.message || "unknown" })
      );
    } finally {
      setLoading(false);
    }
  }

  function copyContext() {
    if (!data) return;
    navigator.clipboard.writeText(data.contextMarkdown);
    setCopied(true);
    toast.success(t("structure.contextCopied"));
    setTimeout(() => setCopied(false), 2000);
  }

  const a = data?.analysis;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[92vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Box className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            {t("structure.title")}
            {data && (
              <Badge variant="secondary" className="ml-2 font-mono">
                {data.pdbId}
              </Badge>
            )}
            {data?.cached && (
              <Badge variant="outline" className="text-[10px]">
                cached
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("structure.description")}
          </DialogDescription>
        </DialogHeader>

        {/* PDB ID input row */}
        <div className="px-6 py-3 border-b bg-muted/30 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={pdbIdInput}
              onChange={(e) => setPdbIdInput(e.target.value)}
              placeholder={t("structure.enterPdbId")}
              className="h-8 pl-8 text-sm font-mono uppercase"
              onKeyDown={(e) => {
                if (e.key === "Enter" && pdbIdInput.trim()) {
                  void analyze(pdbIdInput);
                }
              }}
            />
          </div>
          <Button
            size="sm"
            onClick={() => analyze(pdbIdInput)}
            disabled={loading || !pdbIdInput.trim()}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : (
              <Search className="h-3.5 w-3.5 mr-1.5" />
            )}
            {t("structure.analyze")}
          </Button>
          {data && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => analyze(data.pdbId, true)}
              disabled={loading}
              title={t("structure.reanalyze")}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              {t("structure.reanalyze")}
            </Button>
          )}
          {data?.updatedAt && (
            <span className="text-[10px] text-muted-foreground ml-auto">
              {t("structure.cachedAt")}:{" "}
              {new Date(data.updatedAt).toLocaleString()}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden min-h-0">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-full py-20 gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-amber-600 dark:text-amber-400" />
              <p className="text-sm text-muted-foreground">
                {t("structure.analyzing")}
              </p>
              <p className="text-xs text-muted-foreground/70 max-w-md text-center">
                Downloading the PDB file from RCSB, parsing atoms, and computing
                Ramachandran, SASA, B-factor, hydrogen bonds, ligands, cavities,
                charge/pI, and assembly interfaces…
              </p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full py-20 gap-3">
              <TriangleAlert className="h-10 w-10 text-amber-500" aria-hidden="true" />
              <p className="text-sm text-destructive font-medium">{error}</p>
              <p className="text-xs text-muted-foreground max-w-md text-center">
                Make sure the PDB ID is valid (4 alphanumeric characters, e.g.
                1A3N, 6LU7, 4HHB). Very large structures (&gt;5000 residues) may
                time out — try a smaller one.
              </p>
            </div>
          ) : !data ? (
            <div className="flex flex-col items-center justify-center h-full py-20 gap-3">
              <Box className="h-12 w-12 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground max-w-md text-center">
                {t("structure.noData")}
              </p>
            </div>
          ) : (
            <Tabs
              value={activeTab}
              onValueChange={setActiveTab}
              className="h-full flex flex-col"
            >
              <TabsList className="mx-4 mt-3 flex flex-wrap h-auto gap-0.5">
                <TabsTrigger value="overview" className="text-[10px] gap-1">
                  <CircleDot className="h-3 w-3" />
                  <span className="hidden sm:inline">{t("structure.overview")}</span>
                </TabsTrigger>
                <TabsTrigger value="composition" className="text-[10px] gap-1">
                  <Boxes className="h-3 w-3" />
                  <span className="hidden sm:inline">{t("structure.composition")}</span>
                </TabsTrigger>
                <TabsTrigger value="ss" className="text-[10px] gap-1">
                  <GitBranch className="h-3 w-3" />
                  <span className="hidden md:inline">SS</span>
                </TabsTrigger>
                <TabsTrigger value="ligands" className="text-[10px] gap-1">
                  <Layers3 className="h-3 w-3" />
                  <span className="hidden sm:inline">{t("structure.ligands")}</span>
                </TabsTrigger>
                <TabsTrigger value="quality" className="text-[10px] gap-1">
                  <ShieldCheck className="h-3 w-3" />
                  <span className="hidden md:inline">{t("structure.quality")}</span>
                </TabsTrigger>
                <TabsTrigger value="bfactor" className="text-[10px] gap-1">
                  <Thermometer className="h-3 w-3" />
                  <span className="hidden md:inline">B-fac</span>
                </TabsTrigger>
                <TabsTrigger value="sasa" className="text-[10px] gap-1">
                  <Droplets className="h-3 w-3" />
                  <span className="hidden md:inline">SASA</span>
                </TabsTrigger>
                <TabsTrigger value="interactions" className="text-[10px] gap-1">
                  <Network className="h-3 w-3" />
                  <span className="hidden md:inline">{t("structure.interactions")}</span>
                </TabsTrigger>
                <TabsTrigger value="charge" className="text-[10px] gap-1">
                  <Zap className="h-3 w-3" />
                  <span className="hidden md:inline">{t("structure.electrostatics")}</span>
                </TabsTrigger>
                <TabsTrigger value="cavities" className="text-[10px] gap-1">
                  <CircleDot className="h-3 w-3" />
                  <span className="hidden md:inline">{t("structure.cavities")}</span>
                </TabsTrigger>
                <TabsTrigger value="assemblies" className="text-[10px] gap-1">
                  <Layers3 className="h-3 w-3" />
                  <span className="hidden md:inline">{t("structure.assemblies")}</span>
                </TabsTrigger>
                <TabsTrigger value="compare" className="text-[10px] gap-1">
                  <GitCompare className="h-3 w-3" />
                  <span className="hidden md:inline">{t("structure.compare")}</span>
                </TabsTrigger>
                <TabsTrigger value="context" className="text-[10px] gap-1">
                  <FileText className="h-3 w-3" />
                  <span className="hidden md:inline">LLM ctx</span>
                </TabsTrigger>
              </TabsList>

              <ScrollArea className="flex-1 min-h-0 px-4 pb-4 pt-3">
                <TabsContent value="overview" className="mt-0">
                  <OverviewTab data={data} t={t} />
                </TabsContent>
                <TabsContent value="composition" className="mt-0">
                  <CompositionTab a={a} t={t} />
                </TabsContent>
                <TabsContent value="ss" className="mt-0">
                  <SecondaryStructureTab a={a} t={t} />
                </TabsContent>
                <TabsContent value="ligands" className="mt-0">
                  <LigandsTab a={a} t={t} />
                </TabsContent>
                <TabsContent value="quality" className="mt-0">
                  <QualityTab a={a} t={t} />
                </TabsContent>
                <TabsContent value="bfactor" className="mt-0">
                  <BFactorTab a={a} t={t} />
                </TabsContent>
                <TabsContent value="sasa" className="mt-0">
                  <SasaTab a={a} t={t} />
                </TabsContent>
                <TabsContent value="interactions" className="mt-0">
                  <InteractionsTab a={a} t={t} />
                </TabsContent>
                <TabsContent value="charge" className="mt-0">
                  <ChargeTab a={a} t={t} />
                </TabsContent>
                <TabsContent value="cavities" className="mt-0">
                  <CavitiesTab a={a} t={t} />
                </TabsContent>
                <TabsContent value="assemblies" className="mt-0">
                  <AssembliesTab a={a} t={t} />
                </TabsContent>
                <TabsContent value="compare" className="mt-0">
                  <CompareTab
                    currentPdbId={data.pdbId}
                    initialMobilePdbId={initialMobilePdbId}
                    autoRun={initialMobilePdbId ? true : false}
                    t={t}
                  />
                </TabsContent>
                <TabsContent value="context" className="mt-0">
                  <ContextTab
                    markdown={data.contextMarkdown}
                    copied={copied}
                    onCopy={copyContext}
                    t={t}
                  />
                </TabsContent>
              </ScrollArea>
            </Tabs>
          )}
        </div>

        {/* Footer hint */}
        {data && (
          <div className="px-6 py-2.5 border-t bg-amber-50/50 dark:bg-amber-950/20 text-[10px] text-amber-700 dark:text-amber-400 flex items-center gap-2">
            <Activity className="h-3 w-3 flex-shrink-0" />
            <span className="flex-1">{t("structure.injectionHint")}</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Helper components ---------------- */

function StatCard({
  label,
  value,
  sub,
  color = "default",
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  color?: "default" | "amber" | "emerald" | "sky" | "rose" | "violet";
}) {
  const colorMap = {
    default: "border-border",
    amber: "border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-950/20",
    emerald: "border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/20",
    sky: "border-sky-200 dark:border-sky-900 bg-sky-50/40 dark:bg-sky-950/20",
    rose: "border-rose-200 dark:border-rose-900 bg-rose-50/40 dark:bg-rose-950/20",
    violet: "border-violet-200 dark:border-violet-900 bg-violet-50/40 dark:bg-violet-950/20",
  };
  return (
    <div className={`rounded-lg border p-3 transition-all hover:shadow-sm hover:-translate-y-0.5 ${colorMap[color]}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </div>
      <div className="text-lg font-bold mt-0.5 tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
      {children}
    </div>
  );
}

// Accept the real i18n key type so the provider `t` function is
// assignable (a `key: string` parameter is contravariant-incompatible
// with the union-of-literal-keys signature).
type TFunc = (key: TranslationKey, opts?: any) => string;

function OverviewTab({ data, t }: { data: AnalysisData; t: TFunc }) {
  const a = data.analysis;
  const e = a?.rcsbMetadata?.entry;
  const oligomer = ["monomer", "dimer", "trimer", "tetramer", "pentamer", "hexamer"][
    Math.min(data.chainCount - 1, 5)
  ] || `${data.chainCount}-mer`;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold mb-1">{data.title || data.pdbId}</h3>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary" className="font-mono">PDB:{data.pdbId}</Badge>
          {e?.methods?.map((m: string, i: number) => (
            <Badge key={i} variant="outline" className="text-[10px]">{m}</Badge>
          ))}
          {e?.resolution != null && (
            <Badge variant="outline" className="text-[10px]">
              {e.resolution} Å
            </Badge>
          )}
          {e?.pubmedId && (
            <a
              href={`https://pubmed.ncbi.nlm.nih.gov/${e.pubmedId}/`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex"
            >
              <Badge variant="outline" className="text-[10px] hover:bg-primary/10 cursor-pointer">
                PMID:{e.pubmedId} <ExternalLink className="h-2.5 w-2.5 ml-1" />
              </Badge>
            </a>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatCard label={t("structure.chains")} value={data.chainCount} sub={oligomer} color="amber" />
        <StatCard label={t("structure.residues")} value={data.residueCount} color="emerald" />
        <StatCard label={t("structure.atoms")} value={data.atomCount} color="sky" />
        <StatCard
          label={t("structure.ligands")}
          value={data.ligandCount}
          sub={data.ligandCount > 0 ? "cofactors/ligands" : "none"}
          color="violet"
        />
      </div>

      {a?.ramachandranSummary?.total > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <StatCard
            label={t("structure.ramaFavoured")}
            value={`${a.ramachandranSummary.favouredPct}%`}
            sub={`${a.ramachandranSummary.core + a.ramachandranSummary.allowed}/${a.ramachandranSummary.total} residues`}
            color="emerald"
          />
          <StatCard
            label={t("structure.ramaOutliers")}
            value={`${a.ramachandranSummary.outlierPct}%`}
            sub={`${a.ramachandranSummary.disallowed} residues`}
            color={a.ramachandranSummary.outlierPct > 5 ? "rose" : "emerald"}
          />
          <StatCard
            label={t("structure.hbonds")}
            value={a.hbonds?.length ?? 0}
            color="sky"
          />
          <StatCard
            label={t("structure.clashes")}
            value={a.clashes?.length ?? 0}
            color={a.clashes?.length > 10 ? "rose" : "emerald"}
          />
        </div>
      )}

      {a?.bfactor && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <StatCard
            label={t("structure.bfactorMean")}
            value={a.bfactor.mean.toFixed(1)}
            sub={`σ=${a.bfactor.stdDev.toFixed(1)}`}
            color="amber"
          />
          <StatCard
            label={t("structure.bfactorRange")}
            value={`${a.bfactor.min.toFixed(0)}–${a.bfactor.max.toFixed(0)}`}
            color="amber"
          />
          {a.sasaSummary?.total > 0 && (
            <>
              <StatCard
                label={t("structure.sasaExposed")}
                value={`${a.sasaSummary.exposedPct}%`}
                color="sky"
              />
              <StatCard
                label={t("structure.sasaBuried")}
                value={`${a.sasaSummary.buriedPct}%`}
                color="violet"
              />
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatCard
          label={t("structure.netCharge")}
          value={a?.chargeAtPH7?.totalCharge?.toFixed(1) ?? "—"}
          sub={`${a?.charge?.positiveCount ?? 0}+ / ${a?.charge?.negativeCount ?? 0}−`}
          color={a?.chargeAtPH7?.totalCharge >= 0 ? "sky" : "rose"}
        />
        <StatCard
          label={t("structure.pI")}
          value={a?.isoelectricPoint?.toFixed(2) ?? "—"}
          color="violet"
        />
        {a?.cavities?.length > 0 && (
          <StatCard
            label={t("structure.cavities")}
            value={a.cavities.length}
            sub={`${a.cavities.filter((c: any) => c.isPocket).length} pockets`}
            color="amber"
          />
        )}
        {e?.disulfideBondCount != null && e.disulfideBondCount > 0 && (
          <StatCard
            label="Disulfide bonds"
            value={e.disulfideBondCount}
            color="emerald"
          />
        )}
      </div>

      {e && (
        <Section title="Experimental Metadata" icon={Activity}>
          <div className="rounded-lg border p-3 text-xs space-y-1 bg-card">
            {e.methods?.length > 0 && (
              <div>
                <span className="text-muted-foreground">{t("structure.method")}:</span>{" "}
                <span className="font-medium">{e.methods.join(", ")}</span>
              </div>
            )}
            {e.resolution != null && (
              <div>
                <span className="text-muted-foreground">{t("structure.resolution")}:</span>{" "}
                <span className="font-medium">{e.resolution} Å</span>
              </div>
            )}
            {e.molecularWeight != null && (
              <div>
                <span className="text-muted-foreground">Molecular weight:</span>{" "}
                <span className="font-medium">{Math.round(e.molecularWeight)} Da</span>
              </div>
            )}
            {e.depositDate && (
              <div>
                <span className="text-muted-foreground">Deposited:</span>{" "}
                <span className="font-medium">{e.depositDate.slice(0, 10)}</span>
              </div>
            )}
            {e.releaseDate && (
              <div>
                <span className="text-muted-foreground">Released:</span>{" "}
                <span className="font-medium">{e.releaseDate.slice(0, 10)}</span>
              </div>
            )}
            {e.doi && (
              <div>
                <span className="text-muted-foreground">DOI:</span>{" "}
                <span className="font-medium font-mono text-[10px]">{e.doi}</span>
              </div>
            )}
          </div>
        </Section>
      )}

      {a?.rcsbMetadata?.polymers?.length > 0 && (
        <Section title="Polymer Entities" icon={Dna}>
          <div className="space-y-1.5">
            {a.rcsbMetadata.polymers.slice(0, 6).map((p: any, i: number) => (
              <div
                key={i}
                className="rounded-md border p-2 text-xs flex items-start gap-2 bg-card"
              >
                <Badge variant="outline" className="text-[9px] font-mono">
                  E{p.entityId}
                </Badge>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">
                    {p.description || "unnamed"}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {p.sequenceLength} aa · auth chain(s){" "}
                    {p.authChains.join(",") || p.chains.join(",")}
                    {p.organism ? ` · ${p.organism}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function CompositionTab({ a, t }: { a: any; t: TFunc }) {
  if (!a) return null;
  const c = a.composition;
  return (
    <div className="space-y-4">
      <Section title={t("structure.composition")} icon={Boxes}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
          <StatCard label={t("structure.chains")} value={c.chains.length} sub={c.chains.join(", ")} color="amber" />
          <StatCard label={t("structure.residues")} value={c.numResidues} color="emerald" />
          <StatCard label={t("structure.atoms")} value={c.numAtoms} color="sky" />
          <StatCard label={t("structure.waters")} value={c.numWaters} color="violet" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              {t("structure.helixCount")} / {t("structure.sheetCount")} (records)
            </div>
            <div className="flex gap-3">
              <div>
                <span className="text-2xl font-bold text-rose-600 dark:text-rose-400">{c.helixCount}</span>
                <span className="text-[10px] text-muted-foreground ml-1">helices</span>
              </div>
              <div>
                <span className="text-2xl font-bold text-amber-600 dark:text-amber-400">{c.sheetCount}</span>
                <span className="text-[10px] text-muted-foreground ml-1">sheets</span>
              </div>
            </div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              Top residue types
            </div>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {c.residueCounts.slice(0, 10).map((r: any, i: number) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono font-semibold w-10">{r.resName}</span>
                  <div className="flex-1 h-2 bg-muted rounded overflow-hidden">
                    <div
                      className="h-full bg-emerald-500"
                      style={{
                        width: `${(r.count / c.residueCounts[0].count) * 100}%`,
                      }}
                    />
                  </div>
                  <span className="text-muted-foreground w-8 text-right">{r.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {a.sequences?.length > 0 && (
        <Section title={t("structure.sequences")} icon={Dna}>
          <div className="space-y-2">
            {a.sequences.slice(0, 8).map((seq: any, i: number) => (
              <div key={i} className="rounded-md border p-2 bg-card">
                <div className="text-[10px] text-muted-foreground mb-1">
                  Chain <span className="font-mono font-semibold">{seq.chain}</span> ·{" "}
                  {seq.length} aa
                </div>
                <div className="font-mono text-[10px] leading-relaxed break-all text-foreground/80">
                  {seq.sequence.length > 120
                    ? seq.sequence.slice(0, 120) + "…"
                    : seq.sequence}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function SecondaryStructureTab({ a, t }: { a: any; t: TFunc }) {
  if (!a) return null;
  const ss = a.secondaryStructure || [];
  const helices = ss.filter((s: any) => s.type === "helix");
  const sheets = ss.filter((s: any) => s.type === "sheet");
  return (
    <div className="space-y-4">
      <Section title={t("structure.secondaryStructure")} icon={GitBranch}>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <StatCard label={t("structure.helixCount")} value={helices.length} color="rose" />
          <StatCard label={t("structure.sheetCount")} value={sheets.length} color="amber" />
        </div>
        {helices.length > 0 && (
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
              Helices
            </div>
            <div className="flex flex-wrap gap-1">
              {helices.slice(0, 30).map((h: any, i: number) => (
                <Badge
                  key={i}
                  variant="outline"
                  className="text-[9px] font-mono bg-rose-50/50 dark:bg-rose-950/20"
                >
                  {h.chain}:{h.startResSeq}-{h.endResSeq}
                </Badge>
              ))}
              {helices.length > 30 && (
                <span className="text-[9px] text-muted-foreground">
                  +{helices.length - 30} more
                </span>
              )}
            </div>
          </div>
        )}
        {sheets.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
              Sheets
            </div>
            <div className="flex flex-wrap gap-1">
              {sheets.slice(0, 30).map((s: any, i: number) => (
                <Badge
                  key={i}
                  variant="outline"
                  className="text-[9px] font-mono bg-amber-50/50 dark:bg-amber-950/20"
                >
                  {s.chain}:{s.startResSeq}-{s.endResSeq}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {ss.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No HELIX/SHEET records in this PDB file (common for NMR or EM
            structures, or CIF format).
          </p>
        )}
      </Section>
    </div>
  );
}

function LigandsTab({ a, t }: { a: any; t: TFunc }) {
  if (!a) return null;
  const ligands = a.ligands || [];
  return (
    <div className="space-y-4">
      <Section title={t("structure.ligands")} icon={Layers3}>
        {ligands.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No HETATM ligand records detected (excluding waters).
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {ligands.map((l: any, i: number) => (
              <div
                key={i}
                className="rounded-md border p-2.5 bg-card flex items-start gap-2"
              >
                <Badge
                  variant="secondary"
                  className="font-mono text-[10px] bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200"
                >
                  {l.resName}
                </Badge>
                <div className="flex-1 text-[11px]">
                  <div>
                    <span className="text-muted-foreground">{t("structure.chain")}:</span>{" "}
                    <span className="font-mono font-semibold">{l.chain}</span>
                    <span className="mx-1.5 text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{t("structure.resSeq")}:</span>{" "}
                    <span className="font-mono font-semibold">{l.resSeq}</span>
                  </div>
                  <div className="text-muted-foreground">
                    {l.numAtoms} atoms · centroid (
                    {l.centerX.toFixed(1)}, {l.centerY.toFixed(1)},{" "}
                    {l.centerZ.toFixed(1)})
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function QualityTab({ a, t }: { a: any; t: TFunc }) {
  if (!a) return null;
  const rs = a.ramachandranSummary;
  const clashes = a.clashes || [];
  const severeClashes = clashes.filter((c: any) => c.severity === "severe");
  const moderateClashes = clashes.filter((c: any) => c.severity === "moderate");
  const qualityGrade =
    rs.outlierPct < 2 && severeClashes.length < 5
      ? "good"
      : rs.outlierPct < 5 && severeClashes.length < 20
        ? "fair"
        : "poor";
  const gradeColor = {
    good: "emerald",
    fair: "amber",
    poor: "rose",
  }[qualityGrade];
  return (
    <div className="space-y-4">
      <Section title={t("structure.quality")} icon={ShieldCheck}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
          <StatCard
            label="Overall quality"
            value={qualityGrade.toUpperCase()}
            color={gradeColor as any}
          />
          <StatCard
            label={t("structure.ramaFavoured")}
            value={`${rs.favouredPct}%`}
            sub={`${rs.core + rs.allowed}/${rs.total}`}
            color="emerald"
          />
          <StatCard
            label={t("structure.ramaOutliers")}
            value={`${rs.outlierPct}%`}
            sub={`${rs.disallowed} residues`}
            color={rs.outlierPct > 5 ? "rose" : "emerald"}
          />
          <StatCard
            label={t("structure.clashes")}
            value={clashes.length}
            sub={`${severeClashes.length} severe · ${moderateClashes.length} mod`}
            color={severeClashes.length > 10 ? "rose" : "emerald"}
          />
        </div>

        {/* Ramachandran region breakdown */}
        <div className="rounded-lg border p-3 mb-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
            Ramachandran region breakdown
          </div>
          <div className="space-y-1.5">
            {[
              { label: "Core (favoured)", count: rs.core, color: "bg-emerald-500" },
              { label: "Allowed", count: rs.allowed, color: "bg-sky-500" },
              { label: "Generous", count: rs.generous, color: "bg-amber-500" },
              { label: "Disallowed (outliers)", count: rs.disallowed, color: "bg-rose-500" },
            ].map((r, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className="w-44">{r.label}</span>
                <div className="flex-1 h-2 bg-muted rounded overflow-hidden">
                  <div
                    className={`h-full ${r.color}`}
                    style={{
                      width: `${rs.total > 0 ? (r.count / rs.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                <span className="w-20 text-right text-muted-foreground">
                  {r.count} ({rs.total > 0 ? ((r.count / rs.total) * 100).toFixed(1) : 0}%)
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Ramachandran scatter plot (canvas) */}
        {a.ramachandran?.length > 0 && (
          <div className="rounded-lg border p-3 mb-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
              {t("structure.ramaPlot")}
            </div>
            <p className="text-[10px] text-muted-foreground mb-2">
              {t("structure.ramaPlotDesc")}
            </p>
            <RamachandranPlot points={a.ramachandran} />
          </div>
        )}

        {/* Outlier residues */}
        {a.ramachandran?.filter((r: any) => r.region === "disallowed").length > 0 && (
          <div className="rounded-lg border p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              Ramachandran outlier residues
            </div>
            <div className="flex flex-wrap gap-1">
              {a.ramachandran
                .filter((r: any) => r.region === "disallowed")
                .slice(0, 40)
                .map((r: any, i: number) => (
                  <Badge
                    key={i}
                    variant="outline"
                    className="text-[9px] font-mono bg-rose-50/50 dark:bg-rose-950/20"
                    title={`φ=${r.phi?.toFixed(1)}° ψ=${r.psi?.toFixed(1)}°`}
                  >
                    {r.resName}
                    {r.resSeq}({r.chain})
                  </Badge>
                ))}
            </div>
          </div>
        )}

        {/* Severe clashes */}
        {severeClashes.length > 0 && (
          <div className="rounded-lg border p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              Severe steric clashes ({severeClashes.length})
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {severeClashes.slice(0, 30).map((cl: any, i: number) => (
                <div key={i} className="text-[10px] font-mono flex items-center gap-2">
                  <Badge variant="outline" className="text-[9px] bg-rose-50 dark:bg-rose-950/30">
                    {cl.severity}
                  </Badge>
                  <span>
                    {cl.atom1.resName}
                    {cl.atom1.resSeq}({cl.atom1.chain}).{cl.atom1.atomName} ↔{" "}
                    {cl.atom2.resName}
                    {cl.atom2.resSeq}({cl.atom2.chain}).{cl.atom2.atomName}
                  </span>
                  <span className="text-muted-foreground ml-auto">
                    d={cl.distance.toFixed(2)}Å (overlap {cl.overlap.toFixed(2)}Å)
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function BFactorTab({ a, t }: { a: any; t: TFunc }) {
  if (!a?.bfactor)
    return (
      <p className="text-xs text-muted-foreground py-8 text-center">
        No B-factor data (common for CIF format or theoretical models without
        temperature factors).
      </p>
    );
  const b = a.bfactor;
  const highFlex = b.perResidue
    .filter((p: any) => p.isOutlier && p.bfactor > b.mean + b.stdDev)
    .sort((x: any, y: any) => y.bfactor - x.bfactor)
    .slice(0, 20);
  // Refined AlphaFold pLDDT detection (avoids false positives on ultra-high-
  // resolution crystal structures). Requires integer-like values + high mean +
  // either MODEL/predicted method or a title hint.
  const e = a?.rcsbMetadata?.entry;
  const isAfMethod = e?.methods?.some((m: string) => /MODEL|PREDICT/i.test(m)) ?? false;
  const titleHintsAf = /alphafold|predicted|colabfold/i.test(a?.title || e?.title || "");
  const sampleBf = b.perResidue.slice(0, 200);
  const integerLike = sampleBf.filter(
    (p: any) => Math.abs(p.bfactor - Math.round(p.bfactor)) < 0.05
  ).length;
  const integerRatio = sampleBf.length ? integerLike / sampleBf.length : 0;
  const isPlddt =
    b.max <= 100 &&
    b.min >= 0 &&
    b.mean >= 25 &&
    integerRatio >= 0.8 &&
    (isAfMethod || titleHintsAf || b.mean >= 40);
  return (
    <div className="space-y-4">
      <Section title={t("structure.bfactor")} icon={Thermometer}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
          <StatCard label={t("structure.bfactorMean")} value={b.mean.toFixed(1)} color="amber" />
          <StatCard label="Std dev" value={b.stdDev.toFixed(1)} color="amber" />
          <StatCard label="Min" value={b.min.toFixed(1)} color="sky" />
          <StatCard label="Max" value={b.max.toFixed(1)} color="rose" />
        </div>

        {isPlddt && (
          <div className="rounded-md border border-sky-200 dark:border-sky-900 bg-sky-50/50 dark:bg-sky-950/20 p-2 text-[11px] text-sky-700 dark:text-sky-300 mb-3">
            ℹ B-factor values (range {b.min.toFixed(1)}–{b.max.toFixed(1)}, mean {b.mean.toFixed(1)}, {Math.round(integerRatio * 100)}% integer-valued) are consistent with AlphaFold pLDDT confidence scores
            (≥90 very high, 70–90 confident, 50–70 low, &lt;50 very low).
          </div>
        )}

        {/* B-factor per-residue profile */}
        {b.perResidue?.length > 0 && (
          <div className="rounded-lg border p-3 mb-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
              {t("structure.bfactorProfile")}
            </div>
            <p className="text-[10px] text-muted-foreground mb-2">
              {t("structure.bfactorProfileDesc")}
            </p>
            <BFactorProfileChart
              perResidue={b.perResidue}
              mean={b.mean}
              stdDev={b.stdDev}
              t={t}
            />
          </div>
        )}

        {/* Histogram */}
        <div className="rounded-lg border p-3 mb-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
            B-factor distribution histogram
          </div>
          <div className="flex items-end gap-0.5 h-24">
            {b.histogram.map((h: any, i: number) => {
              const maxCount = Math.max(...b.histogram.map((x: any) => x.count), 1);
              const heightPct = (h.count / maxCount) * 100;
              // Color gradient: blue (low) → white → red (high)
              const binMid = (b.min + b.max) / 2;
              const binCenter = b.min + (i + 0.5) * ((b.max - b.min) / 10 || 1);
              const t = (binCenter - b.min) / (b.max - b.min || 1);
              const color =
                t < 0.5
                  ? `rgb(${Math.round(59 + t * 2 * 196)}, ${Math.round(130 + t * 2 * 125)}, ${Math.round(246 - t * 2 * 246)})`
                  : `rgb(${Math.round(255)}, ${Math.round(125 - (t - 0.5) * 2 * 125)}, ${Math.round(125 - (t - 0.5) * 2 * 125)})`;
              return (
                <div
                  key={i}
                  className="flex-1 flex flex-col items-center justify-end group relative"
                  title={`${h.binLabel}: ${h.count} residues`}
                >
                  <div
                    className="w-full rounded-t"
                    style={{ height: `${heightPct}%`, backgroundColor: color, minHeight: "2px" }}
                  />
                  <div className="text-[8px] text-muted-foreground mt-0.5 rotate-45 origin-left whitespace-nowrap">
                    {h.binLabel.split("-")[0]}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {highFlex.length > 0 && (
          <div className="rounded-lg border p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              High-flexibility residues (B &gt; mean + 2σ)
            </div>
            <div className="flex flex-wrap gap-1">
              {highFlex.map((r: any, i: number) => (
                <Badge
                  key={i}
                  variant="outline"
                  className="text-[9px] font-mono bg-rose-50/50 dark:bg-rose-950/20"
                  title={`z=${r.zScore.toFixed(2)}`}
                >
                  {r.resName}
                  {r.resSeq}({r.chain}) B={r.bfactor.toFixed(0)}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function SasaTab({ a, t }: { a: any; t: TFunc }) {
  if (!a?.sasaSummary?.total)
    return (
      <p className="text-xs text-muted-foreground py-8 text-center">
        No SASA data (structure may be too large or have no protein atoms).
      </p>
    );
  const s = a.sasaSummary;
  const mostExposed = [...(a.sasa || [])]
    .sort((x: any, y: any) => y.sasa - x.sasa)
    .slice(0, 20);
  return (
    <div className="space-y-4">
      <Section title={t("structure.sasa")} icon={Droplets}>
        <div className="grid grid-cols-3 gap-2 mb-3">
          <StatCard label={t("structure.sasaExposed")} value={`${s.exposedPct}%`} sub={`${s.exposed} residues`} color="sky" />
          <StatCard label="Intermediate" value={`${Math.round((s.intermediate / s.total) * 1000) / 10}%`} sub={`${s.intermediate} residues`} color="amber" />
          <StatCard label={t("structure.sasaBuried")} value={`${s.buriedPct}%`} sub={`${s.buried} residues`} color="violet" />
        </div>
        <div className="rounded-lg border p-3 mb-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
            Mean per-residue SASA
          </div>
          <div className="text-xl font-bold">{s.meanSasa} Å²</div>
          <div className="text-[10px] text-muted-foreground">
            Total residues analyzed: {s.total}
          </div>
        </div>
        {/* SASA per-chain bar chart */}
        {a.sasa?.length > 0 && (
          <div className="rounded-lg border p-3 mb-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
              {t("structure.sasaPerChain")}
            </div>
            <p className="text-[10px] text-muted-foreground mb-2">
              {t("structure.sasaPerChainDesc")}
            </p>
            <SasaPerChainChart sasaData={a.sasa} t={t} />
          </div>
        )}
        {mostExposed.length > 0 && (
          <div className="rounded-lg border p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              Most exposed residues (potential surface / active-site candidates)
            </div>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {mostExposed.map((r: any, i: number) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono font-semibold w-24">
                    {r.resName}
                    {r.resSeq}({r.chain})
                  </span>
                  <div className="flex-1 h-2 bg-muted rounded overflow-hidden">
                    <div
                      className="h-full bg-sky-500"
                      style={{
                        width: `${Math.min(100, (r.sasa / mostExposed[0].sasa) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="w-16 text-right text-muted-foreground">
                    {r.sasa.toFixed(1)} Å²
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function InteractionsTab({ a, t }: { a: any; t: TFunc }) {
  if (!a) return null;
  return (
    <div className="space-y-4">
      <Section title={t("structure.interactions")} icon={Network}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
          <StatCard label={t("structure.hbonds")} value={a.hbonds?.length ?? 0} sub="≤ 3.5 Å, geometric" color="sky" />
          <StatCard label="Cα-Cα contacts" value={a.contactMapSize ?? 0} sub="≤ 8 Å" color="emerald" />
          <StatCard label={t("structure.clashes")} value={a.clashes?.length ?? 0} color={a.clashes?.length > 10 ? "rose" : "emerald"} />
        </div>

        {/* Contact map heatmap */}
        {a.parsed?.ca?.length > 0 && (
          <div className="rounded-lg border p-3 mb-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
              {t("structure.contactMap")}
            </div>
            <p className="text-[10px] text-muted-foreground mb-2">
              {t("structure.contactMapDesc")}
            </p>
            <ContactMapHeatmap caAtoms={a.parsed.ca} t={t} />
          </div>
        )}

        {a.hbonds?.length > 0 && (
          <div className="rounded-lg border p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              Hydrogen bonds (first 30, shortest first)
            </div>
            <div className="space-y-0.5 max-h-64 overflow-y-auto font-mono text-[10px]">
              {[...a.hbonds]
                .sort((x: any, y: any) => x.distance - y.distance)
                .slice(0, 30)
                .map((h: any, i: number) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-sky-600 dark:text-sky-400">
                      {h.donorResName}
                      {h.donorResSeq}({h.donorChain}).{h.donorAtom}
                    </span>
                    <span className="text-muted-foreground">→</span>
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {h.acceptorResName}
                      {h.acceptorResSeq}({h.acceptorChain}).{h.acceptorAtom}
                    </span>
                    <span className="ml-auto text-muted-foreground">
                      {h.distance.toFixed(2)}Å
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function ChargeTab({ a, t }: { a: any; t: TFunc }) {
  if (!a) return null;
  const charge = a.charge;
  const netCharge = a.chargeAtPH7?.totalCharge ?? 0;
  const pI = a.isoelectricPoint;
  return (
    <div className="space-y-4">
      <Section title={t("structure.electrostatics")} icon={Zap}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
          <StatCard
            label={t("structure.netCharge")}
            value={netCharge.toFixed(1)}
            sub={netCharge >= 0 ? t("structure.positive") : t("structure.negative")}
            color={netCharge >= 0 ? "sky" : "rose"}
          />
          <StatCard label={t("structure.pI")} value={pI?.toFixed(2) ?? "—"} color="violet" />
          <StatCard label="Positive residues" value={charge?.positiveCount ?? 0} sub="ARG/LYS/HIS" color="sky" />
          <StatCard label="Negative residues" value={charge?.negativeCount ?? 0} sub="ASP/GLU" color="rose" />
        </div>
        <div className="rounded-lg border p-3 text-[11px] space-y-1.5 bg-card">
          <div className="font-semibold mb-1">Interpretation guide</div>
          <div>
            • Net charge{" "}
            <span className={netCharge >= 0 ? "text-sky-600 dark:text-sky-400 font-semibold" : "text-rose-600 dark:text-rose-400 font-semibold"}>
              {netCharge >= 0 ? "+" : ""}
              {netCharge.toFixed(1)}
            </span>{" "}
            at pH 7 — {netCharge > 5
              ? "strongly basic (consistent with DNA/RNA binding)"
              : netCharge < -5
                ? "strongly acidic (consistent with protein-protein interfaces)"
                : "near-neutral (stable soluble protein)"}
            .
          </div>
          <div>
            • pI ={" "}
            <span className="font-semibold text-violet-600 dark:text-violet-400">{pI?.toFixed(2)}</span>{" "}
            — protein is{" "}
            {pI > 7 ? "basic (positively charged below pI)" : "acidic (negatively charged above pI)"}.
          </div>
          <div>
            • {charge?.positiveCount ?? 0} positive vs {charge?.negativeCount ?? 0} negative
            residues → charge ratio{" "}
            {charge?.negativeCount > 0
              ? ((charge?.positiveCount ?? 0) / charge.negativeCount).toFixed(2)
              : "∞"}
            .
          </div>
        </div>
      </Section>
    </div>
  );
}

function CavitiesTab({ a, t }: { a: any; t: TFunc }) {
  if (!a?.cavities?.length)
    return (
      <p className="text-xs text-muted-foreground py-8 text-center">
        No cavities/pockets detected (structure may be too large for grid-based
        detection, or genuinely has none).
      </p>
    );
  const pockets = a.cavities.filter((c: any) => c.isPocket);
  const buried = a.cavities.filter((c: any) => !c.isPocket);
  return (
    <div className="space-y-4">
      <Section title={t("structure.cavities")} icon={CircleDot}>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <StatCard label="Surface pockets" value={pockets.length} color="amber" />
          <StatCard label="Buried cavities" value={buried.length} color="violet" />
        </div>
        {pockets.length > 0 && (
          <div className="rounded-lg border p-3 mb-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              Surface pockets (sorted by volume)
            </div>
            <div className="space-y-1">
              {[...pockets]
                .sort((a: any, b: any) => b.volume - a.volume)
                .slice(0, 10)
                .map((p: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    <Badge variant="outline" className="text-[9px] font-mono">
                      #{p.id}
                    </Badge>
                    <span>
                      {t("structure.volume")}:{" "}
                      <span className="font-semibold">{p.volume.toFixed(0)} Å³</span>
                    </span>
                    <span className="text-muted-foreground">
                      ({p.numGridPoints} grid pts)
                    </span>
                    <span className="text-muted-foreground ml-auto">
                      centroid ({p.centerX.toFixed(0)}, {p.centerY.toFixed(0)},{" "}
                      {p.centerZ.toFixed(0)})
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
        {buried.length > 0 && (
          <div className="rounded-lg border p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              Buried cavities (fully enclosed)
            </div>
            <div className="space-y-1">
              {buried.slice(0, 10).map((c: any, i: number) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <Badge variant="outline" className="text-[9px] font-mono">
                    #{c.id}
                  </Badge>
                  <span>
                    {t("structure.volume")}:{" "}
                    <span className="font-semibold">{c.volume.toFixed(0)} Å³</span>
                  </span>
                  <span className="text-muted-foreground">
                    ({c.numGridPoints} grid pts)
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function AssembliesTab({ a, t }: { a: any; t: TFunc }) {
  const assemblies = a?.rcsbMetadata?.assemblies || [];
  const interfaces = a?.rcsbMetadata?.interfaces || [];
  if (!assemblies.length)
    return (
      <p className="text-xs text-muted-foreground py-8 text-center">
        No assembly data available from RCSB.
      </p>
    );
  return (
    <div className="space-y-4">
      <Section title={t("structure.assemblies")} icon={Layers3}>
        {assemblies.map((asm: any, i: number) => (
          <div key={i} className="rounded-lg border p-3 mb-2 bg-card">
            <div className="flex items-center gap-2 mb-1.5">
              <Badge variant="secondary" className="text-[10px]">
                Assembly {asm.assemblyId}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {asm.numInterfaces} interface(s)
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              {asm.totalBuriedSurfaceArea !== null && (
                <div>
                  <span className="text-muted-foreground">Total BSA:</span>{" "}
                  <span className="font-semibold">
                    {asm.totalBuriedSurfaceArea.toFixed(0)} Å²
                  </span>
                </div>
              )}
              {asm.totalInterfaceResidues !== null && (
                <div>
                  <span className="text-muted-foreground">Interface residues:</span>{" "}
                  <span className="font-semibold">{asm.totalInterfaceResidues}</span>
                </div>
              )}
            </div>
          </div>
        ))}

        {interfaces.length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              {t("structure.interface")} details (Assembly 1)
            </div>
            <div className="space-y-2">
              {interfaces.slice(0, 6).map((it: any, i: number) => (
                <div key={i} className="rounded-md border p-2.5 bg-card">
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <Badge variant="outline" className="text-[9px] font-mono">
                      IF {it.interfaceId}
                    </Badge>
                    {it.interfaceArea !== null && (
                      <span className="text-[11px]">
                        <span className="text-muted-foreground">{t("structure.area")}:</span>{" "}
                        <span className="font-semibold">{it.interfaceArea.toFixed(0)} Å²</span>
                      </span>
                    )}
                    {it.interfaceCharacter && (
                      <Badge variant="outline" className="text-[9px]">
                        {it.interfaceCharacter}
                      </Badge>
                    )}
                    {it.polymerComposition && (
                      <span className="text-[10px] text-muted-foreground">
                        {it.polymerComposition}
                      </span>
                    )}
                  </div>
                  {[it.partner1, it.partner2].filter(Boolean).map((p: any, j: number) => {
                    const top = p.residueSeqIds
                      ?.map((seq: number, k: number) => ({
                        seq,
                        name: p.residueNames?.[k] || "?",
                        bsa: p.bsaValues?.[k] ?? 0,
                      }))
                      .sort((x: any, y: any) => y.bsa - x.bsa)
                      .slice(0, 6);
                    return (
                      <div key={j} className="text-[10px] ml-2">
                        <span className="text-muted-foreground">
                          {t("structure.partner")} {j + 1} (chain {p.authChainId || p.chainId}):
                        </span>{" "}
                        {top?.length
                          ? top.map((r: any) => `${r.name}${r.seq}(${r.bsa.toFixed(0)}Å²)`).join(", ")
                          : "—"}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function ContextTab({
  markdown,
  copied,
  onCopy,
  t,
}: {
  markdown: string;
  copied: boolean;
  onCopy: () => void;
  t: TFunc;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-muted-foreground">
          This Markdown block is auto-injected into paragraph & full-article
          writing prompts so the LLM discusses real structural features.
        </div>
        <Button size="sm" variant="outline" onClick={onCopy} className="h-7">
          {copied ? (
            <Check className="h-3.5 w-3.5 mr-1.5 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <Copy className="h-3.5 w-3.5 mr-1.5" />
          )}
          {t("structure.copyContext")}
        </Button>
      </div>
      <pre className="rounded-lg border bg-muted/30 p-3 text-[10px] leading-relaxed font-mono whitespace-pre-wrap max-h-[60vh] overflow-y-auto">
        {markdown}
      </pre>
    </div>
  );
}

/* ---------------- Ramachandran Plot (canvas) ---------------- */

function RamachandranPlot({ points }: { points: any[] }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = React.useState<{
    x: number;
    y: number;
    label: string;
  } | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const margin = 30;
    const plotW = W - 2 * margin;
    const plotH = H - 2 * margin;

    // Clear
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = "#fafafa";
    ctx.fillRect(margin, margin, plotW, plotH);

    const xScale = (phi: number) => margin + ((phi + 180) / 360) * plotW;
    const yScale = (psi: number) => margin + ((180 - psi) / 360) * plotH;

    // Draw favoured region ellipses (α-helix basin ~ -57,-47; β-sheet ~ -119,113)
    ctx.save();
    // α-helix favoured
    ctx.fillStyle = "rgba(16, 185, 129, 0.18)";
    ctx.beginPath();
    ctx.ellipse(
      xScale(-57),
      yScale(-47),
      plotW * 0.08,
      plotH * 0.09,
      0,
      0,
      2 * Math.PI
    );
    ctx.fill();
    // β-sheet favoured
    ctx.beginPath();
    ctx.ellipse(
      xScale(-119),
      yScale(113),
      plotW * 0.1,
      plotH * 0.1,
      0,
      0,
      2 * Math.PI
    );
    ctx.fill();
    // β-sheet favoured (positive phi)
    ctx.beginPath();
    ctx.ellipse(
      xScale(-139),
      yScale(135),
      plotW * 0.07,
      plotH * 0.07,
      0,
      0,
      2 * Math.PI
    );
    ctx.fill();
    // Left-handed helix
    ctx.beginPath();
    ctx.ellipse(
      xScale(57),
      yScale(47),
      plotW * 0.05,
      plotH * 0.05,
      0,
      0,
      2 * Math.PI
    );
    ctx.fill();
    ctx.restore();

    // Axes
    ctx.strokeStyle = "#d4d4d8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    // x-axis (φ)
    ctx.moveTo(margin, margin + plotH / 2);
    ctx.lineTo(margin + plotW, margin + plotH / 2);
    // y-axis (ψ)
    ctx.moveTo(margin + plotW / 2, margin);
    ctx.lineTo(margin + plotW / 2, margin + plotH);
    ctx.stroke();

    // Grid lines every 60°
    ctx.strokeStyle = "#e4e4e7";
    ctx.lineWidth = 0.5;
    for (let v = -120; v <= 120; v += 60) {
      if (v === 0) continue;
      ctx.beginPath();
      ctx.moveTo(xScale(v), margin);
      ctx.lineTo(xScale(v), margin + plotH);
      ctx.moveTo(margin, yScale(v));
      ctx.lineTo(margin + plotW, yScale(v));
      ctx.stroke();
    }

    // Axis labels
    ctx.fillStyle = "#71717a";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText("φ (°)", margin + plotW / 2, H - 8);
    ctx.save();
    ctx.translate(10, margin + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("ψ (°)", 0, 0);
    ctx.restore();
    // Tick labels
    ctx.font = "8px ui-monospace, monospace";
    ctx.textAlign = "center";
    [-180, -90, 0, 90, 180].forEach((v) => {
      ctx.fillText(`${v}`, xScale(v), margin + plotH + 12);
      ctx.textAlign = "right";
      ctx.fillText(`${v}`, margin - 4, yScale(v) + 3);
      ctx.textAlign = "center";
    });

    // Plot points
    const regionColor: Record<string, string> = {
      core: "rgba(16, 185, 129, 0.7)",
      allowed: "rgba(14, 165, 233, 0.6)",
      generous: "rgba(245, 158, 11, 0.6)",
      disallowed: "rgba(244, 63, 94, 0.85)",
    };
    for (const p of points) {
      if (p.phi === null || p.psi === null) continue;
      ctx.fillStyle = regionColor[p.region] || "rgba(100,100,100,0.5)";
      ctx.beginPath();
      ctx.arc(xScale(p.phi), yScale(p.psi), p.region === "disallowed" ? 2.5 : 1.8, 0, 2 * Math.PI);
      ctx.fill();
    }

    // Border
    ctx.strokeStyle = "#d4d4d8";
    ctx.lineWidth = 1;
    ctx.strokeRect(margin, margin, plotW, plotH);
  }, [points]);

  // Mouse hover handler
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    const margin = 30;
    const plotW = canvas.width - 2 * margin;
    const plotH = canvas.height - 2 * margin;
    const xScale = (phi: number) => margin + ((phi + 180) / 360) * plotW;
    const yScale = (psi: number) => margin + ((180 - psi) / 360) * plotH;
    // Find nearest point within 6px
    let nearest: any = null;
    let minDist = 6;
    for (const p of points) {
      if (p.phi === null || p.psi === null) continue;
      const dx = xScale(p.phi) - mx;
      const dy = yScale(p.psi) - my;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minDist) {
        minDist = d;
        nearest = p;
      }
    }
    if (nearest) {
      setHover({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        label: `${nearest.resName}${nearest.resSeq}(${nearest.chain}) φ=${nearest.phi?.toFixed(1)}° ψ=${nearest.psi?.toFixed(1)}° [${nearest.region}]`,
      });
    } else {
      setHover(null);
    }
  };

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        width={420}
        height={360}
        className="w-full max-w-[420px] h-auto mx-auto block cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
      />
      {/* Legend */}
      <div className="flex flex-wrap justify-center gap-3 mt-2 text-[9px]">
        {[
          { label: "core", color: "bg-emerald-500" },
          { label: "allowed", color: "bg-sky-500" },
          { label: "generous", color: "bg-amber-500" },
          { label: "disallowed", color: "bg-rose-500" },
        ].map((r) => (
          <div key={r.label} className="flex items-center gap-1">
            <span className={`inline-block w-2 h-2 rounded-full ${r.color}`} />
            <span className="text-muted-foreground">{r.label}</span>
          </div>
        ))}
      </div>
      {hover && (
        <div
          className="absolute z-10 pointer-events-none px-2 py-1 rounded bg-black/90 text-white text-[10px] font-mono whitespace-nowrap"
          style={{ left: hover.x + 8, top: hover.y - 24 }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}

/* ---------------- Structure Comparison Tab ---------------- */

function CompareTab({
  currentPdbId,
  initialMobilePdbId,
  autoRun,
  t,
}: {
  currentPdbId: string;
  initialMobilePdbId?: string;
  autoRun?: boolean;
  t: TFunc;
}) {
  const [refId, setRefId] = React.useState(currentPdbId || "");
  const [mobId, setMobId] = React.useState(initialMobilePdbId || "");
  const [refChain, setRefChain] = React.useState("");
  const [mobChain, setMobChain] = React.useState("");
  const [method, setMethod] = React.useState<"sequence" | "residue-number">(
    "sequence"
  );
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<any>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  // Auto-run comparison when both PDB IDs are pre-filled (deep-link from matrix).
  React.useEffect(() => {
    if (autoRun && refId && mobId && !result && !loading) {
      void runComparison();
    }
  }, [autoRun, refId, mobId]);

  async function runComparison() {
    if (!refId.trim() || !mobId.trim()) {
      setError("Please enter both PDB IDs.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.compareStructures(refId.trim(), mobId.trim(), {
        refChain: refChain || undefined,
        mobChain: mobChain || undefined,
        method,
      });
      setResult(res.comparison);
      toast.success(
        t("toast.compareDone", {
          rmsd: res.comparison.rmsd?.toFixed(2) ?? "—",
          tm: res.comparison.tmScore?.toFixed(3) ?? "—",
        })
      );
    } catch (e: any) {
      setError(e?.message || "Comparison failed");
      toast.error(t("toast.compareFailed", { error: e?.message || "unknown" }));
    } finally {
      setLoading(false);
    }
  }

  function copyComparisonContext() {
    if (!result) return;
    // Reconstruct a compact markdown from the result
    const lines = [
      `### STRUCTURE COMPARISON — PDB:${result.referencePdbId} vs PDB:${result.mobilePdbId}`,
      `- Reference: PDB:${result.referencePdbId} (chain ${result.referenceChain}, ${result.referenceLength} Cα)`,
      `- Mobile: PDB:${result.mobilePdbId} (chain ${result.mobileChain}, ${result.mobileLength} Cα)`,
      `- Alignment method: ${result.alignmentMethod} | Cα atoms aligned: ${result.numAligned} | coverage: ${(result.coverage * 100).toFixed(1)}%`,
      `- **RMSD (Kabsch-aligned): ${result.rmsd?.toFixed(2) ?? "—"} Å** | raw RMSD: ${result.rawRmsd?.toFixed(2) ?? "—"} Å`,
      `- **TM-score: ${result.tmScore?.toFixed(3) ?? "—"}** (${result.foldAssessment})`,
      `- Sequence identity: ${(result.sequenceIdentity * 100).toFixed(1)}% | similarity: ${(result.sequenceSimilarity * 100).toFixed(1)}%`,
      `- Interpretation: ${result.interpretation}`,
    ];
    if (result.perResidueRmsd?.length > 0) {
      const topDiv = [...result.perResidueRmsd]
        .sort((a: any, b: any) => b.rmsd - a.rmsd)
        .slice(0, 10);
      lines.push(
        `- Most divergent residues: ${topDiv
          .map((r: any) => `${r.resName}${r.resSeq}(${r.chain},${r.rmsd.toFixed(1)}Å)`)
          .join(", ")}`
      );
    }
    navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    toast.success(t("structure.contextCopied"));
    setTimeout(() => setCopied(false), 2000);
  }

  const foldColor: Record<string, string> = {
    "same-fold": "emerald",
    "similar-fold": "amber",
    "different-fold": "rose",
    insufficient: "slate",
  };

  return (
    <div className="space-y-4">
      <Section title={t("structure.compareTitle")} icon={GitCompare}>
        <p className="text-[11px] text-muted-foreground mb-3">
          {t("structure.compareDesc")}
        </p>

        {/* Input row */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold block mb-1">
              {t("structure.referencePdb")}
            </label>
            <Input
              value={refId}
              onChange={(e) => setRefId(e.target.value.toUpperCase())}
              placeholder="e.g. 1A3N"
              className="h-8 text-sm font-mono"
            />
            <Input
              value={refChain}
              onChange={(e) => setRefChain(e.target.value.toUpperCase())}
              placeholder={`${t("structure.referenceChain")} (optional, default A)`}
              className="h-7 text-xs font-mono mt-1"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold block mb-1">
              {t("structure.mobilePdb")}
            </label>
            <Input
              value={mobId}
              onChange={(e) => setMobId(e.target.value.toUpperCase())}
              placeholder="e.g. 2HHB"
              className="h-8 text-sm font-mono"
            />
            <Input
              value={mobChain}
              onChange={(e) => setMobChain(e.target.value.toUpperCase())}
              placeholder={`${t("structure.mobileChain")} (optional, default A)`}
              className="h-7 text-xs font-mono mt-1"
            />
          </div>
        </div>

        {/* Method selector */}
        <div className="flex items-center gap-3 mb-3">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("structure.alignmentMethod")}:
          </label>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={method === "sequence" ? "default" : "outline"}
              className="h-7 text-[10px]"
              onClick={() => setMethod("sequence")}
            >
              {t("structure.sequence")}
            </Button>
            <Button
              size="sm"
              variant={method === "residue-number" ? "default" : "outline"}
              className="h-7 text-[10px]"
              onClick={() => setMethod("residue-number")}
            >
              {t("structure.residueNumber")}
            </Button>
          </div>
          <Button
            size="sm"
            onClick={runComparison}
            disabled={loading || !refId.trim() || !mobId.trim()}
            className="ml-auto h-8"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : (
              <GitCompare className="h-3.5 w-3.5 mr-1.5" />
            )}
            {t("structure.runComparison")}
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-rose-200 dark:border-rose-900 bg-rose-50/50 dark:bg-rose-950/20 p-2 text-[11px] text-rose-700 dark:text-rose-300 mb-3">
            ⚠ {error}
          </div>
        )}

        {result && (
          <div className="space-y-3">
            {/* Key metrics */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <StatCard
                label={t("structure.rmsd")}
                value={isNaN(result.rmsd) ? "—" : result.rmsd.toFixed(2)}
                sub={`raw: ${isNaN(result.rawRmsd) ? "—" : result.rawRmsd.toFixed(1)}`}
                color="amber"
              />
              <StatCard
                label={t("structure.tmScore")}
                value={result.tmScore.toFixed(3)}
                sub={result.foldAssessment}
                color={foldColor[result.foldAssessment] as any}
              />
              <StatCard
                label={t("structure.seqIdentity")}
                value={`${(result.sequenceIdentity * 100).toFixed(1)}%`}
                sub={`sim: ${(result.sequenceSimilarity * 100).toFixed(0)}%`}
                color="sky"
              />
              <StatCard
                label={t("structure.numAligned")}
                value={result.numAligned}
                sub={`coverage ${(result.coverage * 100).toFixed(0)}%`}
                color="violet"
              />
            </div>

            {/* Fold assessment badge */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                {t("structure.foldAssessment")}:
              </span>
              <Badge
                variant="secondary"
                className={`text-[10px] ${
                  result.foldAssessment === "same-fold"
                    ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                    : result.foldAssessment === "similar-fold"
                      ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                      : result.foldAssessment === "different-fold"
                        ? "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200"
                        : ""
                }`}
              >
                {result.foldAssessment === "same-fold"
                  ? t("structure.sameFold")
                  : result.foldAssessment === "similar-fold"
                    ? t("structure.similarFold")
                    : result.foldAssessment === "different-fold"
                      ? t("structure.differentFold")
                      : t("structure.insufficient")}
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                {result.referencePdbId} ({result.referenceChain}, {result.referenceLength} Cα) ↔ {result.mobilePdbId} ({result.mobileChain}, {result.mobileLength} Cα)
              </span>
            </div>

            {/* Interpretation */}
            <div className="rounded-lg border p-3 bg-card text-[11px] leading-relaxed">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold block mb-1">
                {t("structure.interpretation")}
              </span>
              {result.interpretation}
            </div>

            {/* Per-residue RMSD */}
            {result.perResidueRmsd?.length > 0 && (
              <div className="rounded-lg border p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
                  {t("structure.perResidueRmsd")}
                </div>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {[...result.perResidueRmsd]
                    .sort((a: any, b: any) => b.rmsd - a.rmsd)
                    .slice(0, 20)
                    .map((r: any, i: number) => {
                      const maxRmsd = Math.max(
                        ...result.perResidueRmsd.map((x: any) => x.rmsd),
                        0.1
                      );
                      return (
                        <div key={i} className="flex items-center gap-2 text-[11px]">
                          <span className="font-mono font-semibold w-24">
                            {r.resName}
                            {r.resSeq}({r.chain})
                          </span>
                          <div className="flex-1 h-2 bg-muted rounded overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-amber-400 to-rose-500"
                              style={{
                                width: `${Math.min(100, (r.rmsd / maxRmsd) * 100)}%`,
                              }}
                            />
                          </div>
                          <span className="w-12 text-right text-muted-foreground">
                            {r.rmsd.toFixed(2)}Å
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Formatted sequence alignment view */}
            {result.alignmentBlocks?.length > 0 && (
              <div className="rounded-lg border p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                  {t("structure.alignmentView")}
                </div>
                <p className="text-[10px] text-muted-foreground mb-2">
                  {t("structure.alignmentViewDesc")}
                </p>
                <div className="space-y-1 max-h-64 overflow-y-auto bg-muted/20 rounded p-2">
                  {result.alignmentBlocks.slice(0, 10).map((blk: any, i: number) => (
                    <div key={i} className="font-mono text-[10px] leading-relaxed">
                      <div className="flex items-start gap-1">
                        <span className="text-muted-foreground w-16 shrink-0 text-right">
                          {t("structure.refSeq")} {blk.refStart}
                        </span>
                        <span className="text-sky-700 dark:text-sky-300 tracking-wider">
                          {blk.refSeq}
                        </span>
                      </div>
                      <div className="flex items-start gap-1">
                        <span className="w-16 shrink-0" />
                        <span className="text-muted-foreground tracking-wider">
                          {blk.matchLine}
                        </span>
                      </div>
                      <div className="flex items-start gap-1">
                        <span className="text-muted-foreground w-16 shrink-0 text-right">
                          {t("structure.mobSeq")} {blk.mobStart}
                        </span>
                        <span className="text-emerald-700 dark:text-emerald-300 tracking-wider">
                          {blk.mobSeq}
                        </span>
                      </div>
                      {i < Math.min(result.alignmentBlocks.length, 10) - 1 && (
                        <div className="h-1.5" />
                      )}
                    </div>
                  ))}
                </div>
                {result.alignmentBlocks.length > 10 && (
                  <div className="text-[10px] text-muted-foreground mt-1.5 text-center">
                    Showing first 10 blocks ({result.alignmentBlocks.length} total).
                  </div>
                )}
                {/* Match legend */}
                <div className="flex items-center justify-center gap-3 mt-2 text-[9px]">
                  <span className="flex items-center gap-1">
                    <span className="font-mono text-muted-foreground">|</span>
                    <span className="text-muted-foreground">{t("structure.identity")}</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="font-mono text-muted-foreground">:</span>
                    <span className="text-muted-foreground">similar</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="font-mono text-muted-foreground">.</span>
                    <span className="text-muted-foreground">different</span>
                  </span>
                </div>
              </div>
            )}

            {/* Copy comparison context */}
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={copyComparisonContext}
                className="h-7"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 mr-1.5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                )}
                {t("structure.comparisonContext")}
              </Button>
            </div>
          </div>
        )}

        {!result && !error && !loading && (
          <div className="text-center py-8 text-[11px] text-muted-foreground">
            <GitCompare className="h-8 w-8 mx-auto mb-2 opacity-30" />
            {t("structure.enterTwoPdbIds")}
          </div>
        )}
      </Section>
    </div>
  );
}

/* ---------------- Contact Map Heatmap (canvas) ---------------- */

function ContactMapHeatmap({ caAtoms, t }: { caAtoms: any[]; t: TFunc }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = React.useState<{
    x: number;
    y: number;
    label: string;
  } | null>(null);

  // For performance, cap the matrix at 300×300 by downsampling.
  const MAX_SIZE = 300;
  const atoms = caAtoms.slice(0, MAX_SIZE);
  const n = atoms.length;
  const wasTruncated = caAtoms.length > MAX_SIZE;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || n < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const margin = 28;
    const plotSize = Math.min(W, H) - 2 * margin;

    // Clear
    ctx.clearRect(0, 0, W, H);

    // Compute distance matrix and find max distance for color scaling
    // We render directly to ImageData for performance.
    const cellSize = plotSize / n;
    const imgData = ctx.createImageData(plotSize, plotSize);
    const data = imgData.data;

    // Color scale: 0Å → deep blue, 8Å → cyan, 12Å → yellow, >20Å → white
    const colorForDist = (d: number): [number, number, number] => {
      if (d <= 8) {
        // Blue → cyan gradient for contacts
        const t = d / 8;
        return [
          Math.round(30 + t * 100),
          Math.round(80 + t * 175),
          Math.round(200 + t * 55),
        ];
      } else if (d <= 15) {
        // Cyan → yellow for medium distances
        const t = (d - 8) / 7;
        return [
          Math.round(130 + t * 125),
          Math.round(255 - t * 55),
          Math.round(255 - t * 200),
        ];
      } else {
        // Yellow → white for far
        const t = Math.min(1, (d - 15) / 15);
        return [
          Math.round(255),
          Math.round(200 + t * 55),
          Math.round(55 + t * 200),
        ];
      }
    };

    // Fill the image data — each pixel maps to a cell in the matrix
    for (let py = 0; py < plotSize; py++) {
      for (let px = 0; px < plotSize; px++) {
        const i = Math.floor((px / plotSize) * n);
        const j = Math.floor((py / plotSize) * n);
        let d: number;
        if (i === j) {
          d = 0;
        } else {
          const a = atoms[i];
          const b = atoms[j];
          if (!a || !b) {
            d = 99;
          } else {
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const dz = a.z - b.z;
            d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          }
        }
        const [r, g, bl] = colorForDist(d);
        const idx = (py * plotSize + px) * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = bl;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(imgData, margin, margin);

    // Draw diagonal line
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(margin, margin);
    ctx.lineTo(margin + plotSize, margin + plotSize);
    ctx.stroke();

    // Border
    ctx.strokeStyle = "#d4d4d8";
    ctx.lineWidth = 1;
    ctx.strokeRect(margin, margin, plotSize, plotSize);

    // Axis labels
    ctx.fillStyle = "#71717a";
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(
      `${t("structure.residue")} ${atoms[0]?.resSeq ?? 0} → ${atoms[n - 1]?.resSeq ?? 0}`,
      margin + plotSize / 2,
      H - 6
    );
    ctx.save();
    ctx.translate(8, margin + plotSize / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(
      `${t("structure.residue")} ${atoms[0]?.resSeq ?? 0} → ${atoms[n - 1]?.resSeq ?? 0}`,
      0,
      0
    );
    ctx.restore();
  }, [atoms, n, t]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    const margin = 28;
    const plotSize = Math.min(canvas.width, canvas.height) - 2 * margin;
    if (mx < margin || mx > margin + plotSize || my < margin || my > margin + plotSize) {
      setHover(null);
      return;
    }
    const i = Math.floor(((mx - margin) / plotSize) * n);
    const j = Math.floor(((my - margin) / plotSize) * n);
    if (i >= n || j >= n || i < 0 || j < 0) {
      setHover(null);
      return;
    }
    const a = atoms[i];
    const b = atoms[j];
    if (!a || !b) {
      setHover(null);
      return;
    }
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    setHover({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      label: `${a.resName}${a.resSeq}(${a.chain}) ↔ ${b.resName}${b.resSeq}(${b.chain}) = ${d.toFixed(1)}Å`,
    });
  };

  if (n < 2) {
    return (
      <p className="text-xs text-muted-foreground text-center py-4">
        Not enough Cα atoms for a contact map.
      </p>
    );
  }

  return (
    <div className="relative">
      {wasTruncated && (
        <div className="text-[10px] text-amber-600 dark:text-amber-400 mb-1.5">
          {t("structure.tooLargeForHeatmap", { n: caAtoms.length })}
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={340}
        height={340}
        className="w-full max-w-[340px] h-auto mx-auto block cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
      />
      {/* Color scale legend */}
      <div className="flex items-center justify-center gap-1 mt-2 text-[9px]">
        <span className="text-muted-foreground">0Å</span>
        <div
          className="h-2 w-32 rounded"
          style={{
            background:
              "linear-gradient(to right, rgb(30,80,200), rgb(130,255,255), rgb(255,200,55), rgb(255,255,255))",
          }}
        />
        <span className="text-muted-foreground">30Å+</span>
      </div>
      {hover && (
        <div
          className="absolute z-10 pointer-events-none px-2 py-1 rounded bg-black/90 text-white text-[10px] font-mono whitespace-nowrap"
          style={{ left: hover.x + 8, top: hover.y - 24 }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}

/* ---------------- SASA Per-Chain Bar Chart (canvas) ---------------- */

function SasaPerChainChart({ sasaData, t }: { sasaData: any[]; t: TFunc }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = React.useState<{
    x: number;
    y: number;
    label: string;
  } | null>(null);

  // Aggregate SASA by chain
  const chainData = React.useMemo(() => {
    const map = new Map<string, { chain: string; total: number; count: number; exposed: number; buried: number }>();
    for (const s of sasaData) {
      const existing = map.get(s.chain) || { chain: s.chain, total: 0, count: 0, exposed: 0, buried: 0 };
      existing.total += s.sasa;
      existing.count++;
      if (s.exposure === "exposed") existing.exposed++;
      if (s.exposure === "buried") existing.buried++;
      map.set(s.chain, existing);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [sasaData]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || chainData.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const marginL = 50;
    const marginR = 12;
    const marginT = 12;
    const marginB = 30;
    const plotW = W - marginL - marginR;
    const plotH = H - marginT - marginB;

    ctx.clearRect(0, 0, W, H);

    const maxVal = Math.max(...chainData.map((d) => d.total), 1);
    const barH = (plotH / chainData.length) * 0.7;
    const barGap = (plotH / chainData.length) * 0.3;

    // Y-axis grid lines
    ctx.strokeStyle = "#e4e4e7";
    ctx.lineWidth = 0.5;
    ctx.fillStyle = "#71717a";
    ctx.font = "8px ui-monospace, monospace";
    ctx.textAlign = "right";
    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const val = (maxVal / gridSteps) * i;
      const y = marginT + plotH - (i / gridSteps) * plotH;
      ctx.beginPath();
      ctx.moveTo(marginL, y);
      ctx.lineTo(marginL + plotW, y);
      ctx.stroke();
      ctx.fillText(Math.round(val).toString(), marginL - 4, y + 3);
    }

    // Bars
    chainData.forEach((d, i) => {
      const y = marginT + i * (barH + barGap) + barGap / 2;
      const w = (d.total / maxVal) * plotW;
      // Gradient bar: emerald → teal
      const grad = ctx.createLinearGradient(marginL, 0, marginL + w, 0);
      grad.addColorStop(0, "rgba(16, 185, 129, 0.85)");
      grad.addColorStop(1, "rgba(20, 184, 166, 0.85)");
      ctx.fillStyle = grad;
      ctx.fillRect(marginL, y, w, barH);
      // Value label
      ctx.fillStyle = "#1f2937";
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(`${Math.round(d.total)} Å²`, marginL + w + 4, y + barH / 2 + 3);
      // Chain label
      ctx.fillStyle = "#71717a";
      ctx.textAlign = "right";
      ctx.fillText(`Chain ${d.chain}`, marginL - 4, y + barH / 2 + 3);
    });

    // Axis label
    ctx.fillStyle = "#71717a";
    ctx.font = "9px ui-sans-serif, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${t("structure.totalSasa")} (Å²)`, marginL + plotW / 2, H - 6);
  }, [chainData, t]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    const marginL = 50;
    const marginT = 12;
    const marginB = 30;
    const H = canvas.height;
    const plotH = H - marginT - marginB;
    const barH = (plotH / chainData.length) * 0.7;
    const barGap = (plotH / chainData.length) * 0.3;
    const idx = Math.floor((my - marginT) / (barH + barGap));
    if (idx >= 0 && idx < chainData.length) {
      const d = chainData[idx];
      setHover({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        label: `Chain ${d.chain}: ${Math.round(d.total)} Å² total | ${d.count} res | ${d.exposed} exposed / ${d.buried} buried`,
      });
    } else {
      setHover(null);
    }
  };

  if (chainData.length === 0) {
    return (
      <p className="text-xs text-muted-foreground text-center py-4">
        No SASA data available.
      </p>
    );
  }

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        width={360}
        height={Math.max(120, chainData.length * 40 + 40)}
        className="w-full h-auto mx-auto block cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
      />
      {hover && (
        <div
          className="absolute z-10 pointer-events-none px-2 py-1 rounded bg-black/90 text-white text-[10px] font-mono whitespace-nowrap"
          style={{ left: hover.x + 8, top: hover.y - 24 }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}

/* ---------------- B-factor Per-Residue Line Plot (canvas) ---------------- */

function BFactorProfileChart({
  perResidue,
  mean,
  stdDev,
  t,
}: {
  perResidue: any[];
  mean: number;
  stdDev: number;
  t: TFunc;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = React.useState<{
    x: number;
    y: number;
    label: string;
  } | null>(null);

  // Cap at 500 residues for performance (downsample if larger)
  const MAX_POINTS = 500;
  const data =
    perResidue.length > MAX_POINTS
      ? perResidue.filter((_, i) => i % Math.ceil(perResidue.length / MAX_POINTS) === 0)
      : perResidue;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const marginL = 36;
    const marginR = 12;
    const marginT = 12;
    const marginB = 28;
    const plotW = W - marginL - marginR;
    const plotH = H - marginT - marginB;

    ctx.clearRect(0, 0, W, H);

    const values = data.map((d) => d.bfactor);
    const minV = Math.min(...values, mean - 2 * stdDev);
    const maxV = Math.max(...values, mean + 2 * stdDev);
    const range = maxV - minV || 1;

    const xScale = (i: number) => marginL + (i / (data.length - 1 || 1)) * plotW;
    const yScale = (v: number) =>
      marginT + plotH - ((v - minV) / range) * plotH;

    // Background
    ctx.fillStyle = "#fafafa";
    ctx.fillRect(marginL, marginT, plotW, plotH);

    // Grid + Y-axis labels
    ctx.strokeStyle = "#e4e4e7";
    ctx.lineWidth = 0.5;
    ctx.fillStyle = "#71717a";
    ctx.font = "8px ui-monospace, monospace";
    ctx.textAlign = "right";
    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const val = minV + (range / gridSteps) * i;
      const y = yScale(val);
      ctx.beginPath();
      ctx.moveTo(marginL, y);
      ctx.lineTo(marginL + plotW, y);
      ctx.stroke();
      ctx.fillText(val.toFixed(0), marginL - 4, y + 3);
    }

    // Mean line (dashed)
    ctx.strokeStyle = "rgba(245, 158, 11, 0.7)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(marginL, yScale(mean));
    ctx.lineTo(marginL + plotW, yScale(mean));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(245, 158, 11, 0.9)";
    ctx.font = "8px ui-sans-serif, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`mean ${mean.toFixed(1)}`, marginL + 4, yScale(mean) - 3);

    // Mean + 2σ line (high-flexibility threshold)
    if (mean + 2 * stdDev <= maxV) {
      ctx.strokeStyle = "rgba(244, 63, 94, 0.5)";
      ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(marginL, yScale(mean + 2 * stdDev));
      ctx.lineTo(marginL + plotW, yScale(mean + 2 * stdDev));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Filled area under the curve
    const grad = ctx.createLinearGradient(0, marginT, 0, marginT + plotH);
    grad.addColorStop(0, "rgba(244, 63, 94, 0.35)");
    grad.addColorStop(0.5, "rgba(245, 158, 11, 0.25)");
    grad.addColorStop(1, "rgba(14, 165, 233, 0.15)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(xScale(0), marginT + plotH);
    for (let i = 0; i < data.length; i++) {
      ctx.lineTo(xScale(i), yScale(data[i].bfactor));
    }
    ctx.lineTo(xScale(data.length - 1), marginT + plotH);
    ctx.closePath();
    ctx.fill();

    // Line
    ctx.strokeStyle = "rgba(217, 119, 6, 0.9)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = xScale(i);
      const y = yScale(data[i].bfactor);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Highlight outliers (|z| > 2)
    ctx.fillStyle = "rgba(244, 63, 94, 0.9)";
    for (let i = 0; i < data.length; i++) {
      if (data[i].isOutlier) {
        ctx.beginPath();
        ctx.arc(xScale(i), yScale(data[i].bfactor), 2, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

    // Border
    ctx.strokeStyle = "#d4d4d8";
    ctx.lineWidth = 1;
    ctx.strokeRect(marginL, marginT, plotW, plotH);

    // X-axis label
    ctx.fillStyle = "#71717a";
    ctx.font = "9px ui-sans-serif, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      `${t("structure.residue")} ${data[0]?.resSeq ?? 0} → ${data[data.length - 1]?.resSeq ?? 0}`,
      marginL + plotW / 2,
      H - 6
    );
  }, [data, mean, stdDev, t]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const mx = (e.clientX - rect.left) * scaleX;
    const marginL = 36;
    const marginR = 12;
    const plotW = canvas.width - marginL - marginR;
    const idx = Math.round(((mx - marginL) / plotW) * (data.length - 1));
    if (idx >= 0 && idx < data.length) {
      const d = data[idx];
      setHover({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        label: `${d.resName}${d.resSeq}(${d.chain}) B=${d.bfactor.toFixed(1)} z=${d.zScore?.toFixed(2) ?? "—"}${d.isOutlier ? " ⚠ outlier" : ""}`,
      });
    } else {
      setHover(null);
    }
  };

  if (data.length === 0) {
    return (
      <p className="text-xs text-muted-foreground text-center py-4">
        No B-factor data available.
      </p>
    );
  }

  return (
    <div className="relative">
      {perResidue.length > MAX_POINTS && (
        <div className="text-[10px] text-amber-600 dark:text-amber-400 mb-1.5">
          Showing {data.length} of {perResidue.length} residues (downsampled for performance).
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={420}
        height={200}
        className="w-full h-auto mx-auto block cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
      />
      <div className="flex items-center justify-center gap-4 mt-2 text-[9px]">
        <div className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-amber-600" />
          <span className="text-muted-foreground">B-factor</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 border-t border-dashed border-amber-500" />
          <span className="text-muted-foreground">mean</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-rose-500" />
          <span className="text-muted-foreground">outlier (|z|&gt;2)</span>
        </div>
      </div>
      {hover && (
        <div
          className="absolute z-10 pointer-events-none px-2 py-1 rounded bg-black/90 text-white text-[10px] font-mono whitespace-nowrap"
          style={{ left: hover.x + 8, top: hover.y - 24 }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}
