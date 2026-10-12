/**
 * Session-context cost telemetry (RT9) — the RT8 backlog item 5:
 * "Session-context cost telemetry: assembleFinalPrompt now counts join
 * lengths — surface per-call context bytes in the stats block so the next
 * context-budget decision is data-driven."
 *
 * Until now the only visibility into prompt size was a console.log of the
 * BARE prompt length in chatWithSession — the session-context preamble
 * (assembleFinalPrompt output: system + history + user + ASSISTANT suffix)
 * was never measured anywhere. Deciding whether the 28K-char context
 * budget should shrink, or which taskType actually consumes it, required
 * guesswork.
 *
 * Design (mirrors skill/telemetry-collector):
 *   - MODULE-LEVEL, IN-PROCESS aggregate; the v2 route resets at pipeline
 *     start and reads at the complete event. One run at a time per
 *     process is the deployment reality.
 *   - Observer-only: every entry swallows its own errors — telemetry can
 *     never break a pipeline.
 *   - The metric is CHARS, not bytes: the context budget
 *     (SESSION_MAX_TOTAL_CHARS = 28000) is char-based, and the assembled
 *     prompt is what that budget actually gates.
 *   - Hooked from llm-session right after assembleFinalPrompt returns —
 *     one row per chatWithSession / chatWithSessionStream call, keyed by
 *     taskType. Statelesss calls record their (still self-contained)
 *     prompt size too, so the comparison "stateless vs context-loaded
 *     prompt cost" is measurable per family.
 */

interface PromptSizeAggregate {
  calls: number;
  totalChars: number;
  maxChars: number;
}

const aggregates = new Map<string, PromptSizeAggregate>();

/** llm-session hook — one row per assembled final prompt. */
export function recordSessionPromptSize(taskType: string, promptChars: number): void {
  try {
    const key = taskType || "unknown";
    const cur = aggregates.get(key) ?? { calls: 0, totalChars: 0, maxChars: 0 };
    cur.calls += 1;
    cur.totalChars += promptChars;
    if (promptChars > cur.maxChars) cur.maxChars = promptChars;
    aggregates.set(key, cur);
  } catch {
    // Observer-only: telemetry must never throw into the LLM call path.
  }
}

/** Snapshot for the complete-event stats block (per taskType). */
export function getSessionContextStats(): Record<
  string,
  { calls: number; totalChars: number; maxChars: number }
> {
  const out: Record<string, { calls: number; totalChars: number; maxChars: number }> = {};
  try {
    for (const [taskType, agg] of aggregates) {
      out[taskType] = { ...agg };
    }
  } catch {}
  return out;
}

/** The v2 route calls this at pipeline start (one run per reset). */
export function resetSessionContextStats(): void {
  try {
    aggregates.clear();
  } catch {}
}
