"use client";

import * as React from "react";
import {
  PenLine,
  Layers,
  Gavel,
  Network,
  Lightbulb,
  Sparkles,
  ArrowRight,
  Library,
  Trash2,
  DatabaseZap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ProgressTracker } from "@/components/sciwrite/progress-tracker";
import { CitationHealthDashboard } from "@/components/sciwrite/citation-health-dashboard";
import { WritingTipsPanel } from "@/components/sciwrite/writing-tips-panel";
import { ExportMenu } from "@/components/sciwrite/export-menu";
import { MarkdownCitations } from "@/components/sciwrite/markdown-citations";
import { SortableParagraphs } from "@/components/sciwrite/sortable-paragraphs";
import { cleanArticleContent } from "@/lib/writing";
import { useI18n } from "@/lib/i18n";
import { EmbeddedReviewWorkspace } from "@/components/sciwrite/home/review-workspace";
import { RelationshipWorkspace } from "@/components/sciwrite/home/relationship-workspace";
import { EmptyWorkspace } from "@/components/sciwrite/home/empty-workspace";
// Lazy-loaded heavy dialog component — only needed when the user opens it,
// so it is split into a separate chunk to reduce the initial bundle size.
const ParagraphTrashDialog = React.lazy(() =>
  import("@/components/sciwrite/paragraph-trash-dialog").then(m => ({ default: m.ParagraphTrashDialog }))
);

export function WritingWorkspace({
  project,
  paragraphs,
  articles,
  references,
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
  pendingJumpId,
  onJumpHandled,
}: {
  project?: any;
  paragraphs: any[];
  articles: any[];
  references: any[];
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
  pendingJumpId?: string | null;
  onJumpHandled?: () => void;
}) {
  const { t } = useI18n();
  const [workspaceTab, setWorkspaceTab] = React.useState("paragraphs");
  const [articleViewLang, setArticleViewLang] = React.useState<"en" | "zh">("en");
  const [paraTrashOpen, setParaTrashOpen] = React.useState(false);

  // Jump to a specific paragraph in the workspace. Switches to the
  // paragraphs tab, waits a tick for it to render, then scrolls the
  // paragraph card into view + briefly highlights it. Used by the
  // CitationHealthDashboard's worst-offender list.
  const jumpToParagraph = React.useCallback((paragraphId: string) => {
    setWorkspaceTab("paragraphs");
    // Defer until the paragraphs tab is rendered (next animation frame).
    requestAnimationFrame(() => {
      // The ParagraphCard sets id={paragraph.id} on its root container.
      const el = document.getElementById(paragraphId)
        || document.querySelector(`[data-paragraph-id="${paragraphId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ring-2", "ring-primary", "ring-offset-1");
        setTimeout(
          () =>
            el.classList.remove(
              "ring-2",
              "ring-primary",
              "ring-offset-1"
            ),
          2500
        );
      }
    });
  }, []);

  // Handle pending jump from the Audit task — when the parent passes a
  // pendingJumpId (e.g. from the citation heatmap), scroll to that paragraph.
  React.useEffect(() => {
    if (pendingJumpId) {
      // Wait for the paragraphs tab to be rendered after task switch.
      const timer = setTimeout(() => {
        jumpToParagraph(pendingJumpId);
        onJumpHandled?.();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [pendingJumpId, jumpToParagraph, onJumpHandled]);

  if (!activeProjectId || !project) {
    return <EmptyWorkspace />;
  }
  const lastParagraph = paragraphs[paragraphs.length - 1];
  const tipsFormat = lastParagraph?.format;
  const tipsScenario = lastParagraph?.scenario;
  const latestArticle = articles[0];

  return (
    <div className="flex flex-col h-full relative">
      {/* Workspace header — Atlas structural class with title + field badge */}
      <div className="atlas-workspace-header shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="atlas-workspace-title truncate">
                {project.title}
              </h2>
              {project.field && (
                <span className="atlas-project-field-tag shrink-0">
                  {String(project.field).replace(/-/g, " ")}
                </span>
              )}
            </div>
            <p className="atlas-workspace-topic">
              {project.topic}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs gap-1 hover:bg-muted/60 focus-ring"
              onClick={onOpenUserData}
              title={t("app.uploadDataTitle")}
            >
              <DatabaseZap className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">{t("app.dataButton")}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={`h-8 px-2 text-xs gap-1 focus-ring ${
                tipsOpen
                  ? "bg-primary/10 text-primary hover:bg-primary/15"
                  : "hover:bg-muted/60"
              }`}
              onClick={() => onTipsOpenChange(!tipsOpen)}
              title={t("app.writingTipsTitle")}
            >
              <Lightbulb className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">{t("app.tips")}</span>
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

      {/* Citation Health Dashboard — project-level adversarial audit summary.
          Shows a 0–100 health grade (A–F), blocking/warning counts, and a
          collapsible worst-offenders list. Clicking a paragraph scrolls to it. */}
      {activeProjectId && (
        <CitationHealthDashboard projectId={activeProjectId} onJumpParagraph={jumpToParagraph} />
      )}

      {/* Workspace tabs — Atlas structural tab strip */}
      <div className="atlas-tabs shrink-0">
        <button
          onClick={() => setWorkspaceTab("paragraphs")}
          className={`atlas-tab ${workspaceTab === "paragraphs" ? "atlas-tab-active" : ""}`}
        >
          <PenLine className="h-3 w-3" />
          {t("workspace.paragraphsTabLabel", { n: paragraphs.length })}
        </button>
        <button
          onClick={() => setWorkspaceTab("article")}
          className={`atlas-tab ${workspaceTab === "article" ? "atlas-tab-active" : ""}`}
        >
          <Layers className="h-3 w-3" />
          {t("workspace.articleTab")}
          {latestArticle ? ` (${articles.length})` : ""}
        </button>
        <button
          onClick={() => setWorkspaceTab("review")}
          className={`atlas-tab ${workspaceTab === "review" ? "atlas-tab-active" : ""}`}
        >
          <Gavel className="h-3 w-3" />
          {t("workspace.reviewTab")}
        </button>
        <button
          onClick={() => setWorkspaceTab("relationships")}
          className={`atlas-tab ${workspaceTab === "relationships" ? "atlas-tab-active" : ""}`}
        >
          <Network className="h-3 w-3" />
          {t("workspace.relationshipsTab")}
        </button>
        {latestArticle && (
          <div className="ml-auto shrink-0">
            <ExportMenu type="article" id={latestArticle.id} variant="outline" hasZh={!!latestArticle.contentZh} />
          </div>
        )}
      </div>

      {/* Paragraphs tab */}
      {workspaceTab === "paragraphs" && (
        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-4 py-4">
            {paragraphs.length === 0 ? (
              /* Empty-state hero — larger icon (h-20 w-20) with a soft
                 radial glow behind it, balanced vertical spacing so the
                 CTA sits naturally below. Mirrors EmptyWorkspace's hero
                 treatment but at a slightly smaller scale (within-tab). */
              <div className="text-center py-12 acad-fade-in">
                <div className="relative mb-4 inline-block">
                  <div
                    aria-hidden
                    className="absolute -inset-6 bg-primary/[0.07] blur-2xl rounded-full"
                  />
                  <div className="relative brand-tile h-20 w-20 rounded-[1.5rem] flex items-center justify-center ring-academic">
                    <Lightbulb className="h-9 w-9 text-primary-foreground" />
                  </div>
                </div>
                <h3 className="text-base font-semibold font-serif-text">
                  {t("workspace.startWriting")}
                </h3>
                <p className="text-xs text-muted-foreground mt-2 max-w-sm mx-auto leading-relaxed">
                  {t("workspace.startHint")}
                </p>
                <Button
                  size="sm"
                  className="mt-4 gap-1 btn-gradient-primary text-primary-foreground"
                  onClick={onOpenWrite}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {t("workspace.draftFirst")}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <>
                <div className="divider-academic mb-3">
                  <Library className="h-3 w-3" />
                  <span className="eyebrow">
                    {t("workspace.paragraphs")} ({paragraphs.length})
                  </span>
                  <span className="text-[9px] text-muted-foreground/70 normal-case tracking-normal ml-2">
                    {t("workspace.dragReorder")}
                  </span>
                  {/* Paragraph trash button — opens the paragraph trash dialog */}
                  <button
                    onClick={() => setParaTrashOpen(true)}
                    className="ml-auto text-[9px] text-muted-foreground hover:text-foreground normal-case tracking-normal flex items-center gap-1 focus-ring rounded-sm"
                    title={t("trash.paraTitle") || "Trash — Deleted Paragraphs"}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                {/* round-36: removed the outer canvas-paper sheet — each paragraph
                    is already a surface card, so the box-in-box framing read as
                    redundant (user feedback). Cards sit directly on the desk.
                    pl-6 keeps a left gutter for the drag handle (absolute
                    -left-6, previously roomed by the sheet's p-5 padding). */}
                <div className="pl-6">
                  <SortableParagraphs
                    paragraphs={paragraphs}
                    projectId={activeProjectId}
                    articleContent={articles[0]?.content}
                  />
                </div>
                <div className="pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-9 text-xs gap-1 border-dashed border-primary/40 hover:bg-primary/[0.03] hover:text-primary transition-all"
                    onClick={onOpenWrite}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {t("workspace.draftAnother")}
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
          <div className="px-4 py-4">
            {latestArticle ? (
              <div className="canvas-paper rounded-xl p-5 sm:p-6">
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-base font-semibold font-serif-text flex-1 min-w-0 truncate">
                    {latestArticle.title}
                  </h3>
                  {/* EN/ZH toggle for main workspace article view */}
                  {latestArticle.contentZh && (
                    <div className="flex items-center gap-1 rounded-md border hairline bg-muted/40 p-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => setArticleViewLang("en")}
                        className={`px-2 py-1 rounded text-[10px] font-semibold transition-colors ${
                          articleViewLang === "en"
                            ? "tab-pill"
                            : "tab-pill-inactive"
                        }`}
                        title="English"
                      >
                        EN
                      </button>
                      <button
                        type="button"
                        onClick={() => setArticleViewLang("zh")}
                        className={`px-2 py-1 rounded text-[10px] font-semibold transition-colors ${
                          articleViewLang === "zh"
                            ? "tab-pill"
                            : "tab-pill-inactive"
                        }`}
                        title="中文"
                      >
                        中文
                      </button>
                    </div>
                  )}
                </div>
                <MarkdownCitations
                  content={cleanArticleContent(
                    articleViewLang === "zh" && latestArticle.contentZh
                      ? latestArticle.contentZh
                      : latestArticle.content
                  )}
                  onCitationClick={(ref, idx) => {
                    // r37 fix: the reference list ids are 1-BASED (ref-1, ref-2…)
                    // while idx here is a 0-based findIndex — clicking [1] used to
                    // look up `ref-0` (nonexistent → silent no-op) and [3] jumped
                    // to entry [2].
                    const refEl = document.getElementById(`ref-${idx + 1}`);
                    if (refEl) {
                      refEl.scrollIntoView({ behavior: "smooth", block: "center" });
                      refEl.classList.add("ring-2", "ring-primary", "ring-offset-1");
                      setTimeout(() => refEl.classList.remove("ring-2", "ring-primary", "ring-offset-1"), 2000);
                    }
                  }}
                  className="text-[13.5px]"
                />
              </div>
            ) : (
              /* Empty article state — same hero treatment as empty
                 paragraphs: larger icon + radial glow + balanced CTA. */
              <div className="text-center py-12 acad-fade-in">
                <div className="relative mb-4 inline-block">
                  <div
                    aria-hidden
                    className="absolute -inset-6 bg-primary/[0.07] blur-2xl rounded-full"
                  />
                  <div className="relative brand-tile h-20 w-20 rounded-[1.5rem] flex items-center justify-center ring-academic">
                    <Layers className="h-9 w-9 text-primary-foreground" />
                  </div>
                </div>
                <h3 className="text-base font-semibold font-serif-text">
                  {t("workspace.noArticleTitle")}
                </h3>
                <p className="text-xs text-muted-foreground mt-2 max-w-sm mx-auto mb-4 leading-relaxed">
                  {t("workspace.noArticleDesc")}
                </p>
                <Button
                  size="sm"
                  className="gap-1 btn-gradient-primary text-primary-foreground"
                  onClick={onOpenCompose}
                  disabled={paragraphs.length < 2}
                >
                  <Layers className="h-3.5 w-3.5" />
                  {t("workspace.composeArticleBtn")}
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

      {/* Paragraph trash dialog — scoped to this workspace's project */}
      <React.Suspense fallback={null}>
      <ParagraphTrashDialog
        open={paraTrashOpen}
        onOpenChange={setParaTrashOpen}
        projectId={activeProjectId}
      />
      </React.Suspense>
    </div>
  );
}
