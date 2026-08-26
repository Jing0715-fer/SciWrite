import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  analyzeStructureById,
  buildStructureContextMarkdown,
} from "@/lib/structure-analysis";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/data-sources/[id]/analyze-structure
 *
 * Analyzes the protein structure associated with an RCSB data source.
 * The data source's `externalId` is treated as the PDB ID. Runs the full
 * Molcraft structure-analysis battery, caches the result, and (optionally)
 * appends a deep structural summary to the data source's `summary` field so
 * the writing pipeline can surface real structural features.
 *
 * Body:
 *   { force?: boolean, includeInterfaces?: boolean, updateSummary?: boolean }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const ds = await db.dataSource.findUnique({ where: { id } });
    if (!ds) {
      return NextResponse.json(
        { error: `Data source "${id}" not found.` },
        { status: 404 }
      );
    }
    if (ds.source !== "rcsb" || !ds.externalId) {
      return NextResponse.json(
        {
          error:
            "Structure analysis is only available for RCSB data sources with a PDB ID.",
        },
        { status: 400 }
      );
    }

    const pdbId = ds.externalId.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(pdbId)) {
      return NextResponse.json(
        { error: `Data source externalId "${ds.externalId}" is not a valid PDB ID.` },
        { status: 400 }
      );
    }

    const force = body.force === true;
    const includeInterfaces = body.includeInterfaces === true;
    const updateSummary = body.updateSummary !== false; // default true

    // Use cached analysis if available and not forced.
    let cached = !force
      ? await db.structureAnalysis.findUnique({ where: { pdbId } })
      : null;

    if (!cached) {
      const { result, pdbText } = await analyzeStructureById(pdbId, {
        includeInterfaces,
      });
      const contextMarkdown = buildStructureContextMarkdown(result);
      const analysisJson = JSON.stringify(result);
      const rcsbMetadataJson = result.rcsbMetadata
        ? JSON.stringify(result.rcsbMetadata)
        : null;
      cached = await db.structureAnalysis.upsert({
        where: { pdbId },
        create: {
          pdbId,
          title: result.title || pdbId,
          pdbText,
          analysisJson,
          contextMarkdown,
          rcsbMetadataJson,
          atomCount: result.parsed.numAtoms,
          residueCount: result.parsed.numResidues,
          chainCount: result.composition.chains.length,
          ligandCount: result.ligands.length,
        },
        update: {
          title: result.title || pdbId,
          pdbText,
          analysisJson,
          contextMarkdown,
          rcsbMetadataJson,
          atomCount: result.parsed.numAtoms,
          residueCount: result.parsed.numResidues,
          chainCount: result.composition.chains.length,
          ligandCount: result.ligands.length,
        },
      });
    }

    // Optionally append a concise structural summary to the data source so
    // the writing pipeline picks it up.
    if (updateSummary) {
      const analysis = JSON.parse(cached.analysisJson);
      const compact = buildCompactStructureSummary(analysis, pdbId);
      const existing = ds.summary || "";
      // Avoid duplicating the structural block if already present.
      const marker = "【STRUCTURE ANALYSIS】";
      let newSummary: string;
      if (existing.includes(marker)) {
        newSummary = existing.replace(
          new RegExp(`${marker}[\\s\\S]*?(?=\\n\\n|$|$)`),
          compact
        );
      } else {
        newSummary = existing
          ? `${existing.trim()}\n\n${compact}`
          : compact;
      }
      await db.dataSource.update({ where: { id }, data: { summary: newSummary } });

      // Also enrich the `extra` JSON with a flag + key metrics so the
      // KnowledgePanel can show an "Analyzed ✓" badge.
      let extra: any = {};
      try {
        extra = ds.extra ? JSON.parse(ds.extra) : {};
      } catch {
        extra = {};
      }
      extra.analyzed = true;
      extra.chainCount = analysis.composition.chains.length;
      extra.residueCount = analysis.parsed.numResidues;
      extra.ligandCount = analysis.ligands.length;
      extra.ramachandranFavouredPct = analysis.ramachandranSummary?.favouredPct;
      extra.bfactorMean = analysis.bfactor?.mean;
      extra.pI = analysis.isoelectricPoint;
      extra.netCharge = analysis.chargeAtPH7?.totalCharge;
      await db.dataSource.update({
        where: { id },
        data: { extra: JSON.stringify(extra) },
      });
    }

    return NextResponse.json({
      ok: true,
      pdbId,
      dataSourceId: id,
      cached: force ? false : Boolean(cached),
      title: cached.title,
      atomCount: cached.atomCount,
      residueCount: cached.residueCount,
      chainCount: cached.chainCount,
      ligandCount: cached.ligandCount,
      contextMarkdown: cached.contextMarkdown,
      analysis: JSON.parse(cached.analysisJson),
      updatedAt: cached.updatedAt,
    });
  } catch (err: any) {
    console.error("[/api/data-sources/[id]/analyze-structure] error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Structure analysis failed.") },
      { status: 500 }
    );
  }
}

/** Build a concise, human-readable structural summary for the data source. */
function buildCompactStructureSummary(analysis: any, pdbId: string): string {
  const L: string[] = [];
  L.push("【STRUCTURE ANALYSIS】 (computed from PDB file via Molcraft fusion)");
  const c = analysis.composition;
  L.push(
    `- Composition: ${c.chains.length} chain(s) [${c.chains.join(", ")}], ${analysis.parsed.numResidues} residues, ${analysis.parsed.numAtoms} atoms, ${c.numWaters} waters.`
  );
  const oligomer =
    c.chains.length <= 1
      ? "monomer"
      : c.chains.length === 2
        ? "dimer"
        : c.chains.length === 4
          ? "tetramer"
          : `${c.chains.length}-mer`;
  L.push(`- Oligomeric state: ${oligomer}.`);
  if (analysis.secondaryStructure?.length) {
    const helices = analysis.secondaryStructure.filter((s: any) => s.type === "helix").length;
    const sheets = analysis.secondaryStructure.filter((s: any) => s.type === "sheet").length;
    L.push(`- Secondary structure (records): ${helices} helices, ${sheets} sheets.`);
  }
  if (analysis.ligands?.length) {
    L.push(
      `- Ligands/cofactors (${analysis.ligands.length}): ${analysis.ligands
        .slice(0, 8)
        .map((l: any) => `${l.resName}(${l.chain}:${l.resSeq})`)
        .join(", ")}${analysis.ligands.length > 8 ? " …" : ""}.`
    );
  }
  if (analysis.ramachandranSummary?.total > 0) {
    L.push(
      `- Ramachandran: ${analysis.ramachandranSummary.favouredPct}% favoured, ${analysis.ramachandranSummary.outlierPct}% outliers (${analysis.ramachandranSummary.disallowed}/${analysis.ramachandranSummary.total}).`
    );
  }
  if (analysis.bfactor) {
    L.push(
      `- B-factor: mean ${analysis.bfactor.mean.toFixed(1)}, range ${analysis.bfactor.min.toFixed(1)}–${analysis.bfactor.max.toFixed(1)} (std ${analysis.bfactor.stdDev.toFixed(1)}).`
    );
  }
  if (analysis.sasaSummary?.total > 0) {
    L.push(
      `- SASA: ${analysis.sasaSummary.exposedPct}% exposed, ${analysis.sasaSummary.buriedPct}% buried (mean ${analysis.sasaSummary.meanSasa} Å²/residue).`
    );
  }
  L.push(`- H-bonds (≤3.5Å, geometric): ${analysis.hbonds?.length ?? 0}.`);
  if (analysis.clashes?.length) {
    const severe = analysis.clashes.filter((cl: any) => cl.severity === "severe").length;
    L.push(`- Steric clashes: ${analysis.clashes.length} (${severe} severe).`);
  }
  L.push(
    `- Electrostatics: net charge ${analysis.chargeAtPH7?.totalCharge?.toFixed(1)} at pH 7; pI = ${analysis.isoelectricPoint?.toFixed(2)}.`
  );
  if (analysis.cavities?.length) {
    const pockets = analysis.cavities.filter((cv: any) => cv.isPocket);
    L.push(`- Cavities/pockets: ${pockets.length} surface pocket(s), ${analysis.cavities.length - pockets.length} buried cavity(ies).`);
  }
  if (analysis.rcsbMetadata?.assemblies?.length) {
    const a = analysis.rcsbMetadata.assemblies[0];
    if (a.totalBuriedSurfaceArea !== null) {
      L.push(`- Assembly 1 BSA: ${a.totalBuriedSurfaceArea.toFixed(0)} Å² across ${a.numInterfaces} interface(s).`);
    }
  }
  L.push(`- All values computed from PDB:${pdbId} — cite by [n] in the REFERENCE LIST.`);
  return L.join("\n");
}
