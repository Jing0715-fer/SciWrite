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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function LLMConfigDialog({ open, onOpenChange }: Props) {
  const { t } = useI18n();
  const [config, setConfig] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const [testCli, setTestCli] = React.useState("z-ai");
  const [testPrompt, setTestPrompt] = React.useState("What is 2+2?");
  const [testResult, setTestResult] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);

  const detect = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/llm-config");
      const data = await res.json();
      setConfig(data);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-4 w-4 text-primary" />
            {t("llmConfig.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("llmConfig.desc")}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-6 py-4 space-y-4">
            {/* Default provider */}
            <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-950/20 p-3">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                  {t("llmConfig.default")}
                </span>
                <Badge variant="outline" className="text-[8px] h-3.5 uppercase ml-auto">
                  {t("llmConfig.active")}
                </Badge>
              </div>
              <p className="text-[10px] text-muted-foreground">
                {t("llmConfig.defaultDesc")}
              </p>
            </div>

            {/* Detected CLIs */}
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

              {config?.detected?.map((cli: any) => (
                <div key={cli.name} className="rounded-lg border border-border/60 p-3 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                    <span className="text-xs font-semibold">{cli.label}</span>
                    <Badge variant="outline" className="text-[8px] h-3.5 uppercase">
                      {cli.name}
                    </Badge>
                  </div>
                  <div className="text-[10px] text-muted-foreground space-y-0.5">
                    <p><span className="font-mono">{t("llmConfig.path")}</span> {cli.path}</p>
                    {cli.version && <p><span className="font-mono">{t("llmConfig.version")}</span> {cli.version}</p>}
                    {cli.models?.length > 0 && (
                      <div>
                        <span className="font-mono">{t("llmConfig.models")}</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {cli.models.map((m: string) => (
                            <span key={m} className="text-[9px] px-1 py-0.5 rounded bg-muted/50 font-mono">
                              {m}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
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
                      <span className={`ml-auto ${has ? "text-emerald-600" : "text-muted-foreground"}`}>
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
                  <SelectTrigger className="w-32 h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(config?.detected || []).map((cli: any) => (
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
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

// Inline Select to avoid import issues
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
