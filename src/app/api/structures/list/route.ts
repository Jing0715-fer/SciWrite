import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/structures/list?projectId=X
 *
 * Returns all protein structure analyses cached for a project's RCSB data
 * sources. Used by the paragraph-card "Insert structure analysis" popover to
 * let the user pick which analyzed structure's metrics to insert into the
 * paragraph draft.
 *
 * Returns: { analyses: [{ pdbId, title, chainCount, residueCount, ligandCount,
 *   atomCount, updatedAt, contextMarkdown }] }
 */
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json(
      { error: "Missing 'projectId' query parameter." },
      { status: 400 }
    );
  }
  // Find all RCSB data sources for the project, extract their PDB IDs, then
  // look up cached StructureAnalysis rows.
  const sources = await db.dataSource.findMany({
    where: { projectId, source: "rcsb" },
    select: { externalId: true },
  });
  const pdbIds = [
    ...new Set(
      sources
        .map((s) => s.externalId?.trim().toUpperCase())
        .filter((id): id is string => !!id && /^[A-Z0-9]{4}$/.test(id))
    ),
  ];
  if (!pdbIds.length) {
    return NextResponse.json({ analyses: [] });
  }
  const analyses = await db.structureAnalysis.findMany({
    where: { pdbId: { in: pdbIds } },
    select: {
      pdbId: true,
      title: true,
      atomCount: true,
      residueCount: true,
      chainCount: true,
      ligandCount: true,
      contextMarkdown: true,
      updatedAt: true,
    },
    orderBy: { pdbId: "asc" },
  });
  return NextResponse.json({ analyses });
}
