"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Sparkles,
  Layers,
  PenLine,
  Loader2,
  Radar,
  BarChart3,
  Moon,
  ListTree,
  FolderOpen,
  Database,
} from "lucide-react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { api } from "@/lib/api-client";
import { LLMConfigDialog } from "@/components/sciwrite/llm-config-dialog";
import { ProjectsSidebar } from "@/components/sciwrite/projects-sidebar";
import { DatabaseQueryPanel } from "@/components/sciwrite/database-query-panel";
import { KnowledgePanel } from "@/components/sciwrite/knowledge-panel";
import { useIsMobile } from "@/hooks/use-mobile";
import { CommandPalette } from "@/components/sciwrite/command-palette";
import { LLMCacheStatsPanel } from "@/components/sciwrite/llm-config-dialog";
import { Header } from "@/components/sciwrite/home/header";
import { WritingWorkspace } from "@/components/sciwrite/home/writing-workspace";
import { Footer } from "@/components/sciwrite/home/footer";
import { computeProgressStats } from "@/components/sciwrite/home/shared";
import { useHomeKeyboardShortcuts } from "@/components/sciwrite/home/use-keyboard-shortcuts";
// Lazy-loaded heavy dialog components — these are only needed when the user
// opens them, so we split them into separate chunks to reduce the initial
// bundle size. Each shows a loading spinner while its chunk loads.
const ArticleViewerWithTabs = React.lazy(() =>
  import("@/components/sciwrite/article-viewer-tabs").then(m => ({ default: m.ArticleViewerWithTabs }))
);
const InsightsDialog = React.lazy(() =>
  import("@/components/sciwrite/insights-dialog").then(m => ({ default: m.InsightsDialog }))
);
const UserDataDialog = React.lazy(() =>
  import("@/components/sciwrite/user-data-dialog").then(m => ({ default: m.UserDataDialog }))
);
const UnifiedWritingDialog = React.lazy(() =>
  import("@/components/sciwrite/unified-writing-dialog").then(m => ({ default: m.UnifiedWritingDialog }))
);
import { useI18n } from "@/lib/i18n";
import type { Article } from "@/lib/types";

export default function Home() {
  const { t } = useI18n();
  const { resolvedTheme, setTheme } = useTheme();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  // Mobile layout active panel — on screens < 768px the 3-panel ResizablePanelGroup
  // is replaced with a tab bar so each panel gets full width. Values:
  // "projects" | "workspace" | "data".
  const [mobilePanel, setMobilePanel] = React.useState<"projects" | "workspace" | "data">("workspace");
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(null);
  const [tipsOpen, setTipsOpen] = React.useState(false);
  const [viewArticle, setViewArticle] = React.useState<Article | null>(null);
  const [insightsOpen, setInsightsOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [userDataOpen, setUserDataOpen] = React.useState(false);
  const [llmConfigOpen, setLlmConfigOpen] = React.useState(false);
  const [unifiedWriteOpen, setUnifiedWriteOpen] = React.useState(false);
  const [unifiedWriteTab, setUnifiedWriteTab] = React.useState<"outline" | "gather" | "paragraph" | "compose" | "full">("outline");

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
  const progressStats = React.useMemo(() => computeProgressStats(paragraphs), [paragraphs]);

  const [wordGoal, setWordGoal] = React.useState(1000);

  // Keyboard shortcuts (defined after paragraphs so it can reference it)
  useHomeKeyboardShortcuts({
    activeProjectId,
    paragraphs,
    setPaletteOpen,
    setInsightsOpen,
    setUnifiedWriteTab,
    setUnifiedWriteOpen,
  });

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <Header
        project={project}
        onOpenWrite={() => { setUnifiedWriteTab("paragraph"); setUnifiedWriteOpen(true); }}
        onOpenCompose={() => { setUnifiedWriteTab("compose"); setUnifiedWriteOpen(true); }}
        onOpenGather={() => { setUnifiedWriteTab("gather"); setUnifiedWriteOpen(true); }}
        onOpenInsights={() => setInsightsOpen(true)}
        onOpenOutline={() => { setUnifiedWriteTab("outline"); setUnifiedWriteOpen(true); }}
        onOpenOneClick={() => { setUnifiedWriteTab("full"); setUnifiedWriteOpen(true); }}
        onOpenLLMConfig={() => setLlmConfigOpen(true)}
        paragraphCount={paragraphs.length}
        articleCount={articles.length}
      />

      <main className="flex-1 min-h-0 px-3 pb-2">
        {/* Defer layout rendering until useIsMobile resolves (it returns
            undefined on first render). This prevents the ResizablePanelGroup
            from mounting → unmounting → remounting when isMobile flips from
            undefined → true/false, which triggers the
            "Previous layout not found for panel index 1" warning from
            react-resizable-panels (its internal layout state is destroyed
            when the component is conditionally re-created). */}
        {isMobile === undefined ? (
          <div className="rounded-xl border border-border/60 bg-card overflow-hidden h-full flex items-center justify-center shadow-md">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : isMobile ? (
          <div className="flex flex-col h-full rounded-xl border border-border/60 bg-card overflow-hidden shadow-md">
            {/* Active panel content — full width */}
            <div className="flex-1 min-h-0 overflow-hidden">
              {mobilePanel === "projects" && (
                <ProjectsSidebar
                  projects={projects}
                  activeId={activeProjectId}
                  onSelect={(id) => {
                    setActiveProjectId(id);
                    setMobilePanel("workspace");
                  }}
                  articles={articles}
                  onOpenArticle={(a) => setViewArticle(a as Article)}
                />
              )}
              {mobilePanel === "workspace" && (
                <WritingWorkspace
                  project={project}
                  paragraphs={paragraphs}
                  articles={articles}
                  references={references}
                  activeProjectId={activeProjectId}
                  onOpenWrite={() => { setUnifiedWriteTab("paragraph"); setUnifiedWriteOpen(true); }}
                  onOpenCompose={() => { setUnifiedWriteTab("compose"); setUnifiedWriteOpen(true); }}
                  onOpenGather={() => { setUnifiedWriteTab("gather"); setUnifiedWriteOpen(true); }}
                  onOpenOutline={() => { setUnifiedWriteTab("outline"); setUnifiedWriteOpen(true); }}
                  progressStats={progressStats}
                  wordGoal={wordGoal}
                  onWordGoalChange={setWordGoal}
                  tipsOpen={tipsOpen}
                  onTipsOpenChange={setTipsOpen}
                  onOpenUserData={() => setUserDataOpen(true)}
                  onOpenArticle={(a) => setViewArticle(a as Article)}
                />
              )}
              {mobilePanel === "data" && (
                <div className="flex flex-col h-full overflow-hidden">
                  <div className="h-[44%] min-h-0 border-b border-border/60 overflow-hidden">
                    <DatabaseQueryPanel projectId={activeProjectId} />
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <KnowledgePanel
                      projectId={activeProjectId}
                      dataSources={dataSources}
                      references={references}
                    />
                  </div>
                  <div className="shrink-0 border-t border-border/60 p-2">
                    <LLMCacheStatsPanel />
                  </div>
                </div>
              )}
            </div>
            {/* Bottom tab bar — fixed-height, touch-friendly 44px targets */}
            <div className="shrink-0 flex border-t border-border/60 bg-sidebar/40">
              {([
                { id: "projects", label: "Projects", icon: FolderOpen },
                { id: "workspace", label: "Write", icon: PenLine },
                { id: "data", label: "Data", icon: Database },
              ] as const).map((tab) => {
                const Icon = tab.icon;
                const active = mobilePanel === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setMobilePanel(tab.id)}
                    className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors min-h-[44px] ${
                      active
                        ? "text-primary bg-primary/10 border-t-2 border-primary -mt-px"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
        <ResizablePanelGroup
          direction="horizontal"
          key="desktop-panels"
          className="rounded-xl border border-border/60 bg-card overflow-hidden h-full shadow-lg"
        >
          {/* Left: projects */}
          <ResizablePanel defaultSize={22} minSize={18} maxSize={32} className="bg-sidebar/40">
            <ProjectsSidebar
              projects={projects}
              activeId={activeProjectId}
              onSelect={setActiveProjectId}
              articles={articles}
              onOpenArticle={(a) => setViewArticle(a as Article)}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />

          {/* Center: writing workspace */}
          <ResizablePanel defaultSize={52} minSize={35} className="min-w-0">
            <WritingWorkspace
              project={project}
              paragraphs={paragraphs}
              articles={articles}
              references={references}
              activeProjectId={activeProjectId}
              onOpenWrite={() => { setUnifiedWriteTab("paragraph"); setUnifiedWriteOpen(true); }}
              onOpenCompose={() => { setUnifiedWriteTab("compose"); setUnifiedWriteOpen(true); }}
              onOpenGather={() => { setUnifiedWriteTab("gather"); setUnifiedWriteOpen(true); }}
              onOpenOutline={() => { setUnifiedWriteTab("outline"); setUnifiedWriteOpen(true); }}
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
          <ResizablePanel defaultSize={30} minSize={24} maxSize={42} className="bg-sidebar/20">
            <div className="flex flex-col h-full overflow-hidden">
              <div className="h-[44%] min-h-0 border-b border-border/60 overflow-hidden">
                <DatabaseQueryPanel projectId={activeProjectId} />
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <KnowledgePanel
                  projectId={activeProjectId}
                  dataSources={dataSources}
                  references={references}
                />
              </div>
              {/* LLM cache stats — shows hit rate + clear button so the user
                  can monitor cache effectiveness and force fresh calls. */}
              <div className="shrink-0 border-t border-border/60 p-2">
                <LLMCacheStatsPanel />
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
        )}
      </main>

      <Footer onOpenPalette={() => setPaletteOpen(true)} />

      {/* Modals — lazy-loaded heavy dialogs wrapped in Suspense */}
      {activeProjectId && project && (
        <React.Suspense fallback={null}>
        <UnifiedWritingDialog
          open={unifiedWriteOpen}
          onOpenChange={setUnifiedWriteOpen}
          projectId={activeProjectId}
          topic={project.topic}
          field={project.field ?? undefined}
          paragraphCount={paragraphs.length}
          initialTab={unifiedWriteTab}
        />
        </React.Suspense>
      )}
      {viewArticle && (
        <React.Suspense fallback={null}>
        <ArticleViewerWithTabs
          article={viewArticle}
          projectId={activeProjectId!}
          onClose={() => setViewArticle(null)}
        />
        </React.Suspense>
      )}
      {activeProjectId && (
        <React.Suspense fallback={null}>
        <InsightsDialog
          open={insightsOpen}
          onOpenChange={setInsightsOpen}
          projectId={activeProjectId}
        />
        </React.Suspense>
      )}
      {activeProjectId && (
        <React.Suspense fallback={null}>
        <UserDataDialog
          open={userDataOpen}
          onOpenChange={setUserDataOpen}
          projectId={activeProjectId}
        />
        </React.Suspense>
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
            label: t("cmd.writeParagraph"),
            hint: t("cmd.writeHint"),
            icon: <Sparkles className="h-3.5 w-3.5" />,
            shortcut: "N",
            onSelect: () => {
              setUnifiedWriteTab("paragraph");
              setUnifiedWriteOpen(true);
            },
            group: t("cmd.groupWriting"),
            disabled: !activeProjectId,
          },
          {
            id: "gather",
            label: t("cmd.gatherSourcesAction"),
            hint: t("cmd.gatherDesc"),
            icon: <Radar className="h-3.5 w-3.5" />,
            shortcut: "G",
            onSelect: () => {
              setUnifiedWriteTab("gather");
              setUnifiedWriteOpen(true);
            },
            group: t("cmd.groupWriting"),
            disabled: !activeProjectId,
          },
          {
            id: "compose",
            label: t("cmd.composeArticle"),
            hint: t("cmd.composeHint"),
            icon: <Layers className="h-3.5 w-3.5" />,
            shortcut: "C",
            onSelect: () => {
              setUnifiedWriteTab("compose");
              setUnifiedWriteOpen(true);
            },
            group: t("cmd.groupWriting"),
            disabled: paragraphs.length < 2,
          },
          {
            id: "insights",
            label: t("cmd.projectInsights"),
            hint: t("cmd.insightsHint"),
            icon: <BarChart3 className="h-3.5 w-3.5" />,
            shortcut: "I",
            onSelect: () => setInsightsOpen(true),
            group: t("cmd.groupProject"),
            disabled: !activeProjectId,
          },
          {
            id: "outline",
            label: t("cmd.generateOutline"),
            hint: t("cmd.outlineHint"),
            icon: <ListTree className="h-3.5 w-3.5" />,
            shortcut: "O",
            onSelect: () => {
              setUnifiedWriteTab("outline");
              setUnifiedWriteOpen(true);
            },
            group: t("cmd.groupWriting"),
            disabled: !activeProjectId,
          },
          {
            id: "dark",
            label: t("cmd.toggleDark"),
            icon: <Moon className="h-3.5 w-3.5" />,
            shortcut: "D",
            onSelect: () => {
              // Route through next-themes (see the "d" keyboard shortcut above).
              setTheme(resolvedTheme === "dark" ? "light" : "dark");
            },
            group: t("cmd.groupProject"),
          },
        ]}
      />
    </div>
  );
}
