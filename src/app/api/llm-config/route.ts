import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

export const runtime = "nodejs";
export const maxDuration = 30;

const execAsync = promisify(exec);

// Detect available AI agent CLIs on the local machine
export async function GET() {
  const detectors = [
    { name: "claude", cmd: "which claude 2>/dev/null || echo NOT_FOUND", label: "Claude CLI (Anthropic)" },
    { name: "z-ai", cmd: "which z-ai 2>/dev/null || echo NOT_FOUND", label: "Z.AI CLI" },
    { name: "gemini", cmd: "which gemini 2>/dev/null || echo NOT_FOUND", label: "Gemini CLI (Google)" },
    { name: "ollama", cmd: "which ollama 2>/dev/null || echo NOT_FOUND", label: "Ollama (Local LLM)" },
    { name: "llama", cmd: "which llama 2>/dev/null || echo NOT_FOUND", label: "Llama CLI" },
    { name: "aichat", cmd: "which aichat 2>/dev/null || echo NOT_FOUND", label: "AIChat" },
    { name: "sgpt", cmd: "which sgpt 2>/dev/null || echo NOT_FOUND", label: "ShellGPT" },
    { name: "openai", cmd: "which openai 2>/dev/null || echo NOT_FOUND", label: "OpenAI CLI" },
  ];

  const results: any[] = [];

  for (const det of detectors) {
    try {
      const { stdout } = await execAsync(det.cmd, { timeout: 5000 });
      const path = stdout.trim();
      if (path && path !== "NOT_FOUND") {
        // Try to get version
        let version = "";
        try {
          const verCmd = det.name === "ollama" ? "ollama --version" : `${det.name} --version 2>/dev/null || ${det.name} version 2>/dev/null || echo ""`;
          const { stdout: verOut } = await execAsync(verCmd, { timeout: 5000 });
          version = verOut.trim().split("\n")[0];
        } catch {}

        // For ollama, list available models
        let models: string[] = [];
        if (det.name === "ollama") {
          try {
            const { stdout: modelOut } = await execAsync("ollama list 2>/dev/null", { timeout: 5000 });
            models = modelOut.trim().split("\n").slice(1).map((line) => line.split(/\s+/)[0]).filter(Boolean);
          } catch {}
        }

        results.push({
          name: det.name,
          label: det.label,
          path,
          version,
          models,
          available: true,
        });
      }
    } catch {
      // Not available
    }
  }

  // Check for environment variables (API keys)
  const envKeys = {
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    GOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
    ZAI_API_KEY: !!process.env.ZAI_API_KEY,
  };

  return NextResponse.json({
    detected: results,
    envKeys,
    defaultProvider: "z-ai-sdk", // The built-in z-ai-web-dev-sdk
    sdkAvailable: true,
  });
}

// Test a CLI command
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { cli, prompt } = body;

    if (!cli || !prompt) {
      return NextResponse.json({ error: "Missing 'cli' or 'prompt'." }, { status: 400 });
    }

    // Map CLI name to command pattern
    const cmdMap: Record<string, string> = {
      claude: `claude -p "${prompt.replace(/"/g, '\\"')}"`,
      "z-ai": `z-ai chat -p "${prompt.replace(/"/g, '\\"')}"`,
      gemini: `gemini -p "${prompt.replace(/"/g, '\\"')}"`,
      ollama: `ollama run llama3.2 "${prompt.replace(/"/g, '\\"')}"`,
      aichat: `aichat "${prompt.replace(/"/g, '\\"')}"`,
      sgpt: `sgpt "${prompt.replace(/"/g, '\\"')}"`,
    };

    const cmd = cmdMap[cli];
    if (!cmd) {
      return NextResponse.json({ error: `Unknown CLI: ${cli}` }, { status: 400 });
    }

    const { stdout } = await execAsync(cmd, { timeout: 30000 });
    return NextResponse.json({ output: stdout.trim() });
  } catch (err: any) {
    console.error("[/api/llm-config] POST error:", err);
    return NextResponse.json(
      { error: err?.message || "CLI test failed." },
      { status: 500 }
    );
  }
}
