import { NextResponse } from "next/server";
import { getLLMCacheStats, clearLLMCache } from "@/lib/llm-cache";

export const runtime = "nodejs";

/**
 * GET /api/llm-cache/stats
 *
 * Returns the current LLM cache stats: size (number of cached entries),
 * hits, misses, hitRate (percentage). Used by the LLM Configuration dialog
 * to show the user how effective the cache is.
 */
export async function GET() {
  const stats = getLLMCacheStats();
  return NextResponse.json({ stats });
}

/**
 * DELETE /api/llm-cache/stats
 *
 * Clears the LLM cache manually. The user can trigger this from the LLM
 * Configuration dialog's "Clear cache" button to force fresh LLM calls
 * on the next generation.
 */
export async function DELETE() {
  clearLLMCache();
  return NextResponse.json({ ok: true, message: "LLM cache cleared." });
}
