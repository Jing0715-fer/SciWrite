"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  FlaskConical,
  Sparkles,
  Layers,
  PenLine,
  Loader2,
  BookOpenText,
  Library,
  Lightbulb,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { api } from "@/lib/api-client";
import { ThemeToggle } from "@/components/sciwrite/theme-toggle";
import { ProjectsSidebar } from "@/components/sciwrite/projects-sidebar";
import { DatabaseQueryPanel } from "@/components/sciwrite/database-query-panel";
import { KnowledgePanel } from "@/components/sciwrite/knowledge-panel";
import { ParagraphCard } from "@/components/sciwrite/paragraph-card";
import { TopicComposer } from "@/components/sciwrite/topic-composer";
import { ArticleComposer, ArticleViewer } from "@/components/sciwrite/article-composer";
import type { Article, Project } from "@/lib/types";

export default function Home() {
  const qc = useQueryClient();
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(null);
  const [writeOpen, setWriteOpen] = React.useState(false);
  const [composeOpen, setComposeOpen] = React.useState(false);
  const [viewArticle, setViewArticle] = React.useState<Article | null>(null);

  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });

  const projectQ = useQuery({
    queryKey: ["project", activeProjectId],
    queryFn: () => api.getProject(activeProjectId!),
    enabled: !!activeProjectId,
  });

  // listen for project-created event
  React.useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail as string;
      setActiveProjectId(id);
    };
    window.addEventListener("sciwrite:select-project", handler);
    return () => window.removeEventListener("sciwrite:select-project", handler);
  }, []);

  // auto-select first project
  React.useEffect(() => {
    if (!activeProjectId && projectsQ.data?.projects.length) {
      setActiveProjectId(projectsQ.data.projects[0].id);
    }
  }, [projectsQ.data, activeProjectId]);

  const projects = projectsQ.data?.projects ?? [];
  const project = projectQ.data?.project;
  const paragraphs = (project?.paragraphs ?? []) as any[];
  const dataSources = project?.dataSources ?? [];
  const articles = (project?.articles ?? []) as any[];
  const references = React.useMemo(() => {
    const map = new Map<string, any>();
    for (const r of project?.references ?? []) {
      if (!map.has(r.id)) map.set(r.id, r);
    }
    for (const p of paragraphs) {
      for (const r of p.references || []) {
        if (!map.has(r.id)) map.set(r.id, r);
      }
    }
    return [...map.values()];
  }, [paragraphs, project?.references]);

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <Header
        project={project}
        onOpenWrite={() => setWriteOpen(true)}
        onOpenCompose={() => setComposeOpen(true)}
        paragraphCount={paragraphs.length}
        articleCount={articles.length}
      />

      <main className="flex-1 min-h-0 px-3 pb-2">
        <ResizablePanelGroup direction="horizontal" className="rounded-xl border border-border/60 bg-card overflow-hidden h-full">
          {/* Left: projects */}
          <ResizablePanel defaultSize={18} minSize={15} maxSize={28} className="bg-sidebar/50">
            <ProjectsSidebar
              projects={projects}
              activeId={activeProjectId}
              onSelect={setActiveProjectId}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />

          {/* Center: writing workspace */}
          <ResizablePanel defaultSize={52} minSize={35} className="min-w-0">
            <WritingWorkspace
              project={project}
              paragraphs={paragraphs}
              activeProjectId={activeProjectId}
              onOpenWrite={() => setWriteOpen(true)}
              onOpenCompose={() => setComposeOpen(false)}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />

          {/* Right: databases + knowledge */}
          <ResizablePanel defaultSize={30} minSize={24} maxSize={42} className="bg-sidebar/30">
            <div className="flex flex-col h-full overflow-hidden">
              <div className="h-[44%] min-h-0 border-b border-border/60 overflow-hidden">
                <DatabaseQueryPanel projectId={activeProjectId} />
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <KnowledgePanel
                  projectId={activeProjectId}
                  dataSources={dataSources}
                  references={references}
                  articles={articles}
                  onOpenArticle={(a) => setViewArticle(a as Article)}
                />
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>

      <Footer />

      {/* Modals */}
      {activeProjectId && project && (
        <TopicComposer
          open={writeOpen}
          onOpenChange={setWriteOpen}
          projectId={activeProjectId}
          projectTopic={project.topic}
          projectField={project.field}
          references={references.map((r) => ({
            id: r.id,
            title: r.title,
            type: r.type,
            externalId: r.externalId,
          }))}
          dataSources={dataSources.map((d) => ({
            id: d.id,
            source: d.source,
            title: d.title,
            query: d.query,
          }))}
        />
      )}
      {activeProjectId && (
        <ArticleComposer
          open={composeOpen}
          onOpenChange={setComposeOpen}
          projectId={activeProjectId}
          paragraphs={paragraphs}
        />
      )}
      {viewArticle && (
        <ArticleViewer article={viewArticle} onClose={() => setViewArticle(null)} />
      )}
    </div>
  );
}

function Header({
  project,
  onOpenWrite,
  onOpenCompose,
  paragraphCount,
  articleCount,
}: {
  project?: any;
  onOpenWrite: () => void;
  onOpenCompose: () => void;
  paragraphCount: number;
  articleCount: number;
}) {
  return (
    <header className="shrink-0 px-4 py-2.5 border-b border-border/60 bg-card/80 backdrop-blur flex items-center gap-3">
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-teal-600 flex items-center justify-center shadow-sm">
          <FlaskConical className="h-4.5 w-4.5 text-primary-foreground" />
        </div>
        <div className="leading-none">
          <h1 className="text-sm font-bold tracking-tight">
            SciWrite
            <span className="text-primary">·</span>
            <span className="text-muted-foreground font-normal"> AI Research Writer</span>
          </h1>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            RCSB · UniProt · PubMed · NCBI · BLAST — citation-grade drafting
          </p>
        </div>
      </div>

      <div className="h-6 w-px bg-border mx-1 hidden sm:block" />

      <div className="flex-1 min-w-0 hidden sm:block">
        {project ? (
          <div className="flex items-center gap-2 min-w-0">
            <BookOpenText className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="text-xs font-medium truncate">{project.title}</span>
            <span className="text-[10px] text-muted-foreground truncate hidden md:inline">
              — {project.topic}
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">No project selected</span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {project && (
          <>
            <Badge variant="outline" className="text-[9px] h-5 gap-1">
              <PenLine className="h-2.5 w-2.5" />
              {paragraphCount}
            </Badge>
            <Badge variant="outline" className="text-[9px] h-5 gap-1">
              <Layers className="h-2.5 w-2.5" />
              {articleCount}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={onOpenCompose}
              disabled={paragraphCount < 2}
              title={paragraphCount < 2 ? "Need ≥2 paragraphs" : "Compose article"}
            >
              <Layers className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Compose</span>
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={onOpenWrite}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">AI Write</span>
            </Button>
          </>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}

function WritingWorkspace({
  project,
  paragraphs,
  activeProjectId,
  onOpenWrite,
  onOpenCompose,
}: {
  project?: any;
  paragraphs: any[];
  activeProjectId: string | null;
  onOpenWrite: () => void;
  onOpenCompose: () => void;
}) {
  if (!activeProjectId || !project) {
    return <EmptyWorkspace />;
  }
  return (
    <div className="flex flex-col h-full">
      {/* Project banner */}
      <div className="px-5 py-3 border-b border-border/60 bg-gradient-to-r from-primary/[0.04] to-transparent">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <h2 className="text-base font-semibold tracking-tight truncate font-serif-text">
                {project.title}
              </h2>
              {project.field && (
                <span className="badge-teal px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide shrink-0">
                  {String(project.field).replace("-", " ")}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
              {project.topic}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button size="sm" className="h-8 text-xs gap-1.5" onClick={onOpenWrite}>
              <Sparkles className="h-3.5 w-3.5" />
              AI Write
            </Button>
          </div>
        </div>
      </div>

      {/* Paragraphs */}
      <ScrollArea className="flex-1 scroll-academic">
        <div className="px-5 py-4 max-w-3xl mx-auto space-y-3">
          {paragraphs.length === 0 ? (
            <div className="text-center py-16">
              <div className="h-14 w-14 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center mb-3">
                <Lightbulb className="h-7 w-7 text-primary" />
              </div>
              <h3 className="text-sm font-semibold">Start writing</h3>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                Use “AI Write” to draft your first citation-backed paragraph from
                your topic, or query databases on the right to gather sources.
              </p>
              <Button
                size="sm"
                className="mt-4 gap-1.5"
                onClick={onOpenWrite}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Draft first paragraph
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <>
              <div className="divider-academic mb-1">
                <Library className="h-3 w-3" />
                Paragraphs ({paragraphs.length})
              </div>
              {paragraphs.map((p, i) => (
                <ParagraphCard
                  key={p.id}
                  paragraph={p}
                  projectId={activeProjectId}
                  index={i}
                />
              ))}
              <div className="pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-9 text-xs gap-1.5 border-dashed"
                  onClick={onOpenWrite}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Draft another paragraph
                </Button>
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function EmptyWorkspace() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-primary/15 to-teal-500/15 flex items-center justify-center mb-4 ring-academic">
        <FlaskConical className="h-8 w-8 text-primary" />
      </div>
      <h2 className="text-xl font-semibold font-serif-text">
        Scientific Literature Writing Assistant
      </h2>
      <p className="text-sm text-muted-foreground mt-2 max-w-md leading-relaxed">
        Query RCSB, UniProt, PubMed, NCBI and BLAST. Let AI draft
        citation-backed scholarly paragraphs, annotate and revise them, then
        compose deeper research articles.
      </p>
      <div className="mt-6 grid grid-cols-3 gap-2 max-w-lg text-[11px]">
        {[
          ["1", "Create a project", "Define your research topic & field"],
          ["2", "Query databases", "Fetch papers, structures, sequences, genes"],
          ["3", "Draft & revise", "AI writes; you annotate; AI revises"],
        ].map(([n, t, d]) => (
          <div key={n} className="rounded-lg border border-border/60 p-2.5 text-left">
            <div className="flex items-center gap-1 mb-1">
              <span className="h-4 w-4 rounded-full bg-primary/15 text-primary text-[9px] font-bold flex items-center justify-center">
                {n}
              </span>
              <span className="font-semibold text-[11px]">{t}</span>
            </div>
            <p className="text-[10px] text-muted-foreground leading-snug">{d}</p>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground mt-6">
        Create a project from the left panel to begin.
      </p>
    </div>
  );
}

function Footer() {
  return (
    <footer className="shrink-0 px-4 py-1.5 border-t border-border/60 bg-card/60 backdrop-blur flex items-center justify-between text-[10px] text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          AI-powered · citation-grade
        </span>
        <span className="hidden sm:inline">·</span>
        <span className="hidden sm:inline">
          Inline citations <code className="font-mono text-[9px]">[n]</code> / <code className="font-mono text-[9px]">[SOURCE:ID]</code>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden md:inline">RCSB · UniProt · PubMed · NCBI · BLAST</span>
        <span>·</span>
        <span>SciWrite</span>
      </div>
    </footer>
  );
}
