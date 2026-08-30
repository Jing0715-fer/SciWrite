"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Trash2,
  RotateCcw,
  Loader2,
  AlertTriangle,
  FileText,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { api } from "@/lib/api-client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";
import type { Paragraph } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
}

/**
 * Paragraph Trash Dialog
 *
 * Lists soft-deleted paragraphs for a project. Each paragraph can be:
 *  - Restored (moved back to active paragraphs)
 *  - Permanently deleted (hard delete — irreversible)
 *
 * Supports batch operations: select-all, restore selected, delete selected.
 */
export function ParagraphTrashDialog({ open, onOpenChange, projectId }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [permanentDeleteId, setPermanentDeleteId] = React.useState<string | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [batchDeleteOpen, setBatchDeleteOpen] = React.useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["trashed-paragraphs", projectId],
    queryFn: () => api.listTrashedParagraphs(projectId),
    enabled: open,
  });

  const paragraphs = data?.paragraphs || [];

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelectedIds((prev) =>
      prev.size === paragraphs.length ? new Set() : new Set(paragraphs.map((p) => p.id)),
    );
  };

  const restoreMut = useMutation({
    mutationFn: (id: string) => api.restoreParagraph(id),
    onSuccess: () => {
      toast.success(t("trash.paraRestored") || "Paragraph restored");
      qc.invalidateQueries({ queryKey: ["trashed-paragraphs", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: any) => toast.error(e?.message || "Failed to restore"),
  });

  const permanentDeleteMut = useMutation({
    mutationFn: (id: string) => api.permanentDeleteParagraph(id),
    onSuccess: () => {
      toast.success(t("trash.paraPermanentlyDeleted") || "Paragraph permanently deleted");
      setPermanentDeleteId(null);
      qc.invalidateQueries({ queryKey: ["trashed-paragraphs", projectId] });
    },
    onError: (e: any) => toast.error(e?.message || "Failed to delete"),
  });

  const batchRestoreMut = useMutation({
    mutationFn: (ids: string[]) => api.batchParagraphs("restore", ids),
    onSuccess: (data) => {
      toast.success(t("trash.paraBatchRestored") || `Restored ${data.affected} paragraphs`);
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ["trashed-paragraphs", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: any) => toast.error(e?.message || "Batch restore failed"),
  });

  const batchDeleteMut = useMutation({
    mutationFn: (ids: string[]) => api.batchParagraphs("delete", ids),
    onSuccess: (data) => {
      toast.success(t("trash.paraBatchDeleted") || `Permanently deleted ${data.affected} paragraphs`);
      setSelectedIds(new Set());
      setBatchDeleteOpen(false);
      qc.invalidateQueries({ queryKey: ["trashed-paragraphs", projectId] });
    },
    onError: (e: any) => toast.error(e?.message || "Batch delete failed"),
  });

  const formatDeletedInfo = (deletedAt: string | Date) => {
    const deleted = new Date(deletedAt);
    const now = new Date();
    const daysAgo = Math.floor((now.getTime() - deleted.getTime()) / (1000 * 60 * 60 * 24));
    const daysRemaining = Math.max(0, 30 - daysAgo);
    return { daysAgo, daysRemaining };
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Trash2 className="h-4 w-4 text-muted-foreground" />
            {t("trash.paraTitle") || "Trash — Deleted Paragraphs"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("trash.paraDesc") || "Restore paragraphs or permanently delete them."}
          </DialogDescription>
        </DialogHeader>

        {paragraphs.length > 0 && (
          <div className="px-5 py-2 border-b border-border/40 shrink-0 flex items-center gap-2 bg-muted/10">
            <label className="flex items-center gap-1.5 cursor-pointer text-[10px] text-muted-foreground">
              <input
                type="checkbox"
                checked={selectedIds.size === paragraphs.length && paragraphs.length > 0}
                onChange={toggleSelectAll}
                className="h-3 w-3 rounded border-border accent-primary"
              />
              {t("trash.selectAll") || "Select all"}
            </label>
            {selectedIds.size > 0 && (
              <>
                <span className="text-[10px] text-muted-foreground">
                  {selectedIds.size} {t("trash.selected") || "selected"}
                </span>
                <div className="flex-1" />
                <Button
                  variant="outline" size="sm"
                  className="text-[10px] h-6 gap-1"
                  onClick={() => batchRestoreMut.mutate([...selectedIds])}
                  disabled={batchRestoreMut.isPending}
                >
                  {batchRestoreMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                  {t("trash.restoreSelected") || "Restore selected"}
                </Button>
                <Button
                  variant="outline" size="sm"
                  className="text-[10px] h-6 gap-1 border-red-300/60 dark:border-red-700/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                  onClick={() => setBatchDeleteOpen(true)}
                  disabled={batchDeleteMut.isPending}
                >
                  <Trash2 className="h-3 w-3" />
                  {t("trash.deleteSelected") || "Delete selected"}
                </Button>
              </>
            )}
          </div>
        )}

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-5 py-3 space-y-2">
            {isLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {!isLoading && paragraphs.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Trash2 className="h-8 w-8 text-muted-foreground/40 mb-2" />
                <p className="text-xs text-muted-foreground">
                  {t("trash.paraEmpty") || "Trash is empty — no deleted paragraphs."}
                </p>
              </div>
            )}
            {paragraphs.map((para) => {
              const info = formatDeletedInfo(para.deletedAt!);
              const isSelected = selectedIds.has(para.id);
              return (
                <div
                  key={para.id}
                  className={`rounded-lg border p-3 space-y-2 transition-colors ${
                    isSelected ? "border-primary/40 bg-primary/[0.04]" : "border-border/60 bg-muted/20"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(para.id)}
                      className="h-3 w-3 mt-1 rounded border-border accent-primary shrink-0"
                    />
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{para.title}</p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <Badge variant="outline" className="text-[8px] h-3.5 gap-0.5">
                          <Clock className="h-2.5 w-2.5" />
                          {t("trash.deleted") || "Deleted"} {info.daysAgo}d {t("trash.ago") || "ago"}
                        </Badge>
                        {info.daysRemaining > 0 && (
                          <Badge variant="outline" className="text-[8px] h-3.5 text-amber-600 dark:text-amber-400 border-amber-300/40 dark:border-amber-700/50">
                            {info.daysRemaining}d {t("trash.remaining") || "left"}
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-[8px] h-3.5">{para.format}</Badge>
                        <Badge variant="outline" className="text-[8px] h-3.5">{para.wordCount}w</Badge>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 pl-6">
                    <Button
                      variant="outline" size="sm"
                      className="text-[10px] h-7 gap-1"
                      onClick={() => restoreMut.mutate(para.id)}
                      disabled={restoreMut.isPending}
                    >
                      {restoreMut.isPending && restoreMut.variables === para.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                      {t("trash.restore") || "Restore"}
                    </Button>
                    <Button
                      variant="outline" size="sm"
                      className="text-[10px] h-7 gap-1 border-red-300/60 dark:border-red-700/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                      onClick={() => setPermanentDeleteId(para.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                      {t("trash.deleteForever") || "Delete forever"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>

        <div className="px-5 py-3 border-t border-border/60 shrink-0 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">
            {paragraphs.length} {paragraphs.length === 1 ? "paragraph" : "paragraphs"} {t("trash.inTrash") || "in trash"}
          </span>
          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => onOpenChange(false)}>
            {t("common.close") || "Close"}
          </Button>
        </div>
      </DialogContent>

      <AlertDialog open={!!permanentDeleteId} onOpenChange={(v) => !v && setPermanentDeleteId(null)}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0" />
              {t("trash.paraConfirmTitle") || "Permanently delete this paragraph?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-relaxed">
              {t("trash.confirmPermanentDesc") || "This action cannot be undone. The paragraph and all its data will be permanently removed from the database."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs" disabled={permanentDeleteMut.isPending}>
              {t("common.cancel") || "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              className="text-xs gap-1.5 bg-red-600 hover:bg-red-700 text-white"
              onClick={(e) => { e.preventDefault(); if (permanentDeleteId) permanentDeleteMut.mutate(permanentDeleteId); }}
              disabled={permanentDeleteMut.isPending}
            >
              {permanentDeleteMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              {permanentDeleteMut.isPending ? (t("common.deleting") || "Deleting...") : (t("trash.deleteForever") || "Delete forever")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={batchDeleteOpen} onOpenChange={setBatchDeleteOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0" />
              {t("trash.paraConfirmBatchTitle") || "Permanently delete selected paragraphs?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-relaxed">
              {t("trash.confirmBatchDesc") || "This will permanently delete"}
              {" "}<strong className="text-foreground">{selectedIds.size}</strong>{" "}
              {selectedIds.size === 1 ? "paragraph" : "paragraphs"}.
              {" "}{t("trash.confirmPermanentDesc") || "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs" disabled={batchDeleteMut.isPending}>
              {t("common.cancel") || "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              className="text-xs gap-1.5 bg-red-600 hover:bg-red-700 text-white"
              onClick={(e) => { e.preventDefault(); batchDeleteMut.mutate([...selectedIds]); }}
              disabled={batchDeleteMut.isPending}
            >
              {batchDeleteMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              {batchDeleteMut.isPending ? (t("common.deleting") || "Deleting...") : (t("trash.deleteForever") || "Delete forever")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
