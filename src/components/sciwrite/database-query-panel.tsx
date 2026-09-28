"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Database,
  Loader2,
  Search,
  ExternalLink,
  Plus,
  ChevronDown,
  Dna,
  FlaskConical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api-client";
import { DATABASE_SOURCES } from "@/lib/constants";
import type { DatabaseQueryResponse, DatabaseResultItem } from "@/lib/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";
import { useQueryHistory, QueryHistoryBar } from "@/components/sciwrite/query-history";

/** Semantic source-type badge → design-system .badge-* class.
 *  These ARE the source-type indicators the design system sanctions
 *  (pubmed=emerald, uniprot=teal, rcsb=amber, ncbi=rose, blast=violet,
 *  web=sky). The same hues appear on result cards and on the small dot
 *  in the source dropdown so users read source-type at a glance. */
const SOURCE_BADGE: Record<string, string> = {
  pubmed: "badge-emerald",
  uniprot: "badge-teal",
  rcsb: "badge-amber",
  ncbi: "badge-rose",
  blast: "badge-violet",
  web: "badge-sky",
};

export function DatabaseQueryPanel({ projectId }: { projectId: string | null }) {
  const { t } = useI18n();
  const [source, setSource] = React.useState<string>("pubmed");
  const [query, setQuery] = React.useState("");
  const [blastProgram, setBlastProgram] = React.useState<"blastp" | "blastn">("blastp");
  const [results, setResults] = React.useState<DatabaseQueryResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const qc = useQueryClient();
  const { history, addEntry, removeEntry, clearAll } = useQueryHistory();

  const srcMeta = DATABASE_SOURCES.find((s) => s.id === source)!;

  const searchMut = useMutation({
    mutationFn: async (override?: { source: string; query: string; program?: "blastp" | "blastn" }) => {
      const s = override?.source ?? source;
      const q = override?.query ?? query;
      const p = override?.program ?? blastProgram;
      if (!q.trim()) throw new Error(t("db.pleaseEnterQuery"));
      return api.queryDatabase({
        source: s,
        query: q,
        program: s === "blast" ? p : undefined,
      });
    },
    onSuccess: (data, override) => {
      setResults(data);
      setError(null);
      // Persist to query history
      addEntry({
        source: override?.source ?? source,
        query: override?.query ?? query,
        program: (override?.source ?? source) === "blast" ? (override?.program ?? blastProgram) : undefined,
        resultCount: data.total,
      });
      if (data.items.length === 0) {
        toast.info(t("db.noResultsFound"));
      } else {
        toast.success(t("db.foundToast", { n: data.total, src: srcMeta.shortName }));
      }
    },
    onError: (err: Error) => {
      setError(err.message);
      toast.error(err.message);
    },
  });

  const saveSourceMut = useMutation({
    mutationFn: async (item: DatabaseResultItem) => {
      return api.createDataSource({
        projectId: projectId || undefined,
        source: item.source,
        query,
        rawJson: { items: [item] },
        title: item.title,
        externalId: item.externalId,
        url: item.url,
      });
    },
    onSuccess: () => {
      toast.success(t("toast.addedToSources"));
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveRefMut = useMutation({
    mutationFn: async (item: DatabaseResultItem) => {
      return api.createReference({
        type: item.source,
        externalId: item.externalId,
        title: item.title,
        authors: item.authors,
        journal: item.journal,
        year: item.year,
        url: item.url,
        doi: item.doi,
        abstract: item.abstract,
        projectId: projectId || undefined,
      });
    },
    onSuccess: () => {
      toast.success(t("toast.savedAsReference"));
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ============================================================
          Row 1 — header (.glass-subtle .panel-section-header)
          Mirrors ProjectsSidebar's header rhythm so the two panels read
          as siblings: brand-tile + eyebrow on the left, source picker
          on the right. The header sits at the same vertical position
          as ProjectsSidebar's header (QA #2 fix).
          ============================================================ */}
      <div className="atlas-data-header shrink-0">
        <div className="atlas-data-section-title">
          <span className="atlas-data-section-title-icon">
            <Database className="h-3 w-3" />
          </span>
          {t("db.title")}
        </div>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="h-7 w-[140px] text-xs shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATABASE_SOURCES.map((s) => (
              <SelectItem key={s.id} value={s.id} className="text-xs">
                <span className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center justify-center h-3 min-w-3 px-1 rounded text-[9px] font-bold leading-none ${SOURCE_BADGE[s.id] || "badge-slate"}`}
                  >
                    {s.shortName[0]}
                  </span>
                  {s.shortName}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ============================================================
          Row 2 — search row (.panel-section-header)
          Sits at exactly the same vertical position as ProjectsSidebar's
          search Input (QA #2 fix). Query Input on the left, primary
          gradient CTA on the right. BLAST swaps the Input for a
          Textarea + program picker + BLAST button. The CTA uses
          .btn-gradient-primary so the only saturated color on the panel
          is the brand primary (QA #4 fix — no competing amber/orange).
          ============================================================ */}
      <div className="panel-section-header shrink-0 border-b hairline">
        {source === "blast" ? (
          <div className="space-y-2">
            <Textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={srcMeta.queryPlaceholder}
              className="font-mono text-[11px] min-h-[96px] resize-y"
            />
            <div className="flex items-center gap-2">
              <Select
                value={blastProgram}
                onValueChange={(v) => setBlastProgram(v as "blastp" | "blastn")}
              >
                <SelectTrigger className="h-8 text-xs flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="blastp">{t("db.blastpProtein")}</SelectItem>
                  <SelectItem value="blastn">{t("db.blastnNucleotide")}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={() => searchMut.mutate()}
                disabled={searchMut.isPending}
                className="btn-gradient-primary h-8 px-3 gap-1 text-primary-foreground font-medium"
              >
                {searchMut.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Dna className="h-3.5 w-3.5" />
                )}
                <span>{t("db.blast")}</span>
              </Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              searchMut.mutate();
            }}
            className="flex items-center gap-2"
          >
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/80 pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={srcMeta.queryPlaceholder}
                className="h-8 pl-8 text-xs bg-card border-border/70 focus-visible:border-primary/50 focus-visible:ring-primary/30"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={searchMut.isPending}
              className="btn-gradient-primary h-8 px-3 gap-1 text-primary-foreground font-medium"
            >
              {searchMut.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
              <span className="hidden xs:inline">{t("db.search")}</span>
            </Button>
          </form>
        )}
      </div>

      {/* ============================================================
          Row 3 — hint row (description + Try example)
          Not a .panel-section-header — it doesn't claim the search-row
          alignment; just a thin 4px-scale strip below the search.
          ============================================================ */}
      <div className="px-4 py-2 border-b hairline shrink-0 flex items-center justify-between gap-2 min-w-0">
        <p className="text-[10px] leading-relaxed text-muted-foreground truncate">
          {srcMeta.description}
        </p>
        {srcMeta.example && (
          <button
            type="button"
            onClick={() => setQuery(srcMeta.example)}
            className="text-[10px] text-primary hover:underline shrink-0"
          >
            {t("db.try")} {srcMeta.example}
          </button>
        )}
      </div>

      {/* ============================================================
          Row 3.5 — recent queries history strip
          Persisted to localStorage. Click a chip to re-run the exact
          same source+query; X removes it. Helps the user iterate on
          searches without retyping.
          ============================================================ */}
      <QueryHistoryBar
        history={history}
        onRerun={(entry) => {
          setSource(entry.source);
          setQuery(entry.query);
          if (entry.program) setBlastProgram(entry.program);
          // Pass override so the mutation uses the entry's params directly
          // (state updates are async, so the closure would be stale otherwise).
          searchMut.mutate({
            source: entry.source,
            query: entry.query,
            program: entry.program,
          });
        }}
        onRemove={removeEntry}
        onClear={clearAll}
      />

      {/* ============================================================
          Row 4 — result count stat-tile (only when results are present)
          Uses .stat-tile so the count reads as a metric chip, matching
          the rest of the design system's stat tiles.
          ============================================================ */}
      {results && (
        <div className="px-4 py-2 border-b hairline shrink-0 flex items-center justify-between gap-2">
          <div className="stat-tile inline-flex items-center gap-2 px-2 py-1">
            <Database className="h-3 w-3 text-primary" />
            <span className="font-mono text-[11px] tabular-nums font-semibold text-primary">
              {results.total}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {t("db.resultFrom")} {srcMeta.shortName}
            </span>
          </div>
          <span className="eyebrow">{srcMeta.shortName}</span>
        </div>
      )}

      {/* round-36: the Radix display:table wrapper is killed globally in
          globals.css ([data-radix-scroll-area-viewport] > div), so long
          unbreakable tokens can never push cards off-screen. */}
      <ScrollArea className="flex-1 min-h-0 scroll-academic">
        <div className="px-4 py-3 space-y-2">
          {error && (
            <div className="text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2">
              {error}
            </div>
          )}
          {!results && !searchMut.isPending && (
            <div className="acad-fade-in flex flex-col items-center text-center py-12 text-muted-foreground">
              <div className="ring-academic h-11 w-11 rounded-xl flex items-center justify-center mb-3 bg-card">
                <FlaskConical className="h-5 w-5 text-primary/70" />
              </div>
              <p className="text-xs font-medium tracking-tight">
                {t("db.noResults")}
              </p>
            </div>
          )}
          {searchMut.isPending && (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="surface-card rounded-lg p-3 space-y-2 overflow-hidden"
                >
                  <div className="flex items-start gap-2">
                    <div className="h-4 w-5 bg-muted/60 rounded animate-pulse shrink-0" />
                    <div className="flex-1 space-y-1">
                      <div className="h-3 bg-muted/60 rounded animate-pulse w-full" />
                      <div className="h-3 bg-muted/40 rounded animate-pulse w-3/4" />
                    </div>
                  </div>
                  <div className="flex gap-1 pl-7">
                    <div className="h-3 w-12 bg-muted/40 rounded animate-pulse" />
                    <div className="h-3 w-10 bg-muted/30 rounded animate-pulse" />
                  </div>
                  <div className="h-5 bg-muted/30 rounded animate-pulse w-full" />
                  <div className="flex gap-1 pt-1 border-t hairline">
                    <div className="h-4 w-14 bg-muted/40 rounded animate-pulse" />
                    <div className="h-4 w-16 bg-muted/40 rounded animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* round-50: search-transparency strip — which query spellings ran
              (TMC1 / TMC-1 / TMC 1 / full-name aliases) and which entries the
              LLM relevance filter removed as being about a different protein. */}
          {results && !searchMut.isPending && (results.variants || results.filteredOut) && (
            <div className="text-[11px] surface-card rounded-lg p-2 space-y-1 acad-fade-in">
              {results.variants && results.variants.length > 1 && (
                <div className="flex items-start gap-1 flex-wrap">
                  <span className="text-muted-foreground shrink-0">
                    {t("db.variantsUsed", { n: results.variants.length })}:
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {results.variants.map((v) => (
                      <span
                        key={v}
                        className="inline-block px-1 py-0 rounded bg-primary/10 text-primary border border-primary/15 font-mono leading-4"
                      >
                        {v}
                      </span>
                    ))}
                  </span>
                </div>
              )}
              {results.filteredOut && results.filteredOut.length > 0 && (
                <details className="group">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors select-none list-none flex items-center gap-1">
                    <ChevronDown className="h-3 w-3 shrink-0 transition-transform group-open:rotate-180" />
                    {t("db.filteredOut", { n: results.filteredOut.length })}
                  </summary>
                  <div className="mt-1 space-y-1 pl-4 max-h-40 overflow-y-auto">
                    {results.filteredOut.map((f, i) => (
                      <div key={`${f.externalId ?? f.title}-${i}`} className="leading-relaxed">
                        <span className="text-muted-foreground line-through">
                          {f.title.length > 72 ? f.title.slice(0, 72) + "…" : f.title}
                        </span>
                        <span className="block text-[10px] text-muted-foreground/80 pl-2">
                          {f.reason}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
          {results &&
            results.items.map((item, idx) => (
              <ResultCard
                key={`${item.externalId}-${idx}`}
                item={item}
                index={idx}
                onAddSource={() => saveSourceMut.mutate(item)}
                onAddRef={() => saveRefMut.mutate(item)}
                // Per-item saving state: compare mutate()'s variables against
                // this item — the previous global `isPending` flags made EVERY
                // result card show a spinner while any single save was in
                // flight, hiding which row was actually being saved.
                savingSource={
                  saveSourceMut.isPending && saveSourceMut.variables === item
                }
                savingRef={
                  saveRefMut.isPending && saveRefMut.variables === item
                }
              />
            ))}
          {results && results.rawSnippet && (
            <div className="text-[11px] text-muted-foreground bg-muted/40 border hairline rounded-md p-2 font-mono">
              {results.rawSnippet}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ResultCard({
  item,
  index,
  onAddSource,
  onAddRef,
  savingSource,
  savingRef,
}: {
  item: DatabaseResultItem;
  index: number;
  onAddSource: () => void;
  onAddRef: () => void;
  savingSource: boolean;
  savingRef: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(false);
  const badgeClass = SOURCE_BADGE[item.source] || "badge-slate";
  return (
    <div className="surface-card rounded-lg hover:shadow-md hover:border-primary/30 transition-all overflow-hidden acad-fade-in">
      <div className="p-3 space-y-2">
        <div className="flex items-start gap-2">
          <span className="badge-slate inline-flex items-center justify-center min-w-5 h-4 px-1 rounded text-[9px] font-mono font-semibold shrink-0 mt-1">
            {String(index + 1).padStart(2, "0")}
          </span>
          <div className="flex-1 min-w-0">
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium leading-snug hover:text-primary inline-flex items-start gap-1"
            >
              <span className="line-clamp-2 break-words">{item.title}</span>
              <ExternalLink className="h-3 w-3 shrink-0 mt-1 opacity-60" />
            </a>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 pl-7">
          <span
            className={`inline-flex items-center px-1 h-4 rounded text-[9px] font-semibold uppercase tracking-wide max-w-full truncate ${badgeClass}`}
          >
            {item.source}
            {item.externalId ? `:${item.externalId}` : ""}
          </span>
          {item.year && (
            <span className="text-[10px] text-muted-foreground">{item.year}</span>
          )}
          {item.journal && (
            <span className="text-[10px] text-muted-foreground italic truncate max-w-[140px]">
              {item.journal}
            </span>
          )}
        </div>
        {item.authors && (
          <p className="text-[10px] text-muted-foreground pl-7 line-clamp-1 break-words">
            {item.authors}
          </p>
        )}
        {item.abstract && (
          <p
            className={`text-[11px] text-foreground/80 pl-7 leading-relaxed break-words ${
              expanded ? "" : "line-clamp-2"
            }`}
          >
            {item.abstract}
          </p>
        )}
      </div>
      {/* Action row — secondary actions use variant="outline" with
          border-primary/40 text-primary (QA #4 fix: no raw amber/orange on
          action buttons). The More/Less expand is a tertiary ghost.
          The saving spinner replaces the Plus icon while the per-item
          mutation is in flight, so the user sees exactly which row is
          being saved. */}
      <div className="flex items-center gap-1 px-3 py-2 bg-muted/20 border-t hairline">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[10px] px-2 border-primary/40 text-primary hover:bg-primary/5"
          onClick={onAddSource}
          disabled={savingSource}
        >
          {savingSource ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Plus className="h-3 w-3" />
          )}
          {t("db.source")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[10px] px-2 border-primary/40 text-primary hover:bg-primary/5"
          onClick={onAddRef}
          disabled={savingRef}
        >
          {savingRef ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Plus className="h-3 w-3" />
          )}
          {t("db.reference")}
        </Button>
        {item.abstract && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[10px] px-2 ml-auto"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? t("common.less") : t("common.more")}
            <ChevronDown
              className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </Button>
        )}
      </div>
    </div>
  );
}
