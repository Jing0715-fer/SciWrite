"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Loader2,
  Search,
  Database,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
  Sparkles,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
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
import { useQueryClient } from "@tanstack/react-query";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string | null;
}

/**
 * EnrichReferencesDialog — batch-enrich reference metadata via CrossRef.
 *
 * Two modes:
 *  1. Batch Enrich: scans all project references, finds those with incomplete
 *     metadata (missing authors/year/journal), and fills them via CrossRef
 *     DOI lookup (preferred) or title search (fallback). Shows per-reference
 *     results with which fields were updated.
 *  2. Title Search: search CrossRef by title to find the DOI + full metadata
 *     for a reference the user only knows by name. Results are shown with a
 *     similarity score so the user can pick the best match.
 *
 * Uses CrossRef's "polite pool" (mailto param) for higher rate limits.
 */
export function EnrichReferencesDialog({ open, onOpenChange, projectId }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();

  // ── Batch enrichment ──────────────────────────────────────────────────────
  const enrichMut = useMutation({
    mutationFn: () => api.enrichReferences(projectId!),
    onSuccess: (data) => {
      toast.success(
        `Enriched ${data.enriched} references (${data.failed} failed)`,
      );
      // Invalidate reference queries so the UI refreshes
      qc.invalidateQueries({ queryKey: ["references"] });
      qc.invalidateQueries({ queryKey: ["paragraphs"] });
    },
    onError: (e: any) => toast.error(e?.message || "Enrichment failed"),
  });

  // ── Title search ──────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = React.useState("");
  const searchMut = useMutation({
    mutationFn: ({ query }: { query: string }) =>
      api.searchReferencesByTitle(query, 5),
  });

  const handleSearch = () => {
    if (searchQuery.trim().length < 3) return;
    searchMut.mutate({ query: searchQuery.trim() });
  };

  React.useEffect(() => {
    if (open && projectId && !enrichMut.data && !enrichMut.isPending) {
      enrichMut.mutate();
    }
  }, [open, projectId]);

  const enrichData = enrichMut.data;
  const searchData = searchMut.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Database className="h-4 w-4 text-cyan-600" />
            Enrich References (CrossRef)
          </DialogTitle>
          <DialogDescription className="text-xs">
            Auto-fill missing metadata (authors, year, journal, DOI) via
            CrossRef API
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1">
          <div className="px-5 py-4 space-y-5">
            {/* ── Batch enrichment results ────────────────────────────────── */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-cyan-600" />
                  Batch Enrichment
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[10px] gap-1"
                  onClick={() => enrichMut.mutate()}
                  disabled={enrichMut.isPending || !projectId}
                >
                  <RefreshCw className="h-3 w-3" />
                  Re-run
                </Button>
              </div>

              {enrichMut.isPending && (
                <div className="flex flex-col items-center justify-center py-10 gap-2">
                  <Loader2 className="h-6 w-6 animate-spin text-cyan-600" />
                  <p className="text-xs text-muted-foreground">
                    Querying CrossRef API…
                  </p>
                  <p className="text-[10px] text-muted-foreground/70">
                    Processing up to 50 references
                  </p>
                </div>
              )}

              {enrichData && (
                <>
                  {/* Summary stats */}
                  <div className="grid grid-cols-4 gap-2 mb-3">
                    <div className="rounded-lg border border-border/60 p-2 text-center bg-card">
                      <div className="text-lg font-bold text-foreground">
                        {enrichData.total}
                      </div>
                      <div className="text-[9px] text-muted-foreground uppercase">
                        Total
                      </div>
                    </div>
                    <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-800/40 p-2 text-center bg-emerald-50/50 dark:bg-emerald-950/20">
                      <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                        {enrichData.enriched}
                      </div>
                      <div className="text-[9px] text-muted-foreground uppercase">
                        Enriched
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-200/60 dark:border-slate-800/40 p-2 text-center bg-card">
                      <div className="text-lg font-bold text-muted-foreground">
                        {enrichData.skipped}
                      </div>
                      <div className="text-[9px] text-muted-foreground uppercase">
                        Skipped
                      </div>
                    </div>
                    <div className="rounded-lg border border-red-200/60 dark:border-red-800/40 p-2 text-center bg-red-50/30 dark:bg-red-950/10">
                      <div className="text-lg font-bold text-red-600 dark:text-red-400">
                        {enrichData.failed}
                      </div>
                      <div className="text-[9px] text-muted-foreground uppercase">
                        Failed
                      </div>
                    </div>
                  </div>

                  {enrichData.message && (
                    <p className="text-[11px] text-muted-foreground italic mb-3">
                      {enrichData.message}
                    </p>
                  )}

                  {/* Per-reference details */}
                  {enrichData.details.length > 0 && (
                    <div className="space-y-1.5 max-h-64 overflow-y-auto rounded-lg border border-border/40 p-2">
                      {enrichData.details.map((d, i) => (
                        <div
                          key={d.id}
                          className={`flex items-start gap-2 p-2 rounded-md text-[11px] ${
                            d.status === "enriched"
                              ? "bg-emerald-50/40 dark:bg-emerald-950/10"
                              : d.status === "failed"
                                ? "bg-red-50/30 dark:bg-red-950/10"
                                : "bg-muted/20"
                          } ${i % 2 === 0 ? "" : "bg-muted/10"}`}
                        >
                          <div className="mt-0.5 shrink-0">
                            {d.status === "enriched" ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                            ) : d.status === "failed" ? (
                              <XCircle className="h-3.5 w-3.5 text-red-500" />
                            ) : (
                              <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span className="font-medium truncate">
                                {d.title || "(untitled)"}
                              </span>
                              <Badge
                                variant="outline"
                                className="text-[7px] h-3 px-1 uppercase shrink-0"
                              >
                                {d.strategy}
                              </Badge>
                            </div>
                            {d.fields.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {d.fields.map((f) => (
                                  <span
                                    key={f}
                                    className="text-[9px] px-1 py-0.5 rounded bg-emerald-100/60 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                                  >
                                    +{f}
                                  </span>
                                ))}
                              </div>
                            ) : d.error ? (
                              <span className="text-[9px] text-red-500">
                                {d.error}
                              </span>
                            ) : (
                              <span className="text-[9px] text-muted-foreground">
                                No updates needed
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>

            {/* ── Title search ────────────────────────────────────────────── */}
            <section className="pt-2 border-t border-border/60">
              <h3 className="text-xs font-semibold flex items-center gap-1.5 mb-2.5">
                <Search className="h-3.5 w-3.5 text-cyan-600" />
                Search by Title
              </h3>
              <p className="text-[10px] text-muted-foreground mb-2">
                Find a reference's DOI + full metadata by searching its title on
                CrossRef.
              </p>
              <div className="flex gap-2 mb-3">
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  placeholder="e.g. TMC1 channel mechanotransduction"
                  className="h-8 text-xs"
                  disabled={searchMut.isPending}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 text-xs gap-1 shrink-0"
                  onClick={handleSearch}
                  disabled={searchMut.isPending || searchQuery.trim().length < 3}
                >
                  {searchMut.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                  Search
                </Button>
              </div>

              {searchData && (
                <div className="space-y-2">
                  {searchData.results.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground text-center py-4">
                      No results found. Try a different query.
                    </p>
                  ) : (
                    searchData.results.map((r, i) => (
                      <div
                        key={i}
                        className="rounded-lg border border-border/60 p-2.5 bg-card hover:border-cyan-300/60 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <span className="text-[11px] font-medium flex-1 leading-snug">
                            {r.title}
                          </span>
                          {r.similarity >= 0.7 ? (
                            <Badge className="text-[8px] h-4 bg-emerald-500 hover:bg-emerald-500 shrink-0">
                              {Math.round(r.similarity * 100)}% match
                            </Badge>
                          ) : r.similarity >= 0.5 ? (
                            <Badge
                              variant="outline"
                              className="text-[8px] h-4 border-amber-300/60 text-amber-600 shrink-0"
                            >
                              {Math.round(r.similarity * 100)}% match
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-[8px] h-4 border-slate-300/60 text-slate-400 shrink-0"
                            >
                              {Math.round(r.similarity * 100)}%
                            </Badge>
                          )}
                        </div>
                        {r.authors && (
                          <p className="text-[10px] text-muted-foreground mb-0.5">
                            {r.authors}
                            {r.year && ` (${r.year})`}
                          </p>
                        )}
                        {r.journal && (
                          <p className="text-[10px] italic text-muted-foreground">
                            {r.journal}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1.5">
                          {r.doi && (
                            <span className="text-[9px] font-mono text-cyan-600 dark:text-cyan-400">
                              doi:{r.doi}
                            </span>
                          )}
                          {r.url && (
                            <a
                              href={r.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[9px] text-primary hover:underline inline-flex items-center gap-0.5"
                            >
                              <ExternalLink className="h-2.5 w-2.5" />
                              link
                            </a>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
