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
  onDeleted?: (deletedId: string) => void;
  articles?: any[];
  onOpenArticle?: (a: any) => void;
}

/**
 * ProjectsSidebar — redesigned "project rail".
 *
 * Architectural change: instead of a grid of discrete surface-cards,
 * projects now render as a flat list of list-items in a continuous
 * rail. Each item has:
 * - A left active-indicator bar (theme-shaped: thin line for Emerald,
 *   rounded pill for Ocean, thick block for Sunset, glowing bar for
 *   Violet — real structural difference per theme via CSS).
 * - A compact 2-line title + topic (line-clamp-2).
 * - A meta row with field tag + counts.
 * - Hover-revealed edit/delete actions.
 * The rail feels like a file-browser sidebar, not a card grid.
 */
export function ProjectsSidebar({ projects, activeId, onSelect, onDeleted, articles = [], onOpenArticle }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [trashOpen, setTrashOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
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
      if (id === activeId) onDeleted?.(id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [editingId, setEditingId] = React.useState<string | null>(null);

  return (
    <div className="atlas-rail">
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

      {/* Rail header — title + count + actions */}
      <div className="atlas-rail-header">
        <div className="atlas-rail-title-row">
          <div className="flex items-center gap-2 min-w-0">
            <div className="brand-tile h-6 w-6 rounded-md flex items-center justify-center shrink-0">
              <FlaskConical className="h-3 w-3 text-primary-foreground" />
            </div>
            <span className="atlas-rail-title">{t("projects.title")}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span className="atlas-rail-count">{projects.length}</span>
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
              className="btn-gradient-primary h-7 px-2.5 gap-1 text-primary-foreground font-medium"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">{t("projects.new")}</span>
            </Button>
          </div>
        </div>

        {/* Search row */}
        {projects.length > 0 && (
          <div className="atlas-search-wrap">
            <Search className="atlas-search-icon" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects…"
              className="atlas-search-input"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 h-5 w-5 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Resizable: projects list + articles list */}
      <ResizablePanelGroup direction="vertical" className="flex-1 min-h-0">
        <ResizablePanel
          id="sidebar-projects"
          order={1}
          defaultSize={articles.length > 0 ? (projects.length <= 2 ? 45 : 60) : 100}
          minSize={20}
        >
          <div className="h-full overflow-y-auto scroll-academic [scrollbar-gutter:stable]">
            {projects.length === 0 && (
              <div className="text-center py-8 px-4 text-muted-foreground acad-fade-in">
                <div className="h-12 w-12 mx-auto rounded-xl bg-primary/10 flex items-center justify-center mb-3 ring-academic">
                  <FolderOpen className="h-6 w-6 text-primary" />
                </div>
                <p className="text-xs font-medium">{t("projects.empty")}</p>
                <p className="text-[10px] mt-1 text-muted-foreground/80">
                  {t("projects.emptyHint")}
                </p>
              </div>
            )}
            {filteredProjects.length === 0 && search && (
              <div className="text-center py-8 px-4 text-muted-foreground acad-fade-in">
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
            <div className="min-w-0">
              {filteredProjects.map((p) => (
                <ProjectItem
                  key={p.id}
                  project={p}
                  active={p.id === activeId}
                  editing={editingId === p.id}
                  onEdit={(open) => setEditingId(open ? p.id : null)}
                  onSelect={() => onSelect(p.id)}
                  onDelete={() => delMut.mutate(p.id)}
                  deleting={delMut.isPending && delMut.variables === p.id}
                />
              ))}
            </div>
          </div>
        </ResizablePanel>

        {articles.length > 0 && (
          <ResizableHandle withHandle />
        )}

        {articles.length > 0 && (
          <ResizablePanel id="sidebar-articles" order={2} defaultSize={projects.length <= 2 ? 55 : 40} minSize={25}>
            <div className="flex flex-col h-full">
              <div className="atlas-data-header border-t hairline">
                <span className="atlas-data-section-title">
                  <span className="atlas-data-section-title-icon">
                    <FileStack className="h-3 w-3" />
                  </span>
                  {t("workspace.articleTab") || "Articles"}
                  <span className="atlas-rail-count">{articles.length}</span>
                </span>
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
              <div
                className="flex-1 min-h-0 overflow-y-auto scroll-academic [scrollbar-gutter:stable]"
                data-slot="article-scroll"
              >
                <div className="p-2 space-y-2 min-w-0">
                  {articles.map((a: any) => {
                    const hasZh = !!a.contentZh;
                    const enLen = a.content?.length || 0;
                    const zhLen = a.contentZh?.length || 0;
                    const sections = a._count?.articleParagraph ?? 0;
                    return (
                      <button
                        key={a.id}
                        onClick={() => onOpenArticle?.(a)}
                        className="atlas-result-card block w-full group text-left space-y-1"
                        title="Open full article in viewer"
                      >
                        <div className="flex items-start gap-2">
                          <FileStack className="h-3.5 w-3.5 text-primary shrink-0 mt-1" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] font-medium leading-snug line-clamp-2 group-hover:text-primary transition-colors">
                              {a.title}
                            </p>
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
  editing,
  onEdit,
  onSelect,
  onDelete,
  deleting,
}: {
  project: Project & { _count?: any };
  active: boolean;
  editing: boolean;
  onEdit: (open: boolean) => void;
  onSelect: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [title, setTitle] = React.useState(project.title);
  const [topic, setTopic] = React.useState(project.topic);

  const updateMut = useMutation({
    mutationFn: () => api.updateProject(project.id, { title, topic }),
    onSuccess: () => {
      toast.success(t("toast.projectUpdated"));
      onEdit(false);
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div
      className={`atlas-project-item group ${active ? "atlas-project-item-active" : ""}`}
      onClick={onSelect}
    >
      {editing ? (
        <div className="space-y-2 py-1" onClick={(e) => e.stopPropagation()}>
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
                onEdit(false);
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
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <p
                className="atlas-project-title"
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
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(true);
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
          <div className="atlas-project-meta">
            {project._count?.paragraphs !== undefined && (
              <span className="inline-flex items-center gap-1">
                <FileText className="h-2.5 w-2.5 text-primary" />
                {project._count.paragraphs} paras
              </span>
            )}
            {project._count?.articles !== undefined && (
              <span className="inline-flex items-center gap-1">
                <Layers className="h-2.5 w-2.5 text-primary" />
                {project._count.articles} arts
              </span>
            )}
            {project._count?.dataSources !== undefined && project._count.dataSources > 0 && (
              <span className="inline-flex items-center gap-1">
                <Database className="h-2.5 w-2.5 text-primary" />
                {project._count.dataSources} src
              </span>
            )}
            {project.field && (
              <span className="atlas-project-field-tag ml-auto truncate max-w-[80px]">
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
