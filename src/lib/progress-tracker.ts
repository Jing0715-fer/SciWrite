/**
 * round-52: pipeline progress tracker — maps SSE step events to a weighted,
 * strictly monotonic 0-100 progress value.
 *
 * WHY THIS EXISTS: the one-click generation pipeline's progress bar used to
 * be `(stepIndex + 1) / totalSteps` — every step an equal ~10% slice. But the
 * generate + verify stages loop over N sections (each an LLM write + an
 * adversarial citation check) and typically own 60-80% of the wall clock;
 * translate loops per section too. With the old bar those loops got a fixed
 * ~10% each and — worse — the per-section event interleave
 * (generate.started §i → verify.started §i → generate.started §i+1) made the
 * bar visibly OSCILLATE 8→9→8→9 for the entire loop (user-reported
 * regression).
 *
 * MODEL: phases get bar regions proportional to expected wall-clock weight.
 * Consecutive loop phases (generate + verify) share one contiguous "family"
 * region divided into per-section units, so the bar sweeps smoothly across
 * the whole loop: each section's generate→verify alternation moves it
 * FORWARD, never backward. The section count is learned from the plan event
 * (`sectionCount`) or from the first loop event's `total`, and the layout is
 * renormalized (the monotonic max-clamp absorbs any shift). Every emitted
 * value is non-decreasing — this class is the single source of truth for
 * "the bar must never go backwards".
 *
 * USAGE (route):
 *   const rawSend = (event, data) => controller.enqueue(...);      // existing send
 *   const tracker = new PipelineProgressTracker([
 *     { step: "gather", weight: 2.2 },
 *     ...
 *     { step: "generate", unitWeight: 2 },   // loop phases: weight per section
 *     { step: "verify",   unitWeight: 0.9 }, // consecutive loops share a family
 *     { step: "compose",  weight: 0.5 },
 *   ]);
 *   const send = (event, data) => {
 *     if (event === "step" && data && typeof data === "object") {
 *       const progress = tracker.onEvent(data);
 *       if (progress != null) return rawSend(event, { ...data, progress });
 *     }
 *     rawSend(event, data);
 *   };
 *
 * The frontend reads `data.progress` (0-100) and renders it with a
 * Math.max clamp — belt and suspenders against any future out-of-order emit.
 */

export interface ProgressPhase {
  /** Step id exactly as emitted in send("step", { step: "..." }). */
  step: string;
  /**
   * Fixed phase: relative wall-clock weight of the whole phase.
   * Defaults to 1. Ignored when unitWeight is present.
   */
  weight?: number;
  /**
   * Loop phase: weight PER ITERATION (the phase family's total share is
   * unitWeight × N where N = the learned iteration count). Consecutive
   * loop phases share one family region interleaved per iteration —
   * this is what makes the generate↔verify per-section alternation move
   * the bar forward instead of bouncing it between two step slots.
   */
  unitWeight?: number;
}

interface FamilyEntry {
  kind: "family";
  steps: string[];
  unitWeights: number[];
  familyIdx: number;
}

interface FixedEntry {
  kind: "fixed";
  step: string;
  weight: number;
}

type Entry = FixedEntry | FamilyEntry;

interface LoopGeometry {
  /** Bar % where the family's region starts. */
  familyStart: number;
  /** Bar % where the family's region ends. */
  familyEnd: number;
  /** Learned iteration count (sections). */
  n: number;
  /** Bar % span of ONE iteration's unit. */
  unitShare: number;
  /** Offset from the unit start where THIS phase's sub-slice begins. */
  offsetInUnit: number;
  /** Bar % length of this phase's sub-slice within a unit. */
  subShare: number;
}

interface FixedGeometry {
  start: number;
  end: number;
}

interface TrackedStep {
  kind: "fixed" | "loop";
  entryIdx: number;
  memberIdx?: number;
}

export class PipelineProgressTracker {
  private readonly entries: Entry[] = [];
  private readonly stepIndex = new Map<string, TrackedStep>();
  private readonly familyN: number[] = [];
  private readonly defaultN: number;
  /** translate-style streaming: per (step|section) char estimate for interpolation. */
  private readonly charEstimate = new Map<string, number>();
  /** Loop-phase per-unit crawl state: `${step}|${section}` → fraction of the
   * sub-slice walked so far (fallback when an event carries neither chunk
   * positions nor accumulated length). */
  private readonly unitCrawl = new Map<string, number>();
  /** Fixed-phase crawl state: step id → fraction (0-1) walked through the
   * phase so far. Long phases emit MANY sequential progress events (gather:
   * one per database query, ~20-30s apart) — a constant mid-phase nudge
   * would pin the bar for minutes; the asymptotic crawl advances a shrinking
   * step per event so the bar keeps visibly moving without ever claiming the
   * phase is done before its "done" event. */
  private readonly fixedCrawl = new Map<string, number>();
  private last = 0;
  private finished = false;
  // null sentinel (not "") — a loop-less phase list makes familyN.join("|")
  // return "", which would match the initial "" and skip the first layout.
  private lastLayoutKey: string | null = null;
  private fixedGeo = new Map<string, FixedGeometry>();
  private loopGeo = new Map<string, LoopGeometry>();

  constructor(phases: ProgressPhase[], defaultLoopN = 8) {
    this.defaultN = Math.max(1, Math.floor(defaultLoopN));
    let familyCounter = 0;
    let lastWasLoop = false;
    for (const p of phases) {
      const step = String(p.step || "");
      if (!step) continue;
      if (p.unitWeight != null && p.unitWeight > 0) {
        const prev = this.entries[this.entries.length - 1];
        if (lastWasLoop && prev && prev.kind === "family") {
          prev.steps.push(step);
          prev.unitWeights.push(p.unitWeight);
          this.stepIndex.set(step, { kind: "loop", entryIdx: this.entries.length - 1, memberIdx: prev.steps.length - 1 });
        } else {
          const entry: FamilyEntry = { kind: "family", steps: [step], unitWeights: [p.unitWeight], familyIdx: familyCounter++ };
          this.entries.push(entry);
          this.stepIndex.set(step, { kind: "loop", entryIdx: this.entries.length - 1, memberIdx: 0 });
        }
        lastWasLoop = true;
      } else {
        const weight = Math.max(0.05, p.weight ?? 1);
        this.entries.push({ kind: "fixed", step, weight });
        this.stepIndex.set(step, { kind: "fixed", entryIdx: this.entries.length - 1 });
        lastWasLoop = false;
      }
    }
    this.familyN = new Array(familyCounter).fill(this.defaultN);
  }

  /**
   * Feed one SSE step-event payload through the tracker; returns the progress
   * value to attach (0-100, non-decreasing), or null when the event belongs
   * to no tracked phase (init / audit / post-pipeline extras) — in that case
   * the caller should forward the event undecorated.
   */
  onEvent(data: {
    step?: string;
    status?: string;
    section?: number;
    total?: number;
    sectionCount?: number;
    chunk?: number;
    totalChunks?: number;
    accumulatedLength?: number;
    wordCount?: number;
    [k: string]: unknown;
  }): number | null {
    if (this.finished) return 100;
    const step = data?.step;
    if (typeof step !== "string") return null;
    const tracked = this.stepIndex.get(step);
    if (!tracked) return null;
    const status = String(data?.status ?? "");

    // ---- Learn the real iteration count ----
    // The plan step's done event carries sectionCount (both v1 and v2); loop
    // events carry `total` per family (translate's total can differ from the
    // section count when sections were skipped — per-family learning
    // corrects that on the first translate event).
    if (typeof data.sectionCount === "number" && data.sectionCount > 0) {
      for (let i = 0; i < this.familyN.length; i++) this.familyN[i] = data.sectionCount;
      this.invalidateLayout();
    }
    if (tracked.kind === "loop") {
      const famIdx = (this.entries[tracked.entryIdx] as FamilyEntry).familyIdx;
      if (typeof data.total === "number" && data.total > 0 && this.familyN[famIdx] !== data.total) {
        this.familyN[famIdx] = data.total;
        this.invalidateLayout();
      }
    }

    this.ensureLayout();
    const pct = this.computeFor(tracked, status, data);
    if (pct == null) return null;
    // Monotonic max-clamp + a hair under 100 so the "complete" moment (not a
    // step event) stays the only thing that finishes the bar.
    const val = Math.max(this.last, Math.min(99.4, pct));
    this.last = val;
    return Math.round(val * 10) / 10;
  }

  /** Terminal state — call when the pipeline completes. */
  finish(): number {
    this.finished = true;
    this.last = 100;
    return 100;
  }

  private invalidateLayout() {
    this.lastLayoutKey = null;
  }

  private ensureLayout() {
    const key = this.familyN.join("|");
    if (key === this.lastLayoutKey) return;
    this.lastLayoutKey = key;
    this.fixedGeo = new Map();
    this.loopGeo = new Map();

    let total = 0;
    for (const e of this.entries) {
      total += e.kind === "fixed" ? e.weight : e.unitWeights.reduce((a, b) => a + b, 0) * this.familyN[e.familyIdx];
    }
    const scale = 100 / Math.max(0.0001, total);
    let cum = 0;
    for (const e of this.entries) {
      if (e.kind === "fixed") {
        const span = e.weight * scale;
        this.fixedGeo.set(e.step, { start: cum, end: cum + span });
        cum += span;
      } else {
        const familySpan = e.unitWeights.reduce((a, b) => a + b, 0) * this.familyN[e.familyIdx] * scale;
        const n = Math.max(1, this.familyN[e.familyIdx]);
        const unitShare = familySpan / n;
        const unitWeightSum = e.unitWeights.reduce((a, b) => a + b, 0);
        let subCum = 0;
        for (let m = 0; m < e.steps.length; m++) {
          const subShare = (e.unitWeights[m] / unitWeightSum) * unitShare;
          this.loopGeo.set(e.steps[m], {
            familyStart: cum,
            familyEnd: cum + familySpan,
            n,
            unitShare,
            offsetInUnit: subCum,
            subShare,
          });
          subCum += subShare;
        }
        cum += familySpan;
      }
    }
  }

  private computeFor(tracked: TrackedStep, status: string, data: Record<string, unknown>): number | null {
    if (tracked.kind === "fixed") {
      const step = (this.entries[tracked.entryIdx] as FixedEntry).step;
      const geo = this.fixedGeo.get(step);
      if (!geo) return null;
      if (status === "started") {
        this.fixedCrawl.set(step, 0.15);
        return geo.start;
      }
      if (status === "done") {
        this.fixedCrawl.delete(step);
        return geo.end;
      }
      if (status === "progress" || status === "streaming") {
        // Asymptotic crawl: each progress event advances a shrinking step
        // through the phase's slice (first event ≈ 35%, approaching 92%).
        // Idempotent-safe: repeated events never exceed the phase end, and
        // the monotonic max-clamp absorbs any backward step.
        const prev = this.fixedCrawl.get(step) ?? 0.15;
        const next = Math.min(0.92, prev + (0.95 - prev) * 0.25);
        this.fixedCrawl.set(step, next);
        return geo.start + (geo.end - geo.start) * next;
      }
      return null;
    }

    const step = (this.entries[tracked.entryIdx] as FamilyEntry).steps[tracked.memberIdx ?? 0];
    const geo = this.loopGeo.get(step);
    if (!geo) return null;

    if (typeof data.section !== "number") {
      // Family-level event (e.g. the outer "Translating N sections..."
      // started before the per-section loop begins).
      if (status === "started") return geo.familyStart;
      if (status === "done") return geo.familyEnd;
      return null;
    }

    const i = Math.max(1, Math.min(geo.n, Math.floor(data.section)));
    const unitStart = geo.familyStart + (i - 1) * geo.unitShare;
    const subStart = unitStart + geo.offsetInUnit;

    if (status === "done" || status === "skipped" || status === "error") {
      // The whole section unit is finished (generate+verify both complete,
      // or the section was skipped) — advance to the next unit's start.
      return unitStart + geo.unitShare;
    }
    if (status === "started") {
      // Stash the EN word count for translate-style streaming interpolation,
      // and reset this unit's crawl (a new section starts its own walk).
      if (typeof data.wordCount === "number" && data.wordCount > 0) {
        this.charEstimate.set(`${step}|${i}`, data.wordCount * 1.8);
      }
      this.unitCrawl.delete(`${step}|${i}`);
      return subStart;
    }
    if (status === "progress" || status === "streaming") {
      return subStart + geo.subShare * this.estimateFraction(step, i, data);
    }
    return null;
  }

  /**
   * Intra-unit fraction for progress/streaming events:
   *  - v1 chunk events carry chunk/totalChunks → position within the section
   *  - v2 translate streaming carries accumulatedLength (+ wordCount stashed
   *    from the section's started event) → chars-written interpolation
   *  - otherwise an asymptotic per-unit crawl (each event advances a
   *    shrinking step toward the sub-slice end — long single LLM calls
   *    keep the bar moving instead of pinning it)
   */
  private estimateFraction(step: string, section: number, data: Record<string, unknown>): number {
    const key = `${step}|${section}`;
    let frac: number | null = null;
    const chunk = data.chunk;
    const totalChunks = data.totalChunks;
    if (typeof chunk === "number" && typeof totalChunks === "number" && totalChunks >= 1) {
      frac = Math.min(0.95, (Math.max(1, chunk) - 0.5) / totalChunks);
    } else if (typeof data.accumulatedLength === "number") {
      const est = this.charEstimate.get(key);
      if (est && est > 0) {
        const k = Math.max(0, Math.min(1, (data.accumulatedLength as number) / est));
        frac = Math.min(0.95, 0.1 + 0.85 * k);
      }
    }
    if (frac != null) {
      this.unitCrawl.set(key, frac);
      return frac;
    }
    const prev = this.unitCrawl.get(key) ?? 0.2;
    const next = Math.min(0.85, prev + (0.88 - prev) * 0.3);
    this.unitCrawl.set(key, next);
    return next;
  }
}
