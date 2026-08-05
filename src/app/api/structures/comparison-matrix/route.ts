import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeComparisonMatrix } from "@/lib/structure-analysis";
import crypto from "crypto";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes — O(n²) comparisons

/**
 * POST /api/structures/comparison-matrix
 *
 * Compute a pairwise comparison matrix (RMSD, TM-score, sequence identity)
 * across all analyzed RCSB structures in a project. Results are cached in the
 * ComparisonMatrixCache table keyed by project ID + PDB ID set hash, so repeat
 * requests return instantly unless structures were added/removed (or force=true).
 *
 * Body:
 *   { projectId: string, force?: boolean }
 *
 * Returns:
 *   { ok, matrix: { pdbIds, rmsdMatrix, tmScoreMatrix, identityMatrix, entries, n }, cached: boolean }
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
    // Find all RCSB data sources and their cached structure analyses.
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

    if (pdbIds.length < 2) {
      return NextResponse.json({
        ok: true,
        matrix: {
          pdbIds,
          rmsdMatrix: [],
          tmScoreMatrix: [],
          identityMatrix: [],
          entries: [],
          n: pdbIds.length,
        },
        cached: false,
        message: "Need at least 2 analyzed structures for a comparison matrix.",
      });
    }

    // Compute a hash of the PDB ID set to detect changes.
    const pdbIdHash = crypto
      .createHash("sha256")
      .update(pdbIds.sort().join(","))
      .digest("hex")
      .slice(0, 16);

    // Check cache first (unless force=true).
    if (!force) {
      const cached = await db.comparisonMatrixCache.findUnique({
        where: { projectId },
      });
      if (cached && cached.pdbIdHash === pdbIdHash) {
        // Cache hit — return cached matrix.
        return NextResponse.json({
          ok: true,
          matrix: JSON.parse(cached.matrixJson),
          cached: true,
        });
      }
    }

    // Cache miss or forced — compute the matrix.
    const matrix = await computeComparisonMatrix(pdbIds);
    const matrixJson = JSON.stringify(matrix);

    // Upsert into cache.
    await db.comparisonMatrixCache.upsert({
      where: { projectId },
      create: {
        projectId,
        matrixJson,
        pdbIdHash,
        n: matrix.n,
      },
      update: {
        matrixJson,
        pdbIdHash,
        n: matrix.n,
      },
    });

    return NextResponse.json({
      ok: true,
      matrix,
      cached: false,
    });
  } catch (err: any) {
    console.error("[/api/structures/comparison-matrix] error:", err);
    return NextResponse.json(
      { error: err?.message || "Comparison matrix failed." },
      { status: 500 }
    );
  }
}
