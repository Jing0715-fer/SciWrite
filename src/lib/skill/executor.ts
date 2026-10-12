/**
 * Skill executor (RT5) — the ONE copy of the agent-operation skeleton:
 *
 *   buildPrompt → llm-cache lookup → chatWithSession → parse → postProcess
 *   → validate → (fatal? fallback) → structured telemetry
 *
 * This is the pattern that was copy-pasted ~40× across the codebase (the
 * "A-family" isomorphic triple: citation-planner score, generate-full-helpers
 * curate, curate-smart). Behavior contract (kept IDENTICAL to the legacy
 * hand-rolled sites so migration is a no-op for callers):
 *   1. Cache key derives from prompt+system+temperature+taskType+maxTokens
 *      (provider/model ride inside llmCacheKey since RT2).
 *   2. Cache hit → replay raw (no chat, no session write).
 *   3. Miss → chatWithSession (persists the session message with
 *      metadata.step = skill.sseStep) → cache the raw reply.
 *   4. Parse via the shared robust parser (default safeParseJSON).
 *   5. postProcess may validate per-item and fill mechanical per-item
 *      fallbacks (legacy score semantics).
 *   6. validate issues land in telemetry; an issue prefixed "fatal:" makes
 *      the executor take the skill-level fallback (degraded=true).
 *   7. ANY throw along the way → skill fallback if defined, else rethrow
 *      (a skill without a fallback is a hard-fail skill by design).
 */

import { chatWithSession } from "@/lib/llm-session";
import { getCachedLLMResult, llmCacheKey, setCachedLLMResult } from "@/lib/llm-cache";
import { safeParseJSON } from "@/lib/llm-json";
import type { SkillDefinition, SkillResult, SkillTelemetry } from "./types";

export interface RunSkillOptions<O> {
  projectId: string;
  /** Parse fallback value (safeParseJSON's default when the reply is garbage). */
  fallbackValue: O;
  /** Skip the llm-cache (default: cache is used). */
  noCache?: boolean;
  /** Extra metadata merged over the skill's own metadata rows. */
  metadata?: Record<string, unknown>;
  /** Per-invocation overrides merged over the skill's static chat options
   *  (e.g. scoreSources passes a caller-provided maxTokens). */
  chatOverrides?: { maxTokens?: number; temperature?: number; timeoutMs?: number };
  /**
   * Structured logger (defaults to console). Pipelines inject their
   * scoped logger so skill telemetry lands in the run's log stream.
   */
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

const defaultLog: NonNullable<RunSkillOptions<any>["log"]> = (level, msg, data) => {
  const line = `[skill] ${msg}`;
  if (level === "warn") console.warn(line, data ?? "");
  else if (level === "error") console.error(line, data ?? "");
  else console.log(line, data ?? "");
};

export async function runSkill<I, O>(
  skill: SkillDefinition<I, O>,
  input: I,
  opts: RunSkillOptions<O>,
): Promise<SkillResult<O>> {
  const t0 = Date.now();
  const log = opts.log ?? defaultLog;
  const { system, prompt } = skill.buildPrompt(input);

  const finish = (
    output: O,
    meta: { degraded: boolean; fromCache: boolean; issues: string[] },
  ): SkillResult<O> => {
    const telemetry: SkillTelemetry = {
      skill: skill.id,
      ms: Date.now() - t0,
      fromCache: meta.fromCache,
      degraded: meta.degraded,
      parseIssues: meta.issues,
      promptChars: prompt.length,
      outputChars:
        typeof output === "string" ? output.length : JSON.stringify(output ?? "").length,
    };
    log(
      meta.degraded ? "warn" : "info",
      `skill ${skill.id} ${meta.degraded ? "DEGRADED" : meta.fromCache ? "cache-hit" : "ok"}`,
      telemetry as unknown as Record<string, unknown>,
    );
    return {
      ok: !meta.degraded,
      output,
      degraded: meta.degraded,
      fromCache: meta.fromCache,
      issues: meta.issues,
      telemetry,
    };
  };

  const fallbackRun = async (err: unknown): Promise<SkillResult<O>> => {
    const output = await skill.fallback!(input, err);
    return finish(output, {
      degraded: true,
      fromCache: false,
      issues: [`fallback: ${String((err as Error)?.message ?? err).slice(0, 120)}`],
    });
  };

  try {
    // 1-3. Cache → chat (legacy A-family skeleton, verbatim semantics).
    const chatOpts = { ...skill.chat, ...(opts.chatOverrides ?? {}) };
    let raw: string;
    let fromCache = false;
    if (opts.noCache) {
      raw = await callChat(skill, input, prompt, system, opts, chatOpts);
    } else {
      const cacheKey = await llmCacheKey(prompt, {
        system,
        temperature: chatOpts.temperature,
        taskType: skill.taskType,
        maxTokens: chatOpts.maxTokens,
      });
      const cached = getCachedLLMResult(cacheKey);
      if (cached) {
        raw = cached;
        fromCache = true;
      } else {
        raw = await callChat(skill, input, prompt, system, opts, chatOpts);
        setCachedLLMResult(cacheKey, raw);
      }
    }

    // 4-5. Parse + stage post-processing.
    const parse: (raw: string, fallbackValue: O) => O = skill.parse ?? defaultParse;
    const parsed = parse(raw, opts.fallbackValue);
    const processed = skill.postProcess ? skill.postProcess(parsed, input) : parsed;

    // 6. Validation — fatal issues escalate to the skill fallback.
    const validation = skill.validate ? skill.validate(processed, input) : { ok: true, issues: [] };
    const fatal = validation.issues.filter((i) => i.startsWith("fatal:"));
    if (!validation.ok && fatal.length > 0 && skill.fallback) {
      return fallbackRun(new Error(fatal.join("; ")));
    }

    return finish(processed, {
      degraded: false,
      fromCache,
      issues: validation.issues,
    });
  } catch (err) {
    if (skill.fallback) return fallbackRun(err);
    throw err;
  }
}

function defaultParse<O>(raw: string, fallbackValue: O): O {
  return safeParseJSON(raw, fallbackValue) as O;
}

async function callChat<I, O>(
  skill: SkillDefinition<I, O>,
  input: I,
  prompt: string,
  system: string | undefined,
  opts: RunSkillOptions<O>,
  chatOpts: SkillDefinition<I, O>["chat"],
): Promise<string> {
  const metadata = {
    ...(skill.metadata ? skill.metadata(input) : {}),
    ...(opts.metadata ?? {}),
    // Unification: ONE step field derived from the skill (previously
    // taskType/metadata.step/SSE step disagreed for the same operation).
    step: skill.sseStep,
    skill: skill.id,
  };
  return chatWithSession(opts.projectId, prompt, {
    system,
    temperature: chatOpts.temperature,
    taskType: skill.taskType,
    maxTokens: chatOpts.maxTokens,
    timeoutMs: chatOpts.timeoutMs,
    role: chatOpts.role,
    thinking: chatOpts.thinking,
    metadata,
  });
}
