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

  if (!activeProjectId || !project) {
    return <EmptyWorkspace />;
  }
  const lastParagraph = paragraphs[paragraphs.length - 1];
  const tipsFormat = lastParagraph?.format;
  const tipsScenario = lastParagraph?.scenario;
  const latestArticle = articles[0];

  return (
    <div className="flex flex-col h-full relative">
      <div className="glass-subtle px-5 py-3.5 border-b border-border/60 shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-lg font-semibold tracking-tight truncate font-serif-text leading-tight">
                {project.title}
              </h2>
              {project.field && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide shrink-0 bg-primary/10 text-primary">
                  {String(project.field).replace(/-/g, " ")}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
              {project.topic}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="ghost" size="sm" className="h-8 text-xs gap-1.5 hover:bg-muted/60" onClick={onOpenUserData} title={t("app.uploadDataTitle")}>
              <DatabaseZap className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">{t("app.dataButton")}</span>
            </Button>
            <Button variant="ghost" size="sm" className={`h-8 text-xs gap-1.5 ${tipsOpen ? "bg-amber-100/60 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400" : "hover:bg-muted/60"}`} onClick={() => onTipsOpenChange(!tipsOpen)} title={t("app.writingTipsTitle")}>
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

      {/* Workspace tabs */}
      <div className="flex items-center gap-1 px-5 py-2 border-b border-border/60 shrink-0 bg-muted/15 overflow-x-auto">
        <button onClick={() => setWorkspaceTab("paragraphs")} className={`text-[11px] px-3 py-1 rounded-md font-medium transition-all whitespace-nowrap flex items-center gap-1 ${workspaceTab === "paragraphs" ? "tab-pill" : "tab-pill-inactive"}`}>
          <PenLine className="h-3 w-3" />{t("workspace.paragraphsTabLabel", { n: paragraphs.length })}
        </button>
        <button onClick={() => setWorkspaceTab("article")} className={`text-[11px] px-3 py-1 rounded-md font-medium transition-all whitespace-nowrap flex items-center gap-1 ${workspaceTab === "article" ? "tab-pill" : "tab-pill-inactive"}`}>
          <Layers className="h-3 w-3" />{t("workspace.articleTab")}{latestArticle ? ` (${articles.length})` : ""}
        </button>
        <button onClick={() => setWorkspaceTab("review")} className={`text-[11px] px-3 py-1 rounded-md font-medium transition-all whitespace-nowrap flex items-center gap-1 ${workspaceTab === "review" ? "tab-pill" : "tab-pill-inactive"}`}>
          <Gavel className="h-3 w-3" />{t("workspace.reviewTab")}
        </button>
        <button onClick={() => setWorkspaceTab("relationships")} className={`text-[11px] px-3 py-1 rounded-md font-medium transition-all whitespace-nowrap flex items-center gap-1 ${workspaceTab === "relationships" ? "tab-pill" : "tab-pill-inactive"}`}>
          <Network className="h-3 w-3" />{t("workspace.relationshipsTab")}
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
          <div className="px-5 py-4 max-w-3xl mx-auto space-y-3">
            {paragraphs.length === 0 ? (
              <div className="text-center py-16 acad-fade-in">
                <div className="h-16 w-16 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center mb-3 ring-academic">
                  <Lightbulb className="h-8 w-8 text-primary" />
                </div>
                <h3 className="text-sm font-semibold font-serif-text">{t("workspace.startWriting")}</h3>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto leading-relaxed">
                  {t("workspace.startHint")}
                </p>
                <Button size="sm" className="mt-4 gap-1.5 btn-gradient-primary text-primary-foreground" onClick={onOpenWrite}>
                  <Sparkles className="h-3.5 w-3.5" />
                  {t("workspace.draftFirst")}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <>
                <div className="divider-academic mb-1">
                  <Library className="h-3 w-3" />
                  {t("workspace.paragraphs")} ({paragraphs.length})
                  <span className="text-[9px] text-muted-foreground/70 normal-case tracking-normal ml-2">{t("workspace.dragReorder")}</span>
                  {/* Paragraph trash button — opens the paragraph trash dialog */}
                  <button
                    onClick={() => setParaTrashOpen(true)}
                    className="ml-auto text-[9px] text-muted-foreground hover:text-foreground normal-case tracking-normal flex items-center gap-0.5"
                    title={t("trash.paraTitle") || "Trash — Deleted Paragraphs"}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                <SortableParagraphs paragraphs={paragraphs} projectId={activeProjectId} articleContent={articles[0]?.content} />
                <div className="pt-2">
                  <Button variant="outline" size="sm" className="w-full h-9 text-xs gap-1.5 border-dashed hover:border-primary/50 hover:bg-primary/[0.03] hover:text-primary transition-all" onClick={onOpenWrite}>
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
          <div className="px-5 py-4 max-w-3xl mx-auto">
            {latestArticle ? (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-sm font-semibold font-serif-text flex-1 min-w-0 truncate">{latestArticle.title}</h3>
                  {/* EN/ZH toggle for main workspace article view */}
                  {latestArticle.contentZh && (
                    <div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/30 p-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => setArticleViewLang("en")}
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                          articleViewLang === "en"
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                        title="English"
                      >
                        EN
                      </button>
                      <button
                        type="button"
                        onClick={() => setArticleViewLang("zh")}
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                          articleViewLang === "zh"
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
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
                    const refEl = document.getElementById(`ref-${idx}`);
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
              <div className="text-center py-16 acad-fade-in">
                <div className="h-16 w-16 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center mb-3 ring-academic">
                  <Layers className="h-8 w-8 text-primary" />
                </div>
                <h3 className="text-sm font-semibold font-serif-text">{t("workspace.noArticleTitle")}</h3>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto mb-4 leading-relaxed">
                  {t("workspace.noArticleDesc")}
                </p>
                <Button size="sm" className="gap-1.5 btn-gradient-primary text-primary-foreground" onClick={onOpenCompose} disabled={paragraphs.length < 2}>
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
