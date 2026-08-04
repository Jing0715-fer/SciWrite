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

const SOURCE_BADGE: Record<string, string> = {
  pubmed: "badge-emerald",
  uniprot: "badge-teal",
  rcsb: "badge-amber",
  ncbi: "badge-rose",
  blast: "badge-violet",
  web: "badge-sky",
};

const SOURCE_DOT: Record<string, string> = {
  emerald: "bg-emerald-500",
  teal: "bg-teal-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  violet: "bg-violet-500",
  sky: "bg-sky-500",
};

export function DatabaseQueryPanel({ projectId }: { projectId: string | null }) {
  const { t } = useI18n();
  const [source, setSource] = React.useState<string>("pubmed");
  const [query, setQuery] = React.useState("");
  const [blastProgram, setBlastProgram] = React.useState<"blastp" | "blastn">("blastp");
  const [results, setResults] = React.useState<DatabaseQueryResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const qc = useQueryClient();

  const srcMeta = DATABASE_SOURCES.find((s) => s.id === source)!;

  const searchMut = useMutation({
    mutationFn: async () => {
      if (!query.trim()) throw new Error(t("db.pleaseEnterQuery"));
      return api.queryDatabase({
        source,
        query,
        program: source === "blast" ? blastProgram : undefined,
      });
    },
    onSuccess: (data) => {
      setResults(data);
      setError(null);
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
      <div className="px-4 pt-4 pb-3 border-b border-border/60 space-y-3 shrink-0">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold tracking-tight">
            {t("db.title")}
          </h3>
        </div>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="h-9 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATABASE_SOURCES.map((s) => (
              <SelectItem key={s.id} value={s.id} className="text-xs">
                <span className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${SOURCE_DOT[s.color] || "bg-slate-400"}`}
                  />
                  {s.shortName}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {srcMeta.description}
        </p>
      </div>

      <div className="px-4 py-3 border-b border-border/60 space-y-2 shrink-0">
        {source === "blast" ? (
          <>
            <Textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={srcMeta.queryPlaceholder}
              className="font-mono text-[11px] min-h-[88px] resize-y"
            />
            <div className="flex items-center gap-2">
              <Select
                value={blastProgram}
                onValueChange={(v) => setBlastProgram(v as any)}
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
                className="h-8"
              >
                {searchMut.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Dna className="h-3.5 w-3.5" />
                )}
                <span className="ml-1">{t("db.blast")}</span>
              </Button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              searchMut.mutate();
            }}
            className="flex items-center gap-2"
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={srcMeta.queryPlaceholder}
              className="h-8 text-xs"
            />
            <Button
              type="submit"
              size="sm"
              disabled={searchMut.isPending}
              className="h-8 px-2.5"
            >
              {searchMut.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
            </Button>
          </form>
        )}
        {srcMeta.example && (
          <button
            type="button"
            onClick={() => setQuery(srcMeta.example)}
            className="text-[10px] text-muted-foreground hover:text-primary transition-colors"
          >
            {t("db.try")} {srcMeta.example}
          </button>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0 scroll-academic">
        <div className="px-4 py-3 space-y-2.5">
          {error && (
            <div className="text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2.5">
              {error}
            </div>
          )}
          {!results && !searchMut.isPending && (
            <div className="text-center py-10 text-muted-foreground">
              <FlaskConical className="h-8 w-8 mx-auto mb-2 opacity-40" />
              <p className="text-xs">
                {t("db.noResults")}
              </p>
            </div>
          )}
          {searchMut.isPending && (
            <div className="space-y-2.5">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="rounded-lg border border-border/70 bg-card p-3 space-y-2 overflow-hidden"
                >
                  <div className="flex items-start gap-2">
                    <div className="h-2 w-4 bg-muted/60 rounded animate-pulse mt-0.5" />
                    <div className="flex-1 space-y-1">
                      <div className="h-3 bg-muted/60 rounded animate-pulse w-full" />
                      <div className="h-3 bg-muted/40 rounded animate-pulse w-3/4" />
                    </div>
                  </div>
                  <div className="flex gap-1 pl-6">
                    <div className="h-3 w-12 bg-muted/40 rounded animate-pulse" />
                    <div className="h-3 w-10 bg-muted/30 rounded animate-pulse" />
                  </div>
                  <div className="h-5 bg-muted/30 rounded animate-pulse w-full" />
                  <div className="flex gap-1 pt-1 border-t border-border/30">
                    <div className="h-4 w-14 bg-muted/40 rounded animate-pulse" />
                    <div className="h-4 w-16 bg-muted/40 rounded animate-pulse" />
                  </div>
                </div>
              ))}
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
                savingSource={saveSourceMut.isPending}
                savingRef={saveRefMut.isPending}
              />
            ))}
          {results && results.rawSnippet && (
            <div className="text-[11px] text-muted-foreground bg-muted/40 rounded-md p-2 font-mono">
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
    <div className="rounded-lg border border-border/70 bg-card hover:shadow-sm transition-shadow overflow-hidden">
      <div className="p-3 space-y-1.5">
        <div className="flex items-start gap-2">
          <span className="text-[10px] font-mono text-muted-foreground mt-0.5 shrink-0">
            {String(index + 1).padStart(2, "0")}
          </span>
          <div className="flex-1 min-w-0">
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium leading-snug hover:text-primary inline-flex items-start gap-1"
            >
              <span className="line-clamp-2">{item.title}</span>
              <ExternalLink className="h-3 w-3 shrink-0 mt-0.5 opacity-60" />
            </a>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 pl-6">
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide ${badgeClass}`}
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
          <p className="text-[10px] text-muted-foreground pl-6 line-clamp-1">
            {item.authors}
          </p>
        )}
        {item.abstract && (
          <p
            className={`text-[11px] text-foreground/80 pl-6 leading-relaxed ${
              expanded ? "" : "line-clamp-2"
            }`}
          >
            {item.abstract}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 px-3 py-1.5 bg-muted/30 border-t border-border/50">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] px-2"
          onClick={onAddSource}
          disabled={savingSource}
        >
          <Plus className="h-3 w-3" /> {t("db.source")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] px-2"
          onClick={onAddRef}
          disabled={savingRef}
        >
          <Plus className="h-3 w-3" /> {t("db.reference")}
        </Button>
        {item.abstract && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] px-2 ml-auto"
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
