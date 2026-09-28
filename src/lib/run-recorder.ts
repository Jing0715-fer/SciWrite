import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getSelectedProvider, getSelectedModel } from "@/lib/llm-selection";

/**
 * TaskRunRecorder — ClawsGO Science-inspired run timeline persistence.
 *
 * "可追溯、可复现：每个动作都有时间线记录，整次运行可重放" —
 * every pipeline launch gets a persisted TaskRun row; every step event
 * observed through the SSE `send()` funnel is appended to stepsJson with
 * its own timestamp + duration so the Run Timeline UI can replay the run
 * after the fact (which steps ran, in what order, how long each took,
 * what it produced, and why it stopped).
 *
 * Hard design rules:
 *  - Recording must NEVER break or slow the pipeline: every DB touch is
 *    fire-and-forget with swallowed errors, and step events are flushed on
 *    a trailing throttle so a per-section streaming burst (hundreds of
 *    events) does not translate into hundreds of UPDATEs.
 *  - The recorder is a pure observer: it has no opinion on event ordering,
 *    it just stamps what it sees (the PipelineProgressTracker remains the
 *    single source of truth for progress math).
 */

export interface TaskStepEvent {
  step: string;
  status: string; // started | done | skipped | failed | streaming | info
  message?: string;
  ts: number; // epoch ms — when the event was observed
  ms?: number; // step duration, when the source event carried one
  progress?: number;
  section?: number;
  total?: number;
}

const MAX_STEPS = 900; // cap the JSON array (per-section loops can be long)
const FLUSH_INTERVAL_MS = 2500; // trailing throttle for stepsJson updates

export interface TaskRunMeta {
  projectId: string;
  runId: string;
  pipeline: string; // "v1" | "v2"
  topic?: string;
  language?: string;
  targetWords?: number;
  trigger?: string;
  resumed?: boolean;
}

export class TaskRunRecorder {
  private readonly meta: TaskRunMeta;
  private steps: TaskStepEvent[] = [];
  private lastFlushAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private rowId: string | null = null;
  private settled = false; // complete/fail/abort already recorded
  private startedAt = Date.now();
  private readonly log = logger("task-run-recorder");

  constructor(meta: TaskRunMeta) {
    this.meta = meta;
  }

  /** Create the TaskRun row (swallows every failure — observer only). */
  async start(): Promise<void> {
    let providerSnap: string | undefined;
    let modelSnap: string | undefined;
    try {
      providerSnap = JSON.stringify({
        generate: getSelectedProvider("generate"),
        review: getSelectedProvider("review"),
      });
      modelSnap = JSON.stringify({
        generate: getSelectedModel("generate"),
        review: getSelectedModel("review"),
      });
    } catch {}
    try {
      const row = await db.taskRun.create({
        data: {
          projectId: this.meta.projectId,
          runId: this.meta.runId,
          pipeline: this.meta.pipeline,
          topic: this.meta.topic ?? null,
          language: this.meta.language ?? null,
          targetWords: this.meta.targetWords ?? null,
          provider: providerSnap ?? null,
          model: modelSnap ?? null,
          status: "running",
          trigger: this.meta.trigger ?? "manual",
          resumed: this.meta.resumed ?? false,
          stepsJson: "[]",
        },
      });
      this.rowId = row.id;
    } catch (err: any) {
      // Never let timeline persistence brick a run.
      try { this.log.warn(`start failed (recording disabled): ${String(err?.message ?? err).slice(0, 120)}`); } catch {}
    }
  }

  /**
   * Observe an SSE event. Call with the SAME (event, data) pairs the route
   * sends on the wire. Only "step" events carry timeline records; the
   * terminal events (complete/error) are handled by complete()/fail().
   */
  onEvent(event: string, data: any): void {
    if (!this.rowId || this.settled) return;
    if (event !== "step" || !data || typeof data !== "object") return;
    const { step, status } = data;
    if (typeof step !== "string" || typeof status !== "string") return;
    // "streaming" partials are high-frequency — record a compact sample
    // (the UI live-previews the stream anyway; the timeline only needs the
    // cadence, not every token chunk).
    if (status === "streaming") {
      const last = this.steps[this.steps.length - 1];
      if (last && last.step === step && last.status === "streaming") return;
    }
    const rec: TaskStepEvent = {
      step,
      status,
      ts: Date.now(),
      ...(typeof data.message === "string" ? { message: data.message.slice(0, 400) } : {}),
      ...(typeof data.ms === "number" ? { ms: data.ms } : {}),
      ...(typeof data.progress === "number" ? { progress: data.progress } : {}),
      ...(typeof data.section === "number" ? { section: data.section } : {}),
      ...(typeof data.total === "number" ? { total: data.total } : {}),
    };
    this.steps.push(rec);
    if (this.steps.length > MAX_STEPS) this.steps = this.steps.slice(-MAX_STEPS);
    this.scheduleFlush();
  }

  /** Mark the run completed with its summary + stats payload. */
  async complete(summary: Record<string, any>, stats?: Record<string, any>): Promise<void> {
    if (!this.rowId || this.settled) return;
    this.settled = true;
    await this.flushNow({
      status: "completed",
      summaryJson: safeJson(summary),
      statsJson: stats ? safeJson(stats) : null,
      finishedAt: new Date(),
      durationMs: Date.now() - this.startedAt,
    });
  }

  /** Mark the run failed with the error message. */
  async fail(errorMsg: string): Promise<void> {
    if (!this.rowId || this.settled) return;
    this.settled = true;
    this.pushTerminal("pipeline", "failed", errorMsg);
    await this.flushNow({
      status: "failed",
      error: errorMsg.slice(0, 500),
      finishedAt: new Date(),
      durationMs: Date.now() - this.startedAt,
    });
  }

  /** Mark the run aborted (client disconnect / rate-limit stop). */
  async abort(reason: string): Promise<void> {
    if (!this.rowId || this.settled) return;
    this.settled = true;
    this.pushTerminal("pipeline", "aborted", reason);
    await this.flushNow({
      status: "aborted",
      error: reason.slice(0, 500),
      finishedAt: new Date(),
      durationMs: Date.now() - this.startedAt,
    });
  }

  /**
   * Upgrade a FAILED run to "completed (partial)" — used by v1's catch-block
   * recovery, which composes and saves a partial article after the pipeline
   * errored. The timeline keeps the failure steps and appends the recovery
   * record, so the replay shows both what broke AND what was salvaged.
   */
  async finishPartial(summary: Record<string, any>): Promise<void> {
    if (!this.rowId) return;
    this.settled = true;
    this.pushTerminal(
      "recovery",
      "done",
      `Partial article saved after failure — ${summary.sections ?? "?"} section(s) salvaged.`,
    );
    await this.flushNow({
      status: "completed",
      summaryJson: safeJson({ ...summary, partial: true }),
      finishedAt: new Date(),
      durationMs: Date.now() - this.startedAt,
    });
  }

  private pushTerminal(step: string, status: string, message: string) {
    this.steps.push({ step, status, message: message.slice(0, 400), ts: Date.now() });
  }

  private scheduleFlush(): void {
    const now = Date.now();
    if (now - this.lastFlushAt >= FLUSH_INTERVAL_MS) {
      void this.flushNow();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, FLUSH_INTERVAL_MS - (now - this.lastFlushAt));
  }

  private async flushNow(extra?: Record<string, any>): Promise<void> {
    if (!this.rowId) return;
    this.lastFlushAt = Date.now();
    try {
      await db.taskRun.update({
        where: { id: this.rowId },
        data: {
          stepsJson: safeJson(this.steps) ?? "[]",
          ...(extra ?? {}),
        },
      });
    } catch {}
  }
}

function safeJson(v: any): string | null {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}
