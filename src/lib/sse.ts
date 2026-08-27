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
 *
 * Hardened parser (was fragile):
 *  - events are framed by "\n\n" per the SSE spec (was split on "\n", which
 *    breaks if a server ever emits multi-line data)
 *  - accepts both "data: x" and "data:x" forms
 *  - drains the final buffered event when the server closes mid-frame
 *  - cancels the reader on abnormal exit so the connection doesn't linger
 *
 * Options:
 *  - emitComplete: also forward the "complete" event to onEvent (default only
 *    captures it as the return value)
 *  - rejectOnError: throw on an in-stream "error" event (default forwards it
 *    to onEvent like any other event)
 */
export async function consumeSSEStream(
  url: string,
  body: any,
  onEvent: (event: string, data: any) => void,
  opts?: { emitComplete?: boolean; rejectOnError?: boolean }
): Promise<any> {
  const emitComplete = opts?.emitComplete ?? false;
  const rejectOnError = opts?.rejectOnError ?? false;

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
  let streamError: string | null = null;

  const processLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const payload = line.startsWith("data: ")
      ? line.slice(6)
      : line.slice(5);
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // malformed line — skip
    }
    if (parsed.event === "complete") {
      finalResult = parsed;
      if (emitComplete) onEvent(parsed.event, parsed);
      return;
    }
    if (parsed.event === "error" && rejectOnError) {
      streamError = parsed.error ?? "Stream error";
      return;
    }
    onEvent(parsed.event, parsed);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const evt of events) {
        for (const line of evt.split("\n")) {
          processLine(line);
          if (streamError) throw new Error(streamError);
        }
      }
    }
    // Drain any final buffered partial event (server closed mid-frame).
    for (const line of buffer.split("\n")) {
      processLine(line);
      if (streamError) throw new Error(streamError);
    }
  } finally {
    // Cancel is a no-op once the stream is fully read; on early throw it
    // releases the connection instead of leaving it open.
    reader.cancel().catch(() => {});
  }

  return finalResult;
}
