/**
 * Persistent "currently selected provider" storage.
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
 * Round-18: the store now also carries an optional per-selection MODEL
 * override — e.g. the model id for a CLI provider (codebuddy `--model X`)
 * or an api: provider. Empty string = "use the provider default".
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

interface StoredSelection {
  provider: SelectedProviderId;
  /** Optional model override for the selected provider ("" = default). */
  model?: string;
  updatedAt: string;
}

let _cached: { value: StoredSelection; at: number } | null = null;
const CACHE_TTL_MS = 2_000;

function readSelection(): StoredSelection {
  const fallback: StoredSelection = { provider: "zai-sdk", updatedAt: "" };
  try {
    if (!existsSync(SELECTED_FILE)) return fallback;
    const text = readFileSync(SELECTED_FILE, "utf8");
    const parsed = JSON.parse(text) as StoredSelection;
    return {
      provider: parsed?.provider?.trim() || "zai-sdk",
      model: typeof parsed?.model === "string" ? parsed.model.trim() : "",
      updatedAt: parsed?.updatedAt ?? "",
    };
  } catch {
    return fallback;
  }
}

function writeSelection(sel: StoredSelection): void {
  try {
    const payload: StoredSelection = {
      provider: sel.provider,
      model: sel.model ?? "",
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(SELECTED_FILE, JSON.stringify(payload, null, 2));
    _cached = { value: payload, at: Date.now() };
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

export function getSelectedProvider(): SelectedProviderId {
  return currentSelection().provider;
}

/** Optional model override for the selected provider ("" = provider default). */
export function getSelectedModel(): string {
  return currentSelection().model ?? "";
}

export function setSelectedProvider(
  provider: SelectedProviderId,
  model?: string,
): void {
  const prev = currentSelection();
  const providerChanged = prev.provider !== provider;
  writeSelection({
    provider,
    // Provider switch without an explicit model → CLEAR the override: a
    // model id from the old provider (e.g. "deepseek-chat") is meaningless
    // — and often fatal — for the new one (zai-sdk / codebuddy / ...).
    // Same provider without an explicit model → keep the stored override.
    model: model !== undefined ? model.trim() : providerChanged ? "" : prev.model ?? "",
    updatedAt: new Date().toISOString(),
  });
}
