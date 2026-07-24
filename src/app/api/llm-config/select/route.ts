import { NextRequest, NextResponse } from "next/server";
import { setSelectedProvider, getSelectedProvider } from "@/lib/llm-selection";
import { inspectProviders } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/llm-config/select
 *   Returns the currently selected provider id.
 *   { provider: "cli:hermes" | "zai-sdk" | ... }
 */
export async function GET() {
  return NextResponse.json({ provider: getSelectedProvider() });
}

/**
 * POST /api/llm-config/select
 *   Body: { provider: string }
 *   Persists the user's choice so subsequent LLM calls in `src/lib/ai.ts`
 *   dispatch through the matching adapter in `@/lib/llm`.
 *
 *   Validates the provider id against `inspectProviders()` so a stale UI
 *   choice (e.g. uninstalled CLI) falls back to "zai-sdk" automatically.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const provider = (body?.provider ?? "").toString().trim();
  if (!provider) {
    return NextResponse.json({ error: "Missing 'provider'." }, { status: 400 });
  }

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

  setSelectedProvider(provider);
  return NextResponse.json({ ok: true, provider: getSelectedProvider() });
}
