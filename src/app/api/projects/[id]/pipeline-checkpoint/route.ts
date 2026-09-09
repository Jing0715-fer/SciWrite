import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/projects/[id]/pipeline-checkpoint
 *
 * round-62 (P2-中): the v2 pipeline's checkpoint/resume feature was previously
 * INVISIBLE until you relaunched generation — the "resuming…" notice only ever
 * appeared as an SSE progress message mid-run. This read-only endpoint lets the
 * generation start dialog detect a resumable state UP FRONT and show an
 * explicit "Resume last run" option.
 *
 * A project is resumable when the latest checkpoint set for it has a "pool"
 * stage row (the citation pool / outline / full-texts snapshot written right
 * after allocation). The backend's resume path additionally requires the
 * checkpoint topic to match the CURRENT project topic — that check is
 * replicated here as `topicMatches` so the UI can phrase the banner honestly
 * (a mismatched checkpoint will be discarded by a fresh run).
 *
 * Returns:
 *   { resumable: false }
 * or
 *   {
 *     resumable: true,
 *     topic: string,            // topic stored on the checkpoint
 *     topicMatches: boolean,    // checkpoint topic === current project topic
 *     updatedAt: string,        // last checkpoint write time
 *     sectionsDone: number,     // sections completed & saved (0 = pool only)
 *     sectionsTotal: number,    // sections planned in the restored outline
 *     refsCount: number         // references in the restored citation pool
 *   }
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const project = await db.project.findUnique({
    where: { id },
    select: { id: true, topic: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  try {
    const latestCp = await db.pipelineCheckpoint.findFirst({
      where: { projectId: id },
      orderBy: { updatedAt: "desc" },
    });
    if (!latestCp) {
      return NextResponse.json({ resumable: false });
    }

    const poolCp = await db.pipelineCheckpoint.findUnique({
      where: { runId_stage: { runId: latestCp.runId, stage: "pool" } },
    });
    if (!poolCp) {
      // A checkpoint row exists but the pool snapshot is gone — nothing the
      // resume path could restore. Treat as not resumable.
      return NextResponse.json({ resumable: false });
    }

    let sectionsDone = 0;
    try {
      const secCp = await db.pipelineCheckpoint.findUnique({
        where: { runId_stage: { runId: latestCp.runId, stage: "sections" } },
      });
      if (secCp) {
        const parsed = JSON.parse(secCp.payload);
        if (Array.isArray(parsed)) sectionsDone = parsed.length;
      }
    } catch {
      // Unparsable sections payload — report 0 done; the backend handles the
      // same corruption by falling back to pool-only resume.
    }

    let sectionsTotal = 0;
    let refsCount = 0;
    try {
      const pool = JSON.parse(poolCp.payload);
      sectionsTotal = Array.isArray(pool?.sections) ? pool.sections.length : 0;
      refsCount = Array.isArray(pool?.curatedRefs) ? pool.curatedRefs.length : 0;
    } catch {
      // Unparsable pool payload — the backend's resume path would fail its
      // JSON.parse too and fall back to a fresh run; mirror that.
      return NextResponse.json({ resumable: false });
    }

    const topicMatches =
      (latestCp.topic || "").trim().toLowerCase() ===
      (project.topic || "").trim().toLowerCase();

    return NextResponse.json({
      resumable: true,
      topic: latestCp.topic || "",
      topicMatches,
      updatedAt: latestCp.updatedAt?.toISOString?.() ?? String(latestCp.updatedAt),
      sectionsDone,
      sectionsTotal,
      refsCount,
    });
  } catch (err: any) {
    // Read-only best-effort: never block the dialog on a checkpoint glitch.
    return NextResponse.json({ resumable: false, error: String(err?.message ?? err).slice(0, 120) });
  }
}
