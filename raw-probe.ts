// Single raw SDK attempt — no retries, minimal footprint, exits 0 on success.
import ZAI from "z-ai-web-dev-sdk";
const zai = await ZAI.create();
try {
  const r: any = await zai.chat.completions.create({
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    stream: false,
    thinking: { type: "disabled" },
    max_tokens: 16,
  });
  const text = r?.choices?.[0]?.message?.content ?? "";
  console.log("PROBE_OK", JSON.stringify(String(text).slice(0, 30)));
} catch (e: any) {
  console.log("PROBE_429", String(e?.message ?? e).slice(0, 80));
  process.exit(1);
}
