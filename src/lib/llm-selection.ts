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
 */
export type SelectedProviderId = string;

interface StoredSelection {
  provider: SelectedProviderId;
  updatedAt: string;
}

let _cached: { value: SelectedProviderId; at: number } | null = null;
const CACHE_TTL_MS = 2_000;

export function getSelectedProvider(): SelectedProviderId {
  // In-process fast cache so per-request reads don't touch disk.
  if (_cached && Date.now() - _cached.at < CACHE_TTL_MS) return _cached.value;
  const fallback: SelectedProviderId = "zai-sdk";
  try {
    if (!existsSync(SELECTED_FILE)) {
      _cached = { value: fallback, at: Date.now() };
      return fallback;
    }
    const text = readFileSync(SELECTED_FILE, "utf8");
    const parsed = JSON.parse(text) as StoredSelection;
    const v = parsed?.provider?.trim() || fallback;
    _cached = { value: v, at: Date.now() };
    return v;
  } catch {
    _cached = { value: fallback, at: Date.now() };
    return fallback;
  }
}

export function setSelectedProvider(provider: SelectedProviderId): void {
  try {
    const payload: StoredSelection = {
      provider,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(SELECTED_FILE, JSON.stringify(payload, null, 2));
    _cached = { value: provider, at: Date.now() };
  } catch (err) {
    console.warn("[llm-selection] failed to persist:", (err as Error).message);
  }
}
