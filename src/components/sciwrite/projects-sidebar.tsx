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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  { value: "structural-biology", label: "Structural Biology" },
  { value: "genomics", label: "Genomics" },
  { value: "proteomics", label: "Proteomics" },
  { value: "molecular-biology", label: "Molecular Biology" },
  { value: "biochemistry", label: "Biochemistry" },
  { value: "drug-discovery", label: "Drug Discovery" },
  { value: "clinical", label: "Clinical / Translational" },
  { value: "computational-biology", label: "Computational Biology" },
  { value: "other", label: "Other" },
];

interface Props {
  projects: (Project & { _count?: any })[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

export function ProjectsSidebar({ projects, activeId, onSelect }: Props) {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => {
      toast.success("Project deleted.");
      qc.invalidateQueries({ queryKey: ["projects"] });
      if (editingId) setEditingId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 pt-3 pb-2 border-b border-border/60 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <div className="h-6 w-6 rounded-md bg-primary/10 flex items-center justify-center">
            <FlaskConical className="h-3.5 w-3.5 text-primary" />
          </div>
          <span className="text-xs font-semibold tracking-tight">Projects</span>
        </div>
        <Button
          size="sm"
          variant="default"
          className="h-7 px-2 gap-1"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0 scroll-academic">
        <div className="px-2 py-2 space-y-1">
          {projects.length === 0 && (
            <div className="text-center py-10 px-3 text-muted-foreground">
              <FolderOpen className="h-8 w-8 mx-auto opacity-40 mb-2" />
              <p className="text-xs">No projects yet.</p>
              <p className="text-[10px] mt-1">
                Click “New” to start a research project.
              </p>
            </div>
          )}
          {projects.map((p) => (
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
      </ScrollArea>

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
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [title, setTitle] = React.useState(project.title);
  const [topic, setTopic] = React.useState(project.topic);

  const updateMut = useMutation({
    mutationFn: () => api.updateProject(project.id, { title, topic }),
    onSuccess: () => {
      toast.success("Project updated.");
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div
      className={`group rounded-lg border px-2.5 py-2 transition-all cursor-pointer ${
        active
          ? "border-primary/40 bg-primary/[0.06] ring-academic"
          : "border-transparent hover:border-border/60 hover:bg-muted/40"
      }`}
      onClick={onSelect}
    >
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
              Save
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
          <div className="flex items-start gap-1.5">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium leading-tight truncate">
                {project.title}
              </p>
              <p className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5 leading-snug">
                {project.topic}
              </p>
            </div>
            <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
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
                  if (confirm(`Delete project "${project.title}"? All paragraphs and articles will be removed.`)) {
                    onDelete();
                  }
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
          <div className="flex items-center gap-1 mt-1.5">
            {project._count?.paragraphs !== undefined && (
              <span className="badge-slate px-1 py-0.5 rounded text-[8px] font-semibold uppercase">
                {project._count.paragraphs}¶
              </span>
            )}
            {project._count?.articles !== undefined && (
              <span className="badge-slate px-1 py-0.5 rounded text-[8px] font-semibold uppercase">
                {project._count.articles}A
              </span>
            )}
            {project._count?.dataSources !== undefined && project._count.dataSources > 0 && (
              <span className="badge-slate px-1 py-0.5 rounded text-[8px] font-semibold uppercase">
                {project._count.dataSources}S
              </span>
            )}
            {project.field && (
              <span className="text-[8px] text-muted-foreground ml-auto capitalize truncate max-w-[70px]">
                {project.field.replace("-", " ")}
              </span>
            )}
          </div>
        </>
      )}
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
  const qc = useQueryClient();
  const [title, setTitle] = React.useState("");
  const [topic, setTopic] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [field, setField] = React.useState("structural-biology");

  const createMut = useMutation({
    mutationFn: () =>
      api.createProject({ title, topic, description: description || undefined, field }),
    onSuccess: (data) => {
      toast.success("Project created.");
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
            New Research Project
          </DialogTitle>
          <DialogDescription className="text-xs">
            Define your research topic and field. The AI will use this as the
            scope for literature search and writing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Project title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. CRISPR-Cas9 Specificity Review"
              className="text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Research topic / direction</Label>
            <Textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Describe the scientific question or theme in 1–3 sentences…"
              className="text-sm min-h-[80px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Field</Label>
            <Select value={field} onValueChange={setField}>
              <SelectTrigger className="text-sm h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELDS.map((f) => (
                  <SelectItem key={f.value} value={f.value} className="text-sm">
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Notes (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Any extra context…"
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
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
