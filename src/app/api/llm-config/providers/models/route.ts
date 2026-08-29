import { NextRequest, NextResponse } from "next/server";
import { getProviderProfile } from "@/lib/provider-catalog";
import { resolveApiKey, resolveBaseURL } from "@/lib/api-provider-config";

export const runtime = "nodejs";
export const maxDuration = 20;
export const dynamic = "force-dynamic";

/**
 * GET /api/llm-config/providers/models?providerId=xxx[&apiKey=...][&baseURL=...]
 *
 * Fetches the LIVE model list from a provider's OpenAI-compatible
 * GET {baseURL}/models endpoint. Falls back to the catalog's static model
 * list when no key is available or the endpoint errors — the UI always has
 * something to show, plus a warning explaining why.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const providerId = searchParams.get("providerId") ?? "";
  const profile = getProviderProfile(providerId);
  if (!profile) {
    return NextResponse.json({ error: `Unknown provider: ${providerId}` }, { status: 404 });
  }

  const catalogModels = profile.models.map((m) => ({ id: m.id, name: m.name }));

  // Key resolution: explicit query param (unsaved input in the UI) → stored
  // config → env var. Local runtimes (Ollama) work without a key.
  const queryApiKey = searchParams.get("apiKey")?.trim() || "";
  const apiKey = queryApiKey || resolveApiKey(providerId);
  const queryBase = searchParams.get("baseURL")?.trim() || "";
  const base = (queryBase || resolveBaseURL(providerId) || profile.baseURL).replace(/\/+$/, "");

  if (!apiKey && !profile.apiKeyOptional) {
    return NextResponse.json({
      models: catalogModels,
      warning: "No API key configured — showing catalog models only. Enter a key and retry to fetch live models.",
    });
  }

  const authHeader = profile.authHeader ?? "Authorization";
  const authPrefix = profile.authPrefix ?? "Bearer ";
  const headers: Record<string, string> = {
    [authHeader]: `${authPrefix}${apiKey || "ollama"}`,
    ...(profile.extraHeaders ?? {}),
  };

  try {
    const resp = await fetch(`${base}/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      return NextResponse.json({
        models: catalogModels,
        error: `API returned ${resp.status}: ${errText.slice(0, 200)}`,
      });
    }
    const raw = await resp.text();
    if (raw.trimStart().startsWith("<")) {
      return NextResponse.json({
        models: catalogModels,
        error: "Endpoint returned HTML — the base URL is probably wrong.",
      });
    }
    const json = JSON.parse(raw) as { data?: Array<{ id: string }> };
    const live = (json.data ?? [])
      .map((m) => (typeof m?.id === "string" ? m.id : ""))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (live.length === 0) {
      return NextResponse.json({
        models: catalogModels,
        warning: "Provider returned an empty model list — showing catalog models.",
      });
    }
    return NextResponse.json({ models: live.map((id) => ({ id, name: id })) });
  } catch (err: any) {
    return NextResponse.json({
      models: catalogModels,
      error: `Fetch failed: ${err?.message ?? String(err)}`,
    });
  }
}
