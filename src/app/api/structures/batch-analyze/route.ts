import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  analyzeStructureById,
  buildStructureContextMarkdown,
} from "@/lib/structure-analysis";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes — batch may process many structures

/**
 * POST /api/structures/batch-analyze
 *
 * Analyze ALL unanalyzed RCSB data sources in a project at once. For each
 * RCSB data source whose PDB ID is not yet in the StructureAnalysis cache,
 * downloads the PDB file, runs the full analysis, and caches the result.
 * Also enriches each data source's `extra` JSON with the analyzed flag +
 * key metrics (same as the single analyze-structure route).
 *
 * Body:
 *   { projectId: string, force?: boolean }
 *
 * Returns:
 *   { ok: boolean, total: number, analyzed: number, skipped: number,
 *     failed: number, results: [{ pdbId, status, ... }] }
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const projectId = body.projectId;
  if (!projectId) {
    return NextResponse.json(
      { error: "Missing 'projectId'." },
      { status: 400 }
    );
  }

  const force = body.force === true;

  try {
    // Find all RCSB data sources for the project.
    const sources = await db.dataSource.findMany({
      where: { projectId, source: "rcsb" },
      select: { id: true, externalId: true, extra: true },
    });

    // Extract unique PDB IDs.
    const pdbIdToSourceIds = new Map<string, string[]>();
    for (const s of sources) {
      const pdbId = s.externalId?.trim().toUpperCase();
      if (pdbId && /^[A-Z0-9]{4}$/.test(pdbId)) {
        const existing = pdbIdToSourceIds.get(pdbId) || [];
        existing.push(s.id);
        pdbIdToSourceIds.set(pdbId, existing);
      }
    }

    const allPdbIds = [...pdbIdToSourceIds.keys()];
    if (allPdbIds.length === 0) {
      return NextResponse.json({
        ok: true,
        total: 0,
        analyzed: 0,
        skipped: 0,
        failed: 0,
        results: [],
        message: "No RCSB data sources found in this project.",
      });
    }

    // Find which are already cached (unless force=true).
    const cached = force
      ? new Set<string>()
      : new Set(
          (
            await db.structureAnalysis.findMany({
              where: { pdbId: { in: allPdbIds } },
              select: { pdbId: true },
            })
          ).map((r) => r.pdbId)
        );

    const toAnalyze = allPdbIds.filter((id) => !cached.has(id));
    const results: any[] = [];

    // Analyze each one sequentially (parallel could overwhelm RCSB or memory).
    for (const pdbId of toAnalyze) {
      try {
        const { result, pdbText } = await analyzeStructureById(pdbId, {
          includeInterfaces: true,
        });
        const contextMarkdown = buildStructureContextMarkdown(result);
        const analysisJson = JSON.stringify(result);
        const rcsbMetadataJson = result.rcsbMetadata
          ? JSON.stringify(result.rcsbMetadata)
          : null;

        await db.structureAnalysis.upsert({
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

        // Enrich each data source that references this PDB ID.
        const sourceIds = pdbIdToSourceIds.get(pdbId) || [];
        for (const sourceId of sourceIds) {
          const ds = await db.dataSource.findUnique({
            where: { id: sourceId },
            select: { extra: true, summary: true },
          });
          if (!ds) continue;
          let extra: any = {};
          try {
            extra = ds.extra ? JSON.parse(ds.extra) : {};
          } catch {
            extra = {};
          }
          extra.analyzed = true;
          extra.chainCount = result.composition.chains.length;
          extra.residueCount = result.parsed.numResidues;
          extra.ligandCount = result.ligands.length;
          extra.ramachandranFavouredPct = result.ramachandranSummary?.favouredPct;
          extra.bfactorMean = result.bfactor?.mean;
          extra.pI = result.isoelectricPoint;
          extra.netCharge = result.chargeAtPH7?.totalCharge;
          await db.dataSource.update({
            where: { id: sourceId },
            data: { extra: JSON.stringify(extra) },
          });
        }

        results.push({
          pdbId,
          status: "analyzed",
          chainCount: result.composition.chains.length,
          residueCount: result.parsed.numResidues,
          ligandCount: result.ligands.length,
        });
      } catch (err: any) {
        results.push({
          pdbId,
          status: "failed",
          error: err?.message || "Analysis failed",
        });
      }
    }

    const analyzedCount = results.filter((r) => r.status === "analyzed").length;
    const failedCount = results.filter((r) => r.status === "failed").length;
    const skippedCount = cached.size;

    return NextResponse.json({
      ok: true,
      total: allPdbIds.length,
      analyzed: analyzedCount,
      skipped: skippedCount,
      failed: failedCount,
      results,
    });
  } catch (err: any) {
    console.error("[/api/structures/batch-analyze] error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Batch analysis failed.") },
      { status: 500 }
    );
  }
}
