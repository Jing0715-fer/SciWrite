"use client";

import * as React from "react";
import { Box, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";

/**
 * InsertStructureAnalysisButton — a popover that lists all analyzed RCSB
 * structures in the current project and inserts a compact markdown summary of
 * the selected structure's key metrics into the paragraph draft. This is the
 * "quick insert" counterpart to the full ProteinStructureAnalysisDialog —
 * instead of viewing all 12 tabs, the user picks a structure and gets a
 * one-paragraph summary they can edit into their prose.
 */
export function InsertStructureAnalysisButton({
  projectId,
  onInsert,
}: {
  projectId: string;
  onInsert: (markdown: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [analyses, setAnalyses] = React.useState<any[]>([]);

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .listProjectStructures(projectId)
      .then((res) => setAnalyses(res.analyses || []))
      .catch(() => setAnalyses([]))
      .finally(() => setLoading(false));
  }, [open, projectId]);

  function buildInsertMarkdown(a: any): string {
    // Parse the contextMarkdown to extract key metrics, or build a compact
    // summary from the fields we have.
    const lines: string[] = [];
    lines.push(`> **Structure PDB:${a.pdbId}** — ${a.title || "untitled"}`);
    lines.push(`> - ${a.chainCount} chain(s) · ${a.residueCount} residues · ${a.atomCount} atoms${a.ligandCount > 0 ? ` · ${a.ligandCount} ligand(s)` : ""}`);
    // Try to extract a few key lines from the full context markdown.
    const md = a.contextMarkdown || "";
    const extract = (re: RegExp) => {
      const m = md.match(re);
      return m ? m[1] : null;
    };
    const method = extract(/Method: ([^|]+)/);
    const resolution = extract(/Resolution: ([^|Å]+Å)/);
    const ramaFav = extract(/Favoured \(core\+allowed\): (\S+)%/);
    const ramaOut = extract(/Outliers: (\S+)%/);
    const bfMean = extract(/Mean: ([\d.]+)/);
    const sasaExp = extract(/Exposed: (\S+)%/);
    const sasaBur = extract(/Buried: (\S+)%/);
    const hbonds = extract(/Hydrogen bonds[^:]*: (\d+)/);
    const netCharge = extract(/Net charge at pH 7: ([\d.\-+]+)/);
    const pI = extract(/Isoelectric point \(pI\): ([\d.]+)/);
    const meta: string[] = [];
    if (method) meta.push(`Method: ${method.trim()}`);
    if (resolution) meta.push(`Resolution: ${resolution.trim()}`);
    if (ramaFav) meta.push(`Ramachandran: ${ramaFav}% favoured / ${ramaOut}% outliers`);
    if (bfMean) meta.push(`B̄=${bfMean}`);
    if (sasaExp) meta.push(`SASA: ${sasaExp}% exposed / ${sasaBur}% buried`);
    if (hbonds) meta.push(`${hbonds} H-bonds`);
    if (netCharge) meta.push(`net charge ${netCharge} (pH 7)`);
    if (pI) meta.push(`pI=${pI}`);
    if (meta.length) lines.push(`> - ${meta.join(" · ")}`);
    // Ligands
    const ligMatch = md.match(/Ligands & Cofators \((\d+) detected\):([\s\S]*?)(?=\n\*\*|$)/);
    if (ligMatch && ligMatch[1] !== "0") {
      const ligLines = ligMatch[2].split("\n").filter((l) => l.trim().startsWith("-")).slice(0, 6);
      if (ligLines.length) lines.push(`> - Ligands: ${ligLines.map((l) => l.replace(/^\s*-\s*/, "").replace(/—.*$/, "").trim()).join(", ")}`);
    }
    lines.push(`> _All metrics computed from the actual PDB file via Molcraft structure analysis._`);
    return lines.join("\n");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-[10px] border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-950/30"
          title={t("structure.insertAnalysisTitle")}
        >
          <Box className="h-3 w-3" />
          {t("structure.insertAnalysis")}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-2 max-h-80 overflow-y-auto"
      >
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : analyses.length === 0 ? (
          <div className="text-center py-4 text-[11px] text-muted-foreground">
            <Box className="h-6 w-6 mx-auto mb-1 opacity-30" />
            {t("structure.noAnalyzedSources")}
          </div>
        ) : (
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold px-1 pb-1">
              {t("structure.chooseStructure")}
            </div>
            {analyses.map((a) => (
              <button
                key={a.pdbId}
                onClick={() => {
                  onInsert(buildInsertMarkdown(a));
                  setOpen(false);
                }}
                className="w-full text-left rounded-md border border-border/60 hover:border-amber-300 dark:hover:border-amber-700/50 hover:bg-amber-50/50 dark:hover:bg-amber-950/20 p-2 transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <Badge
                    variant="secondary"
                    className="text-[9px] font-mono bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                  >
                    {a.pdbId}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    {a.chainCount}ch · {a.residueCount}res{a.ligandCount > 0 ? ` · ${a.ligandCount}lig` : ""}
                  </span>
                </div>
                <div className="text-[11px] font-medium mt-0.5 line-clamp-1">
                  {a.title || "untitled"}
                </div>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
