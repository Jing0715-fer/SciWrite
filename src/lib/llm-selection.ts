/**
 * Persistent "currently selected provider" storage — now ROLE-AWARE.
 *
 * Stored in `os.tmpdir()/sciwrite-cache/selected-provider.json` (NOT under
 * the project root) so writes never trigger webpack's file watcher → no
 * HMR / page refresh / CSS flash. Matches the layout of the provider probe
 * cache in `src/lib/llm.ts`.
 *
 * Server-only. The front-end persists the same choice in localStorage so
 * the dialog remembers it across reloads, but the authoritative server
 * state lives here because `src/lib/ai.ts` runs in API routes (nodejs).
 *
 * Round-18: the store carries an optional per-selection MODEL override —
 * e.g. the model id for a CLI provider (codebuddy `--model X`) or an
 * `api:` provider. Empty string = "use the provider default".
 *
 * Round-66 (generation/review split): the store now holds TWO selections:
 *   • generate — writes content (gather/curate/plan/sections/compose/translate)
 *   • review   — verifies & critiques that content (review-engine STEP 8.5,
 *                fact-check, knowledge-verify, adversarial review)
 * Motivation: an external audit of the TMC1/2 article found the same error
 * classes the pipeline's own reviewers missed — a model auditing its own
 * output shares its blind spots. Splitting the two roles across DIFFERENT
 * providers/models (e.g. generate=api:minimax, review=cli:codebuddy — the
 * WorkBuddy desktop agent's CLI — with Deepseek-V4.1-Flash) gives genuinely
 * independent review.
 *
 * Backward compatibility: the legacy flat shape `{ provider, model }` is
 * read as the GENERATE selection; `review` stays unset → review falls back
 * to the generate selection (single-provider behavior, identical to before
 * the split existed).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CACHE_DIR = join(tmpdir(), "sciwrite-cache");
try {
  mkdirSync(CACHE_DIR, { recursive: true });
} catch {}
const SELECTED_FILE = join(CACHE_DIR, "selected-provider.json");

/**
 * Provider id understood by `src/lib/llm.ts`:
 *   - "zai-sdk"          (SciWrite default; z-ai-web-dev-sdk)
 *   - "cli:hermes"       "cli:claude"   "cli:codex"   "cli:gemini"
 *   - "cli:openclaw"     "cli:codebuddy"  "cli:aider"
 *   - "anthropic"        "openai"          (SDK fallbacks, need API keys)
 *   - "api:<catalogId>"  (DSH-mode OpenAI-compatible providers, e.g.
 *                         "api:deepseek" — see src/lib/provider-catalog.ts)
 */
export type SelectedProviderId = string;

/** Pipeline role for provider routing. */
export type LlmRole = "generate" | "review";

export const LLM_ROLES: LlmRole[] = ["generate", "review"];

interface RoleSelection {
  provider: SelectedProviderId;
  /** Optional model override ("" = provider default). */
  model: string;
}

interface StoredSelection {
  /** Legacy field — mirrors roles.generate for old readers. */
  provider: SelectedProviderId;
  model?: string;
  /** Round-66 role-split selections. review may be null (= follow generate). */
  roles?: {
    generate?: RoleSelection;
    review?: RoleSelection | null;
  };
  updatedAt: string;
}

let _cached: { value: StoredSelection; at: number } | null = null;
const CACHE_TTL_MS = 2_000;

/**
 * Round-67 provider-id remap: `api:workbuddy` never existed as a real API —
 * WorkBuddy is a desktop agent whose CLI is `codebuddy` (adapter in
 * src/lib/llm.ts). Any selection stored during the round-66 preview (when a
 * catalog entry had briefly been added under that id) is transparently
 * remapped to `cli:codebuddy` on read so routing never dangles.
 */
function remapProviderId(provider: string): string {
  return provider === "api:workbuddy" ? "cli:codebuddy" : provider;
}

function normalizeSelection(raw: any): StoredSelection {
  // New shape: { roles: { generate: {...}, review: {...}|null } }
  if (raw && typeof raw === "object" && raw.roles && typeof raw.roles === "object") {
    const gen = raw.roles.generate;
    const rev = raw.roles.review;
    const generate: RoleSelection = {
      provider:
        typeof gen?.provider === "string" && gen.provider.trim()
          ? remapProviderId(gen.provider.trim())
          : "zai-sdk",
      model: typeof gen?.model === "string" ? gen.model.trim() : "",
    };
    const review: RoleSelection | null =
      rev && typeof rev === "object" && typeof rev.provider === "string" && rev.provider.trim()
        ? { provider: remapProviderId(rev.provider.trim()), model: typeof rev.model === "string" ? rev.model.trim() : "" }
        : null;
    return {
      provider: generate.provider,
      model: generate.model,
      roles: { generate, review },
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    };
  }
  // Legacy flat shape → generate role only; review unset (follows generate).
  const provider =
    typeof raw?.provider === "string" && raw.provider.trim()
      ? remapProviderId(raw.provider.trim())
      : "zai-sdk";
  const model = typeof raw?.model === "string" ? raw.model.trim() : "";
  return {
    provider,
    model,
    roles: { generate: { provider, model }, review: null },
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : "",
  };
}

function readSelection(): StoredSelection {
  try {
    if (!existsSync(SELECTED_FILE)) return normalizeSelection(null);
    const text = readFileSync(SELECTED_FILE, "utf8");
    return normalizeSelection(JSON.parse(text));
  } catch {
    return normalizeSelection(null);
  }
}

function writeSelection(sel: StoredSelection): void {
  try {
    writeFileSync(SELECTED_FILE, JSON.stringify(sel, null, 2));
    _cached = { value: sel, at: Date.now() };
  } catch (err) {
    console.warn("[llm-selection] failed to persist:", (err as Error).message);
  }
}

function currentSelection(): StoredSelection {
  // In-process fast cache so per-request reads don't touch disk.
  if (_cached && Date.now() - _cached.at < CACHE_TTL_MS) return _cached.value;
  const sel = readSelection();
  _cached = { value: sel, at: Date.now() };
  return sel;
}

/**
 * Resolve the EFFECTIVE selection for a role:
 *   generate → always defined (default zai-sdk)
 *   review   → explicit review selection when set, otherwise the generate
 *              selection (legacy single-provider behavior)
 */
function resolveRole(role: LlmRole): RoleSelection {
  const sel = currentSelection();
  const gen = sel.roles?.generate ?? { provider: sel.provider, model: sel.model ?? "" };
  if (role === "generate") return gen;
  return sel.roles?.review ?? gen;
}

/** Currently selected provider for a role (default "generate"). */
export function getSelectedProvider(role: LlmRole = "generate"): SelectedProviderId {
  return resolveRole(role).provider;
}

/** Optional model override for a role ("" = provider default). */
export function getSelectedModel(role: LlmRole = "generate"): string {
  return resolveRole(role).model;
}

/** True when the review role has an explicit selection (not following generate). */
export function hasReviewOverride(): boolean {
  return currentSelection().roles?.review != null;
}

/** Full snapshot for the UI: both roles + whether review is overridden. */
export function getRoleSelections(): {
  generate: RoleSelection;
  review: RoleSelection | null;
} {
  const sel = currentSelection();
  const gen = sel.roles?.generate ?? { provider: sel.provider, model: sel.model ?? "" };
  return { generate: gen, review: sel.roles?.review ?? null };
}

export function setSelectedProvider(
  provider: SelectedProviderId,
  model?: string,
  role: LlmRole = "generate",
): void {
  const sel = currentSelection();
  const gen = sel.roles?.generate ?? { provider: sel.provider, model: sel.model ?? "" };
  const rev = sel.roles?.review ?? null;

  if (role === "generate") {
    const providerChanged = gen.provider !== provider;
    const nextGen: RoleSelection = {
      provider,
      // Provider switch without an explicit model → CLEAR the override: a
      // model id from the old provider is meaningless — and often fatal —
      // for the new one. Same provider without an explicit model → keep it.
      model: model !== undefined ? model.trim() : providerChanged ? "" : gen.model,
    };
    // When review FOLLOWED the old generate selection, keep following it
    // (stay null). When review had its own selection it is untouched.
    writeSelection({
      provider: nextGen.provider,
      model: nextGen.model,
      roles: { generate: nextGen, review: rev },
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  // ── review role ──
  // model === undefined with the SAME review provider → keep stored override.
  // Switching the review provider without a model → clear the model override.
  const prevRevProvider = rev?.provider ?? "";
  const nextRev: RoleSelection | null = provider
    ? {
        provider,
        model:
          model !== undefined
            ? model.trim()
            : prevRevProvider === provider
              ? (rev?.model ?? "")
              : "",
      }
    : null; // provider="" → clear override, follow generate
  writeSelection({
    provider: gen.provider,
    model: gen.model,
    roles: { generate: gen, review: nextRev },
    updatedAt: new Date().toISOString(),
  });
}

// ─── taskType → role mapping ─────────────────────────────────────────────────
//
// The pipeline tags every chatWithSession() call with a taskType
// ("gather", "plan", "generate", "review", ...). The review role is derived
// from it so call sites need no changes — the split is automatic once a
// review provider is configured.
//
// REVIEW task types (verify/audit/critique the generated content):
//   review              — review-engine STEP 8.5 fix loop + fact-check + /api/ai/review
//   verify              — v2 knowledge-verify step
//   adversarial-review  — /api/articles/[id]/adversarial-review
//   fact-check          — reserved (fact-check.ts currently uses "review")
//   topicality          — reserved for future topicality LLM checks
//
// Everything else (gather/curate/plan/generate/compose/translate/revise/
// write/outline/relationships/allocate/score/analyze/auto-fix/...) produces
// or prepares content → generate role. "revise" and "auto-fix" RESPOND to
// review findings, but they WRITE new content — generation side of the loop.
const REVIEW_TASK_TYPES = new Set([
  "review",
  "verify",
  "adversarial-review",
  "fact-check",
  "topicality",
]);

export function roleForTaskType(taskType: string | undefined | null): LlmRole {
  if (!taskType) return "generate";
  return REVIEW_TASK_TYPES.has(taskType) ? "review" : "generate";
}
