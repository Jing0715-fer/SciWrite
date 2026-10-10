/**
 * quota-probe.ts — minimal z-ai quota probe.
 * Sends a 1-message chat completion with a tiny max_tokens budget.
 * Exit 0 + prints OK when the account-level quota is available again;
 * non-zero exit + prints the error when still rate-limited (429/503).
 */
import ZAI from "z-ai-web-dev-sdk";

async function main() {
  try {
    const zai = await ZAI.create();
    const t0 = Date.now();
    const res = await zai.chat.completions.create({
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      max_tokens: 8,
      temperature: 0,
    });
    const dt = (Date.now() - t0) / 1000;
    const text = res?.choices?.[0]?.message?.content ?? "(empty)";
    console.log(`QUOTA_OK ${dt.toFixed(1)}s reply="${String(text).slice(0, 40).trim()}"`);
    process.exit(0);
  } catch (e: any) {
    const status = e?.status ?? e?.response?.status ?? "?";
    const msg = String(e?.message ?? e).slice(0, 200);
    console.log(`QUOTA_FAIL status=${status} ${msg}`);
    process.exit(1);
  }
}

main();
