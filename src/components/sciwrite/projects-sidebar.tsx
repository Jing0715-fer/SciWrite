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
  ArrowRight,
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
import { Badge } from "@/components/ui/badge";
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
import { ScrollArea } from "@/components/ui/scroll-area";
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
  /** Articles belonging to the currently-active project. Rendered as a list
   *  below the project list so the user can jump to any composed article. */
  articles?: any[];
  /** Open a composed article in the full viewer. */
  onOpenArticle?: (a: any) => void;
}

export function ProjectsSidebar({ projects, activeId, onSelect, articles = [], onOpenArticle }: Props) {
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
    onSuccess: () => {
      toast.success(t("toast.projectDeleted"));
      qc.invalidateQueries({ queryKey: ["projects"] });
      if (editingId) setEditingId(null);
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
      <div className="glass-subtle px-3 pt-3 pb-2 border-b hairline flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="brand-tile h-6 w-6 rounded-md flex items-center justify-center shrink-0">
            <FlaskConical className="h-3.5 w-3.5 text-primary-foreground" />
          </div>
          <span className="eyebrow flex items-center gap-1.5 truncate">
            {t("projects.title")}
            <span className="tabular-nums opacity-60">{projects.length}</span>
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
              size="sm"
              className="h-7 px-2 gap-1 text-[10px]"
              onClick={() => setShareOpen(true)}
              title={t("share.title") || "Share Project"}
            >
              <Share2 className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            variant="default"
            className="btn-gradient-primary h-7 px-2 gap-1 text-primary-foreground font-medium"
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
          doesn't compete with the "no projects yet" empty state. */}
      {projects.length > 0 && (
        <div className="px-3 py-2 border-b hairline shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/80 pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects…"
              className="h-9 rounded-lg pl-8 pr-8 text-[11px] bg-card border-border/70 focus-visible:border-primary/50 focus-visible:ring-primary/30"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Two vertically-stacked panels: projects (top) + articles (bottom).
          Each has its own ScrollArea so they scroll independently — the
          project list no longer gets pushed off-screen when the article
          list grows. The ResizablePanelGroup lets the user drag the
          divider to taste.
          v107-1: When there are few projects (≤2), give articles more space
          (defaultSize 55) so article boxes display fully. When many projects,
          use 40 to give the list room to scroll. */}
      <ResizablePanelGroup direction="vertical" className="flex-1 min-h-0">
        {/* Projects panel */}
        <ResizablePanel defaultSize={projects.length <= 2 ? 45 : 60} minSize={20}>
          {/* v109-2: Use plain overflow-y-auto instead of ScrollArea to match
              the article panel's behavior. ScrollArea's custom scrollbar
              was clipping the right border of project cards. */}
          {/* round-34: [scrollbar-gutter:stable] on BOTH list containers so
              the 10px classic scrollbar space is always reserved — project
              cards and article cards now keep identical widths whether or
              not either list is currently scrolling. */}
          <div className="h-full overflow-y-auto scroll-academic [scrollbar-gutter:stable]">
            {/* v109-1: Match article list padding (px-3) so project cards
                have the same width as article cards. Previously px-2 made
                project cards narrower than article cards. */}
            <div className="px-3 py-2.5 space-y-2 min-w-0">
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
                  deleting={delMut.isPending}
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
          <ResizablePanel defaultSize={projects.length <= 2 ? 55 : 40} minSize={25}>
            <div className="flex flex-col h-full">
              <div className="flex items-center justify-between px-3 pt-2.5 pb-2 shrink-0 border-t hairline">
                <span className="eyebrow flex items-center gap-1.5">
                  <FileStack className="h-3 w-3" />
                  {t("workspace.articleTab") || "Articles"}
                  <span className="tabular-nums opacity-60">{articles.length}</span>
                </span>
                {/* Trash button — opens the article trash dialog where users can
                    restore soft-deleted articles or permanently delete them. */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[9px] gap-1 text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  onClick={() => setTrashOpen(true)}
                  title={t("trash.title") || "Trash — Deleted Articles"}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
              {/* round-34: same scroll-container pattern as the projects
                  panel above (plain overflow-y-auto + stable gutter + inner
                  px-3 div) so both lists lay out cards at exactly the same
                  width. */}
              <div
                className="flex-1 min-h-0 overflow-y-auto scroll-academic [scrollbar-gutter:stable]"
                data-slot="article-scroll"
              >
                <div className="px-3 pb-2 pt-1 space-y-1.5 min-w-0">
                  {articles.map((a: any) => {
                    const hasZh = !!a.contentZh;
                    const enLen = a.content?.length || 0;
                    const zhLen = a.contentZh?.length || 0;
                    const sections = a._count?.articleParagraph ?? 0;
                    return (
                      <button
                        key={a.id}
                        onClick={() => onOpenArticle?.(a)}
                        className="w-full block group text-left surface-card rounded-xl p-2.5 space-y-1 overflow-hidden transition-all duration-200 hover:border-primary/30 hover:shadow-sm! hover:bg-muted/60!"
                        title="Open full article in viewer"
                      >
                        <div className="flex items-start gap-1.5">
                          <FileStack className="h-3.5 w-3.5 text-violet-700 dark:text-violet-400 shrink-0 mt-0.5" />
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
                            <div className="mt-1 space-y-0.5">
                              <div className="flex items-center gap-1 text-[9px] text-muted-foreground flex-wrap">
                                {sections > 0 && (
                                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground text-[9px] font-semibold tabular-nums">
                                    <Layers className="h-2 w-2 text-violet-700 dark:text-violet-300" />
                                    {sections} §
                                  </span>
                                )}
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground text-[9px] font-semibold tabular-nums">
                                  <FileText className="h-2 w-2 text-primary" />
                                  {Math.round(enLen / 6).toLocaleString()}w EN
                                </span>
                              </div>
                              {hasZh && (
                                <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
                                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground text-[9px] font-semibold tabular-nums">
                                    <Languages className="h-2 w-2 text-fuchsia-700 dark:text-fuchsia-300" />
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
          ? "border-primary/40 bg-primary/[0.06]! ring-academic"
          : "hover:border-primary/30 hover:shadow-sm!"
      }`}
      onClick={onSelect}
    >
      {/* Active indicator — 2.5px primary bar inset on the left edge so the
          selected project reads instantly, even at a glance. */}
      {active && (
        <span aria-hidden="true" className="absolute left-0 top-2 bottom-2 w-[2.5px] rounded-full bg-primary" />
      )}
      {editing ? (
        <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-7 text-xs"
          />
          <Textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="text-[11px] min-h-[40px]"
          />
          <div className="flex gap-1">
            <Button
              size="sm"
              className="h-6 text-[10px]"
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
              className="h-6 text-[10px]"
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
              anchor (mirrors the header lockup) + truncate title + hover-only
              edit/delete actions. Title is bold and uses the foreground color
              so it stands out from the muted topic line. */}
          <div className="flex items-start gap-2">
            <span
              className={`inline-flex items-center justify-center h-5 w-5 rounded-md shrink-0 mt-0.5 ${
                active ? "bg-primary/15" : "bg-primary/10"
              }`}
            >
              <FlaskConical className="h-3 w-3 text-primary" />
            </span>
            <div className="flex-1 min-w-0">
              {/* Native title tooltips mirror the (possibly truncated) title +
                  topic so the full text stays reachable in the narrow rail. */}
              <p
                className="text-xs font-semibold leading-tight truncate text-foreground"
                title={project.title}
              >
                {project.title}
              </p>
              <p
                className="text-[10px] text-muted-foreground line-clamp-2 mt-1 leading-snug"
                title={project.topic}
              >
                {project.topic}
              </p>
            </div>
            <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(true);
                }}
              >
                <Pencil className="h-2.5 w-2.5" />
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
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Trash2 className="h-2.5 w-2.5" />
                )}
              </Button>
            </div>
          </div>
          {/* Stat row: unified muted chips — same shape/size/type language as
              the article meta chips — with only the icon tinted by category
              (primary = paragraphs/data, violet = articles) so the counts stay
              quiet while the category survives at 9px. The field chip is an
              eyebrow-style uppercase label clamped to 60px so long field names
              ellipsize instead of pushing counts off-screen. */}
          <div className="flex items-center gap-1 mt-2.5 pr-1">
            {project._count?.paragraphs !== undefined && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground text-[9px] font-semibold tabular-nums">
                <FileText className="h-2 w-2 text-primary" />
                {project._count.paragraphs}
              </span>
            )}
            {project._count?.articles !== undefined && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground text-[9px] font-semibold tabular-nums">
                <Layers className="h-2 w-2 text-violet-700 dark:text-violet-300" />
                {project._count.articles}
              </span>
            )}
            {project._count?.dataSources !== undefined && project._count.dataSources > 0 && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground text-[9px] font-semibold tabular-nums">
                <Database className="h-2 w-2 text-primary" />
                {project._count.dataSources}
              </span>
            )}
            {project.field && (
              <span className="eyebrow ml-auto truncate max-w-[70px] pr-1.5">
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
          <div className="space-y-1.5">
            <Label className="text-xs">{t("projects.titleLabel")}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("projects.titlePlaceholder")}
              className="text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("projects.topicLabel")}</Label>
            <Textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t("projects.topicPlaceholder")}
              className="text-sm min-h-[80px]"
            />
          </div>
          <div className="space-y-1.5">
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
          <div className="space-y-1.5">
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
