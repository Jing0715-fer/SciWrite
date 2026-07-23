"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Loader2,
  Sparkles,
  MessagesSquare,
  Search,
  ShieldAlert,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  Plus,
  X,
  ExternalLink,
  Wand2,
  Lightbulb,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DatabaseResultItem } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  topic: string;
  field?: string | null;
  onProceedToWrite?: (purpose: string, sourceIds: string[]) => void;
}

type Step = "clarify" | "organize" | "critique" | "confirm";

const STEPS: { id: Step; label: string; icon: string }[] = [
  { id: "clarify", label: "Clarify", icon: "MessagesSquare" },
  { id: "organize", label: "Organize", icon: "Search" },
  { id: "critique", label: "Adversarial Check", icon: "ShieldAlert" },
  { id: "confirm", label: "Confirm Sources", icon: "CheckCircle2" },
];

const SOURCE_BADGE: Record<string, string> = {
  pubmed: "badge-emerald",
  uniprot: "badge-teal",
  rcsb: "badge-amber",
  ncbi: "badge-rose",
  blast: "badge-violet",
  web: "badge-sky",
};

interface CandidateItem extends DatabaseResultItem {
  uid: string;
  selected: boolean;
  rationale?: string;
}

export function DataGatheringDialog({
  open,
  onOpenChange,
  projectId,
  topic,
  field,
  onProceedToWrite,
}: Props) {
  const qc = useQueryClient();
  const [step, setStep] = React.useState<Step>("clarify");
  const [history, setHistory] = React.useState<{ question: string; answer: string }[]>([]);
  const [questions, setQuestions] = React.useState<string[]>([]);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [purpose, setPurpose] = React.useState("");
  const [plan, setPlan] = React.useState("");
  const [candidates, setCandidates] = React.useState<CandidateItem[]>([]);
  const [critique, setCritique] = React.useState<any>(null);
  const [iteration, setIteration] = React.useState(0);

  const clarifyMut = useMutation({
    mutationFn: (input: { topic: string; field?: string | null; history: any[] }) =>
      api.aiGather({ mode: "clarify", ...input }),
    onSuccess: (data) => {
      setQuestions(data.questions || []);
      if (data.ready && data.purpose) {
        setPurpose(data.purpose);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const organizeMut = useMutation({
    mutationFn: (input: { topic: string; field?: string | null; purpose: string; runQueries: boolean }) =>
      api.aiGather({ mode: "organize", ...input }),
    onSuccess: (data) => {
      setPlan(data.plan || "");
      const flat: CandidateItem[] = [];
      for (const r of data.results || []) {
        for (const item of r.items || []) {
          flat.push({
            ...item,
            uid: `${item.source}-${item.externalId}-${flat.length}`,
            selected: true,
            rationale: r.rationale,
          });
        }
      }
      setCandidates(flat);
      setStep("critique");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const critiqueMut = useMutation({
    mutationFn: (input: {
      topic: string;
      purpose: string;
      sources: any[];
      runQueries: boolean;
    }) => api.aiGather({ mode: "critique", ...input }),
    onSuccess: (data) => {
      setCritique(data);
      // merge added results from suggestions
      if (data.addedResults?.length) {
        setCandidates((prev) => {
          const next = [...prev];
          for (const r of data.addedResults) {
            for (const item of r.items || []) {
              const exists = next.some(
                (c) => c.externalId === item.externalId && c.source === item.source
              );
              if (!exists) {
                next.push({
                  ...item,
                  uid: `${item.source}-${item.externalId}-${next.length}`,
                  selected: true,
                  rationale: r.rationale,
                });
              }
            }
          }
          return next;
        });
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveMut = useMutation({
    mutationFn: async (items: CandidateItem[]) => {
      const selected = items.filter((c) => c.selected);
      const results: any[] = [];
      for (const item of selected) {
        const ds = await api.createDataSource({
          projectId,
          source: item.source,
          query: item.rationale || item.title,
          rawJson: { items: [item] },
          title: item.title,
          externalId: item.externalId,
          url: item.url,
        });
        results.push(ds);
        if (item.source !== "blast") {
          await api.createReference({
            type: item.source as any,
            externalId: item.externalId,
            title: item.title,
            authors: item.authors,
            journal: item.journal,
            year: item.year,
            url: item.url,
            doi: item.doi,
            abstract: item.abstract,
            projectId,
          }).catch(() => {});
        }
      }
      return results;
    },
    onSuccess: (results) => {
      toast.success(`Saved ${results.length} sources & references.`);
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      onOpenChange(false);
      if (onProceedToWrite) {
        setTimeout(() => onProceedToWrite(purpose, results.map((r: any) => r.dataSource.id)), 200);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Reset when opened
  React.useEffect(() => {
    if (open) {
      setStep("clarify");
      setHistory([]);
      setQuestions([]);
      setAnswers({});
      setPurpose("");
      setPlan("");
      setCandidates([]);
      setCritique(null);
      setIteration(0);
    }
  }, [open]);

  // Auto-run clarify on open
  React.useEffect(() => {
    if (open && questions.length === 0 && !purpose) {
      clarifyMut.mutate({ topic, field, history: [] });
    }
  }, [open]);

  // Auto-run critique when entering the critique step
  React.useEffect(() => {
    if (
      step === "critique" &&
      !critique &&
      !critiqueMut.isPending &&
      candidates.length > 0
    ) {
      critiqueMut.mutate({
        topic,
        purpose: purpose || topic,
        sources: candidates.map((c) => ({
          source: c.source,
          externalId: c.externalId,
          title: c.title,
          authors: c.authors,
          year: c.year,
          journal: c.journal,
          abstract: c.abstract,
        })),
        runQueries: true,
      });
    }
  }, [step]);

  const submitAnswers = () => {
    const newHistory = [...history];
    for (const q of questions) {
      const a = answers[q]?.trim();
      if (a) newHistory.push({ question: q, answer: a });
    }
    setHistory(newHistory);
    setAnswers({});
    clarifyMut.mutate({ topic, field, history: newHistory });
  };

  const proceedToOrganize = () => {
    setStep("organize");
    organizeMut.mutate({
      topic,
      field,
      purpose: purpose || topic,
      runQueries: true,
    });
  };

  const runCritique = () => {
    critiqueMut.mutate({
      topic,
      purpose: purpose || topic,
      sources: candidates.map((c) => ({
        source: c.source,
        externalId: c.externalId,
        title: c.title,
        authors: c.authors,
        year: c.year,
        journal: c.journal,
        abstract: c.abstract,
      })),
      runQueries: true,
    });
  };

  const runAnotherIteration = () => {
    setIteration((i) => i + 1);
    organizeMut.mutate({
      topic,
      field,
      purpose: purpose || topic,
      runQueries: true,
    });
  };

  const toggleCandidate = (uid: string) => {
    setCandidates((prev) =>
      prev.map((c) => (c.uid === uid ? { ...c, selected: !c.selected } : c))
    );
  };

  const selectedCount = candidates.filter((c) => c.selected).length;
  const stepIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            AI Data Source Gathering
          </DialogTitle>
          <DialogDescription className="text-xs">
            Clarify your purpose → AI organizes multi-database searches → adversarial
            critique → you filter &amp; confirm → start writing.
          </DialogDescription>
          {/* Step indicator */}
          <div className="flex items-center gap-1 mt-3">
            {STEPS.map((s, i) => (
              <React.Fragment key={s.id}>
                <div
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                    i === stepIndex
                      ? "bg-primary/10 text-primary"
                      : i < stepIndex
                      ? "text-emerald-600"
                      : "text-muted-foreground"
                  }`}
                >
                  {i < stepIndex ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : i === stepIndex ? (
                    <Loader2
                      className={`h-3 w-3 ${
                        [clarifyMut, organizeMut, critiqueMut].some(
                          (m) => m.isPending
                        )
                          ? "animate-spin"
                          : ""
                      }`}
                    />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-current opacity-40" />
                  )}
                  {s.label}
                </div>
                {i < STEPS.length - 1 && (
                  <div className="h-px w-3 bg-border" />
                )}
              </React.Fragment>
            ))}
          </div>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-6 py-4 min-h-[300px]">
            {/* STEP 1: Clarify */}
            {step === "clarify" && (
              <div className="space-y-4">
                <div className="rounded-lg bg-primary/[0.04] border border-primary/20 p-3">
                  <p className="text-[11px] text-muted-foreground mb-0.5">Research topic</p>
                  <p className="text-sm font-medium">{topic}</p>
                </div>
                {clarifyMut.isPending && questions.length === 0 && (
                  <div className="space-y-2">
                    <SkeletonLine />
                    <SkeletonLine />
                  </div>
                )}
                {questions.map((q, i) => (
                  <div key={i} className="space-y-1.5">
                    <Label className="text-xs flex items-start gap-1.5">
                      <MessagesSquare className="h-3 w-3 mt-0.5 text-primary shrink-0" />
                      <span>{q}</span>
                    </Label>
                    <Textarea
                      value={answers[q] || ""}
                      onChange={(e) =>
                        setAnswers((prev) => ({ ...prev, [q]: e.target.value }))
                      }
                      placeholder="Type your answer…"
                      className="text-xs min-h-[48px]"
                    />
                  </div>
                ))}
                {purpose && questions.length === 0 && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20 p-3 space-y-1.5">
                    <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span className="text-xs font-semibold">
                        Purpose clarified
                      </span>
                    </div>
                    <p className="text-xs leading-relaxed text-foreground/85">
                      {purpose}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* STEP 2: Organize */}
            {step === "organize" && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span>AI is designing a multi-database search plan and executing queries…</span>
                </div>
                {plan && (
                  <div className="rounded-lg bg-muted/40 p-3">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                      Strategy
                    </p>
                    <p className="text-xs leading-relaxed">{plan}</p>
                  </div>
                )}
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <SkeletonLine key={i} />
                  ))}
                </div>
              </div>
            )}

            {/* STEP 3: Critique */}
            {step === "critique" && (
              <div className="space-y-4">
                {critiqueMut.isPending && !critique && (
                  <div className="flex items-center gap-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span>Running adversarial critique on {candidates.length} sources…</span>
                  </div>
                )}
                {critique && (
                  <>
                    <div
                      className={`rounded-lg border p-3 space-y-1 ${
                        critique.verdict === "adequate"
                          ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20"
                          : critique.verdict === "insufficient"
                          ? "border-rose-200 bg-rose-50/50 dark:border-rose-900/50 dark:bg-rose-950/20"
                          : "border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold flex items-center gap-1.5">
                          <ShieldAlert className="h-3.5 w-3.5" />
                          Verdict: {critique.verdict}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          confidence {Math.round((critique.confidence || 0.5) * 100)}%
                        </span>
                      </div>
                    </div>

                    {critique.gaps?.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[10px] uppercase tracking-wider text-amber-600 font-semibold flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" /> Coverage gaps
                        </p>
                        {critique.gaps.map((g: string, i: number) => (
                          <div
                            key={i}
                            className="text-xs rounded-md bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200/60 dark:border-amber-900/40 px-2.5 py-1.5"
                          >
                            {g}
                          </div>
                        ))}
                      </div>
                    )}

                    {critique.biases?.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[10px] uppercase tracking-wider text-rose-600 font-semibold flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" /> Biases detected
                        </p>
                        {critique.biases.map((b: string, i: number) => (
                          <div
                            key={i}
                            className="text-xs rounded-md bg-rose-50/60 dark:bg-rose-950/20 border border-rose-200/60 dark:border-rose-900/40 px-2.5 py-1.5"
                          >
                            {b}
                          </div>
                        ))}
                      </div>
                    )}

                    {critique.addedResults?.length > 0 && (
                      <div className="rounded-md border border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-950/20 px-2.5 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                        <Plus className="h-3 w-3 inline mr-1" />
                        Added {critique.addedResults.reduce(
                          (acc: number, r: any) => acc + (r.items?.length || 0),
                          0
                        )}{" "}
                        new sources from suggestions.
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* STEP 4: Confirm */}
            {step === "confirm" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    Review and filter the gathered sources. Selected items will be
                    saved as data sources &amp; references.
                  </p>
                  <Badge variant="outline" className="text-[10px]">
                    {selectedCount}/{candidates.length} selected
                  </Badge>
                </div>
                {candidates.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-8">
                    No sources gathered. Go back and run the organize step.
                  </p>
                )}
                <div className="space-y-1.5">
                  {candidates.map((c) => (
                    <label
                      key={c.uid}
                      className="flex items-start gap-2 rounded-md border border-border/60 p-2 hover:bg-muted/40 cursor-pointer"
                    >
                      <Checkbox
                        checked={c.selected}
                        onCheckedChange={() => toggleCandidate(c.uid)}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1 mb-0.5">
                          <span
                            className={`px-1 py-0.5 rounded text-[8px] font-semibold uppercase ${SOURCE_BADGE[c.source] || "badge-slate"}`}
                          >
                            {c.source}
                            {c.externalId ? `:${c.externalId}` : ""}
                          </span>
                          {c.year && (
                            <span className="text-[9px] text-muted-foreground">{c.year}</span>
                          )}
                        </div>
                        <p className="text-[11px] font-medium leading-snug line-clamp-2">
                          {c.title}
                        </p>
                        {c.authors && (
                          <p className="text-[9px] text-muted-foreground line-clamp-1">
                            {c.authors}
                          </p>
                        )}
                        {c.rationale && (
                          <p className="text-[9px] italic text-primary/70 mt-0.5 line-clamp-1">
                            {c.rationale}
                          </p>
                        )}
                      </div>
                      {c.url && (
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-muted-foreground hover:text-primary"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-border/60 flex items-center justify-between gap-2">
          <div className="text-[10px] text-muted-foreground">
            {step === "clarify" && purpose && "✓ Purpose ready"}
            {step === "critique" && critique && `Iteration ${iteration + 1} complete`}
            {step === "confirm" && `${selectedCount} sources selected`}
          </div>
          <div className="flex items-center gap-2">
            {step === "clarify" && (
              <>
                {purpose ? (
                  <Button onClick={proceedToOrganize} disabled={organizeMut.isPending} className="gap-1.5">
                    {organizeMut.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ArrowRight className="h-3.5 w-3.5" />
                    )}
                    Start gathering
                  </Button>
                ) : (
                  <Button
                    onClick={submitAnswers}
                    disabled={clarifyMut.isPending}
                    className="gap-1.5"
                  >
                    {clarifyMut.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <MessagesSquare className="h-3.5 w-3.5" />
                    )}
                    Submit answers
                  </Button>
                )}
              </>
            )}
            {step === "critique" && critique && (
              <>
                <Button
                  variant="outline"
                  onClick={runAnotherIteration}
                  disabled={organizeMut.isPending}
                  className="gap-1.5"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Re-organize
                </Button>
                <Button
                  onClick={() => setStep("confirm")}
                  className="gap-1.5"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Review sources
                </Button>
              </>
            )}
            {step === "confirm" && (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    setStep("critique");
                    runCritique();
                  }}
                  disabled={critiqueMut.isPending}
                  className="gap-1.5"
                >
                  <ShieldAlert className="h-3.5 w-3.5" />
                  Run critique again
                </Button>
                <Button
                  onClick={() => saveMut.mutate(candidates)}
                  disabled={saveMut.isPending || selectedCount === 0}
                  className="gap-1.5"
                >
                  {saveMut.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wand2 className="h-3.5 w-3.5" />
                  )}
                  Save &amp; write
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SkeletonLine() {
  return <div className="h-4 rounded bg-muted/60 animate-pulse" />;
}
