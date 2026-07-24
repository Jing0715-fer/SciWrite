import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { inspectProviders } from "@/lib/llm";

export const runtime = "nodejs";
export const maxDuration = 30;

const execAsync = promisify(exec);

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
// Anything that needs the richer `available[]` (with `bin`, `reason`, `via`)
// should call /api/llm/providers directly.
export async function GET() {
  try {
    const { available } = await inspectProviders({ showUnavailable: false });

    const detected = available
      .filter((p) => p.available)
      .map((p) => {
        // CLI providers → derive a stable "name" the legacy dialog/test block
        // already understands (claude, codex, hermes, gemini, codebuddy, ...).
        // SDK providers → "z-ai-sdk" / "anthropic-sdk" / "openai-sdk".
        const baseId = p.provider.replace(/^cli:/, "");
        let name = baseId;
        if (p.provider === "zai-sdk") name = "z-ai";
        if (p.provider === "anthropic") name = "anthropic-sdk";
        if (p.provider === "openai") name = "openai-sdk";
        // Only keep the supported-by-dialog subset to avoid breaking the
        // legacy test-CLI dropdown that maps a small name → command map.
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
        if (!supported.has(name)) return null;
        return {
          name,
          label: p.label,
          // Dialog renders `cli.path`; for SDKs we synthesize a friendly
          // pseudo-path so the existing UI doesn't show "undefined".
          path: p.bin ?? `${p.via}:${p.provider}`,
          version: "",
          models: [],
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
// detected adapter can be tested through one path.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { cli, prompt } = body;

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
    const provider = providerMap[cli];
    if (!provider) {
      return NextResponse.json(
        { error: `Unknown CLI: ${cli}` },
        { status: 400 },
      );
    }

    const r = await generateText("", prompt, {
      llm: { provider, maxTokens: 1024 },
      maxChars: 4000,
    });
    if (!r.ok) {
      return NextResponse.json(
        { error: r.error || "Provider returned no output." },
        { status: 500 },
      );
    }
    return NextResponse.json({ output: r.text });
  } catch (err: any) {
    console.error("[/api/llm-config] POST error:", err);
    return NextResponse.json(
      { error: err?.message || "CLI test failed." },
      { status: 500 },
    );
  }
}