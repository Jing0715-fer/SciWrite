"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Cpu,
  Loader2,
  CheckCircle2,
  XCircle,
  Terminal,
  Zap,
  Settings2,
  Database,
  Trash2,
  Key,
  Globe,
  Box,
  Plus,
  ExternalLink,
  RefreshCw,
  AlertCircle,
  ChevronDown,
  Pencil,
  Snowflake,
  Fish,
  Brain,
  Bot,
  Gem,
  Cloud,
  Moon,
  Sparkles,
  Sparkle,
  BarChart3,
  Wind,
  Rocket,
  Network,
  Hexagon,
  Users,
  Server,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

// ─── DSH-mode API provider types (mirrors /api/llm-config/providers GET) ─────

interface ApiProviderInfo {
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

/** name (dialog) → provider id (server) for CLI + SDK entries. */
const CLI_PROVIDER_MAP: Record<string, string> = {
  hermes: "cli:hermes",
  claude: "cli:claude",
  codex: "cli:codex",
  gemini: "cli:gemini",
  openclaw: "cli:openclaw",
  codebuddy: "cli:codebuddy",
  aider: "cli:aider",
  "z-ai": "zai-sdk",
  "anthropic-sdk": "anthropic",
  "openai-sdk": "openai",
};

/**
 * lucide icon name → component. Provider catalog `icon` fields carry these
 * names over the API JSON (they used to be emoji — replaced per design rule:
 * no emoji icons in the UI). Fallback for unknown names: Globe.
 */
const PROVIDER_ICONS: Record<string, LucideIcon> = {
  snowflake: Snowflake,
  fish: Fish,
  brain: Brain,
  bot: Bot,
  gem: Gem,
  cloud: Cloud,
  moon: Moon,
  sparkles: Sparkles,
  sparkle: Sparkle,
  "bar-chart-3": BarChart3,
  zap: Zap,
  wind: Wind,
  rocket: Rocket,
  network: Network,
  hexagon: Hexagon,
  users: Users,
  server: Server,
};

function ProviderIcon({ name, className }: { name: string; className?: string }) {
  const Icon = PROVIDER_ICONS[name] ?? Globe;
  return <Icon className={cn("shrink-0", className)} aria-hidden="true" />;
}

export function LLMConfigDialog({ open, onOpenChange }: Props) {
  const { t } = useI18n();
  const [config, setConfig] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const [testCli, setTestCli] = React.useState("z-ai");
  const [testPrompt, setTestPrompt] = React.useState("What is 2+2?");
  const [testResult, setTestResult] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  // Persisted across reloads; mirrors the server-side authoritative state in
  // /api/llm-config/select which `src/lib/ai.ts` reads.
  const [selected, setSelected] = React.useState<string>("zai-sdk");
  const [modelOverride, setModelOverride] = React.useState<string>("");
  const [selecting, setSelecting] = React.useState<string | null>(null);

  // ── DSH-mode API providers ──
  const [apiProviders, setApiProviders] = React.useState<ApiProviderInfo[]>([]);
  const [apiDefault, setApiDefault] = React.useState<string>("");
  const [apiLoading, setApiLoading] = React.useState(false);

  const loadSelection = React.useCallback(async () => {
    try {
      const r = await fetch("/api/llm-config/select");
      const d = await r.json();
      if (d?.provider) setSelected(d.provider);
      if (typeof d?.model === "string") setModelOverride(d.model);
    } catch {
      /* server not reachable; keep default */
    }
  }, []);

  const loadApiProviders = React.useCallback(async () => {
    setApiLoading(true);
    try {
      const res = await fetch("/api/llm-config/providers");
      if (!res.ok) return;
      const data = await res.json();
      setApiProviders(data.providers ?? []);
      setApiDefault(data.defaultProvider ?? "");
    } catch {
      /* ignore */
    } finally {
      setApiLoading(false);
    }
  }, []);

  const detect = React.useCallback(async () => {
      setLoading(true);
      try {
        // ?fresh=1 forces a LIVE re-probe of every CLI adapter inside
        // inspectProviders() — bypassing both the in-process (5 min) and the
        // disk (48 h) probe caches. Previously the redetect flow could serve
        // a stale cached snapshot, which is why re-detection "did nothing"
        // after installing a new CLI (hermes/codex).
        const data = await fetch("/api/llm-config?fresh=1").then((r) => r.json());
        setConfig(data);
        await loadSelection();
        await loadApiProviders();
      } catch (e: any) {
        toast.error(e.message);
      } finally {
        setLoading(false);
      }
  }, [loadSelection, loadApiProviders]);

  const choose = React.useCallback(async (name: string) => {
    const provider = CLI_PROVIDER_MAP[name] ?? name; // api:* ids pass through
    setSelecting(name);
    try {
      const r = await fetch("/api/llm-config/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model: modelOverride || undefined }),
      });
      const d = await r.json();
      if (!r.ok || !d?.ok) {
        toast.error(d?.error || "Failed to select provider");
        return;
      }
      setSelected(d.provider);
      if (typeof d?.model === "string") setModelOverride(d.model);
      try { localStorage.setItem("sciwrite:llm-provider:v1", d.provider); } catch {}
      toast.success(`Default provider set to ${name}`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSelecting(null);
    }
  }, [modelOverride]);

  React.useEffect(() => {
    if (open && !config) {
      detect();
    } else if (open && config) {
      // Cheap refresh of selection + provider configs (no forced re-probe).
      loadSelection();
      loadApiProviders();
    }
  }, [open, config, detect, loadSelection, loadApiProviders]);

  const saveModelOverride = async () => {
    try {
      const r = await fetch("/api/llm-config/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selected, model: modelOverride }),
      });
      const d = await r.json();
      if (!r.ok || !d?.ok) {
        toast.error(d?.error || "Failed to save model");
        return;
      }
      toast.success(t("llmConfig.modelSaved"));
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/llm-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cli: testCli, prompt: testPrompt, model: modelOverride || undefined }),
      });
      const data = await res.json();
      if (data.error) {
        setTestResult(`Error: ${data.error}`);
        toast.error(data.error);
      } else {
        setTestResult(data.output);
        toast.success(t("toast.cliTestSuccessful"));
      }
    } catch (e: any) {
      setTestResult(`Error: ${e.message}`);
      toast.error(e.message);
    } finally {
      setTesting(false);
    }
  };

  const selectedLabel = React.useMemo(() => {
    const found = (config?.detected ?? []).find((c: any) => {
      const provId = CLI_PROVIDER_MAP[c.name] ?? c.name;
      return provId === selected;
    });
    return found?.label ?? selected;
  }, [config, selected]);

  const selectedIsApi = selected.startsWith("api:");
  const selectedApi = apiProviders.find((p) => `api:${p.id}` === selected);
  const selectedIsCodebuddy = selected === "cli:codebuddy";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0 rounded-xl overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60 shrink-0 bg-gradient-to-r from-primary/5 to-transparent">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-4 w-4 text-primary" />
            {t("llmConfig.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("llmConfig.desc")}
          </DialogDescription>
        </DialogHeader>

        {/* Native scrollable body — NOT Radix ScrollArea: inside a
            `height:auto + max-h-[85vh]` flex-column dialog, the Radix viewport's
            `height:100%` resolves against a content-derived (indefinite) flex
            item height, silently falling back to full content height. The
            overflow then gets clipped by the dialog's overflow-hidden with no
            scrollbar — "bottom cut off". A native overflow-y-auto div needs no
            percentage resolution: its own flexed height clips the content and
            the (visible, styled) scrollbar just works. */}
        <div className="flex-1 min-h-0 overflow-y-auto scroll-academic">
          <div className="px-6 py-4 space-y-5">
            {/* Currently selected default provider + model override */}
            <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-950/20 p-3 space-y-2">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                  {t("llmConfig.default")} {selectedLabel}
                </span>
                <Badge variant="outline" className="text-[8px] h-3.5 uppercase ml-auto">
                  {t("llmConfig.active")}
                </Badge>
              </div>
              <p className="text-[10px] text-muted-foreground">
                {selected === "zai-sdk" || !selected
                  ? t("llmConfig.defaultDesc")
                  : selectedIsApi
                    ? t("llmConfig.apiSelectedDesc", { name: selectedApi?.displayName ?? selected })
                    : `Currently routing all AI tasks through ${selected} (selected via LLM Config).`}
              </p>
              {/* Model override — applies to CLI agents (codebuddy --model) and
                  API providers alike; empty = provider default. */}
              <div className="flex items-center gap-1.5 pt-0.5">
                <Box className="h-3 w-3 text-muted-foreground shrink-0" />
                <Input
                  value={modelOverride}
                  onChange={(e) => setModelOverride(e.target.value)}
                  placeholder={
                    selectedIsApi
                      ? selectedApi?.effectiveModel || t("llmConfig.modelOverridePlaceholder")
                      : t("llmConfig.modelOverridePlaceholder")
                  }
                  className="h-7 text-[11px] font-mono flex-1 bg-background/60"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[10px] px-2 shrink-0"
                  onClick={saveModelOverride}
                >
                  {t("llmConfig.saveModel")}
                </Button>
              </div>
              {selectedIsCodebuddy && (
                <div className="flex items-start gap-1.5 rounded-md border border-amber-300/50 bg-amber-50/60 dark:bg-amber-950/20 px-2 py-1.5">
                  <AlertCircle className="h-3 w-3 text-amber-600 shrink-0 mt-0.5" />
                  <p className="text-[10px] leading-relaxed text-amber-800 dark:text-amber-300">
                    {t("llmConfig.codebuddyHint")}
                  </p>
                </div>
              )}
            </div>

            {/* Detected CLIs (original agent detection — kept) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
                  <Terminal className="h-3 w-3" />
                  {t("llmConfig.detected")}
                </p>
                <Button variant="ghost" size="sm" className="h-6 text-[10px] gap-1" onClick={detect} disabled={loading}>
                  {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Settings2 className="h-3 w-3" />}
                  {t("llmConfig.redetect")}
                </Button>
              </div>

              {loading && !config && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              )}

              {config?.detected?.length === 0 && !loading && (
                <div className="text-center py-8 text-muted-foreground">
                  <Terminal className="h-8 w-8 mx-auto opacity-40 mb-2" />
                  <p className="text-xs">{t("llmConfig.noClis")}</p>
                  <p className="text-[10px] mt-1">{t("llmConfig.noClisHint")}</p>
                </div>
              )}

              {config?.detected?.map((cli: any) => {
                const provId = CLI_PROVIDER_MAP[cli.name] ?? cli.name;
                const isSelected = selected === provId;
                const isApiRow = cli.name.startsWith("api:");
                return (
                <button
                  key={cli.name}
                  type="button"
                  onClick={() => choose(cli.name)}
                  disabled={selecting === cli.name}
                  className={cn(
                    "w-full text-left rounded-lg border p-3 space-y-1.5 transition-all",
                    isSelected
                      ? "border-primary bg-gradient-to-br from-primary/8 to-primary/3 ring-1 ring-primary/30 shadow-sm"
                      : "border-border/60 hover:border-primary/40 hover:bg-muted/30 hover:shadow-sm",
                    selecting === cli.name ? "opacity-60" : "",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className={cn("h-3.5 w-3.5 shrink-0", isSelected ? "text-primary" : "text-emerald-600")} />
                    <span className="text-xs font-semibold">{cli.label}</span>
                    <Badge variant="outline" className="text-[8px] h-3.5 uppercase">
                      {isApiRow ? cli.name.slice(4) : cli.name}
                    </Badge>
                    {isSelected && (
                      <Badge className="text-[8px] h-3.5 uppercase ml-auto bg-primary text-primary-foreground">
                        default
                      </Badge>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground space-y-0.5">
                    <p><span className="font-mono">{t("llmConfig.path")}</span> {cli.path}</p>
                    {cli.version && <p><span className="font-mono">{t("llmConfig.version")}</span> {cli.version}</p>}
                    {cli.models?.length > 0 && (
                      <div>
                        <span className="font-mono">{t("llmConfig.models")}</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {cli.models.slice(0, 8).map((m: string) => (
                            <span key={m} className="text-[9px] px-1 py-0.5 rounded bg-muted/50 font-mono">
                              {m}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </button>
                );
              })}
            </div>

            {/* API Providers — DSH mode (pdb-tracker-web-v5 style) */}
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
                <Key className="h-3 w-3" />
                {t("llmConfig.apiProviders")}
              </p>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                {t("llmConfig.apiProvidersHint")}
              </p>

              <ApiProviderForm
                providers={apiProviders}
                onSaved={() => { void loadApiProviders(); void detect(); }}
              />

              {/* Configured API providers */}
              {apiLoading && apiProviders.length === 0 ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                apiProviders.filter((p) => p.hasApiKey || p.apiKeyOptional).length > 0 && (
                  <div>
                    <div className="text-[10px] text-muted-foreground mb-1.5 flex items-center justify-between">
                      <span>{t("llmConfig.configured")} ({apiProviders.filter((p) => p.hasApiKey || p.apiKeyOptional).length})</span>
                      <span className="text-[9px] text-muted-foreground/60">{t("llmConfig.clickToSetDefault")}</span>
                    </div>
                    <div className="space-y-1.5">
                      {apiProviders
                        .filter((p) => p.hasApiKey || p.apiKeyOptional)
                        .map((p) => (
                          <ConfiguredApiProviderRow
                            key={p.id}
                            provider={p}
                            isDefault={apiDefault === `api:${p.id}`}
                            onSetDefault={async (id) => {
                              await fetch("/api/llm-config/providers", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ providerId: id, setDefault: true }),
                              });
                              setApiDefault(`api:${id}`);
                              setSelected(`api:${id}`);
                              try { localStorage.setItem("sciwrite:llm-provider:v1", `api:${id}`); } catch {}
                              toast.success(`Default provider set to ${id}`);
                            }}
                            onChanged={() => { void loadApiProviders(); void loadSelection(); }}
                          />
                        ))}
                    </div>
                  </div>
                )
              )}
            </div>

            {/* Environment variables */}
            {config?.envKeys && (
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  {t("llmConfig.apiKeys")}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(config.envKeys).map(([key, has]: [string, any]) => (
                    <div key={key} className="flex items-center gap-2 text-[10px] rounded-md border border-border/50 p-1.5">
                      {has ? (
                        <CheckCircle2 className="h-3 w-3 text-emerald-600 shrink-0" />
                      ) : (
                        <XCircle className="h-3 w-3 text-muted-foreground shrink-0" />
                      )}
                      <span className="font-mono">{key}</span>
                      <span className={cn("ml-auto", has ? "text-emerald-600" : "text-muted-foreground")}>
                        {has ? t("llmConfig.keySet") : t("llmConfig.keyNotSet")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* CLI Test */}
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
                <Zap className="h-3 w-3" />
                {t("llmConfig.testCli")}
              </p>
              <div className="flex gap-2">
                <Select value={testCli} onValueChange={setTestCli}>
                  <SelectTrigger className="w-36 h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    {(config?.detected || []).map((cli: any) => (
                      <SelectItem key={cli.name} value={cli.name} className="text-xs">
                        {cli.name.startsWith("api:") ? cli.name.slice(4) + " (API)" : cli.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={testPrompt}
                  onChange={(e) => setTestPrompt(e.target.value)}
                  placeholder={t("llmConfig.testPromptPlaceholder")}
                  className="flex-1 h-8 text-xs"
                />
                <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={runTest} disabled={testing || !testCli}>
                  {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                  {t("llmConfig.testBtn")}
                </Button>
              </div>
              {testResult && (
                <div className="rounded-md border border-border/40 bg-muted/20 p-2.5">
                  <pre className="text-[10px] font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto scroll-academic">
                    {testResult}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add-provider form (DSH mode) ─────────────────────────────────────────────

function ApiProviderForm({
  providers,
  onSaved,
}: {
  providers: ApiProviderInfo[];
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [baseURL, setBaseURL] = React.useState("");
  const [selectedModel, setSelectedModel] = React.useState("");
  const [liveModels, setLiveModels] = React.useState<Array<{ id: string; name: string }>>([]);
  const [useCustomModel, setUseCustomModel] = React.useState(false);
  const [customModel, setCustomModel] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [fetchingModels, setFetchingModels] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; error?: string; reply?: string } | null>(null);

  // Providers not yet configured (hide ones that already have a key, unless
  // the user wants to re-enter one — those live in the configured list).
  const unconfigured = providers.filter((p) => !p.hasApiKey && !p.apiKeyOptional);
  const selected = providers.find((p) => p.id === selectedId);
  const effectiveModel = useCustomModel ? customModel.trim() : selectedModel;

  // Reset form when provider changes: baseURL + model pre-fill from catalog.
  React.useEffect(() => {
    const sel = providers.find((p) => p.id === selectedId);
    if (sel) {
      setBaseURL(sel.baseURL);
      setSelectedModel(sel.defaultModel);
      setUseCustomModel(false);
      setCustomModel("");
      setLiveModels([]);
      setTestResult(null);
    }
  }, [selectedId, providers]);

  const modelOptions = liveModels.length > 0
    ? liveModels
    : (selected?.models ?? []);

  const fetchLiveModels = async () => {
    if (!selected) return;
    setFetchingModels(true);
    try {
      const params = new URLSearchParams({ providerId: selected.id });
      if (apiKey.trim()) params.set("apiKey", apiKey.trim());
      if (baseURL.trim()) params.set("baseURL", baseURL.trim());
      const res = await fetch(`/api/llm-config/providers/models?${params.toString()}`);
      const data = await res.json();
      if (Array.isArray(data.models) && data.models.length > 0) {
        // Merge: live list first; keep the current selection valid.
        setLiveModels(data.models);
        if (!data.models.some((m: any) => m.id === selectedModel)) {
          setSelectedModel(data.models[0]?.id ?? selectedModel);
        }
      }
      if (data.warning) toast.message(data.warning);
      if (data.error) toast.warning(data.error);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setFetchingModels(false);
    }
  };

  const handleSave = async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      const res = await fetch("/api/llm-config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: selectedId,
          apiKey: apiKey.trim() || undefined,
          baseURL: baseURL.trim() || undefined,
          defaultModel: effectiveModel || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok || !d?.ok) {
        toast.error(d?.error || "Save failed");
        return;
      }
      toast.success(t("llmConfig.providerSaved"));
      setSelectedId("");
      setApiKey("");
      setBaseURL("");
      setSelectedModel("");
      setCustomModel("");
      setUseCustomModel(false);
      setLiveModels([]);
      setTestResult(null);
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!selectedId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/llm-config/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: selectedId,
          apiKey: apiKey.trim() || undefined,
          baseURL: baseURL.trim() || undefined,
          model: effectiveModel || undefined,
        }),
      });
      const data = await res.json();
      setTestResult(data);
      if (data.ok) {
        toast.success(t("llmConfig.providerTested"));
      } else {
        toast.error(data.error || "Test failed");
      }
    } catch (e: any) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  if (unconfigured.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 bg-muted/10 px-4 py-4 text-center">
        <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto mb-1.5" />
        <p className="text-xs text-muted-foreground">{t("llmConfig.allProvidersConfigured")}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/60 bg-muted/5 p-4 space-y-3">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Plus className="h-3.5 w-3.5 text-primary" />
        {t("llmConfig.addProvider")}
      </div>

      {/* Provider dropdown */}
      <div>
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 block">
          {t("llmConfig.providerLabel")}
        </Label>
        <Select value={selectedId} onValueChange={(v) => setSelectedId(v)}>
          <SelectTrigger className="w-full h-8 text-xs">
            <SelectValue placeholder={t("llmConfig.selectProvider")} />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            {unconfigured.map((p) => (
              <SelectItem key={p.id} value={p.id} className="text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <ProviderIcon name={p.icon} className="h-3 w-3 text-primary" />
                  {p.displayName}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selected && (
        <>
          {/* Base URL — pre-filled from catalog, freely editable */}
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
              <Globe className="h-2.5 w-2.5" />
              Base URL
            </Label>
            <Input
              type="text"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="h-8 text-xs font-mono"
            />
            {baseURL.trim() !== selected.baseURL && (
              <p className="text-[9px] text-amber-600 dark:text-amber-400 mt-1">
                {t("llmConfig.customBaseUrl")}
              </p>
            )}
          </div>

          {/* Model — catalog dropdown + custom input toggle */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                <Box className="h-2.5 w-2.5" />
                {t("llmConfig.model")}
              </Label>
              <button
                type="button"
                onClick={fetchLiveModels}
                disabled={fetchingModels}
                className="text-[9px] text-primary hover:underline flex items-center gap-0.5 disabled:opacity-50"
              >
                {fetchingModels ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <RefreshCw className="h-2.5 w-2.5" />}
                {t("llmConfig.fetchModels")}
              </button>
            </div>
            {!useCustomModel ? (
              <>
                <Select value={selectedModel} onValueChange={(v) => setSelectedModel(v)}>
                  <SelectTrigger className="w-full h-8 text-xs font-mono">
                    <SelectValue placeholder={t("llmConfig.selectModel")} />
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    {modelOptions.map((m) => (
                      <SelectItem key={m.id} value={m.id} className="text-xs">
                        {m.name !== m.id ? `${m.name} (${m.id})` : m.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  onClick={() => { setUseCustomModel(true); setCustomModel(selectedModel); }}
                  className="mt-1 text-[10px] text-primary hover:underline"
                >
                  + {t("llmConfig.customModel")}
                </button>
              </>
            ) : (
              <div className="flex gap-1.5">
                <Input
                  type="text"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder={t("llmConfig.customModelPlaceholder")}
                  className="h-8 text-xs font-mono flex-1"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setUseCustomModel(false)}
                  className="h-8 text-[10px] text-muted-foreground shrink-0"
                >
                  {t("llmConfig.backToList")}
                </Button>
              </div>
            )}
          </div>

          {/* API key */}
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
              <Key className="h-2.5 w-2.5" />
              API Key
            </Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                selected.apiKeyOptional
                  ? t("llmConfig.apiKeyOptionalPlaceholder")
                  : t("llmConfig.apiKeyPlaceholder", { name: selected.displayName })
              }
              className="h-8 text-xs font-mono"
              autoComplete="off"
            />
            <p className="text-[9px] text-muted-foreground mt-1">
              {selected.hasApiKey
                ? t("llmConfig.keyStored")
                : `${selected.apiKeyEnv} ${t("llmConfig.envFallback")}`}
            </p>
          </div>

          {/* Test result */}
          {testResult && (
            <div className={cn(
              "rounded-md px-2.5 py-1.5 text-[11px] flex items-center gap-1.5 border",
              testResult.ok
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                : "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300",
            )}>
              {testResult.ok ? <CheckCircle2 className="h-3 w-3 shrink-0" /> : <AlertCircle className="h-3 w-3 shrink-0" />}
              <span className="break-words">{testResult.ok ? `${t("llmConfig.providerTested")}${testResult.reply ? ` — ${testResult.reply}` : ""}` : testResult.error}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <a
              href={selected.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-muted-foreground hover:text-primary flex items-center gap-0.5 transition-colors"
            >
              <ExternalLink className="h-2.5 w-2.5" />
              {t("llmConfig.getApiKey")}
            </a>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={testing || !selectedId}
                className="h-7 text-[10px]"
              >
                {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                {t("llmConfig.testBtn")}
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving || !selectedId || (!apiKey.trim() && !selected.apiKeyOptional && !selected.hasApiKey)}
                className="h-7 text-[10px]"
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                {t("llmConfig.save")}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Configured provider row (expand to edit / test / delete) ────────────────

function ConfiguredApiProviderRow({
  provider,
  isDefault,
  onSetDefault,
  onChanged,
}: {
  provider: ApiProviderInfo;
  isDefault: boolean;
  onSetDefault: (id: string) => Promise<void>;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [editApiKey, setEditApiKey] = React.useState("");
  const [editBaseURL, setEditBaseURL] = React.useState("");
  const [editModel, setEditModel] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; error?: string; reply?: string } | null>(null);

  const handleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!expanded) {
      setEditBaseURL(provider.effectiveBaseURL);
      setEditModel(provider.effectiveModel || provider.defaultModel);
      setEditApiKey("");
      setTestResult(null);
    }
    setExpanded(!expanded);
  };

  const handleSave = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSaving(true);
    try {
      await fetch("/api/llm-config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: provider.id,
          apiKey: editApiKey.trim() || undefined,
          baseURL: editBaseURL.trim() || undefined,
          defaultModel: editModel.trim() || undefined,
        }),
      });
      setEditApiKey("");
      setExpanded(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    // Save unsaved edits first so the test exercises what the user sees.
    if (editApiKey.trim() || editBaseURL !== provider.effectiveBaseURL || editModel !== provider.effectiveModel) {
      await handleSave();
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/llm-config/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: provider.id }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleting(true);
    try {
      await fetch(`/api/llm-config/providers?providerId=${provider.id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className={cn(
        "rounded-md border transition-colors overflow-hidden",
        isDefault
          ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
          : provider.available
            ? "border-emerald-500/30 bg-emerald-500/5"
            : "border-border/60 bg-muted/10",
      )}
    >
      {/* Header row — click sets default; chevron expands editor */}
      <button
        type="button"
        onClick={() => onSetDefault(provider.id)}
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-muted/30 transition-colors"
      >
        <ProviderIcon name={provider.icon} className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-semibold">{provider.displayName}</span>
        {isDefault && (
          <Badge className="text-[8px] h-3.5 uppercase bg-primary text-primary-foreground">
            default
          </Badge>
        )}
        {!provider.hasApiKey && provider.apiKeyOptional && (
          <Badge variant="outline" className="text-[8px] h-3.5">{t("llmConfig.noApiKey")}</Badge>
        )}
        <span className="text-[9px] font-mono text-muted-foreground ml-auto truncate max-w-[45%]">
          {provider.effectiveModel}
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={handleExpand}
          onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") handleExpand(ev as any); }}
          className="p-0.5 rounded hover:bg-muted/70 text-muted-foreground shrink-0"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <Pencil className="h-3 w-3" />}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-border/40 pt-2.5" onClick={(e) => e.stopPropagation()}>
          <div>
            <Label className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Globe className="h-2.5 w-2.5" /> Base URL
            </Label>
            <Input
              value={editBaseURL}
              onChange={(e) => setEditBaseURL(e.target.value)}
              className="h-7 text-[11px] font-mono"
            />
          </div>
          <div>
            <Label className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Box className="h-2.5 w-2.5" /> {t("llmConfig.model")}
            </Label>
            <Input
              value={editModel}
              onChange={(e) => setEditModel(e.target.value)}
              placeholder={provider.defaultModel}
              className="h-7 text-[11px] font-mono"
            />
          </div>
          <div>
            <Label className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Key className="h-2.5 w-2.5" /> API Key
            </Label>
            <Input
              type="password"
              value={editApiKey}
              onChange={(e) => setEditApiKey(e.target.value)}
              placeholder={provider.hasApiKey ? t("llmConfig.keyKeepPlaceholder") : t("llmConfig.apiKeyPlaceholder", { name: provider.displayName })}
              className="h-7 text-[11px] font-mono"
              autoComplete="off"
            />
          </div>
          {testResult && (
            <div className={cn(
              "rounded-md px-2 py-1 text-[10px] flex items-center gap-1.5 border break-words",
              testResult.ok
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                : "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300",
            )}>
              {testResult.ok ? <CheckCircle2 className="h-3 w-3 shrink-0" /> : <AlertCircle className="h-3 w-3 shrink-0" />}
              <span className="break-words">{testResult.ok ? t("llmConfig.providerTested") : testResult.error}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleDelete}
              disabled={deleting}
              className="h-6 text-[10px] text-red-600 hover:text-red-700 hover:bg-red-500/10 gap-1"
            >
              {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              {t("llmConfig.delete")}
            </Button>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" onClick={handleTest} disabled={testing} className="h-6 text-[10px] gap-1">
                {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                {t("llmConfig.testBtn")}
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving} className="h-6 text-[10px] gap-1">
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                {t("llmConfig.save")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * LLM Cache Stats Panel
 *
 * Shows the current LLM cache size + hit/miss rate. The user can manually
 * clear the cache to force fresh LLM calls on the next generation. This is
 * useful when the user suspects the cached results are stale or wants to
 * regenerate with different LLM behavior.
 */
export function LLMCacheStatsPanel() {
  const [stats, setStats] = React.useState<{ size: number; hits: number; misses: number; hitRate: number } | null>(null);
  const [clearing, setClearing] = React.useState(false);

  const loadStats = React.useCallback(async () => {
    try {
      const res = await fetch("/api/llm-cache/stats");
      const data = await res.json();
      setStats(data.stats);
    } catch {
      // server not reachable
    }
  }, []);

  React.useEffect(() => {
    loadStats();
    // Refresh stats every 10s while the panel is visible
    const interval = setInterval(loadStats, 10000);
    return () => clearInterval(interval);
  }, [loadStats]);

  const handleClear = async () => {
    setClearing(true);
    try {
      await fetch("/api/llm-cache/stats", { method: "DELETE" });
      await loadStats();
    } finally {
      setClearing(false);
    }
  };

  if (!stats) return null;

  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
          <Database className="h-3 w-3" />
          LLM Cache
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[9px] text-muted-foreground hover:text-foreground"
          onClick={handleClear}
          disabled={clearing}
          title="Clear all cached LLM responses"
        >
          {clearing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          Clear
        </Button>
      </div>
      <div className="grid grid-cols-4 gap-2">
        <div className="rounded-md bg-background/50 p-1.5 text-center">
          <p className="text-sm font-bold text-primary tabular-nums">{stats.size}</p>
          <p className="text-[8px] uppercase text-muted-foreground">entries</p>
        </div>
        <div className="rounded-md bg-background/50 p-1.5 text-center">
          <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{stats.hits}</p>
          <p className="text-[8px] uppercase text-muted-foreground">hits</p>
        </div>
        <div className="rounded-md bg-background/50 p-1.5 text-center">
          <p className="text-sm font-bold text-amber-600 dark:text-amber-400 tabular-nums">{stats.misses}</p>
          <p className="text-[8px] uppercase text-muted-foreground">misses</p>
        </div>
        <div className="rounded-md bg-background/50 p-1.5 text-center">
          <p className="text-sm font-bold text-foreground tabular-nums">{stats.hitRate}%</p>
          <p className="text-[8px] uppercase text-muted-foreground">hit rate</p>
        </div>
      </div>
    </div>
  );
}
