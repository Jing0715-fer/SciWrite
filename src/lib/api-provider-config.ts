/**
 * API provider credential store — per-provider API key + baseURL + default
 * model overrides for the OpenAI-compatible provider catalog
 * (src/lib/provider-catalog.ts), persisted to ~/.sciwrite/api-providers.json.
 *
 * Ported from pdb-tracker-web-v5's DSH-mode credentials store
 * (src/lib/agent/providers/credentials.ts), adapted for SciWrite:
 *
 *   • Store location: ~/.sciwrite/ (NOT the project dir — writes there would
 *     trigger webpack's file watcher → HMR / page refresh; and NOT os.tmpdir()
 *     either — API keys must survive reboots). Home dir is persistent and
 *     watcher-free.
 *   • File written with 0o600 permissions where the OS supports it.
 *   • Resolution order for keys:  explicit config → provider's env var → null.
 *   • Resolution order for base URL: explicit config override → catalog default.
 *     (Unlike the upstream repo, user-edited base URLs WIN over the catalog —
 *     custom gateways are a core requirement here, not a stale-cache bug.)
 *
 * Server-only (node:fs). The front-end reads/writes through
 * /api/llm-config/providers.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER_CATALOG, getProviderProfile } from "@/lib/provider-catalog";

export interface ApiProviderConfig {
  /** The API key for this provider. */
  apiKey?: string;
  /** Override the default baseURL (custom gateway / proxy). */
  baseURL?: string;
  /** Override the default model for this provider. */
  defaultModel?: string;
  /** When true the provider is skipped even if a key exists. */
  enabled?: boolean;
}

export type ApiProviderConfigMap = Record<string, ApiProviderConfig>;

const CONFIG_DIR = join(homedir(), ".sciwrite");
const CONFIG_FILE = join(CONFIG_DIR, "api-providers.json");

/** In-memory cache with mtime invalidation — eliminates repeated disk reads. */
let cachedConfigs: ApiProviderConfigMap | null = null;
let cachedMtime = 0;

/** Load the provider config from disk (with in-memory caching). */
export function loadApiProviderConfigs(): ApiProviderConfigMap {
  try {
    if (!existsSync(CONFIG_FILE)) {
      cachedConfigs = {};
      cachedMtime = 0;
      return {};
    }
    const stat = statSync(CONFIG_FILE);
    if (cachedConfigs && stat.mtimeMs === cachedMtime) {
      return cachedConfigs;
    }
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    cachedConfigs = JSON.parse(raw) as ApiProviderConfigMap;
    cachedMtime = stat.mtimeMs;
    return cachedConfigs;
  } catch {
    return cachedConfigs ?? {};
  }
}

/** Save the provider config to disk with restrictive permissions + invalidate cache. */
export function saveApiProviderConfigs(configs: ApiProviderConfigMap): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    cachedConfigs = null;
    cachedMtime = 0;
  } catch (err) {
    console.error("[api-provider-config] save failed:", (err as Error).message);
  }
}

/** Get the config for a single provider. */
export function getApiProviderConfig(providerId: string): ApiProviderConfig {
  const configs = loadApiProviderConfigs();
  return configs[providerId] ?? {};
}

/** Set the config for a single provider (merges with existing). */
export function setApiProviderConfig(
  providerId: string,
  config: ApiProviderConfig,
): void {
  if (!getProviderProfile(providerId)) return;
  const configs = loadApiProviderConfigs();
  configs[providerId] = { ...configs[providerId], ...config };
  saveApiProviderConfigs(configs);
}

/** Delete a provider's config. */
export function deleteApiProviderConfig(providerId: string): void {
  const configs = loadApiProviderConfigs();
  delete configs[providerId];
  saveApiProviderConfigs(configs);
}

/**
 * Resolve the effective API key for a provider:
 * explicit config → env var → null. Local runtimes (Ollama) fall back to a
 * dummy key so the auth header is well-formed.
 */
export function resolveApiKey(providerId: string): string | null {
  const profile = getProviderProfile(providerId);
  if (!profile) return null;
  const config = getApiProviderConfig(providerId);
  if (config.apiKey && config.apiKey.trim()) return config.apiKey.trim();
  const envKey = process.env[profile.apiKeyEnv];
  if (envKey && envKey.trim()) return envKey.trim();
  if (profile.apiKeyOptional) return "ollama"; // local runtime — header ignored
  return null;
}

/** Resolve the effective baseURL: user override → catalog default. */
export function resolveBaseURL(providerId: string): string | null {
  const profile = getProviderProfile(providerId);
  if (!profile) return null;
  const config = getApiProviderConfig(providerId);
  const custom = config.baseURL?.trim();
  if (custom) return custom.replace(/\/+$/, "");
  return profile.baseURL;
}

/** Resolve the effective default model: user override → catalog default. */
export function resolveDefaultModel(providerId: string): string | null {
  const profile = getProviderProfile(providerId);
  if (!profile) return null;
  const config = getApiProviderConfig(providerId);
  if (config.defaultModel?.trim()) return config.defaultModel.trim();
  return profile.defaultModel;
}

/** Check if an API provider is usable (has a key, or is a keyless local runtime). */
export function isApiProviderAvailable(providerId: string): boolean {
  const profile = getProviderProfile(providerId);
  if (!profile) return false;
  const config = getApiProviderConfig(providerId);
  if (config.enabled === false) return false;
  if (config.apiKey?.trim()) return true;
  if (profile.apiKeyOptional) return true;
  return !!process.env[profile.apiKeyEnv];
}

export interface ApiProviderStatus {
  id: string;
  displayName: string;
  label: string;
  icon: string;
  baseURL: string;
  effectiveBaseURL: string;
  apiKeyEnv: string;
  defaultModel: string;
  effectiveModel: string;
  models: Array<{ id: string; name: string }>;
  docsUrl: string;
  available: boolean;
  hasApiKey: boolean;
  hasBaseURLOverride: boolean;
  apiKeyOptional: boolean;
}

/** List all catalog providers with their availability status (for the UI). */
export function listApiProvidersWithStatus(): ApiProviderStatus[] {
  return PROVIDER_CATALOG.map((p) => {
    const config = getApiProviderConfig(p.id);
    const effectiveBase = resolveBaseURL(p.id) ?? p.baseURL;
    return {
      id: p.id,
      displayName: p.displayName,
      label: p.label,
      icon: p.icon,
      baseURL: p.baseURL,
      effectiveBaseURL: effectiveBase,
      apiKeyEnv: p.apiKeyEnv,
      defaultModel: p.defaultModel,
      effectiveModel: resolveDefaultModel(p.id) ?? p.defaultModel,
      models: p.models.map((m) => ({ id: m.id, name: m.name })),
      docsUrl: p.docsUrl,
      available: isApiProviderAvailable(p.id),
      hasApiKey: !!config.apiKey?.trim() || !!process.env[p.apiKeyEnv],
      hasBaseURLOverride: !!config.baseURL?.trim(),
      apiKeyOptional: !!p.apiKeyOptional,
    };
  });
}

export { CONFIG_FILE };
