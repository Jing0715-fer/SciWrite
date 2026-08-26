import { NextRequest, NextResponse } from "next/server";
import {
  compareStructures,
  buildComparisonContextMarkdown,
} from "@/lib/structure-analysis";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const maxDuration = 90;

/**
 * POST /api/structures/compare
 *
 * Compare two protein structures by PDB ID. Runs Kabsch superposition +
 * sequence alignment (Smith-Waterman + Needleman-Wunsch, BLOSUM62) and returns
 * RMSD, TM-score, sequence identity, coverage, per-residue RMSD, and a
 * fold assessment (same-fold / similar-fold / different-fold).
 *
 * Body:
 *   { referencePdbId: string, mobilePdbId: string,
 *     refChain?: string, mobChain?: string,
 *     method?: "sequence" | "residue-number" }
 *
 * Both structures are analyzed first (if not cached) so their pdbText is
 * available for the comparison. The result is NOT cached (it's fast once the
 * pdbText is cached), but the comparison markdown can be injected into writing
 * prompts for deeper structural discussion.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const refId = (body.referencePdbId || body.refPdbId || "").toString().trim().toUpperCase();
    const mobId = (body.mobilePdbId || body.mobPdbId || "").toString().trim().toUpperCase();

    if (!refId || !mobId) {
      return NextResponse.json(
        { error: "Both 'referencePdbId' and 'mobilePdbId' are required." },
        { status: 400 }
      );
    }
    if (!/^[A-Z0-9]{4}$/.test(refId) || !/^[A-Z0-9]{4}$/.test(mobId)) {
      return NextResponse.json(
        {
          error: `Invalid PDB IDs: "${refId}", "${mobId}". Expected 4 alphanumeric characters each.`,
        },
        { status: 400 }
      );
    }
    if (refId === mobId) {
      return NextResponse.json(
        { error: "Cannot compare a structure with itself. Choose two different PDB IDs." },
        { status: 400 }
      );
    }

    const method = body.method === "residue-number" ? "residue-number" : "sequence";

    const result = await compareStructures(refId, mobId, {
      refChain: body.refChain,
      mobChain: body.mobChain,
      method,
    });

    const contextMarkdown = buildComparisonContextMarkdown(result);

    return NextResponse.json({
      ok: true,
      comparison: result,
      contextMarkdown,
    });
  } catch (err: any) {
    console.error("[/api/structures/compare] error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Structure comparison failed.") },
      { status: 500 }
    );
  }
}
