import { NextRequest, NextResponse } from "next/server";
import { PROVIDER_CATALOG, getProviderProfile } from "@/lib/provider-catalog";
import {
  listApiProvidersWithStatus,
  setApiProviderConfig,
  deleteApiProviderConfig,
  resolveApiKey,
} from "@/lib/api-provider-config";
import { getSelectedProvider, setSelectedProvider } from "@/lib/llm-selection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/llm-config/providers
 *   → { providers: ApiProviderStatus[], defaultProvider: string }
 *
 * Lists the full DSH-mode provider catalog with per-provider availability
 * (API key configured / env var set / keyless local runtime), effective
 * baseURL + model, and whether the user has overrides stored.
 */
export async function GET() {
  try {
    return NextResponse.json({
      providers: listApiProvidersWithStatus(),
      defaultProvider: getSelectedProvider(),
    });
  } catch (err: any) {
    console.error("[/api/llm-config/providers] GET error:", err);
    return NextResponse.json({ providers: [], defaultProvider: "zai-sdk" }, { status: 200 });
  }
}

/**
 * POST /api/llm-config/providers
 *   Body: { providerId, apiKey?, baseURL?, defaultModel?, enabled?, setDefault?, model? }
 *
 * Saves a provider's config (API key + base URL + default model) to
 * ~/.sciwrite/api-providers.json. When `setDefault` is true the provider is
 * also made the active LLM provider (selection id `api:<providerId>`); the
 * optional `model` field persists a per-selection model override.
 */
export async function POST(req: NextRequest) {
  let body: {
    providerId?: string;
    apiKey?: string;
    baseURL?: string;
    defaultModel?: string;
    enabled?: boolean;
    setDefault?: boolean;
    model?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const providerId = (body.providerId ?? "").toString().trim();
  if (!providerId) {
    return NextResponse.json({ error: "providerId is required." }, { status: 400 });
  }
  // Validate against the catalog BEFORE persisting — the credentials store
  // and the selection store are both keyed by catalog ids.
  if (!getProviderProfile(providerId)) {
    return NextResponse.json(
      { error: `providerId must be one of: ${PROVIDER_CATALOG.map((p) => p.id).join(", ")}` },
      { status: 400 },
    );
  }

  // "Set as default" action — also accepts a model override.
  if (body.setDefault) {
    const model = typeof body.model === "string" ? body.model : undefined;
    setSelectedProvider(`api:${providerId}`, model);
    return NextResponse.json({ ok: true, provider: `api:${providerId}` });
  }

  setApiProviderConfig(providerId, {
    ...(body.apiKey !== undefined ? { apiKey: body.apiKey.trim() || undefined } : {}),
    ...(body.baseURL !== undefined ? { baseURL: body.baseURL.trim() || undefined } : {}),
    ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel.trim() || undefined } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
  });

  return NextResponse.json({
    ok: true,
    providerId,
    hasKey: !!resolveApiKey(providerId),
  });
}

/**
 * DELETE /api/llm-config/providers?providerId=xxx
 *   Removes the stored config (API key + overrides) for a provider.
 *   If the deleted provider is the currently selected default, the selection
 *   resets to zai-sdk so no dangling api: selection remains.
 */
export async function DELETE(req: NextRequest) {
  const providerId = req.nextUrl.searchParams.get("providerId");
  if (!providerId) {
    return NextResponse.json({ error: "providerId query param is required." }, { status: 400 });
  }
  if (!getProviderProfile(providerId)) {
    return NextResponse.json({ error: `Unknown provider: ${providerId}` }, { status: 404 });
  }
  deleteApiProviderConfig(providerId);
  if (getSelectedProvider() === `api:${providerId}`) {
    setSelectedProvider("zai-sdk");
  }
  return NextResponse.json({ ok: true });
}
