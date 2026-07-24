"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Database as DatabaseIcon,
  Trash2,
  ExternalLink,
  Pin,
  PinOff,
  Loader2,
  Plus,
  Microscope,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AddReferenceDialog } from "./add-reference-dialog";
import { useI18n } from "@/lib/i18n";
import { api } from "@/lib/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DataSource, Reference, Article } from "@/lib/types";

const TYPE_BADGE: Record<string, string> = {
  pubmed: "badge-emerald",
  uniprot: "badge-teal",
  rcsb: "badge-amber",
  ncbi: "badge-rose",
  blast: "badge-violet",
  web: "badge-sky",
  manual: "badge-slate",
};

// Display order for source types (most common first)
const SOURCE_TYPE_ORDER = ["pubmed", "rcsb", "uniprot", "ncbi", "blast", "web", "manual"];

const SOURCE_TYPE_ICONS: Record<string, string> = {
  pubmed: "📄",
  rcsb: "🧬",
  uniprot: "🧪",
  ncbi: "🧩",
  blast: "🔬",
  web: "🌐",
  manual: "📝",
};

export function KnowledgePanel({
  projectId,
  dataSources,
  references,
  articles,
  onOpenArticle,
}: {
  projectId: string | null;
  dataSources: DataSource[];
  references: Reference[];
  articles: (Article & { _count?: any })[];
  onOpenArticle: (a: Article) => void;
}) {
  const { t } = useI18n();
  const [addRefOpen, setAddRefOpen] = React.useState(false);
  return (
    <>
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header with Add Reference button */}
      <div className="flex items-center justify-between px-3 mt-3 mb-1 shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
          <DatabaseIcon className="h-3 w-3" />
          {t("knowledge.sources")}
          {dataSources.length > 0 && (
            <span className="text-[9px] opacity-70">{dataSources.length}</span>
          )}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-[10px] gap-1 px-2 border-dashed"
          onClick={() => setAddRefOpen(true)}
        >
          <Plus className="h-3 w-3" />
          {t("knowledge.addReference")}
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <SourcesList projectId={projectId} items={dataSources} />
      </div>
    </div>
    <AddReferenceDialog
      open={addRefOpen}
      onOpenChange={setAddRefOpen}
      projectId={projectId}
    />
    </>
  );
}

function SourcesList({
  projectId,
  items,
}: {
  projectId: string | null;
  items: DataSource[];
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [collapsedTypes, setCollapsedTypes] = React.useState<Set<string>>(new Set());

  const togglePin = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api.updateDataSource(id, { pinned }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteDataSource(id),
    onSuccess: () => {
      toast.success(t("toast.sourceRemoved"));
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const deepReadMut = useMutation({
    mutationFn: (id: string) => api.deepReadDataSource(id),
    onSuccess: (data) => {
      toast.success(t("toast.deepReadComplete", { n: data.contentLength }));
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const [expandedSource, setExpandedSource] = React.useState<string | null>(null);

  // Group items by source type, sorted by SOURCE_TYPE_ORDER then alphabetical
  const sourceTypes = [...new Set(items.map((d) => d.source))].sort((a, b) => {
    const ai = SOURCE_TYPE_ORDER.indexOf(a);
    const bi = SOURCE_TYPE_ORDER.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });

  const toggleType = (type: string) => {
    setCollapsedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  if (items.length === 0) {
    return (
      <ScrollArea className="h-full scroll-academic">
        <div className="px-3 py-2">
          <EmptyState
            icon={<DatabaseIcon className="h-7 w-7" />}
            title={t("knowledge.noSources")}
            hint={t("knowledge.noSourcesHint")}
          />
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="h-full scroll-academic">
      <div className="px-3 py-2 space-y-2.5">
        {sourceTypes.map((st) => {
          const typeItems = items.filter((d) => d.source === st);
          const isCollapsed = collapsedTypes.has(st);
          return (
            <div key={st} className="rounded-lg border border-border/50 overflow-hidden">
              {/* Type section header */}
              <button
                onClick={() => toggleType(st)}
                className="w-full flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/40 hover:bg-muted/60 transition-colors"
              >
                <span className="text-[11px]">{SOURCE_TYPE_ICONS[st] || "📦"}</span>
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase ${TYPE_BADGE[st] || "badge-slate"}`}>
                  {st}
                </span>
                <span className="text-[10px] font-medium text-foreground/80">
                  {typeItems.length} {typeItems.length === 1 ? "item" : "items"}
                </span>
                <span className="ml-auto text-muted-foreground">
                  {isCollapsed ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronUp className="h-3 w-3" />
                  )}
                </span>
              </button>
              {/* Type section body */}
              {!isCollapsed && (
                <div className="p-2 space-y-2 bg-card/30">
                  {typeItems.map((d) => (
                    <SourceCard
                      key={d.id}
                      d={d}
                      t={t}
                      expandedSource={expandedSource}
                      setExpandedSource={setExpandedSource}
                      onPin={(id, pinned) => togglePin.mutate({ id, pinned })}
                      onDelete={(id) => del.mutate(id)}
                      onDeepRead={(id) => deepReadMut.mutate(id)}
                      deepReadPending={deepReadMut.isPending && deepReadMut.variables === d.id}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

function SourceCard({
  d,
  t,
  expandedSource,
  setExpandedSource,
  onPin,
  onDelete,
  onDeepRead,
  deepReadPending,
}: {
  d: DataSource;
  t: (key: any, opts?: any) => string;
  expandedSource: string | null;
  setExpandedSource: (id: string | null) => void;
  onPin: (id: string, pinned: boolean) => void;
  onDelete: (id: string) => void;
  onDeepRead: (id: string) => void;
  deepReadPending: boolean;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-card p-2.5 space-y-1">
      <div className="flex items-start gap-1.5">
        {d.externalId && (
          <span className="text-[9px] font-mono text-muted-foreground">
            {d.externalId}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {d.url && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-sky-600"
              onClick={() => onDeepRead(d.id)}
              disabled={deepReadPending}
              title={t("knowledge.deepReadTitle")}
            >
              {deepReadPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Microscope className="h-3 w-3" />
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onPin(d.id, !d.pinned)}
            title={d.pinned ? t("knowledge.unpin") : t("knowledge.pin")}
          >
            {d.pinned ? (
              <PinOff className="h-3 w-3" />
            ) : (
              <Pin className="h-3 w-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-destructive"
            onClick={() => onDelete(d.id)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <p className="text-[11px] font-medium leading-snug line-clamp-2">
        {d.title || d.query}
      </p>
      {/* Show PDB structure association for RCSB sources */}
      {d.source === "rcsb" && d.externalId && (() => {
        let extra: any = null;
        try { extra = d.extra ? JSON.parse(d.extra) : null; } catch {}
        return extra ? (
          <div className="flex flex-wrap gap-1 mt-0.5">
            <span className="badge-amber px-1 py-0.5 rounded text-[8px] font-semibold uppercase">
              PDB:{d.externalId}
            </span>
            {extra.resolution && (
              <span className="text-[8px] text-muted-foreground">
                {extra.resolution}Å
              </span>
            )}
            {extra.method && (
              <span className="text-[8px] text-muted-foreground">
                {extra.method}
              </span>
            )}
            {extra.hasPublication && (
              <span className="text-[8px] text-emerald-600 font-medium">
                {t("knowledge.linkedPublication")}
              </span>
            )}
          </div>
        ) : null;
      })()}
      {(d.authors || d.journal || d.year) && (
        <p className="text-[9px] text-muted-foreground">
          {d.authors && <span>{d.authors}</span>}
          {d.authors && d.year && <span>, </span>}
          {d.year && <span>{d.year}</span>}
          {d.journal && <span> · <em>{d.journal}</em></span>}
        </p>
      )}
      <p className="text-[9px] text-muted-foreground font-mono truncate">
        {t("knowledge.queryLabel")} {d.query}
      </p>
      {d.url && (
        <a
          href={d.url}
          target="_blank"
          rel="noreferrer"
          className="text-[9px] text-primary hover:underline inline-flex items-center gap-0.5"
        >
          <ExternalLink className="h-2.5 w-2.5" /> {d.url.replace(/^https?:\/\//, "").slice(0, 40)}
        </a>
      )}
      {d.summary && (
        <div className="mt-1.5">
          <button
            onClick={() =>
              setExpandedSource(
                expandedSource === d.id ? null : d.id
              )
            }
            className="text-[9px] uppercase tracking-wider text-sky-600 font-semibold flex items-center gap-1 hover:text-sky-700"
          >
            <Microscope className="h-2.5 w-2.5" />
            {t("knowledge.deepRead")}
            {expandedSource === d.id ? (
              <ChevronUp className="h-2.5 w-2.5" />
            ) : (
              <ChevronDown className="h-2.5 w-2.5" />
            )}
          </button>
          {expandedSource === d.id && (
            <div className="mt-1 rounded-md bg-sky-50/50 dark:bg-sky-950/20 border border-sky-200/40 dark:border-sky-900/40 p-2 text-[10px] leading-relaxed whitespace-pre-wrap font-sans">
              {d.summary}
            </div>
          )}
        </div>
      )}
      {d.pinned && (
        <span className="inline-flex items-center gap-0.5 text-[8px] text-amber-600 font-medium">
          <Pin className="h-2 w-2" /> {t("knowledge.pinned")}
        </span>
      )}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="text-center py-10 text-muted-foreground px-4">
      <div className="opacity-40 flex justify-center mb-2">{icon}</div>
      <p className="text-xs font-medium">{title}</p>
      <p className="text-[10px] mt-1 leading-relaxed">{hint}</p>
    </div>
  );
}
