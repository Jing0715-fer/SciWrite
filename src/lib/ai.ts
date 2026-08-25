import ZAI from "z-ai-web-dev-sdk";
import {
  withRateLimit,
  QuotaExhaustedError,
  RateLimitAbortedError,
} from "@/lib/rate-limiter";

let _zai: Awaited<ReturnType<typeof ZAI.create>> | null = null;

export async function getAI() {
  if (!_zai) {
    _zai = await ZAI.create();
  }
  return _zai;
}

export { QuotaExhaustedError, RateLimitAbortedError };

export interface ChatOptions {
  system?: string;
  temperature?: number;
  thinking?: boolean;
  /** Override the default max_tokens (16384). Useful when the caller knows
   *  it needs more (e.g. very long section generation) or less (short JSON
   *  responses to save tokens). */
  maxTokens?: number;
}

/**
 * Safe prompt size limit — well under the OS spawn() argv limit.
 *
 * Linux: MAX_ARG_STRLEN = 128KB per single argument, ARG_MAX ~2MB total.
 * macOS: ARG_MAX ~256KB.
 * Windows: CreateProcessW cmdline limit ~32KB.
 *
 * We use 24000 chars as a conservative limit that:
 *  - Leaves room for system prompt, CLI flags, and environment variables
 *  - Is well under all platform limits
 *  - Is large enough to contain a full section's worth of context
 *
 * When a prompt exceeds this limit, compressPrompt() intelligently
 * truncates the longest context blocks (reference lists, data source
 * lists, full-text articles) while preserving the instruction portion.
 */
const SAFE_PROMPT_LIMIT = 24000;

/**
 * Compress a prompt that exceeds the safe size limit.
 *
 * Strategy (applied in order until under limit):
 * 1. Truncate the longest contiguous block of reference/data text
 *    (identified by lines starting with [n], [DS:, or containing "Abstract:")
 * 2. If still too long, truncate full-text sections (marked by "--- FULL TEXT ---")
 * 3. If still too long, truncate from the middle of the prompt (keep head + tail)
 * 4. Append a truncation notice so the LLM knows context was shortened
 *
 * @param prompt     The full prompt string
 * @param system     Optional system prompt (not counted toward the limit)
 * @returns          The compressed prompt (or original if under limit)
 */
export function compressPrompt(prompt: string, system?: string): string {
  if (prompt.length <= SAFE_PROMPT_LIMIT) return prompt;

  let compressed = prompt;
  const originalLen = compressed.length;

  // Step 1: Truncate reference lists — find blocks of [n] entries and
  // keep only the first N entries (enough for the LLM to cite from)
  const refBlockRe = /(\[DS:\d+\].*?)(?=\n\n[^[]|\n##|$)/gs;
  const refMatches = [...compressed.matchAll(refBlockRe)];
  if (refMatches.length > 0) {
    for (const m of refMatches.reverse()) {
      if (compressed.length <= SAFE_PROMPT_LIMIT) break;
      const block = m[0];
      if (block.length > 2000) {
        // Keep first 1000 chars of this block, truncate the rest
        const truncated = block.slice(0, 1000) + "\n... (truncated for context limit)\n";
        compressed = compressed.slice(0, m.index) + truncated + compressed.slice(m.index + block.length);
      }
    }
  }

  // Step 2: Truncate full-text sections (PMC articles)
  if (compressed.length > SAFE_PROMPT_LIMIT) {
    const ftRe = /--- FULL TEXT \(PMC free article\) ---[\s\S]*?(?=\n\n\[|\n\n##|$)/g;
    const ftMatches = [...compressed.matchAll(ftRe)];
    for (const m of ftMatches.reverse()) {
      if (compressed.length <= SAFE_PROMPT_LIMIT) break;
      const block = m[0];
      if (block.length > 2000) {
        const truncated = block.slice(0, 1500) + "\n... (full text truncated for context limit)\n";
        compressed = compressed.slice(0, m.index) + truncated + compressed.slice(m.index + block.length);
      }
    }
  }

  // Step 3: Truncate "Abstract:" lines that are very long
  if (compressed.length > SAFE_PROMPT_LIMIT) {
    compressed = compressed.replace(/Abstract: (.{200,}?)(\n|$)/g, (match, text, ending) => {
      if (text.length > 300) {
        return "Abstract: " + text.slice(0, 300) + "..." + ending;
      }
      return match;
    });
  }

  // Step 4: If still too long, truncate from the middle (keep head + tail)
  if (compressed.length > SAFE_PROMPT_LIMIT) {
    const headLen = Math.floor(SAFE_PROMPT_LIMIT * 0.6);
    const tailLen = SAFE_PROMPT_LIMIT - headLen - 200; // 200 chars for notice
    const head = compressed.slice(0, headLen);
    const tail = compressed.slice(compressed.length - tailLen);
    compressed = head + "\n\n[...context truncated for length limit...]\n\n" + tail;
  }

  // Append truncation notice if we actually shortened the prompt
  if (compressed.length < originalLen) {
    compressed += `\n\n[Note: The original prompt was ${originalLen} chars but was compressed to ${compressed.length} chars to fit within the LLM's input limit. Some context may be missing.]`;
  }

  return compressed;
}

export async function chat(prompt: string, opts: ChatOptions = {}): Promise<string> {
  // Compress the prompt if it exceeds the safe size limit.
  // This prevents ENAMETOOLONG errors on CLI providers (codebuddy, hermes,
  // codex) that pass the prompt as a command-line argument to spawn().
  const compressedPrompt = compressPrompt(prompt, opts.system);

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
    messages.push({ role: "user", content: compressedPrompt });

    // v53-恢复: Wrap the SDK call in the global rate-limiter. This applies:
    //  - Token bucket (1 req / 2s spacing)
    //  - 60s cool-down when > 15 calls in 10 min
    //  - Exponential backoff on 429/5xx (1s/2s/4s/8s/16s, max 5 attempts)
    //  - Quota-exhaustion abort (reads x-ratelimit-user-daily-remaining)
    const response = await withRateLimit(
      async (captureHeaders) => {
        const r = await zai.chat.completions.create({
          messages,
          stream: false,
          thinking: { type: opts.thinking ? "enabled" : "disabled" },
          temperature: opts.temperature ?? 0.6,
          // Explicit max_tokens — without this, the SDK may apply a low default
          // (e.g. 4096) that truncates long outputs like gather's JSON query
          // plan (which can legitimately need 8K+ tokens). Default 16384 is a
          // safe upper bound; callers can override via opts.maxTokens.
          max_tokens: opts.maxTokens ?? 16384,
        } as Parameters<typeof zai.chat.completions.create>[0]);
        // Capture rate-limit headers from the underlying response.
        try {
          const hdrs = (r as any)?._response?.headers ?? (r as any)?.headers;
          if (hdrs) captureHeaders(hdrs);
        } catch {}
        return r;
      },
      { label: "chat" },
    );

    return response.choices?.[0]?.message?.content ?? "";
  }

  // Non-default provider → dispatch through the unified dispatcher.
  // When the user has explicitly chosen a CLI provider (codebuddy, codex,
  // hermes, ...), do NOT silently fall back to zai-sdk on failure — that
  // produces the misleading "z-ai-config not found" error and violates the
  // user's explicit choice. Surface the original error instead.
  const { generateText } = await import("@/lib/llm");
  const r = await generateText(opts.system ?? "", prompt, {
    llm: {
      provider: selected,
      temperature: opts.temperature,
    },
    maxChars: 32000,
  });
  if (r.ok) return r.text;
  throw new Error(
    `[ai.chat] selected provider '${selected}' returned no output: ${r.error ?? "unknown error"}`,
  );
}

/**
 * Session-aware variant of `chat()`. Same shape as `chat()` but the caller can
 * pass an existing CLI session id (e.g. a Hermes `session_id: 20260730_...`
 * banner or a codebuddy `sessionId` JSON field) and the returned `cliSessionId`
 * is the *fresh* one returned by the CLI — even when the same id is passed
 * back unchanged. Callers persist `cliSessionId` so the next call within the
 * same logical task can resume the same remote session via `--resume`.
 *
 * Defaults to `chat()` (which discards the id) when no id is passed — keeps
 * z-ai-sdk and any future SDK callers untouched.
 */
export async function chatWithSessionId(
  prompt: string,
  opts: ChatOptions = {},
  sessionId?: string,
): Promise<{ text: string; cliSessionId: string | null }> {
  const compressedPrompt = compressPrompt(prompt, opts.system);
  let selected = "zai-sdk";
  try {
    const { getSelectedProvider } = await import("@/lib/llm-selection");
    selected = getSelectedProvider();
  } catch {
    selected = "zai-sdk";
  }
  if (!selected || selected === "zai-sdk" || selected === "auto") {
    const text = await chat(prompt, opts);
    return { text, cliSessionId: null };
  }
  const { generateText } = await import("@/lib/llm");
  const r = await generateText(opts.system ?? "", prompt, {
    llm: { provider: selected, temperature: opts.temperature },
    maxChars: 32000,
    sessionId,
  });
  if (r.ok) {
    return { text: r.text, cliSessionId: (r.meta?.cliSessionId as string | null) ?? null };
  }
  throw new Error(
    `[ai.chatWithSessionId] selected provider '${selected}' returned no output: ${r.error ?? "unknown error"}`,
  );
}

/**
 * Streaming chat — yields incremental content chunks as the LLM produces them.
 *
 * The z-ai-web-dev-sdk returns a ReadableStream when `stream: true` is set.
 * We parse the SSE `data:` lines and yield the `delta.content` field of each
 * chunk. For non-zai providers (which don't ship native streaming), we fall
 * back to calling `chat()` once and yielding the full result as a single chunk.
 *
 * @param prompt   The user prompt
 * @param opts     Chat options (system, temperature, thinking)
 * @param onChunk  Optional callback invoked for each chunk of text
 * @returns        The full assembled text
 */
export async function chatStream(
  prompt: string,
  opts: ChatOptions = {},
  onChunk?: (chunk: string, accumulated: string) => void,
): Promise<string> {
  // Compress the prompt if it exceeds the safe size limit.
  const compressedPrompt = compressPrompt(prompt, opts.system);

  let selected = "zai-sdk";
  try {
    const { getSelectedProvider } = await import("@/lib/llm-selection");
    selected = getSelectedProvider();
  } catch {
    selected = "zai-sdk";
  }

  // Non-zai providers: fall back to non-streaming chat and yield once.
  if (selected && selected !== "zai-sdk" && selected !== "auto") {
    const full = await chat(compressedPrompt, opts);
    if (onChunk) onChunk(full, full);
    return full;
  }

  const zai = await getAI();
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: compressedPrompt });

  // v53-恢复: Wrap the streaming SDK call in the global rate-limiter.
  // Streaming still consumes a quota slot — same token-bucket / cool-down /
  // 429-backoff applies. We only rate-limit the START of the stream (the SDK
  // call itself); once the stream body begins, we drain it normally below.
  const streamBody: any = await withRateLimit(
    async (captureHeaders) => {
      const r = await zai.chat.completions.create({
        messages,
        stream: true,
        thinking: { type: opts.thinking ? "enabled" : "disabled" },
        temperature: opts.temperature ?? 0.6,
        // Explicit max_tokens for streaming too — section generation can produce
        // 1000+ word sections that need 8K+ output tokens. Default 16384; callers
        // can override via opts.maxTokens.
        max_tokens: opts.maxTokens ?? 16384,
      } as Parameters<typeof zai.chat.completions.create>[0]);
      try {
        const hdrs = (r as any)?._response?.headers ?? (r as any)?.headers;
        if (hdrs) captureHeaders(hdrs);
      } catch {}
      return r;
    },
    { label: "chatStream" },
  );

  // If for some reason we didn't get a stream (provider routed elsewhere),
  // fall back to non-streaming parse.
  if (!streamBody || typeof streamBody.getReader !== "function") {
    const text =
      streamBody?.choices?.[0]?.message?.content ??
      (typeof streamBody === "string" ? streamBody : "");
    if (onChunk) onChunk(text, text);
    return text;
  }

  const reader: ReadableStreamDefaultReader<Uint8Array> = streamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          // OpenAI-style delta content
          const delta =
            parsed?.choices?.[0]?.delta?.content ??
            parsed?.choices?.[0]?.message?.content ??
            parsed?.delta?.content ??
            "";
          if (delta) {
            accumulated += delta;
            if (onChunk) onChunk(delta, accumulated);
          }
        } catch {
          // Some providers send raw text chunks instead of JSON
          if (data && data !== "[DONE]") {
            accumulated += data;
            if (onChunk) onChunk(data, accumulated);
          }
        }
      }
    }
    // Flush any remaining buffered data
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trim();
        if (data && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data);
            const delta =
              parsed?.choices?.[0]?.delta?.content ??
              parsed?.choices?.[0]?.message?.content ??
              "";
            if (delta) {
              accumulated += delta;
              if (onChunk) onChunk(delta, accumulated);
            }
          } catch {
            accumulated += data;
            if (onChunk) onChunk(data, accumulated);
          }
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  return accumulated;
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
  // Non-zai providers don't ship a native web-search tool. Returning [] keeps
  // the pipeline alive (gather/compose will still run with database queries)
  // and avoids throwing the misleading "z-ai-config not found" error.
  if (!(await isZaiSelected())) return [];
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
  // Page reading is a z-ai-sdk hosted tool. Non-zai providers don't ship it;
  // return empty rather than throwing "z-ai-config not found".
  if (!(await isZaiSelected())) return {};
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

/**
 * Returns true when the currently selected provider is z-ai-sdk (or unset).
 * Used by webSearch() / readPage() to no-op when the user picked a CLI
 * provider (hermes/codex/codebuddy/etc.) that doesn't ship web/search tools.
 */
async function isZaiSelected(): Promise<boolean> {
  try {
    const { getSelectedProvider } = await import("@/lib/llm-selection");
    const sel = getSelectedProvider();
    return !sel || sel === "zai-sdk" || sel === "auto";
  } catch {
    return true; // default to zai when we can't determine the selection
  }
}
