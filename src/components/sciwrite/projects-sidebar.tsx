"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Plus,
  FolderOpen,
  Trash2,
  Loader2,
  FlaskConical,
  Pencil,
  Check,
  X,
  Search,
  FileStack,
  Languages,
  FileText,
  Layers,
  Database,
  Share2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ArticleTrashDialog } from "./article-trash-dialog";
import { ShareDialog } from "./share-dialog";
import { ProjectImportExport } from "./project-import-export";
import { useI18n } from "@/lib/i18n";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@/lib/types";

const FIELDS = [
  { value: "structural-biology", labelKey: "projects.fieldStructuralBiology" as const },
  { value: "genomics", labelKey: "projects.fieldGenomics" as const },
  { value: "proteomics", labelKey: "projects.fieldProteomics" as const },
  { value: "molecular-biology", labelKey: "projects.fieldMolecularBiology" as const },
  { value: "biochemistry", labelKey: "projects.fieldBiochemistry" as const },
  { value: "drug-discovery", labelKey: "projects.fieldDrugDiscovery" as const },
  { value: "clinical", labelKey: "projects.fieldClinical" as const },
  { value: "computational-biology", labelKey: "projects.fieldComputationalBiology" as const },
  { value: "other", labelKey: "projects.fieldOther" as const },
];

interface Props {
  projects: (Project & { _count?: any })[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** r37: fired when a project is deleted, so the parent can clear the
   *  active selection (prevents the ghost-project state). */
  onDeleted?: (deletedId: string) => void;
  /** Articles belonging to the currently-active project. Rendered as a list
   *  below the project list so the user can jump to any composed article. */
  articles?: any[];
  /** Open a composed article in the full viewer. */
  onOpenArticle?: (a: any) => void;
}

export function ProjectsSidebar({ projects, activeId, onSelect, onDeleted, articles = [], onOpenArticle }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [trashOpen, setTrashOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  // Project search: matches against title + topic (case-insensitive).
  const [search, setSearch] = React.useState("");
  const filteredProjects = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      (p.title || "").toLowerCase().includes(q) ||
      (p.topic || "").toLowerCase().includes(q),
    );
  }, [projects, search]);

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: (_data, id) => {
      toast.success(t("toast.projectDeleted"));
      qc.invalidateQueries({ queryKey: ["projects"] });
      if (editingId) setEditingId(null);
      // r37 fix (ghost project): when the ACTIVE project is deleted, the
      // ["projects"] invalidation does NOT touch the ["project", id] cache
      // (different key root) and activeProjectId stays set — the workspace
      // kept rendering the deleted project until every mutation 404'd.
      // Notify the parent so it can clear the selection (page.tsx then
      // auto-selects the first remaining project, or shows the empty state).
      if (id === activeId) onDeleted?.(id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-col h-full">
      {/* Article trash dialog — rendered here so it's available whenever
          the sidebar is visible. activeId is the current project whose
          trashed articles will be listed. */}
      {activeId && (
        <ArticleTrashDialog
          open={trashOpen}
          onOpenChange={setTrashOpen}
          projectId={activeId}
        />
      )}
      {activeId && (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          projectId={activeId}
          projectTitle={projects.find((p) => p.id === activeId)?.title || ""}
        />
      )}

      {/* Header — uses .panel-section-header for the same vertical rhythm
          as DatabaseQueryPanel so the search rows align across panels.
          Brand tile + eyebrow + count badge on the left; import/export,
          share, and the gradient "New" CTA on the right. */}
      <div className="glass-subtle panel-section-header flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="brand-tile h-6 w-6 rounded-md flex items-center justify-center shrink-0">
            <FlaskConical className="h-3 w-3 text-primary-foreground" />
          </div>
          <span className="eyebrow flex items-center gap-2 truncate">
            {t("projects.title")}
            <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-md bg-muted text-[10px] tabular-nums text-muted-foreground">
              {projects.length}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <ProjectImportExport
            projectId={activeId}
            variant="ghost"
            size="icon"
            onImported={(id) => onSelect(id)}
          />
          {activeId && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setShareOpen(true)}
              title={t("share.title") || "Share Project"}
            >
              <Share2 className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            className="btn-gradient-primary h-7 px-3 gap-1 text-primary-foreground font-medium"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden xs:inline">{t("projects.new")}</span>
          </Button>
        </div>
      </div>

      {/* Project search bar — filters the list below. When empty, all
          projects show. Search matches project title + topic substring
          (case-insensitive). Hides cleanly when the list is empty so it
          doesn't compete with the "no projects yet" empty state.
          Same .panel-section-header rhythm so this row sits exactly where
          the DatabaseQueryPanel search row sits — fixes QA issue #2. */}
      {projects.length > 0 && (
        <div className="panel-section-header flex items-center gap-2 shrink-0 border-b hairline">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/80 pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects…"
              className="h-8 rounded-md pl-8 pr-8 text-[11px] bg-card border-border/70 focus-visible:border-primary/50 focus-visible:ring-primary/30"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Two vertically-stacked panels: projects (top) + articles (bottom).
          Each has its own overflow container so they scroll independently —
          the project list no longer gets pushed off-screen when the article
          list grows. The ResizablePanelGroup lets the user drag the
          divider to taste.
          v107-1: When there are few projects (≤2), give articles more space
          (defaultSize 55) so article boxes display fully. When many projects,
          use 40 to give the list room to scroll.
          round-62 (P2-低): the articles panel is conditionally rendered — with
          it absent the group held a SINGLE panel at 45/60%, which made
          react-resizable-panels log "Invalid layout total size" on every
          mount. A solo projects panel now defaults to 100 so the total is
          always exactly 100. */}
      <ResizablePanelGroup direction="vertical" className="flex-1 min-h-0">
        {/* Projects panel — id/order given because the sibling articles
            panel mounts/unmounts dynamically (react-resizable-panels needs
            stable panel identity to re-layout without warnings). */}
        <ResizablePanel
          id="sidebar-projects"
          order={1}
          defaultSize={articles.length > 0 ? (projects.length <= 2 ? 45 : 60) : 100}
          minSize={20}
        >
          {/* Plain overflow-y-auto + scroll-academic + stable gutter — the
              scrollbar-gutter:stable trick reserves 10px on the right side
              whether or not the list is currently scrolling, so project
              cards and article cards keep identical widths. scroll-academic
              gives the themed scrollbar styling. */}
          <div className="h-full overflow-y-auto scroll-academic [scrollbar-gutter:stable]">
            <div className="px-3 py-3 space-y-2 min-w-0">
              {projects.length === 0 && (
                <div className="text-center py-6 px-3 text-muted-foreground acad-fade-in">
                  <div className="h-12 w-12 mx-auto rounded-xl bg-primary/10 flex items-center justify-center mb-2 ring-academic">
                    <FolderOpen className="h-6 w-6 text-primary" />
                  </div>
                  <p className="text-xs font-medium">{t("projects.empty")}</p>
                  <p className="text-[10px] mt-1 text-muted-foreground/80">
                    {t("projects.emptyHint")}
                  </p>
                </div>
              )}
              {filteredProjects.length === 0 && search && (
                <div className="text-center py-6 px-3 text-muted-foreground acad-fade-in">
                  <div className="h-10 w-10 mx-auto rounded-xl bg-muted/60 flex items-center justify-center mb-2">
                    <Search className="h-5 w-5 opacity-50" />
                  </div>
                  <p className="text-[11px] font-medium">No projects match “{search}”.</p>
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="mt-2 text-[10px] text-primary hover:underline"
                  >
                    Clear search
                  </button>
                </div>
              )}
              {filteredProjects.map((p) => (
                <ProjectItem
                  key={p.id}
                  project={p}
                  active={p.id === activeId}
                  onSelect={() => onSelect(p.id)}
                  onDelete={() => delMut.mutate(p.id)}
                  deleting={delMut.isPending && delMut.variables === p.id}
                />
              ))}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Articles panel — only rendered when there are articles. The
            header (article count + icon) is shrink-0 so it stays visible
            even when the list scrolls. */}
        {articles.length > 0 && (
          <ResizablePanel id="sidebar-articles" order={2} defaultSize={projects.length <= 2 ? 55 : 40} minSize={25}>
            <div className="flex flex-col h-full">
              <div className="panel-section-header flex items-center justify-between shrink-0 border-t hairline">
                <span className="eyebrow flex items-center gap-2">
                  <FileStack className="h-3 w-3 text-primary" />
                  {t("workspace.articleTab") || "Articles"}
                  <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-md bg-muted text-[10px] tabular-nums text-muted-foreground">
                    {articles.length}
                  </span>
                </span>
                {/* Trash button — opens the article trash dialog where users can
                    restore soft-deleted articles or permanently delete them. */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  onClick={() => setTrashOpen(true)}
                  title={t("trash.title") || "Trash — Deleted Articles"}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
              {/* Same scroll-container pattern as the projects panel above
                  (plain overflow-y-auto + stable gutter + inner px-3 div)
                  so both lists lay out cards at exactly the same width. */}
              <div
                className="flex-1 min-h-0 overflow-y-auto scroll-academic [scrollbar-gutter:stable]"
                data-slot="article-scroll"
              >
                <div className="px-3 py-2 space-y-2 min-w-0">
                  {articles.map((a: any) => {
                    const hasZh = !!a.contentZh;
                    const enLen = a.content?.length || 0;
                    const zhLen = a.contentZh?.length || 0;
                    const sections = a._count?.articleParagraph ?? 0;
                    return (
                      <button
                        key={a.id}
                        onClick={() => onOpenArticle?.(a)}
                        className="w-full block group text-left surface-card rounded-xl p-3 space-y-1 overflow-hidden transition-all duration-200 hover:border-primary/30 hover:bg-muted/60"
                        title="Open full article in viewer"
                      >
                        <div className="flex items-start gap-2">
                          <FileStack className="h-3.5 w-3.5 text-primary shrink-0 mt-1" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] font-medium leading-snug line-clamp-2 group-hover:text-primary transition-colors">
                              {a.title}
                            </p>
                            {/* Two compact stat lines instead of one wrapped row — at
                                22% panel width the previous flex-wrap row would push
                                badges past the scroll viewport's right edge. Vertical
                                stacking keeps every badge fully visible regardless of
                                which language metadata the article carries. Chips use
                                the same muted-bg/icon-tint language as project stats. */}
                            <div className="mt-1 space-y-1">
                              <div className="flex items-center gap-1 text-[9px] text-muted-foreground flex-wrap">
                                {sections > 0 && (
                                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted text-muted-foreground text-[9px] font-semibold tabular-nums">
                                    <Layers className="h-2 w-2 text-primary" />
                                    {sections} §
                                  </span>
                                )}
                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted text-muted-foreground text-[9px] font-semibold tabular-nums">
                                  <FileText className="h-2 w-2 text-primary" />
                                  {Math.round(enLen / 6).toLocaleString()}w EN
                                </span>
                              </div>
                              {hasZh && (
                                <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
                                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted text-muted-foreground text-[9px] font-semibold tabular-nums">
                                    <Languages className="h-2 w-2 text-primary" />
                                    {Math.round(zhLen / 2).toLocaleString()}字
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </ResizablePanel>
        )}
      </ResizablePanelGroup>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}

function ProjectItem({
  project,
  active,
  onSelect,
  onDelete,
  deleting,
}: {
  project: Project & { _count?: any };
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [title, setTitle] = React.useState(project.title);
  const [topic, setTopic] = React.useState(project.topic);

  const updateMut = useMutation({
    mutationFn: () => api.updateProject(project.id, { title, topic }),
    onSuccess: () => {
      toast.success(t("toast.projectUpdated"));
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div
      className={`group relative surface-card rounded-xl p-3 transition-all duration-200 cursor-pointer overflow-hidden ${
        active
          ? "bg-primary/10 ring-academic"
          : "hover:border-primary/30"
      }`}
      onClick={onSelect}
    >
      {/* Active indicator — 2px primary bar inset on the left edge so the
          selected project reads instantly, even at a glance. */}
      {active && (
        <span aria-hidden="true" className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-primary" />
      )}
      {editing ? (
        <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-8 text-xs"
          />
          <Textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="text-[11px] min-h-[40px]"
          />
          <div className="flex gap-1">
            <Button
              size="sm"
              className="h-7 text-[10px]"
              onClick={() => updateMut.mutate()}
              disabled={updateMut.isPending}
            >
              {updateMut.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              {t("common.save")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[10px]"
              onClick={() => {
                setEditing(false);
                setTitle(project.title);
                setTopic(project.topic);
              }}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Title row: FlaskConical icon in a tiny primary-tinted tile as visual
              anchor (mirrors the header lockup) + line-clamp-2 title (so long
              titles like "Auto-Iterate Canar..." stay readable instead of
              being truncated mid-word) + hover-only edit/delete actions.
              Native title attribute carries the full title + topic so the
              full text stays reachable via tooltip in the narrow rail. */}
          <div className="flex items-start gap-2">
            <span
              className={`inline-flex items-center justify-center h-5 w-5 rounded-md shrink-0 ${
                active ? "bg-primary/20" : "bg-primary/10"
              }`}
            >
              <FlaskConical className="h-3 w-3 text-primary" />
            </span>
            <div className="flex-1 min-w-0">
              <p
                className="text-xs font-semibold leading-snug line-clamp-2 text-foreground"
                title={project.title}
              >
                {project.title}
              </p>
              {project.topic && (
                <p
                  className="text-[10px] text-muted-foreground line-clamp-2 mt-1 leading-snug"
                  title={project.topic}
                >
                  {project.topic}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(true);
                }}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDelete(true);
                }}
                disabled={deleting}
              >
                {deleting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
              </Button>
            </div>
          </div>
          {/* Stat row: unified muted chips — same shape/size/type language as
              the article meta chips — with primary-tinted icons so all four
              themes render consistently (no hardcoded violet/fuchsia that
              clash with Sunset/Violet/Ocean palettes). The field chip is an
              eyebrow-style uppercase label clamped to 70px so long field
              names ellipsize instead of pushing counts off-screen. */}
          <div className="flex items-center gap-1 mt-2 pr-1">
            {project._count?.paragraphs !== undefined && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted text-muted-foreground text-[9px] font-semibold tabular-nums">
                <FileText className="h-2 w-2 text-primary" />
                {project._count.paragraphs}
              </span>
            )}
            {project._count?.articles !== undefined && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted text-muted-foreground text-[9px] font-semibold tabular-nums">
                <Layers className="h-2 w-2 text-primary" />
                {project._count.articles}
              </span>
            )}
            {project._count?.dataSources !== undefined && project._count.dataSources > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted text-muted-foreground text-[9px] font-semibold tabular-nums">
                <Database className="h-2 w-2 text-primary" />
                {project._count.dataSources}
              </span>
            )}
            {project.field && (
              <span className="eyebrow ml-auto truncate max-w-[70px] pr-1">
                {project.field.replace(/-/g, " ")}
              </span>
            )}
          </div>
        </>
      )}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("projects.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("projects.deleteConfirm", { name: project.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => onDelete()}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t("common.delete")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [title, setTitle] = React.useState("");
  const [topic, setTopic] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [field, setField] = React.useState("structural-biology");

  const createMut = useMutation({
    mutationFn: () =>
      api.createProject({ title, topic, description: description || undefined, field }),
    onSuccess: (data) => {
      toast.success(t("toast.projectCreated"));
      qc.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
      setTitle("");
      setTopic("");
      setDescription("");
      setField("structural-biology");
      // navigate via custom event so the parent selects the new project
      window.dispatchEvent(new CustomEvent("sciwrite:select-project", { detail: data.project.id }));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="h-4 w-4 text-primary" />
            {t("projects.newProject")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("projects.newDesc")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label className="text-xs">{t("projects.titleLabel")}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("projects.titlePlaceholder")}
              className="text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">{t("projects.topicLabel")}</Label>
            <Textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t("projects.topicPlaceholder")}
              className="text-sm min-h-[80px]"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">{t("projects.fieldLabel")}</Label>
            <Select value={field} onValueChange={setField}>
              <SelectTrigger className="text-sm h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELDS.map((f) => (
                  <SelectItem key={f.value} value={f.value} className="text-sm">
                    {t(f.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-xs">{t("projects.notesLabel")}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("projects.notesPlaceholder")}
              className="text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => createMut.mutate()}
            disabled={createMut.isPending || !title.trim() || !topic.trim()}
            className="gap-2"
          >
            {createMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {t("projects.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
