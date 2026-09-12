"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { signOut } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
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
  LogOut,
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
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { LLMCacheStatsPanel } from "@/components/sciwrite/llm-config-dialog";
import { Header } from "@/components/sciwrite/home/header";
import { WritingWorkspace } from "@/components/sciwrite/home/writing-workspace";
import { Footer } from "@/components/sciwrite/home/footer";
import { computeProgressStats } from "@/components/sciwrite/home/shared";
import { useHomeKeyboardShortcuts } from "@/components/sciwrite/home/use-keyboard-shortcuts";
// Lazy-loaded heavy dialog components — split into separate chunks to
// reduce the initial bundle size.
const ArticleViewerWithTabs = React.lazy(() =>
  import("@/components/sciwrite/article-viewer-tabs").then((m) => ({
    default: m.ArticleViewerWithTabs,
  }))
);
const InsightsDialog = React.lazy(() =>
  import("@/components/sciwrite/insights-dialog").then((m) => ({
    default: m.InsightsDialog,
  }))
);
const UserDataDialog = React.lazy(() =>
  import("@/components/sciwrite/user-data-dialog").then((m) => ({
    default: m.UserDataDialog,
  }))
);
const UnifiedWritingDialog = React.lazy(() =>
  import("@/components/sciwrite/unified-writing-dialog").then((m) => ({
    default: m.UnifiedWritingDialog,
  }))
);
import { useI18n } from "@/lib/i18n";
import type { Article } from "@/lib/types";
import { SessionGate } from "@/components/sciwrite/session-gate";
import { AUTH_ENABLED } from "@/lib/auth-mode";

export default function Page() {
  return (
    <SessionGate>
      <Home />
    </SessionGate>
  );
}

type MobilePanel = "projects" | "workspace" | "data";

function Home() {
  const { t } = useI18n();
  const { resolvedTheme, setTheme } = useTheme();
  const isMobile = useIsMobile();
  const [mobilePanel, setMobilePanel] = React.useState<MobilePanel>("workspace");
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(
    null
  );
  const [tipsOpen, setTipsOpen] = React.useState(false);
  const [viewArticle, setViewArticle] = React.useState<Article | null>(null);
  const [insightsOpen, setInsightsOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [userDataOpen, setUserDataOpen] = React.useState(false);
  const [llmConfigOpen, setLlmConfigOpen] = React.useState(false);
  const [unifiedWriteOpen, setUnifiedWriteOpen] = React.useState(false);
  const [unifiedWriteTab, setUnifiedWriteTab] = React.useState<
    "outline" | "gather" | "paragraph" | "compose" | "full"
  >("outline");

  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });

  const projectQ = useQuery({
    queryKey: ["project", activeProjectId],
    queryFn: () => api.getProject(activeProjectId!),
    enabled: !!activeProjectId,
  });

  React.useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail as string;
      setActiveProjectId(id);
    };
    window.addEventListener("sciwrite:select-project", handler);
    return () => window.removeEventListener("sciwrite:select-project", handler);
  }, []);

  React.useEffect(() => {
    if (!activeProjectId && projectsQ.data?.projects.length) {
      setActiveProjectId(projectsQ.data.projects[0].id);
    }
  }, [projectsQ.data, activeProjectId]);

  const projects = projectsQ.data?.projects ?? [];
  const project = projectQ.data?.project;
  // Memoize derived arrays so they don't create fresh references every render
  // (which would bust downstream useMemo/useCallback deps and cause cascade
  // re-renders of ProjectsSidebar, WritingWorkspace, etc.).
  const paragraphs = React.useMemo(
    () => (project?.paragraphs ?? []) as any[],
    [project?.paragraphs]
  );
  const dataSources = React.useMemo(
    () => project?.dataSources ?? [],
    [project?.dataSources]
  );
  const articles = React.useMemo(
    () => (project?.articles ?? []) as any[],
    [project?.articles]
  );
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

  const progressStats = React.useMemo(
    () => computeProgressStats(paragraphs),
    [paragraphs]
  );

  const [wordGoal, setWordGoal] = React.useState(1000);
  const goalKey = activeProjectId
    ? `sciwrite:wordGoal:${activeProjectId}`
    : null;
  const lastGoalProjectRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!goalKey || !project || project.id !== activeProjectId) return;
    const projectSwitched = lastGoalProjectRef.current !== activeProjectId;
    lastGoalProjectRef.current = activeProjectId;
    try {
      const stored = window.localStorage.getItem(goalKey);
      const n = Number(stored);
      if (stored && n > 0) {
        setWordGoal(n);
        return;
      }
    } catch {
      /* localStorage unavailable */
    }
    const floor = Math.max(
      1000,
      Math.ceil((progressStats.totalWords || 0) / 1000) * 1000
    );
    if (projectSwitched) {
      setWordGoal(floor);
    } else {
      setWordGoal((prev) => (prev < floor ? floor : prev));
    }
  }, [goalKey, activeProjectId, project, progressStats.totalWords]);

  const handleWordGoalChange = React.useCallback(
    (goal: number) => {
      const g = Math.max(100, Math.round(goal));
      setWordGoal(g);
      if (goalKey) {
        try {
          window.localStorage.setItem(goalKey, String(g));
        } catch {
          /* storage unavailable */
        }
      }
    },
    [goalKey]
  );

  useHomeKeyboardShortcuts({
    activeProjectId,
    paragraphs,
    setPaletteOpen,
    setInsightsOpen,
    setUnifiedWriteTab,
    setUnifiedWriteOpen,
  });

  const openWrite = () => {
    setUnifiedWriteTab("paragraph");
    setUnifiedWriteOpen(true);
  };
  const openCompose = () => {
    setUnifiedWriteTab("compose");
    setUnifiedWriteOpen(true);
  };
  const openGather = () => {
    setUnifiedWriteTab("gather");
    setUnifiedWriteOpen(true);
  };
  const openOutline = () => {
    setUnifiedWriteTab("outline");
    setUnifiedWriteOpen(true);
  };

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <Header
        project={project}
        onOpenWrite={openWrite}
        onOpenCompose={openCompose}
        onOpenGather={openGather}
        onOpenInsights={() => setInsightsOpen(true)}
        onOpenOutline={openOutline}
        onOpenOneClick={() => {
          setUnifiedWriteTab("full");
          setUnifiedWriteOpen(true);
        }}
        onOpenLLMConfig={() => setLlmConfigOpen(true)}
        paragraphCount={paragraphs.length}
        articleCount={articles.length}
      />

      <main className="flex-1 min-h-0 px-3 pb-2">
        {isMobile === undefined ? (
          <div className="shell-frame h-full flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : isMobile ? (
          <div className="shell-frame flex flex-col h-full">
            <div className="flex-1 min-h-0 overflow-hidden relative">
              {/* Render all three panels simultaneously and toggle visibility
                  via CSS — preserves internal state (search results, scroll
                  position, form input) when switching mobile tabs. Previously
                  conditional mounting destroyed all child state on tab switch. */}
              <div className={`absolute inset-0 overflow-hidden ${mobilePanel === "projects" ? "" : "hidden"}`}>
                <ProjectsSidebar
                  projects={projects}
                  activeId={activeProjectId}
                  onSelect={(id) => {
                    setActiveProjectId(id);
                    setMobilePanel("workspace");
                  }}
                  onDeleted={(deletedId) => {
                    if (deletedId === activeProjectId) setActiveProjectId(null);
                  }}
                  articles={articles}
                  onOpenArticle={(a) => setViewArticle(a as Article)}
                />
              </div>
              <div className={`absolute inset-0 overflow-hidden ${mobilePanel === "workspace" ? "" : "hidden"}`}>
                <WritingWorkspace
                  project={project}
                  paragraphs={paragraphs}
                  articles={articles}
                  references={references}
                  activeProjectId={activeProjectId}
                  onOpenWrite={openWrite}
                  onOpenCompose={openCompose}
                  onOpenGather={openGather}
                  onOpenOutline={openOutline}
                  progressStats={progressStats}
                  wordGoal={wordGoal}
                  onWordGoalChange={handleWordGoalChange}
                  tipsOpen={tipsOpen}
                  onTipsOpenChange={setTipsOpen}
                  onOpenUserData={() => setUserDataOpen(true)}
                  onOpenArticle={(a) => setViewArticle(a as Article)}
                />
              </div>
              <div className={`absolute inset-0 overflow-hidden ${mobilePanel === "data" ? "" : "hidden"}`}>
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
              </div>
            </div>
            <div className="shrink-0 flex border-t border-border/60 panel-tint">
              {(
                [
                  { id: "projects", label: "Projects", icon: FolderOpen },
                  { id: "workspace", label: "Write", icon: PenLine },
                  { id: "data", label: "Data", icon: Database },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                const active = mobilePanel === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setMobilePanel(tab.id)}
                    className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 text-[10px] font-medium transition-colors min-h-[44px] ${
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
            className="shell-frame h-full"
          >
            <ResizablePanel
              defaultSize={22}
              minSize={18}
              maxSize={32}
              className="panel-tint"
            >
              <ProjectsSidebar
                projects={projects}
                activeId={activeProjectId}
                onSelect={setActiveProjectId}
                onDeleted={(deletedId) => {
                  if (deletedId === activeProjectId) setActiveProjectId(null);
                }}
                articles={articles}
                onOpenArticle={(a) => setViewArticle(a as Article)}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />

            <ResizablePanel defaultSize={48} minSize={35} className="min-w-0">
              <WritingWorkspace
                project={project}
                paragraphs={paragraphs}
                articles={articles}
                references={references}
                activeProjectId={activeProjectId}
                onOpenWrite={openWrite}
                onOpenCompose={openCompose}
                onOpenGather={openGather}
                onOpenOutline={openOutline}
                progressStats={progressStats}
                wordGoal={wordGoal}
                onWordGoalChange={handleWordGoalChange}
                tipsOpen={tipsOpen}
                onTipsOpenChange={setTipsOpen}
                onOpenUserData={() => setUserDataOpen(true)}
                onOpenArticle={(a) => setViewArticle(a as Article)}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />

            <ResizablePanel
              defaultSize={30}
              minSize={24}
              maxSize={42}
              className="panel-tint"
            >
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
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </main>

      <Footer onOpenPalette={() => setPaletteOpen(true)} />

      {/* Modals */}
      {activeProjectId && project && (
        <ErrorBoundary>
        <React.Suspense fallback={null}>
          <UnifiedWritingDialog
            open={unifiedWriteOpen}
            onOpenChange={setUnifiedWriteOpen}
            projectId={activeProjectId}
            topic={project.topic}
            field={project.field ?? undefined}
            paragraphCount={paragraphs.length}
            sourceCount={dataSources.length}
            articleCount={articles.length}
            initialTab={unifiedWriteTab}
            onGenerationTargetWords={handleWordGoalChange}
          />
        </React.Suspense>
        </ErrorBoundary>
      )}
      {viewArticle && (
        <ErrorBoundary>
        <React.Suspense fallback={null}>
          <ArticleViewerWithTabs
            article={viewArticle}
            projectId={activeProjectId!}
            onClose={() => setViewArticle(null)}
          />
        </React.Suspense>
        </ErrorBoundary>
      )}
      {activeProjectId && (
        <ErrorBoundary>
        <React.Suspense fallback={null}>
          <InsightsDialog
            open={insightsOpen}
            onOpenChange={setInsightsOpen}
            projectId={activeProjectId}
          />
        </React.Suspense>
        </ErrorBoundary>
      )}
      {activeProjectId && (
        <ErrorBoundary>
        <React.Suspense fallback={null}>
          <UserDataDialog
            open={userDataOpen}
            onOpenChange={setUserDataOpen}
            projectId={activeProjectId}
          />
        </React.Suspense>
        </ErrorBoundary>
      )}
      <LLMConfigDialog open={llmConfigOpen} onOpenChange={setLlmConfigOpen} />
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
              setTheme(resolvedTheme === "dark" ? "light" : "dark");
            },
            group: t("cmd.groupProject"),
          },
          ...(AUTH_ENABLED
            ? [
                {
                  id: "signout",
                  label: t("auth.signOut"),
                  icon: <LogOut className="h-3.5 w-3.5" />,
                  onSelect: () => {
                    signOut({ callbackUrl: "/" });
                  },
                  group: t("cmd.groupProject"),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}
