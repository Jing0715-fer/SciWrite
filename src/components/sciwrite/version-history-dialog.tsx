"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  History,
  Loader2,
  RotateCcw,
  GitCompare,
  Save,
  X,
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

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  articleId: string;
  articleTitle: string;
}

/**
 * Version History Dialog
 *
 * Shows all saved version snapshots of an article. The user can:
 *  - Save a new snapshot ("Save version" button)
 *  - Select two versions to diff (click to select, then "Compare")
 *  - Restore a previous version (with confirmation — current content is
 *    auto-saved as a new version before restore, so it's undoable)
 *
 * The diff is a simple line-by-line comparison: added lines are green,
 * removed lines are red, unchanged lines are gray. This is NOT a
 * word-level diff — it's fast and good enough for spotting structural
 * changes between versions.
 */
export function VersionHistoryDialog({ open, onOpenChange, articleId, articleTitle }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [selectedForDiff, setSelectedForDiff] = React.useState<Set<string>>(new Set());
  const [diffData, setDiffData] = React.useState<{ left: any; right: any } | null>(null);
  const [restoreId, setRestoreId] = React.useState<string | null>(null);
  const [saveLabel, setSaveLabel] = React.useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["article-versions", articleId],
    queryFn: () => api.listArticleVersions(articleId),
    enabled: open,
  });

  const versions = data?.versions || [];

  const saveMut = useMutation({
    mutationFn: () => api.createArticleVersion(articleId, saveLabel.trim() || undefined),
    onSuccess: () => {
      toast.success(t("version.saved") || "Version saved");
      setSaveLabel("");
      qc.invalidateQueries({ queryKey: ["article-versions", articleId] });
    },
    onError: (e: any) => toast.error(e?.message || "Failed to save version"),
  });

  const restoreMut = useMutation({
    mutationFn: (versionId: string) => api.restoreArticleVersion(articleId, versionId),
    onSuccess: () => {
      toast.success(t("version.restored") || "Version restored — current content was saved as a new version first");
      setRestoreId(null);
      qc.invalidateQueries({ queryKey: ["article-versions", articleId] });
      qc.invalidateQueries({ queryKey: ["project"] });
    },
    onError: (e: any) => toast.error(e?.message || "Failed to restore"),
  });

  // Diff two versions: fetch both, compute line-by-line diff
  const compareMut = useMutation({
    mutationFn: async (ids: string[]) => {
      const [v1, v2] = await Promise.all(
        ids.map((id) => api.getArticleVersion(articleId, id))
      );
      return { left: v1.version, right: v2.version };
    },
    onSuccess: (data) => {
      setDiffData(data);
    },
    onError: (e: any) => toast.error(e?.message || "Failed to load diff"),
  });

  const toggleDiffSelect = (id: string) => {
    setSelectedForDiff((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 2) next.add(id);
      else {
        // Already 2 selected — replace the oldest with the new one
        next.clear();
        next.add(id);
      }
      return next;
    });
  };

  const handleCompare = () => {
    if (selectedForDiff.size !== 2) return;
    compareMut.mutate([...selectedForDiff]);
  };

  // Simple line-by-line diff: split both contents by newline, mark each line
  // as "same", "added" (in right but not left), or "removed" (in left but not right).
  const computeDiff = (left: string, right: string) => {
    const leftLines = left.split("\n");
    const rightLines = right.split("\n");
    const leftSet = new Set(leftLines);
    const rightSet = new Set(rightLines);
    const result: { text: string; type: "same" | "added" | "removed" }[] = [];

    // Show removed lines first (from left), then added lines (from right)
    for (const line of leftLines) {
      if (!rightSet.has(line)) {
        result.push({ text: line, type: "removed" });
      } else {
        result.push({ text: line, type: "same" });
      }
    }
    for (const line of rightLines) {
      if (!leftSet.has(line)) {
        result.push({ text: line, type: "added" });
      }
    }
    return result;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden rounded-xl">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border/60 shrink-0 bg-gradient-to-r from-primary/5 to-transparent">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <div className="flex items-center justify-center h-7 w-7 rounded-md bg-primary/10 text-primary">
              <History className="h-4 w-4" />
            </div>
            {t("version.title") || "Version History"}
            {versions.length > 0 && (
              <Badge variant="outline" className="text-[9px] h-4 px-1.5 gap-0.5 font-mono">
                {versions.length}
              </Badge>
            )}
            <span className="text-[10px] text-muted-foreground font-normal truncate ml-1">
              {articleTitle.slice(0, 50)}
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("version.desc") || "Save snapshots, compare versions, or restore a previous version. Restoring auto-saves the current content first."}
          </DialogDescription>
        </DialogHeader>

        {/* Save new version bar */}
        <div className="px-5 py-2 border-b border-border/40 shrink-0 flex items-center gap-2 bg-muted/10">
          <input
            type="text"
            value={saveLabel}
            onChange={(e) => setSaveLabel(e.target.value)}
            placeholder={t("version.labelPlaceholder") || "Label (optional, e.g. 'before revision')"}
            className="flex-1 h-7 text-[11px] rounded-md border border-input bg-background px-2.5 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
          />
          <Button
            variant="default"
            size="sm"
            className="text-[10px] h-7 gap-1"
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending}
          >
            {saveMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            {t("version.saveBtn") || "Save version"}
          </Button>
          {selectedForDiff.size === 2 && (
            <Button
              variant="outline"
              size="sm"
              className="text-[10px] h-7 gap-1"
              onClick={handleCompare}
              disabled={compareMut.isPending}
            >
              {compareMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitCompare className="h-3 w-3" />}
              {t("version.compare") || "Compare"}
            </Button>
          )}
        </div>

        {/* Version list or diff view */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-5 py-3">
            {isLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {!isLoading && versions.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <History className="h-8 w-8 text-muted-foreground/40 mb-2" />
                <p className="text-xs text-muted-foreground">
                  {t("version.empty") || "No saved versions yet. Click 'Save version' to create a snapshot."}
                </p>
              </div>
            )}

            {/* Diff view */}
            {diffData && (
              <div className="mb-4 rounded-lg border border-border/60 overflow-hidden">
                <div className="px-3 py-2 bg-muted/30 border-b border-border/40 flex items-center justify-between">
                  <span className="text-[10px] font-mono text-muted-foreground">
                    Diff: <span className="text-red-500">− removed</span> / <span className="text-emerald-500">+ added</span>
                  </span>
                  <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[9px]" onClick={() => setDiffData(null)}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
                <div className="font-mono text-[10px] leading-relaxed max-h-96 overflow-y-auto scroll-academic">
                  {computeDiff(diffData.left.content, diffData.right.content).map((line, i) => (
                    <div
                      key={i}
                      className={`px-3 py-0.5 ${
                        line.type === "added"
                          ? "bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400"
                          : line.type === "removed"
                          ? "bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-400 line-through"
                          : "text-muted-foreground/50"
                      }`}
                    >
                      {line.type === "added" ? "+ " : line.type === "removed" ? "− " : "  "}
                      {line.text.slice(0, 120) || " "}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Version list */}
            <div className="space-y-1.5">
              {versions.map((v, i) => {
                const isSelected = selectedForDiff.has(v.id);
                return (
                  <div
                    key={v.id}
                    className={`rounded-md border p-2.5 flex items-center gap-2 transition-colors cursor-pointer ${
                      isSelected
                        ? "border-primary/40 bg-primary/[0.04]"
                        : "border-border/50 hover:border-border/80 hover:bg-muted/20"
                    }`}
                    onClick={() => toggleDiffSelect(v.id)}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleDiffSelect(v.id)}
                        className="h-3 w-3 rounded border-border accent-primary shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] font-medium text-foreground truncate">
                            {v.label || `Version ${versions.length - i}`}
                          </span>
                          {i === 0 && (
                            <Badge variant="outline" className="text-[7px] h-3 px-1 uppercase text-emerald-600 border-emerald-300/40">
                              Latest
                            </Badge>
                          )}
                        </div>
                        <p className="text-[9px] text-muted-foreground">
                          {new Date(v.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                          {" · "}
                          {v.wordCount}w
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[9px] h-6 px-2 gap-1 text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRestoreId(v.id);
                      }}
                    >
                      <RotateCcw className="h-3 w-3" />
                      {t("version.restore") || "Restore"}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        </ScrollArea>

        <div className="px-5 py-3 border-t border-border/60 shrink-0 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">
            {versions.length} {versions.length === 1 ? "version" : "versions"}
            {selectedForDiff.size > 0 && ` · ${selectedForDiff.size} selected for diff`}
          </span>
          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => onOpenChange(false)}>
            {t("common.close") || "Close"}
          </Button>
        </div>
      </DialogContent>

      {/* Restore confirmation */}
      <AlertDialog open={!!restoreId} onOpenChange={(v) => !v && setRestoreId(null)}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <RotateCcw className="h-5 w-5 text-amber-600 shrink-0" />
              {t("version.confirmRestoreTitle") || "Restore this version?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-relaxed">
              {t("version.confirmRestoreDesc") || "The article will be reverted to this version's content. The current content will be automatically saved as a new version first, so you can undo this restore."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs" disabled={restoreMut.isPending}>
              {t("common.cancel") || "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              className="text-xs gap-1.5"
              onClick={(e) => {
                e.preventDefault();
                if (restoreId) restoreMut.mutate(restoreId);
              }}
              disabled={restoreMut.isPending}
            >
              {restoreMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              {t("version.restore") || "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
