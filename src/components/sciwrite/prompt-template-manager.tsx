"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  FileText,
  Plus,
  Trash2,
  Loader2,
  Save,
  Pencil,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
} from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const TASK_TYPES = [
  { value: "generate", label: "Section Generation" },
  { value: "translate", label: "Translation" },
  { value: "review", label: "AI Review" },
  { value: "gather", label: "Data Gathering" },
  { value: "plan", label: "Outline Planning" },
];

/**
 * Prompt Template Manager Dialog
 *
 * Full CRUD interface for prompt templates. Users can:
 *  - Create new templates (name, taskType, systemPrompt, instruction)
 *  - Edit existing templates
 *  - Delete templates (default templates are protected)
 *
 * Templates are stored in the DB and can be selected from the AI Hub's
 * Full Article tab to customize LLM behavior for specific use cases
 * (e.g. "Clinical focus", "Structural biology emphasis").
 */
export function PromptTemplateManager({ open, onOpenChange }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({
    name: "",
    taskType: "generate",
    systemPrompt: "",
    instruction: "",
  });

  const { data, isLoading } = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: () => api.listPromptTemplates(),
    enabled: open,
  });

  const templates = data?.templates || [];

  const createMut = useMutation({
    mutationFn: () => api.createPromptTemplate({
      name: form.name,
      taskType: form.taskType,
      systemPrompt: form.systemPrompt || undefined,
      instruction: form.instruction || undefined,
    }),
    onSuccess: () => {
      toast.success(t("template.created") || "Template created");
      setForm({ name: "", taskType: "generate", systemPrompt: "", instruction: "" });
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ["prompt-templates"] });
    },
    onError: (e: any) => toast.error(e?.message || "Failed to create template"),
  });

  const updateMut = useMutation({
    mutationFn: (id: string) => api.updatePromptTemplate(id, {
      name: form.name,
      systemPrompt: form.systemPrompt || null,
      instruction: form.instruction || null,
    }),
    onSuccess: () => {
      toast.success(t("template.updated") || "Template updated");
      setEditingId(null);
      setForm({ name: "", taskType: "generate", systemPrompt: "", instruction: "" });
      qc.invalidateQueries({ queryKey: ["prompt-templates"] });
    },
    onError: (e: any) => toast.error(e?.message || "Failed to update template"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deletePromptTemplate(id),
    onSuccess: () => {
      toast.success(t("template.deleted") || "Template deleted");
      qc.invalidateQueries({ queryKey: ["prompt-templates"] });
    },
    onError: (e: any) => toast.error(e?.message || "Failed to delete template"),
  });

  const startEdit = (tpl: any) => {
    setEditingId(tpl.id);
    setForm({
      name: tpl.name,
      taskType: tpl.taskType,
      systemPrompt: tpl.systemPrompt || "",
      instruction: tpl.instruction || "",
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm({ name: "", taskType: "generate", systemPrompt: "", instruction: "" });
  };

  const handleSave = () => {
    if (!form.name.trim()) {
      toast.error(t("template.nameRequired") || "Name is required");
      return;
    }
    if (editingId) {
      updateMut.mutate(editingId);
    } else {
      createMut.mutate();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-muted-foreground" />
            {t("template.title") || "Prompt Template Manager"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("template.desc") || "Create, edit, and delete reusable prompt templates. Templates customize the LLM's behavior for specific tasks."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 min-h-0">
          {/* Template list */}
          <div className="w-1/2 border-r border-border/40 overflow-hidden flex flex-col">
            <div className="px-3 py-2 border-b border-border/40 shrink-0 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                {t("template.templates") || "Templates"} ({templates.length})
              </span>
              {!editingId && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[9px] gap-0.5"
                  onClick={() => setEditingId("new")}
                >
                  <Plus className="h-3 w-3" />
                  {t("template.new") || "New"}
                </Button>
              )}
            </div>
            <ScrollArea className="flex-1 min-h-0">
              <div className="px-3 py-2 space-y-1.5">
                {isLoading && (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                )}
                {!isLoading && templates.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-8">
                    {t("template.empty") || "No templates yet. Click 'New' to create one."}
                  </p>
                )}
                {templates.map((tpl) => (
                  <div
                    key={tpl.id}
                    className={`rounded-md border p-2 space-y-1 cursor-pointer transition-colors ${
                      editingId === tpl.id
                        ? "border-primary/40 bg-primary/[0.04]"
                        : "border-border/50 hover:border-border/80 hover:bg-muted/20"
                    }`}
                    onClick={() => startEdit(tpl)}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium text-foreground truncate flex-1">
                        {tpl.name}
                      </span>
                      {tpl.isDefault && (
                        <Badge variant="outline" className="text-[7px] h-3 px-1 uppercase">
                          Default
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[7px] h-3 px-1">
                        {TASK_TYPES.find((tt) => tt.value === tpl.taskType)?.label || tpl.taskType}
                      </Badge>
                      {tpl.instruction && (
                        <span className="text-[8px] text-muted-foreground/60 truncate">
                          {tpl.instruction.slice(0, 40)}…
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Editor pane */}
          <div className="w-1/2 overflow-hidden flex flex-col">
            {editingId ? (
              <div className="flex flex-col h-full">
                <div className="px-4 py-3 border-b border-border/40 shrink-0 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    {editingId === "new"
                      ? (t("template.create") || "Create Template")
                      : (t("template.edit") || "Edit Template")}
                  </span>
                  <Button variant="ghost" size="sm" className="h-5 px-1.5" onClick={cancelEdit}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
                <ScrollArea className="flex-1 min-h-0">
                  <div className="px-4 py-3 space-y-3">
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">
                        {t("template.nameLabel") || "Name"}
                      </Label>
                      <Input
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        placeholder="e.g. Clinical focus"
                        className="h-8 text-[11px]"
                      />
                    </div>
                    {editingId === "new" && (
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">
                          {t("template.taskTypeLabel") || "Task Type"}
                        </Label>
                        <Select value={form.taskType} onValueChange={(v) => setForm({ ...form, taskType: v })}>
                          <SelectTrigger className="h-8 text-[11px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {TASK_TYPES.map((tt) => (
                              <SelectItem key={tt.value} value={tt.value} className="text-xs">
                                {tt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">
                        {t("template.systemLabel") || "System Prompt (optional)"}
                      </Label>
                      <Textarea
                        value={form.systemPrompt}
                        onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                        placeholder="Overrides the default system prompt for this task type…"
                        className="text-[10px] min-h-[80px] font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">
                        {t("template.instructionLabel") || "Extra Instruction (optional)"}
                      </Label>
                      <Textarea
                        value={form.instruction}
                        onChange={(e) => setForm({ ...form, instruction: e.target.value })}
                        placeholder="Appended to the user prompt, e.g. 'Focus on clinical implications and therapeutic relevance.'"
                        className="text-[10px] min-h-[80px] font-mono"
                      />
                    </div>
                  </div>
                </ScrollArea>
                <div className="px-4 py-2 border-t border-border/40 shrink-0 flex items-center justify-between">
                  {editingId !== "new" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[10px] h-6 gap-1 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                      onClick={() => {
                        deleteMut.mutate(editingId);
                        cancelEdit();
                      }}
                      disabled={deleteMut.isPending}
                    >
                      <Trash2 className="h-3 w-3" />
                      {t("template.delete") || "Delete"}
                    </Button>
                  )}
                  <div className="flex items-center gap-1.5 ml-auto">
                    <Button variant="ghost" size="sm" className="text-[10px] h-6" onClick={cancelEdit}>
                      {t("common.cancel") || "Cancel"}
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      className="text-[10px] h-6 gap-1"
                      onClick={handleSave}
                      disabled={createMut.isPending || updateMut.isPending}
                    >
                      {createMut.isPending || updateMut.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Save className="h-3 w-3" />
                      )}
                      {t("common.save") || "Save"}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center px-4">
                <FileText className="h-8 w-8 text-muted-foreground/40 mb-2" />
                <p className="text-xs text-muted-foreground">
                  {t("template.selectHint") || "Select a template to edit, or click 'New' to create one."}
                </p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
