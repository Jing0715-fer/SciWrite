import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  analyzeStructureById,
  buildStructureContextMarkdown,
  runStructureAnalysis,
} from "@/lib/structure-analysis";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/structures/analyze
 *
 * Analyze a protein structure by PDB ID (downloads the PDB file from RCSB,
 * fetches richer metadata, runs the full Molcraft structure-analysis battery,
 * caches the result in the `StructureAnalysis` table, and returns the
 * structured analysis + LLM-ready Markdown context).
 *
 * Body:
 *   { pdbId: string, force?: boolean, includeInterfaces?: boolean }
 *
 * Or, for an uploaded PDB file:
 *   { pdbText: string, name?: string }
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    // Case 1: uploaded PDB text
    if (body.pdbText && typeof body.pdbText === "string") {
      const name = (body.name || "uploaded").toString();
      const result = runStructureAnalysis(body.pdbText, { pdbId: name });
      const contextMarkdown = buildStructureContextMarkdown(result);
      return NextResponse.json({
        ok: true,
        pdbId: name,
        cached: false,
        uploaded: true,
        analysis: result,
        contextMarkdown,
      });
    }

    // Case 2: analyze by PDB ID
    const pdbId = (body.pdbId || "").toString().trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(pdbId)) {
      return NextResponse.json(
        { error: `Invalid PDB ID "${body.pdbId}". Expected 4 alphanumeric characters.` },
        { status: 400 }
      );
    }

    const force = body.force === true;
    const includeInterfaces = body.includeInterfaces === true;

    // Return cached analysis if present and not forced.
    if (!force) {
      const cached = await db.structureAnalysis.findUnique({ where: { pdbId } });
      if (cached) {
        return NextResponse.json({
          ok: true,
          pdbId,
          cached: true,
          analysis: JSON.parse(cached.analysisJson),
          contextMarkdown: cached.contextMarkdown,
          rcsbMetadata: cached.rcsbMetadataJson
            ? JSON.parse(cached.rcsbMetadataJson)
            : null,
          title: cached.title,
          atomCount: cached.atomCount,
          residueCount: cached.residueCount,
          chainCount: cached.chainCount,
          ligandCount: cached.ligandCount,
          createdAt: cached.createdAt,
          updatedAt: cached.updatedAt,
        });
      }
    }

    // Run the full analysis.
    const { result, pdbText } = await analyzeStructureById(pdbId, {
      includeInterfaces,
    });
    const contextMarkdown = buildStructureContextMarkdown(result);

    // Persist to cache (upsert by pdbId).
    const analysisJson = JSON.stringify(result);
    const rcsbMetadataJson = result.rcsbMetadata
      ? JSON.stringify(result.rcsbMetadata)
      : null;
    const saved = await db.structureAnalysis.upsert({
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

    // Invalidate comparison matrix cache for any project that contains this
    // PDB ID (since re-analysis may change the coordinates/metrics).
    try {
      const sourcesWithThisPdb = await db.dataSource.findMany({
        where: { source: "rcsb", externalId: pdbId },
        select: { projectId: true },
      });
      const projectIds = [
        ...new Set(
          sourcesWithThisPdb
            .map((s) => s.projectId)
            .filter((id): id is string => !!id)
        ),
      ];
      if (projectIds.length > 0) {
        await db.comparisonMatrixCache.deleteMany({
          where: { projectId: { in: projectIds } },
        });
      }
    } catch (e) {
      // Non-critical — don't fail the analysis if cache invalidation fails.
      console.warn("[/api/structures/analyze] matrix cache invalidation failed:", e);
    }

    return NextResponse.json({
      ok: true,
      pdbId,
      cached: false,
      savedId: saved.id,
      analysis: result,
      contextMarkdown,
      title: result.title,
      atomCount: result.parsed.numAtoms,
      residueCount: result.parsed.numResidues,
      chainCount: result.composition.chains.length,
      ligandCount: result.ligands.length,
      updatedAt: saved.updatedAt,
    });
  } catch (err: any) {
    console.error("[/api/structures/analyze] error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Structure analysis failed.") },
      { status: 500 }
    );
  }
}

/**
 * GET /api/structures/analyze?pdbId=1A3N
 * Convenience getter — returns cached analysis if present, else 404.
 */
export async function GET(req: NextRequest) {
  const pdbId = req.nextUrl.searchParams.get("pdbId")?.trim().toUpperCase();
  if (!pdbId) {
    return NextResponse.json(
      { error: "Missing 'pdbId' query parameter." },
      { status: 400 }
    );
  }
  const cached = await db.structureAnalysis.findUnique({ where: { pdbId } });
  if (!cached) {
    return NextResponse.json(
      { error: `No cached analysis for PDB:${pdbId}. POST to /api/structures/analyze to run it.` },
      { status: 404 }
    );
  }
  return NextResponse.json({
    ok: true,
    pdbId,
    cached: true,
    analysis: JSON.parse(cached.analysisJson),
    contextMarkdown: cached.contextMarkdown,
    rcsbMetadata: cached.rcsbMetadataJson ? JSON.parse(cached.rcsbMetadataJson) : null,
    title: cached.title,
    atomCount: cached.atomCount,
    residueCount: cached.residueCount,
    chainCount: cached.chainCount,
    ligandCount: cached.ligandCount,
    updatedAt: cached.updatedAt,
  });
}
