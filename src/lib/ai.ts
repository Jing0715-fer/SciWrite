import ZAI from "z-ai-web-dev-sdk";

let _zai: Awaited<ReturnType<typeof ZAI.create>> | null = null;

export async function getAI() {
  if (!_zai) {
    _zai = await ZAI.create();
  }
  return _zai;
}

export interface ChatOptions {
  system?: string;
  temperature?: number;
  thinking?: boolean;
}

export async function chat(prompt: string, opts: ChatOptions = {}): Promise<string> {
  // Provider routing: respect the user's selection persisted via
  // /api/llm-config/select. Default ("zai-sdk" or unset) keeps the original
  // z-ai-web-dev-sdk path so behavior is unchanged for users who never open
  // the dialog. Any other selected provider (cli:hermes, cli:codex, ...)
  // routes through `generateText()` in `@/lib/llm`, which performs its own
  // probe + fallback chain.
  let selected = "zai-sdk";
  try {
    const { getSelectedProvider } = await import("@/lib/llm-selection");
    selected = getSelectedProvider();
  } catch {
    selected = "zai-sdk";
  }

  if (!selected || selected === "zai-sdk" || selected === "auto") {
    const zai = await getAI();
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: prompt });

    const response = await zai.chat.completions.create({
      messages,
      stream: false,
      thinking: { type: opts.thinking ? "enabled" : "disabled" },
      temperature: opts.temperature ?? 0.6,
    } as Parameters<typeof zai.chat.completions.create>[0]);

    return response.choices?.[0]?.message?.content ?? "";
  }

  // Non-default provider → dispatch through the unified dispatcher.
  try {
    const { generateText } = await import("@/lib/llm");
    const r = await generateText(opts.system ?? "", prompt, {
      llm: {
        provider: selected,
        temperature: opts.temperature,
      },
      maxChars: 32000,
    });
    if (r.ok) return r.text;
    // If the chosen provider fails, fall back to zai-sdk so callers always
    // get an answer (matches the original promise: never fabricate, but
    // never leave the writer hung either).
    console.warn(`[ai.chat] ${selected} failed, falling back to zai-sdk:`, r.error);
  } catch (err) {
    console.warn(`[ai.chat] dispatcher threw, falling back to zai-sdk:`, err);
  }

  const zai = await getAI();
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });
  const response = await zai.chat.completions.create({
    messages,
    stream: false,
    thinking: { type: opts.thinking ? "enabled" : "disabled" },
    temperature: opts.temperature ?? 0.6,
  } as Parameters<typeof zai.chat.completions.create>[0]);
  return response.choices?.[0]?.message?.content ?? "";
}

export interface WebSearchItem {
  url: string;
  name: string;
  snippet: string;
  host_name?: string;
  rank?: number;
  date?: string;
  favicon?: string;
}

export async function webSearch(
  query: string,
  num = 8
): Promise<WebSearchItem[]> {
  try {
    const zai = await getAI();
    const result = await zai.functions.invoke("web_search", {
      query,
      num,
    });
    if (Array.isArray(result)) return result as WebSearchItem[];
    return [];
  } catch (err) {
    console.error("webSearch error:", err);
    return [];
  }
}

export interface PageReadResult {
  title?: string;
  text?: string;
  html?: string;
  url?: string;
  publishedTime?: string;
}

export async function readPage(url: string): Promise<PageReadResult> {
  try {
    const zai = await getAI();
    const result: any = await zai.functions.invoke("page_reader", { url });
    const data = result?.data ?? result;
    return {
      title: data?.title,
      text: data?.text,
      html: data?.html,
      url: data?.url ?? url,
      publishedTime: data?.publishedTime ?? data?.publish_time,
    };
  } catch (err) {
    console.error("readPage error:", err);
    return {};
  }
}
