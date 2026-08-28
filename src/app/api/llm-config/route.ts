import { NextRequest, NextResponse } from "next/server";
import { inspectProviders } from "@/lib/llm";
import { safeErrorMessage } from "@/lib/api-helpers";
import { listApiProvidersWithStatus } from "@/lib/api-provider-config";

export const runtime = "nodejs";
export const maxDuration = 60;

// Thin adapter: forward to the unified provider detection in @/lib/llm
// (ported from pdb-tracker-web-v4). The legacy `/api/llm-config` shape is
// preserved so the existing LLMConfigDialog keeps working without UI changes:
//
//   {
//     detected: [{ name, label, path, version, models, available }],
//     envKeys: { OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, ZAI_API_KEY },
//     defaultProvider, sdkAvailable
//   }
//
// Round-18 additions:
//   • `?fresh=1` — force a LIVE re-probe of every CLI adapter (bypasses both
//     the in-process and disk probe caches). The dialog's 重新检测 button uses
//     this; previously it could serve a stale cached snapshot, which is why
//     re-detection "did nothing" on machines where hermes/codex were installed
//     after the first probe.
//   • Configured OpenAI-compatible API providers (DSH-mode catalog) are
//     appended to `detected` with name `api:<id>` so the unified
//     click-to-select list shows them alongside the CLI agents.
export async function GET(req: NextRequest) {
  try {
    const fresh = req.nextUrl.searchParams.get("fresh") === "1";
    // showUnavailable: true so the dialog can render a row for every known
    // CLI provider — even adapters that weren't probed (cache miss) or that
    // failed the last probe. Without this, installing codebuddy and hitting
    // 重新检测 still wouldn't surface it as an option to choose.
    const { available } = await inspectProviders({ showUnavailable: true, force: fresh });

    const detected = available
      .filter((p) => p.available)
      .map((p) => {
        // CLI providers → derive a stable "name" the legacy dialog/test block
        // already understands (claude, codex, hermes, gemini, codebuddy, ...).
        // SDK providers → "z-ai-sdk" / "anthropic-sdk" / "openai-sdk".
        // API catalog providers → "api:<catalogId>" (DSH mode).
        const baseId = p.provider.replace(/^cli:/, "");
        let name = baseId;
        if (p.provider === "zai-sdk") name = "z-ai";
        if (p.provider === "anthropic") name = "anthropic-sdk";
        if (p.provider === "openai") name = "openai-sdk";
        if (p.provider.startsWith("api:")) name = p.provider;
        // Only keep the supported-by-dialog subset — CLI agents, the SDK
        // fallbacks, and every configured api: catalog provider.
        const supported = new Set([
          "claude",
          "codex",
          "hermes",
          "gemini",
          "openclaw",
          "codebuddy",
          "aider",
          "z-ai",
          "anthropic-sdk",
          "openai-sdk",
        ]);
        if (!supported.has(name) && !name.startsWith("api:")) return null;
        // Models known for configured api providers (catalog + override).
        let models: string[] = [];
        if (p.provider.startsWith("api:")) {
          const status = listApiProvidersWithStatus().find((s) => `api:${s.id}` === p.provider);
          if (status) {
            const ids = status.models.map((m) => m.id);
            models = ids.includes(status.effectiveModel) ? ids : [...ids, status.effectiveModel];
          }
        }
        return {
          name,
          label: p.label,
          // Dialog renders `cli.path`; for SDKs we synthesize a friendly
          // pseudo-path so the existing UI doesn't show "undefined".
          path: p.bin ?? `${p.via}:${p.provider}`,
          version: "",
          models,
          available: true,
          via: p.via,
        };
      })
      .filter(Boolean);

    const envKeys = {
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      GOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
      ZAI_API_KEY: !!process.env.ZAI_API_KEY,
    };

    return NextResponse.json({
      detected,
      envKeys,
      defaultProvider: "z-ai-sdk",
      sdkAvailable: true,
    });
  } catch (err: any) {
    console.error("[/api/llm-config] GET error:", err);
    return NextResponse.json(
      { detected: [], envKeys: {}, defaultProvider: "z-ai-sdk", sdkAvailable: true },
      { status: 200 },
    );
  }
}

// Test a CLI command — kept for the legacy "test CLI" panel in the dialog.
// The dialog sends `{ cli, prompt }`; we dispatch through @/lib/llm so any
// detected adapter can be tested through one path. Round-18: also accepts
// `api:<id>` names so configured OpenAI-compatible providers are testable
// from the same panel.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { cli, prompt, model } = body;

    if (!cli || !prompt) {
      return NextResponse.json(
        { error: "Missing 'cli' or 'prompt'." },
        { status: 400 },
      );
    }

    // Use the dispatcher directly: pass the resolved provider name and let
    // callAnyLlm walk the order with fallbacks. Catches and returns error
    // text the dialog already displays.
    const { generateText } = await import("@/lib/llm");
    const providerMap: Record<string, string> = {
      "claude": "cli:claude",
      "codex": "cli:codex",
      "hermes": "cli:hermes",
      "gemini": "cli:gemini",
      "openclaw": "cli:openclaw",
      "codebuddy": "cli:codebuddy",
      "aider": "cli:aider",
      "z-ai": "zai-sdk",
      "anthropic-sdk": "anthropic",
      "openai-sdk": "openai",
    };
    // api:<id> names pass straight through; everything else must be known.
    const provider = cli.startsWith("api:") ? cli : providerMap[cli];
    if (!provider) {
      return NextResponse.json(
        { error: `Unknown CLI: ${cli}` },
        { status: 400 },
      );
    }

    const r = await generateText("", prompt, {
      llm: { provider, maxTokens: 1024, model: model || undefined },
      maxChars: 4000,
    });
    if (!r.ok) {
      return NextResponse.json(
        { error: r.error || "Provider returned no output." },
        { status: 500 },
      );
    }
    return NextResponse.json({ output: r.text, provider: r.provider, model: r.model });
  } catch (err: any) {
    console.error("[/api/llm-config] POST error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "CLI test failed.") },
      { status: 500 },
    );
  }
}
