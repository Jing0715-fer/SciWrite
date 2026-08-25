"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Sparkles,
  Loader2,
  Wand2,
  X,
  BookOpen,
  Database as DatabaseIcon,
  Globe,
  PenLine,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api-client";
import {
  PARAGRAPH_FORMATS,
  PARAGRAPH_SCENARIOS,
} from "@/lib/constants";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";
import { JOURNAL_TEMPLATES } from "@/lib/journal-templates";
import { MarkdownCitations } from "./markdown-citations";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  projectTopic: string;
  projectField?: string | null;
  references: { id: string; title: string; type: string; externalId?: string | null }[];
  dataSources: { id: string; source: string; title: string | null; query: string }[];
}

export function TopicComposer({
  open,
  onOpenChange,
  projectId,
  projectTopic,
  projectField,
  references,
  dataSources,
}: Props) {
  const { t } = useI18n();
  const [topic, setTopic] = React.useState(projectTopic || "");
  const [focus, setFocus] = React.useState("");
  const [format, setFormat] = React.useState<string>("background");
  const [scenario, setScenario] = React.useState<string>("literature-review");
  const [outputLang, setOutputLang] = React.useState<string>("English");
  const [genMode, setGenMode] = React.useState<"single" | "full">("single");
  const [targetWords, setTargetWords] = React.useState(3000);
  const [journalTemplate, setJournalTemplate] = React.useState("generic");
  const [selectedRefs, setSelectedRefs] = React.useState<string[]>([]);
  const [selectedSources, setSelectedSources] = React.useState<string[]>([]);
  const [searchQ, setSearchQ] = React.useState("");
  const [generated, setGenerated] = React.useState<string | null>(null);
  const [streamText, setStreamText] = React.useState("");
  const qc = useQueryClient();

  // v53-恢复: Poll the LLM quota status every 5s while the composer is open.
  // Shows dailyRemaining / windowCount / coolDownActive next to the generate
  // button so the user knows whether the pipeline is likely to succeed.
  const quotaQ = useQuery({
    queryKey: ["quota-status"],
    queryFn: async () => {
      const r = await fetch("/api/quota-status");
      if (!r.ok) return null;
      return (await r.json()) as {
        dailyRemaining: number | null;
        dailyLimit: number | null;
        windowCount: number;
        windowThreshold: number;
        coolDownActive: boolean;
        aborted: boolean;
      };
    },
    refetchInterval: open ? 5000 : false,
    staleTime: 2000,
  });

  React.useEffect(() => {
    if (open) {
      setTopic(projectTopic || "");
      setGenerated(null);
      setStreamText("");
    }
  }, [open, projectTopic]);

  // streaming-style reveal of generated content
  React.useEffect(() => {
    if (!generated) return;
    let i = 0;
    setStreamText("");
    const chunk = Math.max(2, Math.floor(generated.length / 220));
    const id = setInterval(() => {
      i += chunk;
      setStreamText(generated.slice(0, i));
      if (i >= generated.length) clearInterval(id);
    }, 14);
    return () => clearInterval(id);
  }, [generated]);

  const writeMut = useMutation({
    mutationFn: async () => {
      if (genMode === "full") {
        // Full article mode: use streaming generate-full
        setGenerated("__STREAMING__");
        const result = await api.aiGenerateFullStream(
          { projectId, journalTemplate, language: outputLang, targetWords },
          (event, data) => {
            if (data.message) {
              setStreamText((prev) => prev + (prev ? "\n" : "") + `[${event}] ${data.message}`);
            }
            // v84-1: Track current pipeline step for progress visualization
            if (event === "step" && data.step) {
              const stepMap: Record<string, number> = {
                init: 1, gather: 2, curate: 3, plan: 4, generate: 5,
                compose: 6, audit: 7, translate: 8, done: 9,
              };
              const stepNum = stepMap[data.step] || 0;
              if (stepNum > 0) {
                setStreamText((prev) => {
                  // Update the last "step" line with a progress bar
                  const lines = prev.split("\n");
                  const lastStepLine = lines.findIndex((l) => l.includes("▰"));
                  const progressBar = "▰".repeat(stepNum) + "▱".repeat(Math.max(0, 9 - stepNum));
                  const stepLine = `[progress] ${progressBar} Step ${stepNum}/9: ${data.step}`;
                  if (lastStepLine >= 0) {
                    lines[lastStepLine] = stepLine;
                  } else {
                    lines.push(stepLine);
                  }
                  return lines.join("\n");
                });
              }
            }
            // v73-3: Show final citation-health status to user
            if (event === "step" && data.errorFree !== undefined) {
              if (data.errorFree) {
                toast.success(`✅ Article ready: 0 blocking errors, ${data.finalWarnings || 0} warnings`);
              } else {
                toast.warning(`⚠️ ${data.finalBlocking || 0} blocking errors remain. Run auto-fix from Citation Health tab.`);
              }
            }
          }
        );
        return { content: "Full article generated. Check the Article tab in the workspace.", __full: true, result };
      }
      // Single paragraph mode
      const searchQueries = searchQ
        .split(/[\n;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      return api.aiWrite({
        topic,
        focus: focus || undefined,
        format: format as any,
        scenario: scenario as any,
        projectId,
        field: projectField || undefined,
        language: outputLang,
        referenceIds: selectedRefs,
        dataSourceIds: selectedSources,
        searchQueries,
      });
    },
    onSuccess: (data) => {
      if ("__full" in data && data.__full) {
        toast.success(t("toast.fullArticleGenerated"));
        qc.invalidateQueries({ queryKey: ["project", projectId] });
        onOpenChange(false);
      } else {
        setGenerated(data.content);
        toast.success(t("toast.paragraphDrafted"));
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!generated) throw new Error("Nothing to save yet.");
      return api.createParagraph({
        projectId,
        title: focus ? focus.slice(0, 60) : topic.slice(0, 60),
        content: generated,
        format,
        scenario,
      });
    },
    onSuccess: () => {
      toast.success(t("toast.paragraphSaved"));
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = (arr: string[], setArr: (v: string[]) => void, id: string) => {
    setArr(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[88vh] flex flex-col gap-0 p-0 rounded-xl overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60 bg-gradient-to-r from-primary/5 to-transparent">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            {t("topic.title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("topic.desc")}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-6 py-4 space-y-4">
            {/* Generation mode selector — v86-1: Enhanced with gradient + icons */}
            <div className="flex gap-1 p-1 rounded-lg bg-muted/50 border border-border/30">
              <button
                onClick={() => setGenMode("single")}
                className={`flex-1 text-xs py-2 rounded-md transition-all flex items-center justify-center gap-1.5 ${
                  genMode === "single"
                    ? "bg-card shadow-sm font-medium text-primary border border-primary/20"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                }`}
              >
                <PenLine className="h-3.5 w-3.5" />
                {t("topic.singleParagraph")}
              </button>
              <button
                onClick={() => setGenMode("full")}
                className={`flex-1 text-xs py-2 rounded-md transition-all flex items-center justify-center gap-1.5 ${
                  genMode === "full"
                    ? "bg-gradient-to-r from-primary to-primary/80 shadow-md font-medium text-primary-foreground border border-primary/30"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                }`}
              >
                <Zap className="h-3.5 w-3.5" />
                {t("topic.fullArticle")}
              </button>
            </div>

            {/* Full article mode: show target words + journal template */}
            {/* v86-1: Enhanced with card-style container + gradient range track */}
            {genMode === "full" && (
              <div className="grid grid-cols-2 gap-3 p-3 rounded-lg bg-muted/20 border border-border/30">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium flex items-center gap-1">
                    <span>{t("topic.targetWords")}:</span>
                    <span className="text-primary font-bold tabular-nums">{targetWords}</span>
                    <span className="text-muted-foreground">words</span>
                  </Label>
                  <input
                    type="range" min={500} max={10000} step={100}
                    value={targetWords}
                    onChange={(e) => setTargetWords(Number(e.target.value))}
                    className="w-full h-2 accent-primary cursor-pointer"
                  />
                  <div className="flex justify-between text-[9px] text-muted-foreground">
                    <span>500</span>
                    <span>5000</span>
                    <span>10000</span>
                  </div>
                  {/* v100-3: Quick word-count presets */}
                  <div className="flex items-center gap-1 pt-1 flex-wrap">
                    {[600, 1000, 1500, 2000, 3000].map((preset) => (
                      <button
                        key={preset}
                        onClick={() => setTargetWords(preset)}
                        className={`text-[9px] px-1.5 py-0.5 rounded transition-all ${
                          targetWords === preset
                            ? "bg-primary/10 text-primary font-semibold ring-1 ring-primary/20"
                            : "bg-muted/60 text-muted-foreground hover:bg-muted hover:scale-105"
                        }`}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t("topic.journalTemplate")}</Label>
                  <Select value={journalTemplate} onValueChange={setJournalTemplate}>
                    <SelectTrigger className="text-xs h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {JOURNAL_TEMPLATES.map((jt) => (
                        <SelectItem key={jt.id} value={jt.id} className="text-xs">{jt.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs">{t("topic.topicLabel")}</Label>
              <Textarea
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={t("topic.topicPlaceholder")}
                className="text-sm min-h-[60px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("topic.focusLabel")}</Label>
              <Input
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                placeholder={t("topic.focusPlaceholder")}
                className="text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("topic.formatLabel")}</Label>
                <Select value={format} onValueChange={setFormat}>
                  <SelectTrigger className="text-xs h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PARAGRAPH_FORMATS.map((f) => (
                      <SelectItem key={f.id} value={f.id} className="text-xs">
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("topic.scenarioLabel")}</Label>
                <Select value={scenario} onValueChange={setScenario}>
                  <SelectTrigger className="text-xs h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PARAGRAPH_SCENARIOS.map((s) => (
                      <SelectItem key={s.id} value={s.id} className="text-xs">
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Output language selector */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t("topic.languageLabel")}</Label>
              <Select value={outputLang} onValueChange={setOutputLang}>
                <SelectTrigger className="text-xs h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="English" className="text-xs">{t("topic.langEnglish")}</SelectItem>
                  <SelectItem value="中文" className="text-xs">{t("topic.langChinese")}</SelectItem>
                  <SelectItem value="both" className="text-xs">{t("topic.langBoth")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Sources selectors */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1.5">
                  <DatabaseIcon className="h-3 w-3" /> {t("topic.dataSourcesLabel")} ({selectedSources.length})
                </Label>
                <div className="rounded-md border border-border/60 max-h-32 overflow-y-auto scroll-academic divide-y divide-border/40">
                  {dataSources.length === 0 && (
                    <p className="text-[10px] text-muted-foreground p-2">
                      {t("topic.noSources")}
                    </p>
                  )}
                  {dataSources.map((d) => (
                    <label
                      key={d.id}
                      className="flex items-start gap-2 p-2 hover:bg-muted/40 cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedSources.includes(d.id)}
                        onCheckedChange={() =>
                          toggle(selectedSources, setSelectedSources, d.id)
                        }
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium truncate">
                          {d.title || d.query}
                        </p>
                        <p className="text-[9px] text-muted-foreground uppercase">
                          {d.source}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1.5">
                  <BookOpen className="h-3 w-3" /> {t("topic.refsLabel")} ({selectedRefs.length})
                </Label>
                <div className="rounded-md border border-border/60 max-h-32 overflow-y-auto scroll-academic divide-y divide-border/40">
                  {references.length === 0 && (
                    <p className="text-[10px] text-muted-foreground p-2">
                      {t("topic.noRefs")}
                    </p>
                  )}
                  {references.map((r) => (
                    <label
                      key={r.id}
                      className="flex items-start gap-2 p-2 hover:bg-muted/40 cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedRefs.includes(r.id)}
                        onCheckedChange={() =>
                          toggle(selectedRefs, setSelectedRefs, r.id)
                        }
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium line-clamp-2">
                          {r.title}
                        </p>
                        <p className="text-[9px] text-muted-foreground">
                          {r.type}
                          {r.externalId ? `:${r.externalId}` : ""}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs flex items-center gap-1.5">
                <Globe className="h-3 w-3" /> {t("topic.searchLabel")}
              </Label>
              <Textarea
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder={t("topic.searchPlaceholder")}
                className="text-xs min-h-[48px] font-mono"
              />
            </div>

            {writeMut.isPending && !generated && (
              <div className="rounded-lg border border-primary/30 bg-primary/[0.02] p-4 space-y-3 acad-fade-in">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span className="text-xs font-semibold text-primary">
                    {t("topic.researchingLabel")}
                  </span>
                </div>
                <div className="space-y-2">
                  {[
                    t("topic.researchingStep1"),
                    t("topic.researchingStep2"),
                    t("topic.researchingStep3"),
                  ].map((step, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-[11px] text-muted-foreground"
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          i === 0
                            ? "bg-primary animate-pulse"
                            : "bg-muted-foreground/30"
                        }`}
                      />
                      {step}
                    </div>
                  ))}
                </div>
                <div className="space-y-1.5">
                  <div className="h-3 rounded bg-muted/60 animate-pulse w-3/4" />
                  <div className="h-3 rounded bg-muted/40 animate-pulse w-full" />
                  <div className="h-3 rounded bg-muted/40 animate-pulse w-5/6" />
                  <div className="h-3 rounded bg-muted/30 animate-pulse w-2/3" />
                </div>
              </div>
            )}

            {generated && (
              <div className="rounded-lg border border-primary/30 bg-primary/[0.02] p-4 acad-fade-in">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] uppercase tracking-wider text-primary font-semibold flex items-center gap-1">
                    <Wand2 className="h-3 w-3" /> {t("topic.generated")}
                  </span>
                  <button
                    onClick={() => {
                      setGenerated(null);
                      setStreamText("");
                    }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <MarkdownCitations
                  content={streamText}
                  className="text-[13px]"
                />
                {streamText.length < generated.length && (
                  <span className="typing-caret" />
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="px-6 py-3 border-t border-border/60 gap-2">
          {!generated || generated === "__STREAMING__" ? (
            <>
              {generated === "__STREAMING__" && streamText && (
                <div className="flex-1 max-h-32 overflow-y-auto scroll-academic rounded-lg border border-primary/20 bg-gradient-to-br from-primary/5 to-muted/30 p-3 space-y-1">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Loader2 className="h-3 w-3 animate-spin text-primary" />
                    <span className="text-[10px] font-medium text-primary">Pipeline Progress</span>
                  </div>
                  {streamText.split("\n").slice(-8).map((line, i) => {
                    const isStep = line.includes("[step]");
                    const isError = line.toLowerCase().includes("error") || line.toLowerCase().includes("fail");
                    const isDone = line.toLowerCase().includes("done") || line.toLowerCase().includes("complete");
                    return (
                      <p key={i} className={`text-[9px] font-mono leading-relaxed ${
                        isError ? "text-red-500 dark:text-red-400" :
                        isDone ? "text-emerald-600 dark:text-emerald-400" :
                        isStep ? "text-primary/70" :
                        "text-muted-foreground"
                      }`}>{line}</p>
                    );
                  })}
                </div>
              )}
              {/* v53-恢复: LLM quota status badge — shows dailyRemaining / windowCount */}
              {/* v83-1: Enhanced UI with progress bar and better visual design */}
              {quotaQ.data && genMode === "full" && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/40 border border-border/40">
                  {quotaQ.data.aborted ? (
                    <Badge variant="destructive" className="text-[9px] px-2 py-0 h-5 gap-0.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                      ABORTED
                    </Badge>
                  ) : quotaQ.data.coolDownActive ? (
                    <Badge
                      variant="secondary"
                      className="text-[9px] px-2 py-0 h-5 gap-0.5 bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                      COOL-DOWN
                    </Badge>
                  ) : (
                    <Badge
                      variant="secondary"
                      className="text-[9px] px-2 py-0 h-5 gap-0.5 bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-300"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      ACTIVE
                    </Badge>
                  )}
                  {quotaQ.data.dailyRemaining !== null ? (
                    <span className="text-[10px]">
                      Daily: <span className={
                        (quotaQ.data.dailyRemaining ?? 0) < 50
                          ? "text-amber-600 dark:text-amber-400 font-semibold"
                          : "text-emerald-600 dark:text-emerald-400 font-semibold"
                      }>{quotaQ.data.dailyRemaining}</span>
                      {quotaQ.data.dailyLimit ? `/${quotaQ.data.dailyLimit}` : ""}
                    </span>
                  ) : (
                    <span className="text-[10px]">Daily: <span className="text-muted-foreground">unknown</span></span>
                  )}
                  <span className="text-muted-foreground/60">·</span>
                  <span className="text-[10px]">
                    10min: <span className={
                      quotaQ.data.windowCount >= quotaQ.data.windowThreshold
                        ? "text-amber-600 dark:text-amber-400 font-semibold"
                        : "text-foreground font-semibold"
                    }>{quotaQ.data.windowCount}</span>/{quotaQ.data.windowThreshold}
                  </span>
                </div>
              )}
              <Button
                onClick={() => writeMut.mutate()}
                disabled={writeMut.isPending || !topic.trim() || (quotaQ.data?.aborted ?? false)}
                className={`gap-2 transition-all ${genMode === "full" ? "bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 shadow-md" : ""}`}
              >
                {writeMut.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : genMode === "full" ? (
                  <Zap className="h-4 w-4" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {writeMut.isPending
                  ? (genMode === "full" ? t("topic.generatingFullArticle") : t("topic.researching"))
                  : (genMode === "full" ? t("topic.generateFullArticle") : t("topic.generate"))}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => writeMut.mutate()}
                disabled={writeMut.isPending}
                className="gap-2"
              >
                <Sparkles className="h-4 w-4" />
                {t("topic.regenerate")}
              </Button>
              <Button
                onClick={() => saveMut.mutate()}
                disabled={saveMut.isPending}
                className="gap-2"
              >
                {saveMut.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                {t("topic.saveWorkspace")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
