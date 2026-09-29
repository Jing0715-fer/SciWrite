import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { safeErrorMessage } from "@/lib/api-helpers";
import { runWatch } from "@/lib/run-watch";

export const runtime = "nodejs";

/**
 * GET /api/task-runs?projectId=xxx&limit=20
 *
 * round-cs-1 (ClawsGO Science-inspired "可追溯、可复现"): list persisted
 * pipeline runs for a project — the replayable "run timeline". Each row
 * carries the full per-step records (stepsJson), the launch config snapshot
 * (provider/model transparency), and the final summary/stats.
 *
 * round-cs-8: this endpoint is also the LIVE-PROGRESS RECOVERY source —
 * when the SSE wire drops mid-run, the writing dialog polls this route
 * and renders the persisted stepsJson as the progress log. Two
 * consequences:
 *  1. every GET touches the run-watch registry (lib/run-watch.ts) so the
 *     v2 pipeline knows a client is still watching a disconnected run;
 *  2. the zombie sweep must be LIVENESS-AWARE, not age-aware. The old rule
 *     ("running" AND startedAt older than 45 min → aborted) falsely killed
 *     LIVE long runs — bilingual v2 pipelines routinely exceed 45 min end
 *     to end (a 171-source knowledge pass alone can take ~1h), and the
 *     recovery poller reads these rows mid-run. A run is a zombie only
 *     when its timeline has been SILENT: the recorder flushes stepsJson
 *     within ~2.5s of every step event, so a live run's last step ts is
 *     always fresh, while a dev-server restart leaves it frozen forever.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");
    if (!projectId) {
      return NextResponse.json({ error: "Missing 'projectId'." }, { status: 400 });
    }
    const limit = Math.max(1, Math.min(50, Number(searchParams.get("limit")) || 20));

    // round-cs-8: this read is a liveness signal — a client is watching
    // this project's runs (recovery poller or the timeline UI).
    runWatch.touch(projectId);

    // --- Zombie sweep (liveness-aware, bounded by projectId) ---
    // A "running" row is only a zombie when its timeline has been silent
    // for STALE_STEP_MS (no step event for 20 min ⇒ the recording process
    // is gone; live runs flush at least one step every few minutes even in
    // their quietest phases). Age alone (the old 45-min startedAt rule) is
    // NOT evidence of death for hours-long bilingual runs.
    const STALE_STEP_MS = 20 * 60 * 1000;
    try {
      const runningRows = await db.taskRun.findMany({
        where: { projectId, status: "running" },
        select: { id: true, stepsJson: true, startedAt: true },
      });
      const now = Date.now();
      for (const row of runningRows) {
        let lastTs = new Date(row.startedAt).getTime() || 0;
        try {
          const steps = JSON.parse(row.stepsJson || "[]");
          const last = Array.isArray(steps) ? steps[steps.length - 1] : null;
          if (typeof last?.ts === "number" && last.ts > lastTs) lastTs = last.ts;
        } catch {}
        if (now - lastTs > STALE_STEP_MS) {
          await db.taskRun.update({
            where: { id: row.id },
            data: {
              status: "aborted",
              error: "run interrupted (server restart or crash) — timeline preserved",
              finishedAt: new Date(),
            },
          });
        }
      }
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
