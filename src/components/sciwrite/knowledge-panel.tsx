"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  BookOpen,
  Database as DatabaseIcon,
  FileText,
  Trash2,
  ExternalLink,
  Pin,
  PinOff,
  Layers,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
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
  return (
    <Tabs defaultValue="sources" className="flex flex-col h-full overflow-hidden">
      <TabsList className="grid grid-cols-3 mx-3 mt-3 h-8 shrink-0">
        <TabsTrigger value="sources" className="text-[11px] gap-1">
          <DatabaseIcon className="h-3 w-3" />
          Sources
          {dataSources.length > 0 && (
            <span className="text-[9px] opacity-70">{dataSources.length}</span>
          )}
        </TabsTrigger>
        <TabsTrigger value="refs" className="text-[11px] gap-1">
          <BookOpen className="h-3 w-3" />
          Refs
          {references.length > 0 && (
            <span className="text-[9px] opacity-70">{references.length}</span>
          )}
        </TabsTrigger>
        <TabsTrigger value="articles" className="text-[11px] gap-1">
          <Layers className="h-3 w-3" />
          Articles
          {articles.length > 0 && (
            <span className="text-[9px] opacity-70">{articles.length}</span>
          )}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="sources" className="flex-1 mt-0 min-h-0 overflow-hidden">
        <SourcesList projectId={projectId} items={dataSources} />
      </TabsContent>
      <TabsContent value="refs" className="flex-1 mt-0 min-h-0 overflow-hidden">
        <ReferencesList projectId={projectId} items={references} />
      </TabsContent>
      <TabsContent value="articles" className="flex-1 mt-0 min-h-0 overflow-hidden">
        <ArticlesList items={articles} onOpen={onOpenArticle} projectId={projectId} />
      </TabsContent>
    </Tabs>
  );
}

function SourcesList({
  projectId,
  items,
}: {
  projectId: string | null;
  items: DataSource[];
}) {
  const qc = useQueryClient();
  const togglePin = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api.updateDataSource(id, { pinned }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteDataSource(id),
    onSuccess: () => {
      toast.success("Source removed.");
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <ScrollArea className="h-full scroll-academic">
      <div className="px-3 py-2 space-y-2">
        {items.length === 0 && (
          <EmptyState
            icon={<DatabaseIcon className="h-7 w-7" />}
            title="No saved sources"
            hint="Query a database and click “+ Source” to pin records here."
          />
        )}
        {items.map((d) => (
          <div
            key={d.id}
            className="rounded-lg border border-border/60 bg-card p-2.5 space-y-1"
          >
            <div className="flex items-start gap-1.5">
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase ${TYPE_BADGE[d.source] || "badge-slate"}`}
              >
                {d.source}
              </span>
              {d.externalId && (
                <span className="text-[9px] font-mono text-muted-foreground">
                  {d.externalId}
                </span>
              )}
              <div className="ml-auto flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => togglePin.mutate({ id: d.id, pinned: !d.pinned })}
                  title={d.pinned ? "Unpin" : "Pin"}
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
                  onClick={() => del.mutate(d.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
            <p className="text-[11px] font-medium leading-snug line-clamp-2">
              {d.title || d.query}
            </p>
            <p className="text-[9px] text-muted-foreground font-mono truncate">
              query: {d.query}
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
            {d.pinned && (
              <span className="inline-flex items-center gap-0.5 text-[8px] text-amber-600 font-medium">
                <Pin className="h-2 w-2" /> pinned
              </span>
            )}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function ReferencesList({
  projectId,
  items,
}: {
  projectId: string | null;
  items: Reference[];
}) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (id: string) => api.deleteReference(id),
    onSuccess: () => {
      toast.success("Reference removed.");
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <ScrollArea className="h-full scroll-academic">
      <div className="px-3 py-2 space-y-2">
        {items.length === 0 && (
          <EmptyState
            icon={<BookOpen className="h-7 w-7" />}
            title="No references yet"
            hint="Save references from database results or add manually."
          />
        )}
        {items.map((r, i) => (
          <div
            key={r.id}
            className="rounded-lg border border-border/60 bg-card p-2.5 space-y-1"
          >
            <div className="flex items-start gap-1.5">
              <span className="text-[10px] font-mono text-muted-foreground mt-0.5">
                [{i + 1}]
              </span>
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase ${TYPE_BADGE[r.type] || "badge-slate"}`}
              >
                {r.type}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 ml-auto text-destructive"
                onClick={() => del.mutate(r.id)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
            <a
              href={r.url || "#"}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] font-medium leading-snug hover:text-primary line-clamp-2 block"
            >
              {r.title}
            </a>
            <p className="text-[9px] text-muted-foreground">
              {r.authors && <span>{r.authors}</span>}
              {r.authors && r.year && <span>, </span>}
              {r.year && <span>{r.year}</span>}
              {r.journal && <span> · <em>{r.journal}</em></span>}
            </p>
            {r.doi && (
              <p className="text-[9px] text-muted-foreground font-mono">DOI: {r.doi}</p>
            )}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function ArticlesList({
  items,
  onOpen,
  projectId,
}: {
  items: (Article & { _count?: any })[];
  onOpen: (a: Article) => void;
  projectId: string | null;
}) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (id: string) => api.deleteArticle(id),
    onSuccess: () => {
      toast.success("Article deleted.");
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <ScrollArea className="h-full scroll-academic">
      <div className="px-3 py-2 space-y-2">
        {items.length === 0 && (
          <EmptyState
            icon={<Layers className="h-7 w-7" />}
            title="No composed articles"
            hint="Select paragraphs and use “Compose” to generate a deeper article."
          />
        )}
        {items.map((a) => (
          <div
            key={a.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(a)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(a);
              }
            }}
            className="w-full text-left rounded-lg border border-border/60 bg-card p-2.5 hover:border-primary/40 hover:shadow-sm transition-all space-y-1 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <div className="flex items-center gap-1.5">
              <FileText className="h-3 w-3 text-primary" />
              <span className="text-[9px] text-muted-foreground uppercase tracking-wide">
                Article
              </span>
              <span className="ml-auto text-[9px] text-muted-foreground">
                {a.updatedAt ? new Date(a.updatedAt).toLocaleDateString() : ""}
              </span>
            </div>
            <p className="text-[11px] font-medium leading-snug line-clamp-2">
              {a.title}
            </p>
            {a.abstract && (
              <p className="text-[9px] text-muted-foreground italic line-clamp-2">
                {a.abstract}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-muted-foreground">
                {a._count?.articleParagraph ?? 0} paragraphs
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 ml-auto text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  del.mutate(a.id);
                }}
              >
                <Trash2 className="h-2.5 w-2.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
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
