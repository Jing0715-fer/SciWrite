"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Loader2,
  LayoutGrid,
  Image as ImageIcon,
  CheckCircle2,
  AlertTriangle,
  ArrowRightCircle,
  Plus,
  RefreshCw,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { useMutation } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  articleId: string;
}

/**
 * StructureDialog — AI-powered article structure analysis + caption generation.
 *
 * Two tabs:
 *  1. Structure Optimization: overall score, strengths, weaknesses, actionable
 *     suggestions (reorder / expand / add), recommended section order, and
 *     missing-section detection.
 *  2. Figure/Table Captions: detects "Figure N" / "Table N" references in the
 *     article and generates publication-quality captions from surrounding
 *     context. Each caption can be copied to the clipboard.
 */
export function StructureDialog({ open, onOpenChange, articleId }: Props) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = React.useState<"structure" | "captions">("structure");

  // ── Structure optimization mutation ───────────────────────────────────────
  const structMut = useMutation({
    mutationFn: () => api.optimizeStructure(articleId),
    onError: (e: any) => toast.error(e?.message || "Analysis failed"),
  });

  // ── Caption generation mutation ───────────────────────────────────────────
  const captionMut = useMutation({
    mutationFn: () => api.generateCaptions(articleId),
    onError: (e: any) => toast.error(e?.message || "Caption generation failed"),
  });

  // Auto-run the active tab's analysis when the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    if (activeTab === "structure" && !structMut.data && !structMut.isPending) {
      structMut.mutate();
    }
    if (activeTab === "captions" && !captionMut.data && !captionMut.isPending) {
      captionMut.mutate();
    }
  }, [open, activeTab]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Caption copied to clipboard");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <LayoutGrid className="h-4 w-4 text-violet-600 dark:text-violet-400" />
            AI Structure Analysis & Captions
          </DialogTitle>
          <DialogDescription className="text-xs">
            Optimize article structure and auto-generate figure/table captions
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as any)}
          className="flex-1 min-h-0 flex flex-col"
        >
          <div className="px-5 pt-3 shrink-0">
            <TabsList className="grid w-full grid-cols-2 max-w-md">
              <TabsTrigger value="structure" className="text-xs gap-1.5">
                <LayoutGrid className="h-3.5 w-3.5" />
                Structure
              </TabsTrigger>
              <TabsTrigger value="captions" className="text-xs gap-1.5">
                <ImageIcon className="h-3.5 w-3.5" />
                Captions
              </TabsTrigger>
            </TabsList>
          </div>

          {/* ── Structure Optimization Tab ──────────────────────────────────── */}
          <TabsContent
            value="structure"
            className="flex-1 mt-0 min-h-0 data-[state=active]:flex data-[state=active]:flex-col"
          >
            <ScrollArea className="flex-1">
              <div className="px-5 py-4 space-y-4">
                {structMut.isPending && (
                  <div className="flex flex-col items-center justify-center py-16 gap-3">
                    <Loader2 className="h-8 w-8 animate-spin text-violet-600 dark:text-violet-400" />
                    <p className="text-xs text-muted-foreground">
                      Analyzing article structure…
                    </p>
                  </div>
                )}

                {structMut.data && (
                  <>
                    {/* Score + meta */}
                    <div className="flex items-center gap-4 p-4 rounded-lg bg-gradient-to-br from-violet-50 to-fuchsia-50 dark:from-violet-950/30 dark:to-fuchsia-950/20 border border-violet-200/60 dark:border-violet-800/40">
                      <div className="flex flex-col items-center">
                        <div className="text-3xl font-bold text-violet-700 dark:text-violet-300">
                          {structMut.data.score}
                        </div>
                        <div className="text-[9px] text-muted-foreground uppercase tracking-wide">
                          / 100
                        </div>
                      </div>
                      <div className="flex-1">
                        <div className="text-xs font-semibold mb-1">
                          Structure Quality Score
                        </div>
                        <Progress
                          value={structMut.data.score}
                          className="h-2"
                        />
                        <div className="text-[10px] text-muted-foreground mt-1.5 flex gap-3">
                          <span>{structMut.data.analyzedSections} sections</span>
                          <span>·</span>
                          <span>{structMut.data.totalWords} words</span>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[10px] gap-1"
                        onClick={() => structMut.mutate()}
                        disabled={structMut.isPending}
                      >
                        <RefreshCw className="h-3 w-3" />
                        Re-run
                      </Button>
                    </div>

                    {/* Strengths + Weaknesses */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-800/40 p-3">
                        <div className="flex items-center gap-1.5 mb-2">
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                          <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                            Strengths
                          </span>
                        </div>
                        <ul className="space-y-1.5">
                          {structMut.data.strengths.length === 0 ? (
                            <li className="text-[11px] text-muted-foreground">
                              No specific strengths identified.
                            </li>
                          ) : (
                            structMut.data.strengths.map((s, i) => (
                              <li key={i} className="text-[11px] flex gap-1.5">
                                <span className="text-emerald-500">•</span>
                                <span>{s}</span>
                              </li>
                            ))
                          )}
                        </ul>
                      </div>
                      <div className="rounded-lg border border-amber-200/60 dark:border-amber-800/40 p-3">
                        <div className="flex items-center gap-1.5 mb-2">
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                          <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                            Weaknesses
                          </span>
                        </div>
                        <ul className="space-y-1.5">
                          {structMut.data.weaknesses.length === 0 ? (
                            <li className="text-[11px] text-muted-foreground">
                              No major weaknesses found.
                            </li>
                          ) : (
                            structMut.data.weaknesses.map((w, i) => (
                              <li key={i} className="text-[11px] flex gap-1.5">
                                <span className="text-amber-500">•</span>
                                <span>{w}</span>
                              </li>
                            ))
                          )}
                        </ul>
                      </div>
                    </div>

                    {/* Actionable suggestions */}
                    <div>
                      <div className="text-xs font-semibold mb-2 flex items-center gap-1.5">
                        <ArrowRightCircle className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                        Suggestions ({structMut.data.suggestions.length})
                      </div>
                      <div className="space-y-2">
                        {structMut.data.suggestions.length === 0 ? (
                          <p className="text-[11px] text-muted-foreground px-3 py-2">
                            No suggestions — structure looks good!
                          </p>
                        ) : (
                          structMut.data.suggestions.map((s, i) => (
                            <div
                              key={i}
                              className="rounded-md border border-border/60 p-2.5 bg-card hover:bg-accent/30 transition-colors"
                            >
                              <div className="flex items-center gap-2 mb-1">
                                <Badge
                                  variant="outline"
                                  className={`text-[8px] h-4 uppercase ${
                                    s.priority === "high"
                                      ? "border-red-300/60 dark:border-red-700/50 text-red-600 dark:text-red-400"
                                      : s.priority === "medium"
                                      ? "border-amber-300/60 dark:border-amber-700/50 text-amber-600 dark:text-amber-400"
                                      : "border-border/60 text-muted-foreground"
                                  }`}
                                >
                                  {s.priority}
                                </Badge>
                                <Badge
                                  variant="outline"
                                  className="text-[8px] h-4 uppercase border-violet-300/60 dark:border-violet-700/50 text-violet-600 dark:text-violet-400"
                                >
                                  {s.type}
                                </Badge>
                                <span className="text-xs font-medium">
                                  {s.section}
                                </span>
                              </div>
                              <p className="text-[11px] text-muted-foreground leading-relaxed">
                                {s.suggestion}
                              </p>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* Recommended order + missing sections */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {structMut.data.recommendedOrder.length > 0 && (
                        <div className="rounded-lg border border-border/60 p-3">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                            Recommended Section Order
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            {structMut.data.recommendedOrder.map((sec, i) => (
                              <React.Fragment key={i}>
                                {i > 0 && (
                                  <ArrowRightCircle className="h-3 w-3 text-muted-foreground/50" />
                                )}
                                <Badge
                                  variant="secondary"
                                  className="text-[10px] font-normal"
                                >
                                  {sec}
                                </Badge>
                              </React.Fragment>
                            ))}
                          </div>
                        </div>
                      )}
                      {structMut.data.missingSections.length > 0 && (
                        <div className="rounded-lg border border-red-200/60 dark:border-red-800/40 p-3">
                          <div className="flex items-center gap-1.5 mb-2">
                            <Plus className="h-3 w-3 text-red-500" />
                            <span className="text-[10px] uppercase tracking-wide text-red-600 dark:text-red-400">
                              Missing Sections
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {structMut.data.missingSections.map((sec, i) => (
                              <Badge
                                key={i}
                                variant="outline"
                                className="text-[10px] border-red-300/60 dark:border-red-700/50 text-red-600 dark:text-red-400"
                              >
                                {sec}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* ── Figure/Table Captions Tab ──────────────────────────────────── */}
          <TabsContent
            value="captions"
            className="flex-1 mt-0 min-h-0 data-[state=active]:flex data-[state=active]:flex-col"
          >
            <ScrollArea className="flex-1">
              <div className="px-5 py-4 space-y-3">
                {captionMut.isPending && (
                  <div className="flex flex-col items-center justify-center py-16 gap-3">
                    <Loader2 className="h-8 w-8 animate-spin text-fuchsia-600 dark:text-fuchsia-400" />
                    <p className="text-xs text-muted-foreground">
                      Detecting figures & generating captions…
                    </p>
                  </div>
                )}

                {captionMut.data && (
                  <>
                    <div className="flex items-center justify-between">
                      <div className="flex gap-3 text-[11px] text-muted-foreground">
                        <span>
                          <strong className="text-foreground">
                            {captionMut.data.totalDetected}
                          </strong>{" "}
                          detected
                        </span>
                        <span>·</span>
                        <span>
                          <strong className="text-foreground">
                            {captionMut.data.generated}
                          </strong>{" "}
                          captions generated
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[10px] gap-1"
                        onClick={() => captionMut.mutate()}
                        disabled={captionMut.isPending}
                      >
                        <RefreshCw className="h-3 w-3" />
                        Re-run
                      </Button>
                    </div>

                    {captionMut.data.captions.length === 0 ? (
                      <div className="text-center py-12">
                        <ImageIcon className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                        <p className="text-xs text-muted-foreground">
                          {captionMut.data.message ||
                            "No figures or tables detected in this article."}
                        </p>
                        <p className="text-[10px] text-muted-foreground/70 mt-1">
                          Add "Figure 1" or "Table 1" references to your text to
                          enable caption generation.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {captionMut.data.captions.map((c, i) => (
                          <div
                            key={i}
                            className="rounded-lg border border-border/60 p-3 hover:border-fuchsia-300/60 dark:hover:border-fuchsia-700/50 transition-colors"
                          >
                            <div className="flex items-center gap-2 mb-2">
                              <Badge
                                variant="outline"
                                className={`text-[9px] uppercase ${
                                  c.type === "figure"
                                    ? "border-blue-300/60 dark:border-blue-700/50 text-blue-600 dark:text-blue-400"
                                    : "border-emerald-300/60 dark:border-emerald-700/50 text-emerald-600 dark:text-emerald-400"
                                }`}
                              >
                                {c.type}
                              </Badge>
                              <span className="text-xs font-semibold">
                                {c.reference}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="ml-auto h-6 px-2 text-[10px] gap-1"
                                onClick={() => copyToClipboard(c.caption)}
                              >
                                <Copy className="h-3 w-3" />
                                Copy
                              </Button>
                            </div>
                            <p className="text-[12px] leading-relaxed text-foreground bg-muted/40 rounded p-2">
                              {c.caption}
                            </p>
                            {c.context && (
                              <details className="mt-2">
                                <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
                                  View surrounding context
                                </summary>
                                <p className="text-[10px] text-muted-foreground mt-1 italic line-clamp-3">
                                  {c.context}
                                </p>
                              </details>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
