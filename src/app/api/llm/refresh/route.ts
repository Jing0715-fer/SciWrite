import { NextResponse } from "next/server";
import { clearLlmProbeCache, inspectProviders } from "@/lib/llm";

// Force a re-probe of all CLI providers on the next request to
// /api/llm/providers. Use when the user has installed a new CLI tool or WSL
// distro and wants the front-end to pick it up without restarting the dev
// server.
export const dynamic = "force-dynamic";
export async function POST() {
  clearLlmProbeCache();
  // Trigger an actual re-probe synchronously so the next /api/llm/providers
  // call sees the fresh data instead of the just-cleared empty cache.
  try {
    const result = await inspectProviders();
    return NextResponse.json({
      ok: true,
      message: "Probe cache cleared + re-probed",
      providers: result.available.length,
      wsl: result.available.filter((p) => p.via === "wsl").length,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        message: "Probe cleared but re-probe failed: " + (err?.message ?? "unknown"),
      },
      { status: 500 },
    );
  }
}
export async function GET() {
  return POST();
}
