import { db } from "@/lib/db";
import { chat } from "@/lib/ai";

/**
 * LLM Session Manager
 *
 * Maintains conversation context across multiple AI tasks within the same project.
 * This allows gather → curate → relationships → plan → generate → compose → review
 * to share context, making the LLM's outputs more coherent and connected.
 *
 * Conversation history is persisted in the ConversationSession table and loaded
 * before each chat() call, so the LLM "remembers" what it did in previous steps.
 */

export type SessionRole = "system" | "user" | "assistant";

export interface ChatSessionOptions {
  system?: string;
  temperature?: number;
  thinking?: boolean;
  /** Override the default max_tokens for the LLM call. Forwarded to
   *  chatStream / chatWithSessionId. */
  maxTokens?: number;
  /** Task type for categorization (gather, curate, plan, generate, etc.) */
  taskType: string;
  /** Max number of previous messages to include as context (default 20) */
  maxContextMessages?: number;
  /** Max approximate tokens for context (default 8000) */
  maxContextTokens?: number;
  /** Optional metadata to store with the message */
  metadata?: Record<string, any>;
}

/**
 * Estimate token count for a string (rough: 1 token ≈ 4 chars).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Load conversation history for a project, filtered by task types.
 * Returns messages in chronological order, respecting the context window.
 *
 * @param projectId   The project ID
 * @param taskTypes  Optional: only include messages from these task types.
 *                   If omitted, includes ALL task types (full project context).
 * @param maxMessages Max messages to return (most recent first, then reversed)
 * @param maxTokens   Max approximate tokens to include
 */
export async function loadSessionContext(
  projectId: string,
  taskTypes?: string[],
  maxMessages = 20,
  maxTokens = 8000
): Promise<{ role: SessionRole; content: string; taskType: string }[]> {
  const where: any = { projectId };
  if (taskTypes && taskTypes.length > 0) {
    where.taskType = { in: taskTypes };
  }

  const messages = await db.conversationSession.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: maxMessages * 2, // fetch more than needed, then trim by tokens
  });

  // Reverse to chronological order
  messages.reverse();

  // Build context, trimming from the front if we exceed token budget
  const context: { role: SessionRole; content: string; taskType: string }[] = [];
  let totalTokens = 0;

  // Walk from the END (most recent) backwards, accumulating until budget hit
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const msgTokens = msg.tokenEstimate || estimateTokens(msg.content);
    if (totalTokens + msgTokens > maxTokens && context.length >= 4) break;
    context.unshift({
      role: msg.role as SessionRole,
      content: msg.content,
      taskType: msg.taskType,
    });
    totalTokens += msgTokens;
    if (context.length >= maxMessages) break;
  }

  return context;
}

/**
 * Save a message to the conversation session.
 */
export async function saveSessionMessage(
  projectId: string,
  taskType: string,
  role: SessionRole,
  content: string,
  metadata?: Record<string, any>,
  cliSessionId?: string | null,
  cliProvider?: string | null,
): Promise<void> {
  try {
    await db.conversationSession.create({
      data: {
        projectId,
        taskType,
        role,
        content,
        metadata: metadata ? JSON.stringify(metadata) : null,
        tokenEstimate: estimateTokens(content),
        // Only persist the cliSessionId (+ provider) on assistant turns —
        // that's when the LLM returns a fresh id. Storing it on user turns
        // too would just duplicate the previous assistant id and waste a
        // query. Both fields travel together; if one is present without the
        // other, the lookup in chatWithSession() will skip the row.
        ...(role === "assistant" && cliSessionId && cliProvider
          ? { cliSessionId, cliProvider }
          : {}),
      },
    });
  } catch (err) {
    // Non-fatal — context saving should never break the main task
    console.error("[saveSessionMessage] error:", err);
  }
}

/**
 * Chat with session context — loads previous conversation history for the project,
 * appends the new user message, calls the LLM, saves both the user message and
 * the assistant response to the session.
 *
 * This makes all LLM tasks within a project share context:
 *   - The gather task's source list is visible to the curate task
 *   - The plan task's outline is visible to the generate task
 *   - The generate task's section content is visible to the compose task
 *   - etc.
 *
 * @param projectId  The project ID (session scope)
 * @param prompt     The user's prompt for this task
 * @param opts       Session options (system, temperature, taskType, etc.)
 * @returns         The LLM's response text
 */
export async function chatWithSession(
  projectId: string,
  prompt: string,
  opts: ChatSessionOptions
): Promise<string> {
  // Load conversation context for this project (all task types, to maximize continuity)
  const context = await loadSessionContext(
    projectId,
    undefined, // include ALL task types for full context
    opts.maxContextMessages ?? 20,
    opts.maxContextTokens ?? 8000
  );

  // Build messages array: system → context → new prompt
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];

  if (opts.system) {
    messages.push({ role: "system", content: opts.system });
  }

  // Append context messages. Insert a separator comment so the LLM knows this is
  // prior conversation history from related tasks.
  if (context.length > 0) {
    // Cap to last 4 messages (300 chars each) and always include.
    // Without this preamble, deepseek-v4-pro loses track of "what task
    // am I on" and produces generic text instead of project-aware output.
    // Slimming the preamble keeps single chatWithSession calls under
    // ~4KB so the model responds in 5-15s instead of 60s+.
    const recent = context.slice(-4);
    const trimmedSummary = recent
      .map((m) => {
        const tag = m.taskType ? `[${m.taskType}]` : "";
        return `${tag} ${m.role}: ${m.content.slice(0, 300).replace(/\s+/g, " ")}`;
      })
      .join("\n\n");
    if (trimmedSummary.length > 0) {
      messages.push({
        role: "user",
        content: `=== RECENT CONTEXT (last ${recent.length} messages) ===\n${trimmedSummary}\n=== END CONTEXT ===\n\nNow continue with the following new task:`,
      });
    }
  }

  messages.push({ role: "user", content: prompt });

  // Save the user message to session BEFORE calling LLM
  const _t0 = Date.now();
  await saveSessionMessage(projectId, opts.taskType, "user", prompt, opts.metadata);
  console.log(`[chatWithSession] +${Date.now() - _t0}ms saved user msg to ConversationSession`);

  console.log(`[chatWithSession] +${Date.now() - _t0}ms about to call chat() (taskType=${opts.taskType}, promptLen=${prompt.length})`);
  // Call the LLM via the routed chat() in @/lib/ai so the user's selected
  // provider (zai-sdk / cli:codebuddy / cli:hermes / ...) is honored. Direct
  // zai.chat.completions.create() bypassed provider selection and hung on
  // providers that don't have .z-ai-config (which is everything that isn't
  // zai-sdk).
  // Build the full prompt + system into a single string.
  // CRITICAL: CLI providers (codebuddy, codex, hermes) pass the prompt as a
  // command-line argument to spawn(). When the prompt exceeds the OS limit
  // (~32KB on Windows, ~128KB per-arg on Linux), spawn() throws ENAMETOOLONG.
  //
  // Strategy:
  // 1. First, drop oldest context messages (keep system + latest prompt)
  // 2. If still too long, use compressPrompt() to intelligently truncate
  //    the longest context blocks (reference lists, full-text articles, etc.)
  const MAX_TOTAL_CHARS = 28000;
  let finalPrompt = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  if (finalPrompt.length > MAX_TOTAL_CHARS) {
    // Drop oldest non-system messages (front) one at a time until we fit.
    while (finalPrompt.length > MAX_TOTAL_CHARS && messages.length > 2) {
      messages.splice(1, 1); // remove oldest non-system message
      finalPrompt = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
    }
    // If dropping messages wasn't enough (single message too long), compress
    const { compressPrompt } = await import("@/lib/ai");
    finalPrompt = compressPrompt(finalPrompt);
    finalPrompt += "\n\n[...conversation history truncated for context-window safety...]";
  }
  finalPrompt += "\n\nASSISTANT:";
  // Resolve which (if any) CLI session id to resume. We pull the most recent
  // assistant message for this (project, taskType, cliProvider) that carries
  // a cliSessionId. The cliProvider scope is critical: each CLI keeps its
  // own session store on disk, so feeding codebuddy's id to hermes (or vice
  // versa) would either fail or, worse, silently start a new session while
  // the caller thinks it's resuming. When the user switches provider mid-
  // project the new provider simply starts fresh.
  let resumeSessionId: string | undefined;
  let activeProvider: string | undefined;
  try {
    const { getSelectedProvider } = await import("@/lib/llm-selection");
    activeProvider = getSelectedProvider();
  } catch {
    activeProvider = undefined;
  }
  if (activeProvider) {
    try {
      const last = await db.conversationSession.findFirst({
        where: {
          projectId,
          taskType: opts.taskType,
          role: "assistant",
          cliProvider: activeProvider,
          cliSessionId: { not: null },
        },
        orderBy: { createdAt: "desc" },
        select: { cliSessionId: true },
      });
      if (last?.cliSessionId) resumeSessionId = last.cliSessionId;
    } catch (err) {
      console.error("[chatWithSession] failed to look up prior cliSessionId:", err);
    }
  }
  const { chatWithSessionId } = await import("@/lib/ai");
  const { text: assistantContent, cliSessionId: freshSessionId } =
    await chatWithSessionId(
      finalPrompt,
      {
        system: opts.system,
        temperature: opts.temperature,
        thinking: opts.thinking,
        maxTokens: opts.maxTokens,
      },
      resumeSessionId,
    );
  console.log(
    `[chatWithSession] +${Date.now() - _t0}ms chatWithSessionId returned ` +
      `(assistantContent=${assistantContent.length} chars, cliSessionId=${
        freshSessionId ?? "(none)"
      }, resumed=${resumeSessionId ? "yes" : "no"})`,
  );

  // Save the assistant response to session, carrying the fresh cliSessionId
  // + provider forward so the next call within the same (taskType, provider)
  // can resume it. Passing the wrong provider would let a different CLI pick
  // up this id later — see the lookup above for the matching filter.
  const _t1 = Date.now();
  await saveSessionMessage(
    projectId,
    opts.taskType,
    "assistant",
    assistantContent,
    { ...opts.metadata, tokens: estimateTokens(assistantContent) },
    freshSessionId,
    activeProvider ?? undefined,
  );
  console.log(`[chatWithSession] +${Date.now() - _t1}ms saved assistant msg to ConversationSession`);

  return assistantContent;
}

/**
 * Streaming variant of `chatWithSession()`.
 *
 * This is the SAME as `chatWithSession()` — loads conversation history for the
 * project, saves both the user message and the assistant response to the
 * session — but yields tokens to `onChunk` as they arrive from the LLM, instead
 * of blocking until the full response is ready.
 *
 * WHY THIS EXISTS:
 *   The full-article generation pipeline (`/api/ai/generate-full`) generates
 *   each section via `chatStream()` directly, which is stateless — each call
 *   is independent and the LLM has no memory of how previous sections were
 *   formatted. This produced inconsistent paragraph styles across sections
 *   (numbered title prefixes like "2. Genomic Organization..." in some
 *   sections but not others, varying paragraph density, etc.).
 *
 *   Routing section generation through `chatWithSessionStream()` instead gives
 *   every section access to the same conversation history (gather → curate →
 *   plan → generate §1 → generate §2 → ...), so the LLM sees how it wrote
 *   prior sections and naturally maintains a consistent style — the same
 *   benefit that `chatWithSession()` already provides to the curate/plan/
 *   relationships steps.
 *
 * TRADE-OFF:
 *   For CLI providers (codebuddy, codex, hermes), `chatStream()` falls back
 *   to a single non-streaming `chat()` call and yields once — so streaming
 *   is effectively lost for those providers, but session context is still
 *   loaded and saved. For the default z-ai-sdk provider, true token-by-token
 *   streaming is preserved.
 *
 *   CLI session resume (`--resume <id>`) is NOT supported by this streaming
 *   variant, because `chatStream()` doesn't return a `cliSessionId`. If the
 *   user picked a CLI provider and relies on resume, they should use
 *   `chatWithSession()` (non-streaming) instead.
 *
 * @param projectId  The project ID (session scope)
 * @param prompt     The user's prompt for this task
 * @param opts       Session options (system, temperature, taskType, etc.)
 * @param onChunk    Optional callback invoked for each chunk of text
 * @returns          The full assembled assistant text
 */
export async function chatWithSessionStream(
  projectId: string,
  prompt: string,
  opts: ChatSessionOptions,
  onChunk?: (chunk: string, accumulated: string) => void,
): Promise<string> {
  // Load conversation context for this project (all task types, to maximize
  // continuity). This is the SAME logic as chatWithSession() — the only
  // difference is that we call chatStream() instead of chatWithSessionId()
  // at the end so the caller gets token-by-token streaming.
  const context = await loadSessionContext(
    projectId,
    undefined, // include ALL task types for full context
    opts.maxContextMessages ?? 20,
    opts.maxContextTokens ?? 8000
  );

  // Build messages array: system → context → new prompt
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];

  if (opts.system) {
    messages.push({ role: "system", content: opts.system });
  }

  // Append context messages (same slimming logic as chatWithSession — keep
  // only the last 4 messages, 300 chars each, so the preamble stays small
  // and the model responds quickly).
  if (context.length > 0) {
    const recent = context.slice(-4);
    const trimmedSummary = recent
      .map((m) => {
        const tag = m.taskType ? `[${m.taskType}]` : "";
        return `${tag} ${m.role}: ${m.content.slice(0, 300).replace(/\s+/g, " ")}`;
      })
      .join("\n\n");
    if (trimmedSummary.length > 0) {
      messages.push({
        role: "user",
        content: `=== RECENT CONTEXT (last ${recent.length} messages) ===\n${trimmedSummary}\n=== END CONTEXT ===\n\nNow continue with the following new task:`,
      });
    }
  }

  messages.push({ role: "user", content: prompt });

  // Save the user message to session BEFORE calling LLM (same as chatWithSession)
  const _t0 = Date.now();
  await saveSessionMessage(projectId, opts.taskType, "user", prompt, opts.metadata);
  console.log(`[chatWithSessionStream] +${Date.now() - _t0}ms saved user msg to ConversationSession (taskType=${opts.taskType}, promptLen=${prompt.length})`);

  // Build the full prompt + system into a single string, with the same
  // context-window safety compression as chatWithSession().
  const MAX_TOTAL_CHARS = 28000;
  let finalPrompt = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  if (finalPrompt.length > MAX_TOTAL_CHARS) {
    while (finalPrompt.length > MAX_TOTAL_CHARS && messages.length > 2) {
      messages.splice(1, 1);
      finalPrompt = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
    }
    const { compressPrompt } = await import("@/lib/ai");
    finalPrompt = compressPrompt(finalPrompt);
    finalPrompt += "\n\n[...conversation history truncated for context-window safety...]";
  }
  finalPrompt += "\n\nASSISTANT:";

  // Resolve the active provider so we can branch:
  //  - CLI providers (hermes, codex, codebuddy, ...): use chatWithSessionId()
  //    which passes --resume <sessionId> to the CLI so all calls within the
  //    same (project, taskType, provider) share ONE remote CLI session.
  //    This is the fix for "同一个任务的多次调用没有在 hermes 中共用一个 session".
  //    These providers don't support true token streaming anyway (chatStream
  //    falls back to a single chat() call for them), so we lose nothing by
  //    going through chatWithSessionId — and we GAIN session resume.
  //  - z-ai-sdk (default): use chatStream() for true token-by-token streaming.
  //    z-ai-sdk has no CLI session concept, so resume doesn't apply.
  let activeProvider: string | undefined;
  try {
    const { getSelectedProvider } = await import("@/lib/llm-selection");
    activeProvider = getSelectedProvider();
  } catch {
    activeProvider = undefined;
  }
  const isCliProvider = !!activeProvider && activeProvider !== "zai-sdk" && activeProvider !== "auto";

  let assistantContent: string;
  let freshSessionId: string | null = null;

  if (isCliProvider) {
    // Look up the most recent cliSessionId for this (project, taskType, provider)
    // so we can resume the same CLI session. This mirrors chatWithSession()'s
    // logic — without it, every section generation would start a fresh hermes
    // session and lose the accumulated context that drives format consistency.
    let resumeSessionId: string | undefined;
    try {
      const last = await db.conversationSession.findFirst({
        where: {
          projectId,
          taskType: opts.taskType,
          role: "assistant",
          cliProvider: activeProvider,
          cliSessionId: { not: null },
        },
        orderBy: { createdAt: "desc" },
        select: { cliSessionId: true },
      });
      if (last?.cliSessionId) resumeSessionId = last.cliSessionId;
    } catch (err) {
      console.error("[chatWithSessionStream] failed to look up prior cliSessionId:", err);
    }

    const { chatWithSessionId } = await import("@/lib/ai");
    const result = await chatWithSessionId(
      finalPrompt,
      {
        system: opts.system,
        temperature: opts.temperature,
        thinking: opts.thinking,
        maxTokens: opts.maxTokens,
      },
      resumeSessionId,
    );
    assistantContent = result.text;
    freshSessionId = result.cliSessionId;
    // CLI providers don't stream — yield the full text once so the UI still
    // gets an onChunk callback (the streaming-log panel relies on it).
    if (onChunk) onChunk(assistantContent, assistantContent);
    console.log(
      `[chatWithSessionStream] +${Date.now() - _t0}ms chatWithSessionId returned ` +
        `(assistantContent=${assistantContent.length} chars, cliSessionId=${
          freshSessionId ?? "(none)"
        }, resumed=${resumeSessionId ? "yes" : "no"}, provider=${activeProvider})`,
    );
  } else {
    // z-ai-sdk: true token-by-token streaming.
    const { chatStream } = await import("@/lib/ai");
    assistantContent = await chatStream(
      finalPrompt,
      {
        system: opts.system,
        temperature: opts.temperature,
        thinking: opts.thinking,
        maxTokens: opts.maxTokens,
      },
      onChunk,
    );
    console.log(
      `[chatWithSessionStream] +${Date.now() - _t0}ms chatStream returned ` +
        `(assistantContent=${assistantContent.length} chars, taskType=${opts.taskType}, provider=zai-sdk)`,
    );
  }

  // Save the assistant response to session. For CLI providers we persist the
  // fresh cliSessionId + provider so the NEXT call within the same
  // (project, taskType, provider) can resume the same CLI session.
  const _t1 = Date.now();
  await saveSessionMessage(
    projectId,
    opts.taskType,
    "assistant",
    assistantContent,
    { ...opts.metadata, tokens: estimateTokens(assistantContent) },
    freshSessionId,
    activeProvider ?? undefined,
  );
  console.log(`[chatWithSessionStream] +${Date.now() - _t1}ms saved assistant msg to ConversationSession`);

  return assistantContent;
}

/**
 * Clear conversation session for a project (e.g. when starting a fresh full-article generation).
 * Optionally only clear specific task types.
 */
export async function clearSession(
  projectId: string,
  taskTypes?: string[]
): Promise<void> {
  const where: any = { projectId };
  if (taskTypes && taskTypes.length > 0) {
    where.taskType = { in: taskTypes };
  }
  await db.conversationSession.deleteMany({ where });
}
