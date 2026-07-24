/**
 * GET /api/llm/providers
 *
 * LLM provider detection (ported from pdb-tracker-web-v4). Reports which
 * providers are available so the UI can render the selector pills.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { inspectProviders } from "@/lib/llm";

export async function GET(request: Request) {
  const url = new URL(request.url);
  // Default hidden: only show providers that actually work.
  // `?all=1` makes the panel render dim "unavailable" entries for context.
  // `?whitelist=claude,zai-sdk` filters down to a chosen subset.
  const showUnavailable = url.searchParams.get("all") === "1";
  const whitelistParam = url.searchParams.get("whitelist");
  const whitelist = whitelistParam
    ? whitelistParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const inspection = await inspectProviders({ showUnavailable, whitelist });
  return Response.json({
    env: {
      provider: process.env.LLM_PROVIDER || "",
      apiKey: process.env.ANTHROPIC_API_KEY
        ? "***"
        : process.env.OPENAI_API_KEY
          ? "***"
          : "",
      baseUrl: process.env.LLM_BASE_URL || "",
      model: process.env.LLM_MODEL || "",
    },
    chosen: inspection.chosen,
    available: inspection.available,
    totalClisScanned: inspection.totalClisScanned,
  });
}
