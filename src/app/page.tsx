"use client";

import * as React from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
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
  Radar,
  BarChart3,
  Sun,
  Moon,
  ListTree,
  DatabaseZap,
  Zap,
  Gavel,
  Network,
  Cpu,
  CheckCircle2,
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
import { LanguageToggle } from "@/components/sciwrite/language-toggle";
import { LLMConfigDialog } from "@/components/sciwrite/llm-config-dialog";
import { ProjectsSidebar } from "@/components/sciwrite/projects-sidebar";
import { DatabaseQueryPanel } from "@/components/sciwrite/database-query-panel";
import { KnowledgePanel } from "@/components/sciwrite/knowledge-panel";
import { ParagraphCard } from "@/components/sciwrite/paragraph-card";
import { SortableParagraphs } from "@/components/sciwrite/sortable-paragraphs";
import { TopicComposer } from "@/components/sciwrite/topic-composer";
import { ArticleComposer } from "@/components/sciwrite/article-composer";
import { ArticleViewerWithTabs } from "@/components/sciwrite/article-viewer-tabs";
import { DataGatheringDialog } from "@/components/sciwrite/data-gathering-dialog";
import { ExportMenu } from "@/components/sciwrite/export-menu";
import { MarkdownCitations } from "@/components/sciwrite/markdown-citations";
import { InsightsDialog } from "@/components/sciwrite/insights-dialog";
import { CommandPalette } from "@/components/sciwrite/command-palette";
import { OutlineDialog } from "@/components/sciwrite/outline-dialog";
import { UserDataDialog } from "@/components/sciwrite/user-data-dialog";
import { OneClickGenerateDialog } from "@/components/sciwrite/one-click-generate-dialog";
import { ProgressTracker } from "@/components/sciwrite/progress-tracker";
import { WritingTipsPanel } from "@/components/sciwrite/writing-tips-panel";
import { useI18n } from "@/lib/i18n";
import type { Article, Project } from "@/lib/types";

export default function Home() {
  const qc = useQueryClient();
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(null);
  const [writeOpen, setWriteOpen] = React.useState(false);
  const [composeOpen, setComposeOpen] = React.useState(false);
  const [tipsOpen, setTipsOpen] = React.useState(false);
  const [viewArticle, setViewArticle] = React.useState<Article | null>(null);
  const [gatherOpen, setGatherOpen] = React.useState(false);
  const [insightsOpen, setInsightsOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [outlineOpen, setOutlineOpen] = React.useState(false);
  const [userDataOpen, setUserDataOpen] = React.useState(false);
  const [oneClickOpen, setOneClickOpen] = React.useState(false);
  const [llmConfigOpen, setLlmConfigOpen] = React.useState(false);

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
      const key = `${r.type}:${r.externalId || r.title}`;
      if (!map.has(key)) map.set(key, r);
    }
    for (const p of paragraphs) {
      for (const r of p.references || []) {
        const key = `${r.type}:${r.externalId || r.title}`;
        if (!map.has(key)) map.set(key, r);
      }
    }
    return [...map.values()];
  }, [paragraphs, project?.references]);

  // Derived progress stats
  const progressStats = React.useMemo(() => {
    const totalWords = paragraphs.reduce(
      (sum, p) => sum + (p.wordCount || 0),
      0
    );
    const totalCitations = paragraphs.reduce((sum, p) => {
      const matches = p.content?.match(
        /\[(\d{1,3}(?:[,\-–\s]\d{1,3})*|[A-Z]{2,12}:\s?[^\]\n]{1,60})\]/g
      );
      return sum + (matches?.length || 0);
    }, 0);
    const paragraphsCited = paragraphs.filter(
      (p) => /\[\d{1,3}/.test(p.content || "") || /\[[A-Z]{2,12}:/i.test(p.content || "")
    ).length;
    const citationCoverage =
      paragraphs.length > 0
        ? Math.round((paragraphsCited / paragraphs.length) * 100)
        : 0;
    const unresolved = paragraphs.reduce(
      (s, p) => s + (p.annotations?.filter((a: any) => !a.resolved).length || 0),
      0
    );
    const resolved = paragraphs.reduce(
      (s, p) => s + (p.annotations?.filter((a: any) => a.resolved).length || 0),
      0
    );
    return {
      totalWords,
      totalParagraphs: paragraphs.length,
      totalCitations,
      citationCoverage,
      unresolvedAnnotations: unresolved,
      resolvedAnnotations: resolved,
    };
  }, [paragraphs]);

  const [wordGoal, setWordGoal] = React.useState(1000);

  // Keyboard shortcuts (defined after paragraphs so it can reference it)
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const tag = (e.target as HTMLElement)?.tagName;
      const isTyping =
        tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;
      // Cmd/Ctrl+K always opens palette
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // Single-key shortcuts only when not typing and no modifier (except Shift)
      if (isTyping || meta || e.altKey) return;
      if (!activeProjectId) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        setWriteOpen(true);
      } else if (k === "g") {
        e.preventDefault();
        setGatherOpen(true);
      } else if (k === "i") {
        e.preventDefault();
        setInsightsOpen(true);
      } else if (k === "o") {
        e.preventDefault();
        setOutlineOpen(true);
      } else if (k === "c" && paragraphs.length >= 2) {
        e.preventDefault();
        setComposeOpen(true);
      } else if (k === "d") {
        e.preventDefault();
        const isDark = document.documentElement.classList.contains("dark");
        document.documentElement.classList.toggle("dark", !isDark);
        try {
          localStorage.setItem("theme", isDark ? "light" : "dark");
        } catch {}
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeProjectId, paragraphs.length]);

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <Header
        project={project}
        onOpenWrite={() => setWriteOpen(true)}
        onOpenCompose={() => setComposeOpen(true)}
        onOpenGather={() => setGatherOpen(true)}
        onOpenInsights={() => setInsightsOpen(true)}
        onOpenOutline={() => setOutlineOpen(true)}
        onOpenOneClick={() => setOneClickOpen(true)}
        onOpenLLMConfig={() => setLlmConfigOpen(true)}
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
              articles={articles}
              activeProjectId={activeProjectId}
              onOpenWrite={() => setWriteOpen(true)}
              onOpenCompose={() => setComposeOpen(true)}
              onOpenGather={() => setGatherOpen(true)}
              onOpenOutline={() => setOutlineOpen(true)}
              progressStats={progressStats}
              wordGoal={wordGoal}
              onWordGoalChange={setWordGoal}
              tipsOpen={tipsOpen}
              onTipsOpenChange={setTipsOpen}
              onOpenUserData={() => setUserDataOpen(true)}
              onOpenArticle={(a) => setViewArticle(a as Article)}
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

      <Footer onOpenPalette={() => setPaletteOpen(true)} />

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
        <ArticleViewerWithTabs
          article={viewArticle}
          projectId={activeProjectId!}
          onClose={() => setViewArticle(null)}
        />
      )}
      {activeProjectId && project && (
        <DataGatheringDialog
          open={gatherOpen}
          onOpenChange={setGatherOpen}
          projectId={activeProjectId}
          topic={project.topic}
          field={project.field}
          onProceedToWrite={() => setWriteOpen(true)}
        />
      )}
      {activeProjectId && (
        <InsightsDialog
          open={insightsOpen}
          onOpenChange={setInsightsOpen}
          projectId={activeProjectId}
        />
      )}
      {activeProjectId && project && (
        <OutlineDialog
          open={outlineOpen}
          onOpenChange={setOutlineOpen}
          projectId={activeProjectId}
          topic={project.topic}
          onUseParagraph={() => {
            setOutlineOpen(false);
            setWriteOpen(true);
          }}
        />
      )}
      {activeProjectId && (
        <UserDataDialog
          open={userDataOpen}
          onOpenChange={setUserDataOpen}
          projectId={activeProjectId}
        />
      )}
      {activeProjectId && project && (
        <OneClickGenerateDialog
          open={oneClickOpen}
          onOpenChange={setOneClickOpen}
          projectId={activeProjectId}
          topic={project.topic}
        />
      )}
      <LLMConfigDialog
        open={llmConfigOpen}
        onOpenChange={setLlmConfigOpen}
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        actions={[
          {
            id: "write",
            label: "AI Write paragraph",
            hint: "Draft a citation-backed paragraph",
            icon: <Sparkles className="h-3.5 w-3.5" />,
            shortcut: "N",
            onSelect: () => setWriteOpen(true),
            group: "Writing",
            disabled: !activeProjectId,
          },
          {
            id: "gather",
            label: "Gather sources (AI)",
            hint: "Clarify → organize → adversarial critique",
            icon: <Radar className="h-3.5 w-3.5" />,
            shortcut: "G",
            onSelect: () => setGatherOpen(true),
            group: "Writing",
            disabled: !activeProjectId,
          },
          {
            id: "compose",
            label: "Compose article",
            hint: "Stitch paragraphs into a deeper article",
            icon: <Layers className="h-3.5 w-3.5" />,
            shortcut: "C",
            onSelect: () => setComposeOpen(true),
            group: "Writing",
            disabled: paragraphs.length < 2,
          },
          {
            id: "insights",
            label: "Project insights",
            hint: "Word count, citation coverage, distributions",
            icon: <BarChart3 className="h-3.5 w-3.5" />,
            shortcut: "I",
            onSelect: () => setInsightsOpen(true),
            group: "Project",
            disabled: !activeProjectId,
          },
          {
            id: "outline",
            label: "Generate research outline",
            hint: "AI-suggested paragraph plan with queries",
            icon: <ListTree className="h-3.5 w-3.5" />,
            shortcut: "O",
            onSelect: () => setOutlineOpen(true),
            group: "Writing",
            disabled: !activeProjectId,
          },
          {
            id: "dark",
            label: "Toggle dark mode",
            icon: <Moon className="h-3.5 w-3.5" />,
            shortcut: "D",
            onSelect: () => {
              const isDark = document.documentElement.classList.contains("dark");
              document.documentElement.classList.toggle("dark", !isDark);
              try {
                localStorage.setItem("theme", isDark ? "light" : "dark");
              } catch {}
            },
            group: "Project",
          },
        ]}
      />
    </div>
  );
}

function Header({
  project,
  onOpenWrite,
  onOpenCompose,
  onOpenGather,
  onOpenInsights,
  onOpenOutline,
  onOpenOneClick,
  onOpenLLMConfig,
  paragraphCount,
  articleCount,
}: {
  project?: any;
  onOpenWrite: () => void;
  onOpenCompose: () => void;
  onOpenGather: () => void;
  onOpenInsights: () => void;
  onOpenOutline: () => void;
  onOpenOneClick: () => void;
  onOpenLLMConfig: () => void;
  paragraphCount: number;
  articleCount: number;
}) {
  const { t } = useI18n();
  return (
    <header className="shrink-0 px-4 py-2.5 border-b border-border/60 bg-card/80 backdrop-blur flex items-center gap-3">
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-teal-600 flex items-center justify-center shadow-sm">
          <FlaskConical className="h-4.5 w-4.5 text-primary-foreground" />
        </div>
        <div className="leading-none">
          <h1 className="text-sm font-bold tracking-tight">
            {t("app.title")}
            <span className="text-primary">·</span>
            <span className="text-muted-foreground font-normal"> {t("app.subtitle")}</span>
          </h1>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {t("app.tagline")}
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
          <span className="text-xs text-muted-foreground">{t("app.noProject")}</span>
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
              variant="ghost"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={onOpenInsights}
              title="Project insights & analytics"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">{t("app.insights")}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={onOpenOutline}
              title="Generate AI research outline"
            >
              <ListTree className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">{t("app.outline")}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={onOpenGather}
              title="AI gathers & organizes sources with adversarial check"
            >
              <Radar className="h-3.5 w-3.5" />
              <span className="hidden md:inline">{t("app.gather")}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={onOpenCompose}
              disabled={paragraphCount < 2}
              title={paragraphCount < 2 ? "Need ≥2 paragraphs" : "Compose article"}
            >
              <Layers className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("app.compose")}</span>
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={onOpenWrite}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("app.aiWrite")}</span>
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full"
          onClick={() => onOpenLLMConfig()}
          title="LLM Configuration"
        >
          <Cpu className="h-4 w-4" />
        </Button>
        <LanguageToggle />
        <ThemeToggle />
      </div>
    </header>
  );
}

function WritingWorkspace({
  project,
  paragraphs,
  articles,
  activeProjectId,
  onOpenWrite,
  onOpenCompose,
  onOpenGather,
  onOpenOutline,
  progressStats,
  wordGoal,
  onWordGoalChange,
  tipsOpen,
  onTipsOpenChange,
  onOpenUserData,
  onOpenArticle,
}: {
  project?: any;
  paragraphs: any[];
  articles: any[];
  activeProjectId: string | null;
  onOpenWrite: () => void;
  onOpenCompose: () => void;
  onOpenGather: () => void;
  onOpenOutline: () => void;
  progressStats: {
    totalWords: number;
    totalParagraphs: number;
    totalCitations: number;
    citationCoverage: number;
    unresolvedAnnotations: number;
    resolvedAnnotations: number;
  };
  wordGoal: number;
  onWordGoalChange: (g: number) => void;
  tipsOpen: boolean;
  onTipsOpenChange: (v: boolean) => void;
  onOpenUserData: () => void;
  onOpenArticle: (a: any) => void;
}) {
  const [workspaceTab, setWorkspaceTab] = React.useState("paragraphs");

  if (!activeProjectId || !project) {
    return <EmptyWorkspace />;
  }
  const lastParagraph = paragraphs[paragraphs.length - 1];
  const tipsFormat = lastParagraph?.format;
  const tipsScenario = lastParagraph?.scenario;
  const latestArticle = articles[0];

  return (
    <div className="flex flex-col h-full relative">
      <div className="px-5 py-3 border-b border-border/60 bg-gradient-to-r from-primary/[0.04] to-transparent shrink-0">
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
            <Button variant="ghost" size="sm" className="h-8 text-xs gap-1.5" onClick={onOpenUserData} title="Upload experiment data">
              <DatabaseZap className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">Data</span>
            </Button>
            <Button variant="ghost" size="sm" className={`h-8 text-xs gap-1.5 ${tipsOpen ? "bg-amber-100/60 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400" : ""}`} onClick={() => onTipsOpenChange(!tipsOpen)} title="Writing tips">
              <Lightbulb className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">Tips</span>
            </Button>
          </div>
        </div>
      </div>

      <ProgressTracker
        totalWords={progressStats.totalWords}
        totalParagraphs={progressStats.totalParagraphs}
        totalCitations={progressStats.totalCitations}
        citationCoverage={progressStats.citationCoverage}
        unresolvedAnnotations={progressStats.unresolvedAnnotations}
        resolvedAnnotations={progressStats.resolvedAnnotations}
        wordGoal={wordGoal}
        onWordGoalChange={onWordGoalChange}
      />

      {/* Workspace tabs */}
      <div className="flex items-center gap-1 px-5 py-1.5 border-b border-border/60 shrink-0 bg-muted/20 overflow-x-auto">
        <button onClick={() => setWorkspaceTab("paragraphs")} className={`text-[11px] px-3 py-1 rounded-md font-medium transition-colors whitespace-nowrap ${workspaceTab === "paragraphs" ? "bg-card shadow-sm text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/40"}`}>
          <PenLine className="h-3 w-3 inline mr-1" />Paragraphs ({paragraphs.length})
        </button>
        <button onClick={() => setWorkspaceTab("article")} className={`text-[11px] px-3 py-1 rounded-md font-medium transition-colors whitespace-nowrap ${workspaceTab === "article" ? "bg-card shadow-sm text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/40"}`}>
          <Layers className="h-3 w-3 inline mr-1" />Article {latestArticle ? `(${articles.length})` : ""}
        </button>
        <button onClick={() => setWorkspaceTab("review")} className={`text-[11px] px-3 py-1 rounded-md font-medium transition-colors whitespace-nowrap ${workspaceTab === "review" ? "bg-card shadow-sm text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/40"}`}>
          <Gavel className="h-3 w-3 inline mr-1" />Review
        </button>
        <button onClick={() => setWorkspaceTab("relationships")} className={`text-[11px] px-3 py-1 rounded-md font-medium transition-colors whitespace-nowrap ${workspaceTab === "relationships" ? "bg-card shadow-sm text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/40"}`}>
          <Network className="h-3 w-3 inline mr-1" />Relationships
        </button>
        {latestArticle && (
          <div className="ml-auto shrink-0">
            <ExportMenu type="article" id={latestArticle.id} variant="outline" />
          </div>
        )}
      </div>

      {/* Paragraphs tab */}
      {workspaceTab === "paragraphs" && (
        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-5 py-4 max-w-3xl mx-auto space-y-3">
            {paragraphs.length === 0 ? (
              <div className="text-center py-16">
                <div className="h-14 w-14 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center mb-3">
                  <Lightbulb className="h-7 w-7 text-primary" />
                </div>
                <h3 className="text-sm font-semibold">Start writing</h3>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                  Use "AI Write" to draft your first citation-backed paragraph.
                </p>
                <Button size="sm" className="mt-4 gap-1.5" onClick={onOpenWrite}>
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
                  <span className="text-[9px] text-muted-foreground/70 normal-case tracking-normal ml-2">drag ⠿ to reorder</span>
                </div>
                <SortableParagraphs paragraphs={paragraphs} projectId={activeProjectId} />
                <div className="pt-2">
                  <Button variant="outline" size="sm" className="w-full h-9 text-xs gap-1.5 border-dashed" onClick={onOpenWrite}>
                    <Sparkles className="h-3.5 w-3.5" />
                    Draft another paragraph
                  </Button>
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      )}

      {/* Article tab */}
      {workspaceTab === "article" && (
        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-5 py-4 max-w-3xl mx-auto">
            {latestArticle ? (
              <div>
                <h3 className="text-sm font-semibold mb-3 font-serif-text">{latestArticle.title}</h3>
                <MarkdownCitations content={latestArticle.content} className="text-[13.5px]" />
              </div>
            ) : (
              <div className="text-center py-16">
                <Layers className="h-10 w-10 mx-auto opacity-40 mb-3" />
                <h3 className="text-sm font-semibold">No composed article yet</h3>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto mb-4">
                  Use "Compose" or "Generate" to create a full article.
                </p>
                <Button size="sm" className="gap-1.5" onClick={onOpenCompose} disabled={paragraphs.length < 2}>
                  <Layers className="h-3.5 w-3.5" />
                  Compose article
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>
      )}

      {/* Review tab */}
      {workspaceTab === "review" && (
        <EmbeddedReviewWorkspace articleId={latestArticle?.id} articleTitle={latestArticle?.title} projectId={activeProjectId} />
      )}

      {/* Relationships tab */}
      {workspaceTab === "relationships" && (
        <RelationshipWorkspace projectId={activeProjectId} />
      )}

      <WritingTipsPanel format={tipsFormat} scenario={tipsScenario} open={tipsOpen} onOpenChange={onTipsOpenChange} />
    </div>
  );
}


function EmbeddedReviewWorkspace({ articleId, articleTitle, projectId }: { articleId?: string; articleTitle?: string; projectId: string }) {
  const [reviewData, setReviewData] = React.useState<any>(null);
  const reviewMut = useMutation({
    mutationFn: () => articleId ? api.aiReview({ mode: "review", articleId }) : Promise.reject(new Error("No article")),
    onSuccess: (data) => { setReviewData(data); toast.success("Review completed."); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <ScrollArea className="flex-1 min-h-0 scroll-academic">
      <div className="px-5 py-4 max-w-2xl mx-auto">
        {!reviewData && !reviewMut.isPending && (
          <div className="text-center py-12">
            <div className="h-14 w-14 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center mb-3">
              <Gavel className="h-7 w-7 text-primary" />
            </div>
            <h3 className="text-sm font-semibold">AI Peer Review</h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto mb-4">
              Run a structured peer review with multi-dimensional scoring.
            </p>
            <Button size="sm" className="gap-1.5 text-xs" onClick={() => reviewMut.mutate()} disabled={!articleId}>
              <Gavel className="h-3.5 w-3.5" /> Run review
            </Button>
          </div>
        )}
        {reviewMut.isPending && (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        )}
        {reviewData && (
          <div className="space-y-3">
            {reviewData.verdict && (
              <div className={`rounded-lg border p-3 ${reviewData.verdict === "accept" ? "border-emerald-200/60 bg-emerald-50/50" : "border-amber-200/60 bg-amber-50/50"}`}>
                <span className={`text-sm font-semibold ${reviewData.verdict === "accept" ? "text-emerald-700" : "text-amber-700"}`}>
                  {reviewData.verdict === "accept" ? "✓ Accept" : `⚠ ${reviewData.verdict}`}
                </span>
              </div>
            )}
            {reviewData.scores && (
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(reviewData.scores).map(([key, val]: [string, any]) => (
                  <div key={key} className="rounded-md border border-border/50 p-2 text-center">
                    <p className="text-sm font-bold">{val}/10</p>
                    <p className="text-[9px] uppercase text-muted-foreground">{key}</p>
                  </div>
                ))}
              </div>
            )}
            {reviewData.review?.summary && (
              <div className="rounded-md border border-border/50 p-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">Summary</p>
                <p className="text-xs leading-relaxed">{reviewData.review.summary}</p>
              </div>
            )}
            {reviewData.review && (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-emerald-200/50 bg-emerald-50/30 p-2">
                  <p className="text-[10px] uppercase font-semibold text-emerald-700 mb-1">Strengths</p>
                  {safeParseArr(reviewData.review.strengths).map((s: string, i: number) => <p key={i} className="text-[10px] mb-1">• {s}</p>)}
                </div>
                <div className="rounded-md border border-rose-200/50 bg-rose-50/30 p-2">
                  <p className="text-[10px] uppercase font-semibold text-rose-700 mb-1">Weaknesses</p>
                  {safeParseArr(reviewData.review.weaknesses).map((w: string, i: number) => <p key={i} className="text-[10px] mb-1">• {w}</p>)}
                </div>
              </div>
            )}
            <Button size="sm" variant="outline" className="gap-1.5 text-xs w-full" onClick={() => reviewMut.mutate()} disabled={reviewMut.isPending}>
              {reviewMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Re-run review
            </Button>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function RelationshipWorkspace({ projectId }: { projectId: string }) {
  const [relData, setRelData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);

  const analyze = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/ai/source-relationships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      setRelData(data);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  return (
    <ScrollArea className="flex-1 min-h-0 scroll-academic">
      <div className="px-5 py-4 max-w-2xl mx-auto">
        {!relData && !loading && (
          <div className="text-center py-12">
            <div className="h-14 w-14 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center mb-3">
              <Network className="h-7 w-7 text-primary" />
            </div>
            <h3 className="text-sm font-semibold">Source Relationship Analysis</h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto mb-4">
              Analyze how your data sources relate — themes, connections, contradictions.
            </p>
            <Button size="sm" className="gap-1.5 text-xs" onClick={analyze}>
              <Network className="h-3.5 w-3.5" /> Analyze relationships
            </Button>
          </div>
        )}
        {loading && (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        )}
        {relData && !loading && (
          <div className="space-y-3">
            {relData.summary && (
              <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
                <p className="text-[10px] uppercase tracking-wider text-primary font-semibold mb-1">Summary</p>
                <p className="text-xs leading-relaxed">{relData.summary}</p>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border border-border/50 p-2 text-center">
                <p className="text-lg font-bold">{relData.nodes?.length || 0}</p>
                <p className="text-[9px] uppercase text-muted-foreground">Sources</p>
              </div>
              <div className="rounded-md border border-border/50 p-2 text-center">
                <p className="text-lg font-bold">{relData.edges?.length || 0}</p>
                <p className="text-[9px] uppercase text-muted-foreground">Connections</p>
              </div>
              <div className="rounded-md border border-border/50 p-2 text-center">
                <p className="text-lg font-bold">{relData.themes?.length || 0}</p>
                <p className="text-[9px] uppercase text-muted-foreground">Themes</p>
              </div>
            </div>
            {relData.themes?.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Thematic Clusters</p>
                {relData.themes.map((t: any, i: number) => (
                  <div key={i} className="rounded-md border border-border/50 p-2.5">
                    <span className="text-xs font-semibold">{t.name}</span>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{t.description}</p>
                  </div>
                ))}
              </div>
            )}
            {relData.keyInsights?.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-wider text-primary font-semibold">Key Insights</p>
                {relData.keyInsights.map((insight: string, i: number) => (
                  <div key={i} className="flex items-start gap-1.5 text-[11px]">
                    <CheckCircle2 className="h-3 w-3 text-primary mt-0.5 shrink-0" />
                    <span>{insight}</span>
                  </div>
                ))}
              </div>
            )}
            <Button size="sm" variant="outline" className="gap-1.5 text-xs w-full" onClick={analyze}>
              <Network className="h-3.5 w-3.5" /> Re-analyze
            </Button>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function safeParseArr(raw: string): any[] {
  if (!raw) return [];
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
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

function Footer({ onOpenPalette }: { onOpenPalette?: () => void }) {
  const { t } = useI18n();
  return (
    <footer className="shrink-0 px-4 py-1.5 border-t border-border/60 bg-card/60 backdrop-blur flex items-center justify-between text-[10px] text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {t("footer.aiPowered")}
        </span>
        <span className="hidden sm:inline">·</span>
        <span className="hidden sm:inline">
          {t("footer.citations")} <code className="font-mono text-[9px]">[n]</code> / <code className="font-mono text-[9px]">[SOURCE:ID]</code>
        </span>
      </div>
      <div className="flex items-center gap-2">
        {onOpenPalette && (
          <button
            onClick={onOpenPalette}
            className="hidden md:inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/60 hover:bg-muted/60 transition-colors"
            title="Open command palette"
          >
            <kbd className="font-mono text-[9px] font-semibold">⌘K</kbd>
            <span className="text-muted-foreground">{t("footer.commands")}</span>
          </button>
        )}
        <span className="hidden md:inline">RCSB · UniProt · PubMed · NCBI · BLAST</span>
        <span>·</span>
        <span>{t("app.title")}</span>
      </div>
    </footer>
  );
}
