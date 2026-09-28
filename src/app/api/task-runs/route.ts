import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";

/**
 * GET /api/task-runs?projectId=xxx&limit=20
 *
 * round-cs-1 (ClawsGO Science-inspired "可追溯、可复现"): list persisted
 * pipeline runs for a project — the replayable "run timeline". Each row
 * carries the full per-step records (stepsJson), the launch config snapshot
 * (provider/model transparency), and the final summary/stats.
 *
 * Zombie sweep: a run whose process died (server restart / crash) stays
 * status="running" forever. maxDuration is 30 min, so any "running" row
 * older than 45 min is marked aborted on read — the timeline never shows
 * a phantom in-flight run.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");
    if (!projectId) {
      return NextResponse.json({ error: "Missing 'projectId'." }, { status: 400 });
    }
    const limit = Math.max(1, Math.min(50, Number(searchParams.get("limit")) || 20));

    // --- Zombie sweep (cheap, bounded by projectId) ---
    const staleCutoff = new Date(Date.now() - 45 * 60 * 1000);
    try {
      await db.taskRun.updateMany({
        where: { projectId, status: "running", startedAt: { lt: staleCutoff } },
        data: {
          status: "aborted",
          error: "run interrupted (server restart or crash) — timeline preserved",
          finishedAt: new Date(),
        },
      });
    } catch {}

    const runs = await db.taskRun.findMany({
      where: { projectId },
      orderBy: { startedAt: "desc" },
      take: limit,
      select: {
        id: true,
        runId: true,
        pipeline: true,
        topic: true,
        language: true,
        targetWords: true,
        provider: true,
        model: true,
        status: true,
        resumed: true,
        stepsJson: true,
        statsJson: true,
        summaryJson: true,
        error: true,
        startedAt: true,
        finishedAt: true,
        durationMs: true,
      },
    });

    // Parse the JSON blobs so the client gets structured objects, and
    // annotate each run with a compact step rollup for the list view.
    const parsed = runs.map((r) => {
      let steps: any[] = [];
      try { steps = JSON.parse(r.stepsJson || "[]"); } catch { steps = []; }
      const done = steps.filter((s) => s.status === "done").length;
      const skipped = steps.filter((s) => s.status === "skipped").length;
      const failed = steps.filter((s) => s.status === "failed").length;
      return {
        ...r,
        stepsJson: undefined, // replaced by `steps` below
        steps,
        stepCount: steps.length,
        stepRollup: { done, skipped, failed },
        summary: safeParse(r.summaryJson),
        stats: safeParse(r.statsJson),
      };
    });

    return NextResponse.json({ runs: parsed });
  } catch (err: any) {
    return NextResponse.json({ error: safeErrorMessage(err, "Failed to load task runs.") }, { status: 500 });
  }
}

/**
 * DELETE /api/task-runs?id=xxx — remove one run record (housekeeping; the
 * run's article/paragraphs are NOT touched — only the timeline entry).
 */
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Missing 'id'." }, { status: 400 });
    }
    await db.taskRun.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: safeErrorMessage(err, "Failed to delete task run.") }, { status: 500 });
  }
}

function safeParse(v: string | null): any {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
