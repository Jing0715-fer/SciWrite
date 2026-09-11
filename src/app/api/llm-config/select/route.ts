import { NextRequest, NextResponse } from "next/server";
import {
  setSelectedProvider,
  getSelectedProvider,
  getSelectedModel,
  getRoleSelections,
  hasReviewOverride,
  type LlmRole,
} from "@/lib/llm-selection";
import { inspectProviders } from "@/lib/llm";
import { getProviderProfile } from "@/lib/provider-catalog";
import { isApiProviderAvailable } from "@/lib/api-provider-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/llm-config/select
 *   Returns the currently selected provider id + model override — for BOTH
 *   pipeline roles (round-66 generation/review split):
 *   {
 *     provider: "api:minimax",           // generate role (legacy field kept)
 *     model: "MiniMax-M2",
 *     roles: {
 *       generate: { provider: "api:minimax", model: "MiniMax-M2" },
 *       review:   { provider: "cli:codebuddy", model: "Deepseek-V4.1-Flash" } | null
 *     },
 *     reviewOverride: true
 *   }
 *   `roles.review === null` means the review role FOLLOWS the generate
 *   selection (legacy single-provider behavior).
 */
export async function GET() {
  const roles = getRoleSelections();
  return NextResponse.json({
    provider: getSelectedProvider("generate"),
    model: getSelectedModel("generate"),
    roles,
    reviewOverride: hasReviewOverride(),
  });
}

/**
 * POST /api/llm-config/select
 *   Body: { provider: string, model?: string, role?: "generate" | "review" }
 *   Persists the user's choice (default role "generate") so subsequent LLM
 *   calls in `src/lib/ai.ts` dispatch through the matching adapter in
 *   `@/lib/llm`. Passing `provider: ""` with `role: "review"` CLEARS the
 *   review override — review goes back to following the generate selection.
 *
 * Validates the provider id against `inspectProviders()` so a stale UI
 * choice (e.g. uninstalled CLI) falls back to "zai-sdk" automatically.
 * Round-18: `api:<catalogId>` ids (DSH-mode OpenAI-compatible providers)
 * are validated against the catalog + stored key instead of the CLI probe.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const provider = (body?.provider ?? "").toString().trim();
  const roleRaw = (body?.role ?? "generate").toString().trim();
  const role: LlmRole = roleRaw === "review" ? "review" : "generate";

  // Clearing the review override: provider "" (or "follow"/"inherit") + role review.
  if (role === "review" && (!provider || provider === "follow" || provider === "inherit")) {
    setSelectedProvider("", undefined, "review");
    return NextResponse.json({
      ok: true,
      provider: getSelectedProvider("generate"),
      model: getSelectedModel("generate"),
      roles: getRoleSelections(),
      reviewOverride: false,
    });
  }

  if (!provider) {
    return NextResponse.json({ error: "Missing 'provider'." }, { status: 400 });
  }
  const model = typeof body?.model === "string" ? body.model.trim() : undefined;

  // Allow a small set of well-known ids without re-probing the world.
  const KNOWN = new Set([
    "zai-sdk",
    "cli:hermes",
    "cli:claude",
    "cli:codex",
    "cli:gemini",
    "cli:openclaw",
    "cli:codebuddy",
    "cli:aider",
    "anthropic",
    "openai",
  ]);

  // DSH-mode api providers: valid when they exist in the catalog AND have a
  // usable key (stored config or env var). Keyless local runtimes (Ollama)
  // count as available.
  if (provider.startsWith("api:")) {
    const profile = getProviderProfile(provider.slice("api:".length));
    if (!profile) {
      return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
    }
    if (!isApiProviderAvailable(profile.id)) {
      return NextResponse.json(
        {
          error: `${profile.displayName} has no API key configured — save one in the API Providers section first.`,
        },
        { status: 409 },
      );
    }
    setSelectedProvider(provider, model, role);
    return NextResponse.json({
      ok: true,
      provider: getSelectedProvider(role),
      model: getSelectedModel(role),
      roles: getRoleSelections(),
      reviewOverride: hasReviewOverride(),
    });
  }

  if (!KNOWN.has(provider)) {
    return NextResponse.json(
      { error: `Unknown provider: ${provider}` },
      { status: 400 },
    );
  }

  // For CLI providers, verify the binary is actually still detectable. If
  // not, reject so the user gets a clear error rather than silent fallback
  // to zai-sdk.
  if (provider.startsWith("cli:")) {
    try {
      const { available } = await inspectProviders({ showUnavailable: false });
      const stillThere = available.some(
        (p) => p.provider === provider && p.available,
      );
      if (!stillThere) {
        return NextResponse.json(
          {
            error: `Provider ${provider} is not currently detectable. Run /api/llm/refresh and retry.`,
          },
          { status: 409 },
        );
      }
    } catch {
      // If inspectProviders itself errors out (e.g. WSL probe hang), allow
      // the selection — server-side dispatch will fail visibly on first use.
    }
  }

  setSelectedProvider(provider, model, role);
  return NextResponse.json({
    ok: true,
    provider: getSelectedProvider(role),
    model: getSelectedModel(role),
    roles: getRoleSelections(),
    reviewOverride: hasReviewOverride(),
  });
}
