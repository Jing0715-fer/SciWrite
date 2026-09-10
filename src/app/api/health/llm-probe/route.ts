import { NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

/**
 * GET /api/health/llm-probe — is the chat provider answering right now?
 *
 * Tiny direct-SDK probe (max_tokens 8, no rate-limiter wrapping, no cache)
 * used by test harnesses and the auto-iterate infrastructure to decide when
 * a 429 account-level storm has cleared before burning a pipeline attempt.
 * Returns { healthy, detail } — always 200 so fetch failures are data, not
 * transport errors.
 */
export async function GET() {
  try {
    const zai = await ZAI.create();
    await zai.chat.completions.create({
      messages: [{ role: "user", content: "Reply OK." }],
      max_tokens: 8,
    });
    return NextResponse.json({ healthy: true, detail: "ok" });
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 160);
    return NextResponse.json({ healthy: false, detail: msg });
  }
}
