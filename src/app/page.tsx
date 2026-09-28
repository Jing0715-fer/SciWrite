"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { signOut } from "next-auth/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Sparkles,
  Layers,
  PenLine,
  Loader2,
  Radar,
  BarChart3,
  Moon,
  ListTree,
  LogOut,
  Search,
  Database,
  FlaskConical,
  ChevronDown,
  FolderOpen,
  PanelRight,
  Clock,
  HelpCircle,
  Check,
  Plus,
  Copy,
  Cpu,
  Keyboard,
  Quote,
  Command as CommandIcon,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { LLMConfigDialog } from "@/components/sciwrite/llm-config-dialog";
import { ProjectsSidebar } from "@/components/sciwrite/projects-sidebar";
import { DatabaseQueryPanel } from "@/components/sciwrite/database-query-panel";
import { KnowledgePanel } from "@/components/sciwrite/knowledge-panel";
import { useIsMobile } from "@/hooks/use-mobile";
import { CommandPalette } from "@/components/sciwrite/command-palette";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { LLMCacheStatsPanel } from "@/components/sciwrite/llm-config-dialog";
import { WritingWorkspace } from "@/components/sciwrite/home/writing-workspace";
import { computeProgressStats } from "@/components/sciwrite/home/shared";
import { useHomeKeyboardShortcuts } from "@/components/sciwrite/home/use-keyboard-shortcuts";
import { useRecentProjects } from "@/components/sciwrite/use-recent-projects";
import { ShortcutsOverlay } from "@/components/sciwrite/home/shortcuts-overlay";
import { OnboardingTour } from "@/components/sciwrite/home/onboarding-tour";
import { ChangelogDialog } from "@/components/sciwrite/home/changelog-dialog";
import { CitationHeatmap } from "@/components/sciwrite/citation-heatmap";
import { SourceDonut } from "@/components/sciwrite/source-donut";
import {
  ThemeSwitcher,
} from "@/components/sciwrite/theme-switcher";
import { ThemeToggle } from "@/components/sciwrite/theme-toggle";
import { LanguageToggle } from "@/components/sciwrite/language-toggle";
// Lazy-loaded heavy dialog components.
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

// ============================================================
// TASK MODEL — the 5 primary user tasks. This is the core
// architectural change: instead of 3 static panels always visible,
// the UI is organized around the ACTIVE TASK. One task at a time
// gets the full focal workspace; context lives in a slide-in drawer.
// ============================================================
type TaskId = "research" | "draft" | "compose" | "audit" | "manage";

const TASKS: { id: TaskId; icon: typeof Search; labelKey: string }[] = [
  { id: "research", icon: Search, labelKey: "task.research" },
  { id: "draft", icon: PenLine, labelKey: "task.draft" },
  { id: "compose", icon: Layers, labelKey: "task.compose" },
  { id: "audit", icon: Radar, labelKey: "task.audit" },
  { id: "manage", icon: FolderOpen, labelKey: "task.manage" },
];

function Home() {
  const { t } = useI18n();
  const { resolvedTheme, setTheme } = useTheme();
  const isMobile = useIsMobile();
  const [activeTask, setActiveTask] = React.useState<TaskId>("draft");
  const qc = useQueryClient();
  const [contextOpen, setContextOpen] = React.useState(false);
  const [projectSwitcherOpen, setProjectSwitcherOpen] = React.useState(false);
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(null);
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
  // Memoize derived arrays to prevent cascade re-renders of children
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

  // Citation health for the Audit task tab badge — after paragraphs so
  // the enabled flag can read paragraphs.length safely.
  const healthQ = useQuery({
    queryKey: ["citation-health", activeProjectId],
    queryFn: () => api.getCitationHealth(activeProjectId!),
    enabled: !!activeProjectId && paragraphs.length > 0,
  });
  const citationGrade = healthQ.data?.aggregate?.grade;
  const healthLoading = healthQ.isFetching && !healthQ.data;

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

  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [pendingJumpId, setPendingJumpId] = React.useState<string | null>(null);
  const recentProjectIds = useRecentProjects(activeProjectId);
  const [forceTour, setForceTour] = React.useState(false);
  const [forceChangelog, setForceChangelog] = React.useState(false);

  const reopenTour = React.useCallback(() => {
    setForceTour(false);
    // Tick the flag so the effect re-fires
    requestAnimationFrame(() => setForceTour(true));
  }, []);
  const reopenChangelog = React.useCallback(() => {
    setForceChangelog(false);
    requestAnimationFrame(() => setForceChangelog(true));
  }, []);

  /** Duplicate the active project — fetches its data and creates a new
   *  project with the same title + topic + field + "(copy)" suffix. */
  const duplicateProject = React.useCallback(async () => {
    if (!activeProjectId || !project) return;
    try {
      const res = await api.createProject({
        title: `${project.title} (copy)`,
        topic: project.topic,
        description: project.description || undefined,
        field: project.field || undefined,
      });
      qc.invalidateQueries({ queryKey: ["projects"] });
      setActiveProjectId(res.project.id);
      setProjectSwitcherOpen(false);
      toast.success("Project duplicated");
    } catch (e: any) {
      toast.error(e.message || "Failed to duplicate project");
    }
  }, [activeProjectId, project, qc]);

  /** Jump to a paragraph: switches to the Draft task and signals the
   *  WritingWorkspace to scroll the paragraph into view + highlight it. */
  const jumpToParagraph = React.useCallback((paragraphId: string) => {
    setActiveTask("draft");
    setPendingJumpId(paragraphId);
  }, []);

  useHomeKeyboardShortcuts({
    activeProjectId,
    paragraphs,
    setPaletteOpen,
    setInsightsOpen,
    setUnifiedWriteTab,
    setUnifiedWriteOpen,
    setShortcutsOpen,
    setActiveTask,
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
    setActiveTask("research");
  };
  const openOutline = () => {
    setUnifiedWriteTab("outline");
    setUnifiedWriteOpen(true);
  };

  const activeProject = projects.find((p) => p.id === activeProjectId);

  return (
    <div className="canvas-shell h-screen flex flex-col bg-background overflow-hidden">
      {/* ===== TOP COMMAND BAR ===== */}
      <TopBar
        project={activeProject}
        projectsCount={projects.length}
        paragraphCount={paragraphs.length}
        articleCount={articles.length}
        onOpenProjectSwitcher={() => setProjectSwitcherOpen((v) => !v)}
        projectSwitcherOpen={projectSwitcherOpen}
        projects={projects}
        activeProjectId={activeProjectId}
        recentProjectIds={recentProjectIds}
        onSelectProject={(id) => {
          setActiveProjectId(id);
          setProjectSwitcherOpen(false);
        }}
        onCreateProject={() => {
          // open the writing dialog's outline tab as a quick create proxy
          setUnifiedWriteTab("outline");
          setUnifiedWriteOpen(true);
        }}
        onOpenWrite={openWrite}
        onOpenLLMConfig={() => setLlmConfigOpen(true)}
        onToggleContext={() => setContextOpen((v) => !v)}
        contextOpen={contextOpen}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenTour={reopenTour}
        onOpenChangelog={reopenChangelog}
        onDuplicateProject={duplicateProject}
      />

      {/* ===== TASK TAB STRIP ===== */}
      <TaskTabs
        activeTask={activeTask}
        onChange={setActiveTask}
        isMobile={isMobile}
        badges={{
          draft: paragraphs.length,
          compose: articles.length,
          manage: projects.length,
        }}
        grades={{
          audit: citationGrade,
        }}
        gradeLoading={{
          audit: healthLoading,
        }}
      />

      {/* ===== MAIN: focal workspace + context drawer ===== */}
      <main className="flex-1 min-h-0 flex overflow-hidden">
        {/* Focal workspace — renders the active task */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {activeTask === "research" && (
            <ResearchWorkspace
              projectId={activeProjectId}
              dataSources={dataSources}
              references={references}
              onOpenArticle={(a) => setViewArticle(a as Article)}
              articles={articles}
            />
          )}
          {activeTask === "draft" && (
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
              pendingJumpId={pendingJumpId}
              onJumpHandled={() => setPendingJumpId(null)}
            />
          )}
          {activeTask === "compose" && (
            <ComposeWorkspace
              articles={articles}
              paragraphs={paragraphs}
              onOpenCompose={openCompose}
              onOpenArticle={(a) => setViewArticle(a as Article)}
            />
          )}
          {activeTask === "audit" && (
            <AuditWorkspace
              projectId={activeProjectId}
              paragraphs={paragraphs}
              onOpenInsights={() => setInsightsOpen(true)}
              onJumpParagraph={jumpToParagraph}
            />
          )}
          {activeTask === "manage" && (
            <ManageWorkspace
              projects={projects}
              activeId={activeProjectId}
              onSelect={setActiveProjectId}
              onDeleted={(id) => {
                if (id === activeProjectId) setActiveProjectId(null);
              }}
              articles={articles}
              onOpenArticle={(a) => setViewArticle(a as Article)}
              isMobile={isMobile}
            />
          )}
        </div>

        {/* Context drawer — slide-in right panel */}
        {contextOpen && !isMobile && (
          <ContextDrawer
            projectId={activeProjectId}
            dataSources={dataSources}
            references={references}
            onClose={() => setContextOpen(false)}
            onOpenUserData={() => setUserDataOpen(true)}
            onOpenWrite={openWrite}
            onOpenGather={openGather}
            onOpenInsights={() => setInsightsOpen(true)}
          />
        )}
      </main>

      {/* ===== STATUS BAR ===== */}
      <StatusBar onOpenPalette={() => setPaletteOpen(true)} />

      {/* ===== Modals ===== */}
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
      <ShortcutsOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <OnboardingTour forceOpen={forceTour} />
      <ChangelogDialog forceOpen={forceChangelog} />
    </div>
  );
}

// ============================================================
// TOP BAR — minimal command bar (brand + project switcher + actions)
// ============================================================
function TopBar({
  project,
  projectsCount,
  paragraphCount,
  articleCount,
  onOpenProjectSwitcher,
  projectSwitcherOpen,
  projects,
  activeProjectId,
  recentProjectIds,
  onSelectProject,
  onCreateProject,
  onOpenWrite,
  onOpenLLMConfig,
  onToggleContext,
  contextOpen,
  onOpenPalette,
  onOpenShortcuts,
  onOpenTour,
  onOpenChangelog,
  onDuplicateProject,
}: {
  project?: any;
  projectsCount: number;
  paragraphCount: number;
  articleCount: number;
  onOpenProjectSwitcher: () => void;
  projectSwitcherOpen: boolean;
  projects: any[];
  activeProjectId: string | null;
  recentProjectIds: string[];
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onOpenWrite: () => void;
  onOpenLLMConfig: () => void;
  onToggleContext: () => void;
  contextOpen: boolean;
  onOpenPalette: () => void;
  onOpenShortcuts: () => void;
  onOpenTour: () => void;
  onOpenChangelog: () => void;
  onDuplicateProject: () => void;
}) {
  const { t } = useI18n();
  const [helpOpen, setHelpOpen] = React.useState(false);
  return (
    <header className="canvas-topbar shrink-0 h-14 flex items-center gap-3 px-4 relative z-40">
      {/* Brand */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="canvas-brand-mark">
          <FlaskConical className="h-4 w-4 text-primary-foreground" />
        </div>
        <div className="hidden sm:flex flex-col leading-none">
          <span className="canvas-brand-name">SciWrite</span>
          <span className="canvas-brand-sub">Canvas</span>
        </div>
      </div>

      {/* Project switcher — dropdown button */}
      <button
        onClick={onOpenProjectSwitcher}
        className="canvas-project-switcher group"
        aria-expanded={projectSwitcherOpen}
      >
        <FolderOpen className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="truncate max-w-[180px] text-[13px] font-medium">
          {project ? project.title : t("app.noProject")}
        </span>
        <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${projectSwitcherOpen ? "rotate-180" : ""}`} />
        <span className="canvas-project-count">{projectsCount}</span>
      </button>

      {/* Project switcher dropdown */}
      {projectSwitcherOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={onOpenProjectSwitcher} />
          <div className="canvas-switcher-dropdown">
            <div className="canvas-switcher-header">
              <span className="canvas-switcher-title">Projects</span>
              <button onClick={onCreateProject} className="canvas-switcher-new">
                <Plus className="h-3 w-3" />
                New
              </button>
            </div>
            {/* Recent projects quick-access row */}
            {recentProjectIds.length > 1 && (
              <>
                <div className="canvas-recent-label">Recent</div>
                <div className="canvas-recent-row">
                  {recentProjectIds.slice(0, 5).map((id) => {
                    const p = projects.find((pr) => pr.id === id);
                    if (!p) return null;
                    return (
                      <button
                        key={id}
                        onClick={() => onSelectProject(id)}
                        className={`canvas-recent-chip ${id === activeProjectId ? "canvas-recent-chip-active" : ""}`}
                        title={p.title}
                      >
                        <Clock className="h-2.5 w-2.5 shrink-0" />
                        <span className="canvas-recent-chip-title">{p.title}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <div className="canvas-switcher-list">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`canvas-switcher-item-row ${p.id === activeProjectId ? "canvas-switcher-item-active" : ""}`}
                >
                  <button
                    onClick={() => onSelectProject(p.id)}
                    className="canvas-switcher-item"
                  >
                    <span className="canvas-switcher-item-title truncate">{p.title}</span>
                    {p.id === activeProjectId && <Check className="h-3 w-3 text-primary shrink-0" />}
                  </button>
                  {p.id === activeProjectId && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onDuplicateProject(); }}
                      className="canvas-switcher-duplicate"
                      title="Duplicate this project"
                    >
                      <Copy className="h-3 w-3" />
                      <span className="hidden sm:inline">Duplicate</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Center: command palette trigger */}
      <button
        onClick={onOpenPalette}
        className="canvas-cmdk-trigger hidden md:flex"
        title={t("footer.openPaletteTitle")}
      >
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[12px] text-muted-foreground">Search or jump to…</span>
        <kbd className="canvas-cmdk-kbd">⌘K</kbd>
      </button>

      {/* Right: actions */}
      <div className="ml-auto flex items-center gap-1 shrink-0">
        {project && (
          <button onClick={onOpenWrite} className="canvas-cta-btn" title={t("app.unifiedWriteTitle")}>
            <Sparkles className="h-3.5 w-3.5" />
            <span className="hidden sm:inline text-[12px] font-semibold">{t("app.unifiedWrite")}</span>
          </button>
        )}
        {/* Help menu — re-trigger tour/changelog/shortcuts */}
        <div className="relative">
          <button
            onClick={() => setHelpOpen((v) => !v)}
            className={`canvas-icon-btn ${helpOpen ? "canvas-icon-btn-active" : ""}`}
            title="Help"
            aria-label="Help menu"
            aria-expanded={helpOpen}
          >
            <HelpCircle className="h-4 w-4" />
          </button>
          {helpOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setHelpOpen(false)} />
              <div className="canvas-help-dropdown">
                <button
                  onClick={() => { onOpenTour(); setHelpOpen(false); }}
                  className="canvas-help-item"
                >
                  <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
                  <div className="canvas-help-item-body">
                    <span className="canvas-help-item-title">Restart tour</span>
                    <span className="canvas-help-item-desc">Take the 7-step walkthrough again</span>
                  </div>
                </button>
                <button
                  onClick={() => { onOpenChangelog(); setHelpOpen(false); }}
                  className="canvas-help-item"
                >
                  <Layers className="h-3.5 w-3.5 text-primary shrink-0" />
                  <div className="canvas-help-item-body">
                    <span className="canvas-help-item-title">What's new</span>
                    <span className="canvas-help-item-desc">See recent feature updates</span>
                  </div>
                </button>
                <button
                  onClick={() => { onOpenShortcuts(); setHelpOpen(false); }}
                  className="canvas-help-item"
                >
                  <Keyboard className="h-3.5 w-3.5 text-primary shrink-0" />
                  <div className="canvas-help-item-body">
                    <span className="canvas-help-item-title">Keyboard shortcuts</span>
                    <span className="canvas-help-item-desc">All 15 shortcuts in one view</span>
                  </div>
                </button>
              </div>
            </>
          )}
        </div>
        <button onClick={onOpenShortcuts} className="canvas-icon-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
          <Keyboard className="h-4 w-4" />
        </button>
        <button onClick={onOpenLLMConfig} className="canvas-icon-btn" title={t("app.llmConfigTitle")}>
          <Cpu className="h-4 w-4" />
        </button>
        <LanguageToggle />
        <ThemeSwitcher />
        <ThemeToggle />
        <button
          onClick={onToggleContext}
          className={`canvas-icon-btn ${contextOpen ? "canvas-icon-btn-active" : ""}`}
          title="Toggle context panel"
          aria-label="Toggle context panel"
        >
          <PanelRight className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

// ============================================================
// TASK TABS — the 5-task switcher strip
// ============================================================
function TaskTabs({
  activeTask,
  onChange,
  isMobile,
  badges,
  grades,
  gradeLoading,
}: {
  activeTask: TaskId;
  onChange: (t: TaskId) => void;
  isMobile?: boolean;
  badges?: Partial<Record<TaskId, number>>;
  grades?: Partial<Record<TaskId, string>>;
  gradeLoading?: Partial<Record<TaskId, boolean>>;
}) {
  const { t } = useI18n();
  const labels: Record<TaskId, string> = {
    research: t("task.research"),
    draft: t("task.draft"),
    compose: t("task.compose"),
    audit: t("task.audit"),
    manage: t("task.manage"),
  };
  return (
    <nav className="canvas-tasknav shrink-0 h-10 flex items-center gap-1 px-4 overflow-x-auto">
      {TASKS.map((task, idx) => {
        const Icon = task.icon;
        const active = activeTask === task.id;
        const badge = badges?.[task.id];
        const grade = grades?.[task.id];
        const isLoading = gradeLoading?.[task.id];
        const gradeClass = grade ? getGradeClass(grade) : "";
        return (
          <button
            key={task.id}
            onClick={() => onChange(task.id)}
            className={`canvas-task-tab ${active ? "canvas-task-tab-active" : ""}`}
            aria-current={active ? "page" : undefined}
            title={`${labels[task.id]} (press ${idx + 1})`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{labels[task.id]}</span>
            {badge !== undefined && badge > 0 && (
              <span className="canvas-task-badge">{badge}</span>
            )}
            {isLoading && (
              <span className="canvas-task-grade-skeleton" title="Computing citation health…" />
            )}
            {grade && !isLoading && (
              <span className={`canvas-task-grade ${gradeClass}`} title={`Citation health: ${grade}`}>
                {grade}
              </span>
            )}
            <span className="canvas-task-tab-num">{idx + 1}</span>
          </button>
        );
      })}
    </nav>
  );
}

function getGradeClass(grade: string): string {
  if (grade === "A") return "canvas-task-grade-a";
  if (grade === "B") return "canvas-task-grade-b";
  if (grade === "C") return "canvas-task-grade-c";
  if (grade === "D") return "canvas-task-grade-d";
  return "canvas-task-grade-f";
}

// ============================================================
// STATUS BAR — slim footer
// ============================================================
function StatusBar({ onOpenPalette }: { onOpenPalette?: () => void }) {
  const { t } = useI18n();
  return (
    <footer className="canvas-statusbar shrink-0 h-7 px-4 flex items-center justify-between text-[10px] relative z-20">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 font-medium text-foreground/80">
          <span className="relative inline-flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-primary/60 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
          </span>
          {t("footer.aiPowered")}
        </span>
      </div>
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="hidden md:inline tracking-wide">
          RCSB · UniProt · PubMed · NCBI · BLAST
        </span>
        <span className="opacity-30">·</span>
        <span className="font-mono text-[9px]">[n] · [SOURCE:ID]</span>
      </div>
    </footer>
  );
}

// ============================================================
// RESEARCH WORKSPACE — full-width database + knowledge
// ============================================================
function ResearchWorkspace({
  projectId,
  dataSources,
  references,
  onOpenArticle,
  articles,
}: {
  projectId: string | null;
  dataSources: any[];
  references: any[];
  onOpenArticle: (a: any) => void;
  articles: any[];
}) {
  const [activeType, setActiveType] = React.useState<string | null>(null);
  // Reset filter when project changes
  React.useEffect(() => { setActiveType(null); }, [projectId]);
  const filteredSources = activeType
    ? dataSources.filter((s) => (s.source || s.type || s.sourceType || "manual") === activeType)
    : dataSources;
  return (
    <div className="canvas-workspace-research flex h-full">
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden border-r border-border/60">
        {/* Source distribution donut — clickable to filter the knowledge
            panel by source type. Active segment is highlighted, others dimmed. */}
        {dataSources.length > 0 && (
          <SourceDonut
            sources={dataSources}
            activeType={activeType}
            onSelectType={setActiveType}
          />
        )}
        <DatabaseQueryPanel projectId={projectId} />
      </div>
      <div className="w-[380px] shrink-0 flex flex-col overflow-hidden">
        <KnowledgePanel
          projectId={projectId}
          dataSources={filteredSources}
          references={references}
        />
      </div>
    </div>
  );
}

// ============================================================
// COMPOSE WORKSPACE — article-centric
// ============================================================
function ComposeWorkspace({
  articles,
  paragraphs,
  onOpenCompose,
  onOpenArticle,
}: {
  articles: any[];
  paragraphs: any[];
  onOpenCompose: () => void;
  onOpenArticle: (a: any) => void;
}) {
  const { t } = useI18n();
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const latestArticle = articles[0];

  // When no article exists but paragraphs do, show the compose wizard
  // (paragraph selection + preview) instead of just an empty state.
  const showWizard = articles.length === 0 && paragraphs.length >= 2;

  const toggleParagraph = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(paragraphs.map((p) => p.id)));
  const selectNone = () => setSelectedIds(new Set());

  return (
    <div className="canvas-workspace-compose flex flex-col h-full overflow-hidden">
      <div className="canvas-workspace-header">
        <h2 className="canvas-workspace-title">Article Composition</h2>
        <p className="canvas-workspace-topic">
          {paragraphs.length} paragraphs ready · {articles.length} articles composed
        </p>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto canvas-scroll">
        {articles.length === 0 && paragraphs.length < 2 ? (
          <div className="canvas-empty-compose">
            <Layers className="h-12 w-12 text-primary/40" />
            <h3 className="canvas-empty-title">{t("workspace.noArticleTitle")}</h3>
            <p className="canvas-empty-desc">{t("workspace.noArticleDesc")}</p>
            <button onClick={onOpenCompose} disabled={paragraphs.length < 2} className="canvas-cta-btn mt-4">
              <Layers className="h-3.5 w-3.5" />
              {t("workspace.composeArticleBtn")}
            </button>
          </div>
        ) : showWizard ? (
          /* Compose wizard — paragraph selection + preview */
          <div className="canvas-compose-wizard">
            <div className="canvas-wizard-header">
              <h3 className="canvas-wizard-title">Select paragraphs to compose</h3>
              <div className="canvas-wizard-actions">
                <button onClick={selectAll} className="canvas-wizard-link">Select all</button>
                <span className="text-muted-foreground/40">·</span>
                <button onClick={selectNone} className="canvas-wizard-link">Clear</button>
                <span className="canvas-wizard-count">{selectedIds.size} selected</span>
              </div>
            </div>
            <div className="canvas-wizard-paragraphs">
              {paragraphs.map((p, i) => {
                const selected = selectedIds.has(p.id);
                const preview = (p.content || "").replace(/\[[^\]]*\]/g, "").trim().slice(0, 140);
                return (
                  <button
                    key={p.id}
                    onClick={() => toggleParagraph(p.id)}
                    className={`canvas-wizard-paragraph ${selected ? "canvas-wizard-paragraph-selected" : ""}`}
                  >
                    <div className="canvas-wizard-paragraph-marker">
                      <span className="canvas-wizard-paragraph-num">§{i + 1}</span>
                      {selected && <Check className="h-3 w-3 text-primary" />}
                    </div>
                    <div className="canvas-wizard-paragraph-body">
                      <div className="canvas-wizard-paragraph-meta">
                        {p.wordCount || 0} words
                        {(p.content?.match(/\[\d{1,3}/g) || []).length > 0 && (
                          <span className="canvas-wizard-paragraph-cite">
                            {(p.content.match(/\[\d{1,3}/g) || []).length} citations
                          </span>
                        )}
                      </div>
                      <p className="canvas-wizard-paragraph-preview">{preview}…</p>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="canvas-wizard-footer">
              <button
                onClick={onOpenCompose}
                className="canvas-cta-btn"
                title={t("workspace.composeArticleBtn")}
              >
                <Layers className="h-3.5 w-3.5" />
                Compose Article
              </button>
            </div>
          </div>
        ) : (
          <div className="canvas-compose-grid">
            {articles.map((a) => (
              <button key={a.id} onClick={() => onOpenArticle(a)} className="canvas-article-card">
                <div className="canvas-article-card-header">
                  <Layers className="h-4 w-4 text-primary" />
                  <span className="canvas-article-card-title">{a.title}</span>
                </div>
                <div className="canvas-article-card-meta">
                  <span>{Math.round((a.content?.length || 0) / 6).toLocaleString()} words</span>
                  {a.contentZh && <span>· 中文</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// AUDIT WORKSPACE — citation health + insights
// ============================================================
function AuditWorkspace({
  projectId,
  paragraphs,
  onOpenInsights,
  onJumpParagraph,
}: {
  projectId: string | null;
  paragraphs: any[];
  onOpenInsights: () => void;
  onJumpParagraph: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="canvas-workspace-audit flex flex-col h-full overflow-hidden">
      <div className="canvas-workspace-header">
        <h2 className="canvas-workspace-title">Citation Audit &amp; Quality</h2>
        <p className="canvas-workspace-topic">
          Adversarial citation verification across {paragraphs.length} paragraphs
        </p>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto canvas-scroll p-4">
        {projectId ? (
          <AuditContent
            projectId={projectId}
            paragraphs={paragraphs}
            onOpenInsights={onOpenInsights}
            onJumpParagraph={onJumpParagraph}
          />
        ) : (
          <div className="canvas-empty-compose">
            <Radar className="h-12 w-12 text-primary/40" />
            <h3 className="canvas-empty-title">Select a project to audit</h3>
          </div>
        )}
      </div>
    </div>
  );
}

// Lazy-load the CitationHealthDashboard (heavy)
const CitationHealthDashboard = React.lazy(() =>
  import("@/components/sciwrite/citation-health-dashboard").then((m) => ({
    default: m.CitationHealthDashboard,
  }))
);
function AuditContent({
  projectId,
  paragraphs,
  onOpenInsights,
  onJumpParagraph,
}: {
  projectId: string;
  paragraphs: any[];
  onOpenInsights: () => void;
  onJumpParagraph: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={onOpenInsights} className="canvas-cta-btn">
          <BarChart3 className="h-3.5 w-3.5" />
          Project Insights
        </button>
      </div>
      {/* Citation heatmap — per-paragraph density visualization */}
      {paragraphs.length > 0 && (
        <div className="canvas-audit-section">
          <h3 className="canvas-audit-section-title flex items-center gap-2">
            <Quote className="h-4 w-4 text-primary" />
            Citation Density Heatmap
          </h3>
          <CitationHeatmap
            paragraphs={paragraphs}
            onJumpParagraph={onJumpParagraph}
          />
        </div>
      )}
      <React.Suspense fallback={<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}>
        <CitationHealthDashboard projectId={projectId} onJumpParagraph={onJumpParagraph} />
      </React.Suspense>
    </div>
  );
}

// ============================================================
// MANAGE WORKSPACE — projects + articles (uses existing sidebar)
// ============================================================
function ManageWorkspace({
  projects,
  activeId,
  onSelect,
  onDeleted,
  articles,
  onOpenArticle,
  isMobile,
}: {
  projects: any[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
  articles: any[];
  onOpenArticle: (a: any) => void;
  isMobile?: boolean;
}) {
  const { t } = useI18n();
  // Aggregate stats across all projects for the summary header
  const totalParagraphs = projects.reduce((s, p) => s + (p._count?.paragraphs || 0), 0);
  const totalArticles = projects.reduce((s, p) => s + (p._count?.articles || 0), 0);
  const totalSources = projects.reduce((s, p) => s + (p._count?.dataSources || 0), 0);
  // Unique fields
  const fields = new Set(projects.map((p) => p.field).filter(Boolean));
  const fieldCount = fields.size;
  // Avg sources per project
  const avgSources = projects.length > 0 ? Math.round(totalSources / projects.length) : 0;

  return (
    <div className="canvas-workspace-manage flex flex-col h-full overflow-hidden">
      <div className="canvas-workspace-header">
        <h2 className="canvas-workspace-title">Project Management</h2>
        <p className="canvas-workspace-topic">
          {projects.length} projects · {totalParagraphs} paragraphs · {totalArticles} articles · {totalSources} sources
        </p>
      </div>
      {/* Stats grid — at-a-glance project portfolio summary */}
      <div className="canvas-stats-grid">
        <div className="canvas-stat-card">
          <div className="canvas-stat-card-icon"><FolderOpen className="h-3.5 w-3.5" /></div>
          <div className="canvas-stat-card-label">Projects</div>
          <div className="canvas-stat-card-value">{projects.length}</div>
        </div>
        <div className="canvas-stat-card">
          <div className="canvas-stat-card-icon"><PenLine className="h-3.5 w-3.5" /></div>
          <div className="canvas-stat-card-label">Paragraphs</div>
          <div className="canvas-stat-card-value">{totalParagraphs}</div>
        </div>
        <div className="canvas-stat-card">
          <div className="canvas-stat-card-icon"><Layers className="h-3.5 w-3.5" /></div>
          <div className="canvas-stat-card-label">Articles</div>
          <div className="canvas-stat-card-value">{totalArticles}</div>
        </div>
        <div className="canvas-stat-card">
          <div className="canvas-stat-card-icon"><Database className="h-3.5 w-3.5" /></div>
          <div className="canvas-stat-card-label">Sources</div>
          <div className="canvas-stat-card-value">{totalSources}</div>
        </div>
        <div className="canvas-stat-card">
          <div className="canvas-stat-card-icon"><FlaskConical className="h-3.5 w-3.5" /></div>
          <div className="canvas-stat-card-label">Fields</div>
          <div className="canvas-stat-card-value">{fieldCount}</div>
        </div>
        <div className="canvas-stat-card">
          <div className="canvas-stat-card-icon"><BarChart3 className="h-3.5 w-3.5" /></div>
          <div className="canvas-stat-card-label">Avg sources</div>
          <div className="canvas-stat-card-value">{avgSources}</div>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto canvas-scroll">
        {/* Reuse the ProjectsSidebar which has all the create/edit/delete/share
            logic — but now it's inside the Manage task's card-grid context.
            The sidebar renders its own rail with the project list. */}
        <ProjectsSidebar
          projects={projects}
          activeId={activeId}
          onSelect={onSelect}
          onDeleted={onDeleted}
          articles={articles}
          onOpenArticle={onOpenArticle}
        />
      </div>
    </div>
  );
}

// ============================================================
// CONTEXT DRAWER — slide-in right panel
// ============================================================
function ContextDrawer({
  projectId,
  dataSources,
  references,
  onClose,
  onOpenUserData,
  onOpenWrite,
  onOpenGather,
  onOpenInsights,
}: {
  projectId: string | null;
  dataSources: any[];
  references: any[];
  onClose: () => void;
  onOpenUserData: () => void;
  onOpenWrite: () => void;
  onOpenGather: () => void;
  onOpenInsights: () => void;
}) {
  const { t } = useI18n();
  return (
    <aside className="canvas-context-drawer w-80 shrink-0 flex flex-col overflow-hidden">
      <div className="canvas-drawer-header">
        <span className="canvas-drawer-title">Context</span>
        <button onClick={onClose} className="canvas-icon-btn h-7 w-7" aria-label="Close context">
          <PanelRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto canvas-scroll">
        <KnowledgePanel
          projectId={projectId}
          dataSources={dataSources}
          references={references}
        />
      </div>
      <div className="canvas-drawer-footer">
        <button onClick={onOpenUserData} className="canvas-drawer-action">
          <Database className="h-3.5 w-3.5" />
          {t("app.dataButton")}
        </button>
        <button onClick={onOpenInsights} className="canvas-drawer-action">
          <BarChart3 className="h-3.5 w-3.5" />
          {t("app.insights")}
        </button>
      </div>
    </aside>
  );
}
