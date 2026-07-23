"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  ListTree,
  Loader2,
  Sparkles,
  ArrowRight,
  Search,
  BookOpen,
  Lightbulb,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { api } from "@/lib/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PARAGRAPH_FORMATS, PARAGRAPH_SCENARIOS } from "@/lib/constants";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  topic: string;
  onUseParagraph?: (item: any) => void;
}

const FORMAT_COLOR: Record<string, string> = {
  abstract: "badge-violet",
  intro: "badge-emerald",
  background: "badge-teal",
  methods: "badge-sky",
  results: "badge-amber",
  discussion: "badge-rose",
  conclusion: "badge-slate",
};

const SOURCE_BADGE: Record<string, string> = {
  pubmed: "badge-emerald",
  uniprot: "badge-teal",
  rcsb: "badge-amber",
  ncbi: "badge-rose",
  blast: "badge-violet",
};

export function OutlineDialog({
  open,
  onOpenChange,
  projectId,
  topic,
  onUseParagraph,
}: Props) {
  const qc = useQueryClient();
  const [purpose, setPurpose] = React.useState("");
  const [outline, setOutline] = React.useState<any[] | null>(null);
  const [summary, setSummary] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setOutline(null);
      setSummary("");
      setPurpose("");
    }
  }, [open]);

  const genMut = useMutation({
    mutationFn: () => api.aiOutline({ projectId, purpose: purpose || undefined }),
    onSuccess: (data) => {
      setOutline(data.outline);
      setSummary(data.summary);
      if (data.outline.length === 0) {
        toast.info("No outline generated. Try a more specific topic.");
      } else {
        toast.success(`Generated ${data.outline.length}-paragraph outline.`);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runQueryMut = useMutation({
    mutationFn: async (q: { database: string; query: string }) => {
      return api.queryDatabase({ source: q.database, query: q.query });
    },
    onSuccess: (_data, variables) => {
      toast.success(`Query executed: ${variables.database} "${variables.query.slice(0, 30)}…"`);
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ListTree className="h-4 w-4 text-primary" />
            AI Research Outline
          </DialogTitle>
          <DialogDescription className="text-xs">
            Generate a structured paragraph plan from your topic — each with format,
            scenario, focus, and suggested database queries.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-6 py-4 min-h-[300px]">
            <div className="rounded-lg bg-primary/[0.04] border border-primary/20 p-3 mb-4">
              <p className="text-[11px] text-muted-foreground mb-0.5">Research topic</p>
              <p className="text-sm font-medium">{topic}</p>
            </div>

            <div className="space-y-1.5 mb-4">
              <Label className="text-xs">
                Purpose / angle (optional — refines the outline)
              </Label>
              <Input
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="e.g. focus on therapeutic applications and recent engineering improvements"
                className="text-xs h-8"
              />
            </div>

            {genMut.isPending && !outline && (
              <div className="space-y-3 py-4">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span>Designing paragraph outline…</span>
                </div>
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-border/60 p-3 space-y-2"
                  >
                    <div className="flex gap-2">
                      <div className="h-3 w-16 bg-muted/60 rounded animate-pulse" />
                      <div className="h-3 w-20 bg-muted/40 rounded animate-pulse" />
                      <div className="h-3 flex-1 bg-muted/30 rounded animate-pulse" />
                    </div>
                    <div className="h-2.5 w-full bg-muted/30 rounded animate-pulse" />
                    <div className="h-2.5 w-3/4 bg-muted/30 rounded animate-pulse" />
                  </div>
                ))}
              </div>
            )}

            {summary && (
              <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-950/20 p-3 mb-4">
                <div className="flex items-center gap-1.5 mb-1">
                  <Lightbulb className="h-3.5 w-3.5 text-emerald-600" />
                  <span className="text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400 font-semibold">
                    Strategy
                  </span>
                </div>
                <p className="text-xs leading-relaxed">{summary}</p>
              </div>
            )}

            {outline && outline.length > 0 && (
              <div className="space-y-2.5">
                {outline.map((item, i) => {
                  const formatMeta = PARAGRAPH_FORMATS.find(
                    (f) => f.id === item.format
                  );
                  const scenarioMeta = PARAGRAPH_SCENARIOS.find(
                    (s) => s.id === item.scenario
                  );
                  return (
                    <div
                      key={i}
                      className="rounded-lg border border-border/60 bg-card p-3 space-y-2 hover:border-primary/30 transition-colors"
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-[10px] font-mono text-muted-foreground mt-0.5 shrink-0">
                          §{String(i + 1).padStart(2, "0")}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-1 mb-1">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase ${
                                FORMAT_COLOR[item.format] || "badge-slate"
                              }`}
                            >
                              {formatMeta?.label || item.format}
                            </span>
                            <span className="badge-slate px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase">
                              {scenarioMeta?.label || item.scenario}
                            </span>
                          </div>
                          <p className="text-xs font-semibold leading-snug">
                            {item.title}
                          </p>
                          {item.focus && (
                            <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                              {item.focus}
                            </p>
                          )}
                          {item.suggestedQueries?.length > 0 && (
                            <div className="mt-2 space-y-1">
                              <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
                                <Search className="h-2.5 w-2.5" />
                                Suggested queries
                              </p>
                              {item.suggestedQueries.map(
                                (q: any, qi: number) => (
                                  <div
                                    key={qi}
                                    className="flex items-center gap-1.5 rounded-md bg-muted/30 px-2 py-1"
                                  >
                                    <span
                                      className={`px-1 py-0.5 rounded text-[8px] font-semibold uppercase ${
                                        SOURCE_BADGE[q.database] || "badge-slate"
                                      }`}
                                    >
                                      {q.database}
                                    </span>
                                    <span className="text-[10px] font-mono truncate flex-1">
                                      {q.query}
                                    </span>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-5 px-1.5 text-[9px] gap-0.5 shrink-0"
                                      onClick={() =>
                                        runQueryMut.mutate(q)
                                      }
                                      disabled={runQueryMut.isPending}
                                    >
                                      <ArrowRight className="h-2.5 w-2.5" />
                                      Run
                                    </Button>
                                  </div>
                                )
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      {onUseParagraph && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full h-7 text-[11px] gap-1.5 border-dashed mt-1"
                          onClick={() => onUseParagraph(item)}
                        >
                          <Sparkles className="h-3 w-3" />
                          Write this paragraph
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {!outline && !genMut.isPending && (
              <div className="text-center py-12">
                <div className="h-14 w-14 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center mb-3">
                  <ListTree className="h-7 w-7 text-primary" />
                </div>
                <h3 className="text-sm font-semibold">Generate a paragraph plan</h3>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                  The AI will analyze your topic and propose a structured outline
                  with formats, scenarios, and database search queries for each
                  paragraph.
                </p>
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="px-6 py-3 border-t border-border/60 flex items-center justify-between gap-2">
          <div className="text-[10px] text-muted-foreground">
            {outline && `${outline.length} paragraphs planned`}
          </div>
          <div className="flex items-center gap-2">
            {outline && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => genMut.mutate()}
                disabled={genMut.isPending}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Regenerate
              </Button>
            )}
            <Button
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => genMut.mutate()}
              disabled={genMut.isPending}
            >
              {genMut.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {outline ? "Regenerate outline" : "Generate outline"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
