import { NextResponse } from "next/server";
import { getQuotaSnapshot, getWindowCount, isAborted } from "@/lib/rate-limiter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/quota-status
 *
 * Returns the cached LLM quota state for the current process:
 *  - dailyRemaining: calls remaining today (from x-ratelimit-user-daily-remaining)
 *  - dailyLimit: total daily limit (from x-ratelimit-user-daily-limit)
 *  - windowCount: calls in the last 10 minutes (sliding window)
 *  - coolDownActive: whether a 60s cool-down is currently enforced
 *  - aborted: whether the abort flag is set (rate-limit / quota event)
 *
 * NOTE: This is process-local state. In a multi-instance deployment,
 * each instance has its own quota cache — the actual remaining quota
 * is tracked by the provider. This endpoint is for UI hint purposes.
 */
export async function GET() {
  const snap = getQuotaSnapshot();
  const win = getWindowCount();
  return NextResponse.json({
    dailyRemaining: snap.dailyRemaining ?? null,
    dailyLimit: snap.dailyLimit ?? null,
    windowCount: win,
    windowThreshold: 15,
    coolDownActive: win >= 15,
    aborted: isAborted(),
    lastUpdated: new Date().toISOString(),
  });
}
