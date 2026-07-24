import { db } from "@/lib/db";
import { chat, getAI } from "@/lib/ai";

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
  metadata?: Record<string, any>
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
  const zai = await getAI();

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
    // Add a brief context preamble to help the LLM understand the history
    const contextSummary = context
      .map((m) => {
        const tag = m.taskType ? `[${m.taskType}]` : "";
        return `${tag} ${m.role}: ${m.content.slice(0, 500)}`;
      })
      .join("\n\n");

    // Only include context if it's not too long relative to the new prompt
    const contextTokens = estimateTokens(contextSummary);
    const promptTokens = estimateTokens(prompt);
    if (contextTokens < Math.max(4000, promptTokens * 3)) {
      messages.push({
        role: "user",
        content: `=== PRIOR CONVERSATION CONTEXT (from related tasks in this project) ===\n${contextSummary}\n=== END PRIOR CONTEXT ===\n\nNow continue with the following new task:`,
      });
    }
  }

  messages.push({ role: "user", content: prompt });

  // Save the user message to session BEFORE calling LLM
  await saveSessionMessage(projectId, opts.taskType, "user", prompt, opts.metadata);

  // Call the LLM
  const response = await zai.chat.completions.create({
    messages,
    stream: false,
    thinking: { type: opts.thinking ? "enabled" : "disabled" },
    temperature: opts.temperature ?? 0.6,
  } as Parameters<typeof zai.chat.completions.create>[0]);

  const assistantContent = response.choices?.[0]?.message?.content ?? "";

  // Save the assistant response to session
  await saveSessionMessage(projectId, opts.taskType, "assistant", assistantContent, {
    ...opts.metadata,
    tokens: estimateTokens(assistantContent),
  });

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

/**
 * Get a summary of the conversation session for a project (for UI/debugging).
 */
export async function getSessionSummary(
  projectId: string
): Promise<{ taskType: string; count: number; lastMessage: string; lastAt: Date }[]> {
  const messages = await db.conversationSession.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const byTask = new Map<string, { count: number; lastMessage: string; lastAt: Date }>();
  for (const msg of messages) {
    const existing = byTask.get(msg.taskType);
    if (!existing || msg.createdAt > existing.lastAt) {
      byTask.set(msg.taskType, {
        count: (existing?.count || 0) + 1,
        lastMessage: msg.content.slice(0, 100),
        lastAt: msg.createdAt,
      });
    } else {
      existing.count++;
    }
  }

  return Array.from(byTask.values()).map((v) => ({
    ...v,
    taskType: byTask.keys().next().value || "",
  }));
}
