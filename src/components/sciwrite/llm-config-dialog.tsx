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
  RefreshCw,
  Sparkles,
  ShieldCheck,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const PROVIDER_ICONS: Record<string, string> = {
  "z-ai": "🧊",
  "zai-sdk": "🧊",
  "anthropic-sdk": "🤖",
  "anthropic": "🤖",
  "openai-sdk": "🟢",
  "openai": "🟢",
  "hermes": "🪶",
  "claude": "🟠",
  "codex": "🟢",
  "openclaw": "🦅",
  "gemini": "♊",
  "codebuddy": "💙",
  "aider": "🤝",
};

const PROVIDER_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  "z-ai": { bg: "bg-sky-500/10", border: "border-sky-500/30", text: "text-sky-600 dark:text-sky-400" },
  "zai-sdk": { bg: "bg-sky-500/10", border: "border-sky-500/30", text: "text-sky-600 dark:text-sky-400" },
  "anthropic-sdk": { bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-600 dark:text-amber-400" },
  "anthropic": { bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-600 dark:text-amber-400" },
  "openai-sdk": { bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-600 dark:text-emerald-400" },
  "openai": { bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-600 dark:text-emerald-400" },
  "hermes": { bg: "bg-violet-500/10", border: "border-violet-500/30", text: "text-violet-600 dark:text-violet-400" },
  "claude": { bg: "bg-orange-500/10", border: "border-orange-500/30", text: "text-orange-600 dark:text-orange-400" },
  "codex": { bg: "bg-teal-500/10", border: "border-teal-500/30", text: "text-teal-600 dark:text-teal-400" },
  "gemini": { bg: "bg-blue-500/10", border: "border-blue-500/30", text: "text-blue-600 dark:text-blue-400" },
};

export function LLMConfigDialog({ open, onOpenChange }: Props) {
  const { t } = useI18n();
  const [config, setConfig] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const [testCli, setTestCli] = React.useState("z-ai");
  const [testPrompt, setTestPrompt] = React.useState("What is 2+2?");
  const [testResult, setTestResult] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [selected, setSelected] = React.useState<string>("zai-sdk");
  const [selecting, setSelecting] = React.useState<string | null>(null);

  const loadSelection = React.useCallback(async () => {
    try {
      const r = await fetch("/api/llm-config/select");
      const d = await r.json();
      if (d?.provider) setSelected(d.provider);
    } catch {}
  }, []);

  const detect = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/llm-config");
      const data = await res.json();
      setConfig(data);
      await loadSelection();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [loadSelection]);

  const choose = React.useCallback(async (name: string) => {
    const providerMap: Record<string, string> = {
      hermes: "cli:hermes", claude: "cli:claude", codex: "cli:codex",
      gemini: "cli:gemini", openclaw: "cli:openclaw", codebuddy: "cli:codebuddy",
      aider: "cli:aider", "z-ai": "zai-sdk",
      "anthropic-sdk": "anthropic", "openai-sdk": "openai",
    };
    const provider = providerMap[name] ?? name;
    setSelecting(name);
    try {
      const r = await fetch("/api/llm-config/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const d = await r.json();
      if (!r.ok || !d?.ok) {
        toast.error(d?.error || "Failed to select provider");
        return;
      }
      setSelected(d.provider);
      try { localStorage.setItem("sciwrite:llm-provider:v1", d.provider); } catch {}
      toast.success(`Default provider set to ${name}`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSelecting(null);
    }
  }, []);

  React.useEffect(() => {
    if (open && !config) detect();
  }, [open, config, detect]);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/llm-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cli: testCli, prompt: testPrompt }),
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

  const getProviderId = (name: string): string => {
    const m: Record<string, string> = {
      hermes: "cli:hermes", claude: "cli:claude", codex: "cli:codex",
      gemini: "cli:gemini", openclaw: "cli:openclaw", codebuddy: "cli:codebuddy",
      aider: "cli:aider", "z-ai": "zai-sdk",
      "anthropic-sdk": "anthropic", "openai-sdk": "openai",
    };
    return m[name] ?? name;
  };

  const selectedLabel = config?.detected?.find((c: any) => getProviderId(c.name) === selected)?.label ?? selected;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden border-border/60 shadow-2xl">
        {/* Gradient header */}
        <div className="relative px-6 pt-5 pb-4 border-b border-border/60 shrink-0 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center shrink-0">
              <Cpu className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="flex items-center gap-2 text-base font-semibold">
                {t("llmConfig.title")}
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                {t("llmConfig.desc")}
              </DialogDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[10px] gap-1 shrink-0"
              onClick={detect}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              {t("llmConfig.redetect")}
            </Button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto scroll-academic">
          <div className="px-6 py-4 space-y-4">
            {/* Currently selected provider - prominent card */}
            <div className="rounded-xl border-2 border-emerald-500/40 dark:border-emerald-900/50 bg-gradient-to-br from-emerald-50/60 via-emerald-50/30 to-transparent dark:from-emerald-950/30 dark:to-transparent p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-7 w-7 rounded-lg bg-emerald-100 dark:bg-emerald-950/50 flex items-center justify-center">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                </div>
                <div className="flex-1">
                  <p className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400 font-semibold">
                    {t("llmConfig.active")}
                  </p>
                  <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                    {selectedLabel}
                  </p>
                </div>
                <Badge className="text-[8px] h-4 uppercase bg-emerald-600 text-white">
                  Default
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed pl-9">
                {selected === "zai-sdk" || !selected
                  ? t("llmConfig.defaultDesc")
                  : `Currently routing all AI tasks through ${selected}.`}
              </p>
            </div>

            {/* Detected CLIs section */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1.5">
                  <Terminal className="h-3 w-3" />
                  {t("llmConfig.detected")}
                </p>
                {config?.detected?.length > 0 && (
                  <Badge variant="outline" className="text-[8px] h-3.5">
                    {config.detected.length} found
                  </Badge>
                )}
              </div>

              {loading && !config && (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  <p className="text-xs text-muted-foreground mt-3">Detecting CLI providers...</p>
                </div>
              )}

              {config?.detected?.length === 0 && !loading && (
                <div className="text-center py-8 rounded-lg border border-dashed border-border/60 bg-muted/20">
                  <Terminal className="h-8 w-8 mx-auto opacity-40 mb-2" />
                  <p className="text-xs font-medium text-muted-foreground">{t("llmConfig.noClis")}</p>
                  <p className="text-[10px] mt-1 text-muted-foreground/70">{t("llmConfig.noClisHint")}</p>
                </div>
              )}

              {/* Provider cards grid */}
              <div className="grid grid-cols-1 gap-2">
                {config?.detected?.map((cli: any) => {
                  const provId = getProviderId(cli.name);
                  const isSelected = selected === provId;
                  const colors = PROVIDER_COLORS[cli.name] || { bg: "bg-muted/40", border: "border-border/60", text: "text-foreground" };
                  const icon = PROVIDER_ICONS[cli.name] || "🔧";
                  return (
                    <button
                      key={cli.name}
                      type="button"
                      onClick={() => choose(cli.name)}
                      disabled={selecting === cli.name}
                      className={`w-full text-left rounded-lg border p-3 transition-all relative overflow-hidden ${
                        isSelected
                          ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                          : "border-border/60 hover:border-primary/40 hover:bg-muted/30"
                      } ${selecting === cli.name ? "opacity-60" : ""}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`h-9 w-9 rounded-lg ${colors.bg} ${colors.border} border flex items-center justify-center shrink-0`}>
                          <span className="text-base">{icon}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold truncate">{cli.label}</span>
                            <Badge variant="outline" className="text-[8px] h-3.5 uppercase shrink-0">
                              {cli.name}
                            </Badge>
                            {isSelected && (
                              <Badge className="text-[8px] h-3.5 uppercase ml-auto bg-primary text-primary-foreground shrink-0">
                                <CheckCircle2 className="h-2 w-2 mr-0.5" />
                                Selected
                              </Badge>
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5 space-y-0.5">
                            {cli.path && (
                              <p className="flex items-center gap-1">
                                <span className="font-mono opacity-60">path:</span>
                                <span className="font-mono truncate">{cli.path}</span>
                              </p>
                            )}
                            {cli.version && (
                              <p className="flex items-center gap-1">
                                <span className="font-mono opacity-60">ver:</span>
                                <span className="font-mono">{cli.version}</span>
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                      {cli.models?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2 pl-12">
                          {cli.models.map((m: string) => (
                            <span key={m} className="text-[9px] px-1.5 py-0.5 rounded bg-muted/60 font-mono">
                              {m}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Environment variables */}
            {config?.envKeys && (
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1.5">
                  <Zap className="h-3 w-3" />
                  {t("llmConfig.apiKeys")}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(config.envKeys).map(([key, has]: [string, any]) => (
                    <div key={key} className={`flex items-center gap-2 text-[10px] rounded-md border p-2 transition-colors ${
                      has ? "border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/30 dark:bg-emerald-950/10"
                          : "border-border/50 bg-muted/20"
                    }`}>
                      {has ? (
                        <CheckCircle2 className="h-3 w-3 text-emerald-600 shrink-0" />
                      ) : (
                        <XCircle className="h-3 w-3 text-muted-foreground shrink-0" />
                      )}
                      <span className="font-mono font-medium">{key}</span>
                      <span className={`ml-auto text-[9px] font-medium ${has ? "text-emerald-600" : "text-muted-foreground"}`}>
                        {has ? t("llmConfig.keySet") : t("llmConfig.keyNotSet")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* CLI Test section */}
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1.5">
                <Zap className="h-3 w-3" />
                {t("llmConfig.testCli")}
              </p>
              <div className="flex gap-2">
                <Select value={testCli} onValueChange={setTestCli}>
                  <SelectTrigger className="w-32 h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(config?.detected || [{ name: "z-ai", label: "Z.AI SDK" }]).map((cli: any) => (
                      <SelectItem key={cli.name} value={cli.name} className="text-xs">
                        {cli.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={testPrompt}
                  onChange={(e) => setTestPrompt(e.target.value)}
                  placeholder={t("llmConfig.testPromptPlaceholder")}
                  className="flex-1 h-9 text-xs"
                />
                <Button size="sm" className="h-9 gap-1.5 text-xs" onClick={runTest} disabled={testing || !testCli}>
                  {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                  {t("llmConfig.testBtn")}
                </Button>
              </div>
              {testResult && (
                <div className="rounded-md border border-border/40 bg-muted/20 p-3">
                  <pre className="text-[10px] font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto scroll-academic leading-relaxed">
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
