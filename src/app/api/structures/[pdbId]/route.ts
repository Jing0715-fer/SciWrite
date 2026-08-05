import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/structures/[pdbId]
 * Returns the cached structure analysis for a PDB ID (404 if not analyzed yet).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ pdbId: string }> }
) {
  const { pdbId: raw } = await params;
  const pdbId = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(pdbId)) {
    return NextResponse.json(
      { error: `Invalid PDB ID "${raw}".` },
      { status: 400 }
    );
  }
  const cached = await db.structureAnalysis.findUnique({ where: { pdbId } });
  if (!cached) {
    return NextResponse.json(
      {
        error: `No cached analysis for PDB:${pdbId}.`,
        hint: "POST /api/structures/analyze with { pdbId } to run the analysis.",
      },
      { status: 404 }
    );
  }
  return NextResponse.json({
    ok: true,
    pdbId,
    analysis: JSON.parse(cached.analysisJson),
    contextMarkdown: cached.contextMarkdown,
    rcsbMetadata: cached.rcsbMetadataJson ? JSON.parse(cached.rcsbMetadataJson) : null,
    title: cached.title,
    atomCount: cached.atomCount,
    residueCount: cached.residueCount,
    chainCount: cached.chainCount,
    ligandCount: cached.ligandCount,
    pdbTextLength: cached.pdbText.length,
    createdAt: cached.createdAt,
    updatedAt: cached.updatedAt,
  });
}

/**
 * DELETE /api/structures/[pdbId]
 * Removes the cached analysis (forces re-analysis on next POST).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ pdbId: string }> }
) {
  const { pdbId: raw } = await params;
  const pdbId = raw.trim().toUpperCase();
  try {
    await db.structureAnalysis.delete({ where: { pdbId } });
    return NextResponse.json({ ok: true, deleted: pdbId });
  } catch {
    return NextResponse.json({ ok: true, deleted: null, note: "Nothing to delete." });
  }
}
