/**
 * Shared SSE (Server-Sent Events) streaming helper for LLM tasks.
 *
 * Provides a simple `createSSEStream` function that:
 *  1. Creates a ReadableStream with proper SSE encoding
 *  2. Returns a `send(event, data)` callback for emitting progress events
 *  3. Returns a `complete()` callback to close the stream
 *
 * Usage in API route:
 *   export async function POST(req) {
 *     const { stream, send, complete } = createSSEStream();
 *     (async () => {
 *       send("step", { status: "started", message: "Starting..." });
 *       // ... do work ...
 *       send("step", { status: "done", message: "Complete" });
 *       send("complete", { result: data });
 *       complete();
 *     })();
 *     return new Response(stream, { headers: SSE_HEADERS });
 *   }
 */

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

export interface SSEStream {
  stream: ReadableStream<Uint8Array>;
  send: (event: string, data: any) => void;
  complete: () => void;
  error: (message: string) => void;
}

export function createSSEStream(): SSEStream {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const send = (event: string, data: any) => {
    if (!controller) return;
    try {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ event, ...data })}\n\n`)
      );
    } catch {
      // Controller may be closed already
    }
  };

  const complete = () => {
    if (!controller) return;
    try {
      controller.close();
    } catch {}
    controller = null;
  };

  const error = (message: string) => {
    send("error", { error: message });
    complete();
  };

  return { stream, send, complete, error };
}

/**
 * Client-side helper to consume an SSE stream from an API route.
 *
 * Usage:
 *   const data = await consumeSSEStream("/api/ai/write", body, (event, data) => {
 *     // Update UI with progress
 *     console.log(event, data.message);
 *   });
 */
export async function consumeSSEStream(
  url: string,
  body: any,
  onEvent: (event: string, data: any) => void
): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed (${res.status})`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: any = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.event === "complete") {
          finalResult = parsed;
        } else {
          onEvent(parsed.event, parsed);
        }
      } catch {
        // Ignore malformed lines
      }
    }
  }

  return finalResult;
}
