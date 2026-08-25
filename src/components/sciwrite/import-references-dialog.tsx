"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Loader2,
  Upload,
  FileText,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
  ClipboardPaste,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
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
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string | null;
}

/**
 * ImportReferencesDialog — bulk-import references from .bib/.ris files.
 *
 * Two input modes:
 *  1. Upload: drag-and-drop or click to select a .bib/.ris file. The file
 *     content is read client-side and sent to the API.
 *  2. Paste: paste BibTeX or RIS text directly into a textarea.
 *
 * After import, shows a results summary (imported/skipped/total) + a per-entry
 * detail list with status (imported/duplicate) and which fields were extracted.
 *
 * Supported formats:
 *  - BibTeX (.bib): @article{key, title={...}, author={...}, ...}
 *  - RIS (.ris): TY  - JOUR / AU  - ... / ER  -
 */
export function ImportReferencesDialog({ open, onOpenChange, projectId }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();

  const [format, setFormat] = React.useState<"bib" | "ris">("bib");
  const [textContent, setTextContent] = React.useState("");
  const [fileName, setFileName] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const importMut = useMutation({
    mutationFn: ({
      content,
      fmt,
    }: {
      content: string;
      fmt: "bib" | "ris";
    }) => api.importReferences(projectId!, content, fmt),
    onSuccess: (data) => {
      toast.success(
        `Imported ${data.imported} references (${data.skipped} skipped)`,
      );
      // Invalidate reference queries so the UI refreshes
      qc.invalidateQueries({ queryKey: ["references"] });
      qc.invalidateQueries({ queryKey: ["paragraphs"] });
      qc.invalidateQueries({ queryKey: ["project"] });
    },
    onError: (e: any) => toast.error(e?.message || "Import failed"),
  });

  // ── File upload handler ────────────────────────────────────────────────────
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Auto-detect format from extension
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext === "ris") setFormat("ris");
    else if (ext === "bib" || ext === "bibtex") setFormat("bib");

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = String(ev.target?.result || "");
      setTextContent(text);
    };
    reader.onerror = () => toast.error("Failed to read file");
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext === "ris") setFormat("ris");
    else if (ext === "bib" || ext === "bibtex") setFormat("bib");

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => setTextContent(String(ev.target?.result || ""));
    reader.readAsText(file);
  };

  const handleImport = () => {
    if (!projectId) {
      toast.error("No project selected");
      return;
    }
    if (!textContent.trim()) {
      toast.error("No content to import");
      return;
    }
    importMut.mutate({ content: textContent, fmt: format });
  };

  const handleReset = () => {
    setTextContent("");
    setFileName(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    importMut.reset();
  };

  const data = importMut.data;
  const canImport = textContent.trim().length > 0 && projectId && !importMut.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) handleReset();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[88vh] flex flex-col gap-0 p-0 overflow-hidden rounded-xl">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border/60 shrink-0 bg-gradient-to-r from-primary/5 to-transparent">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Upload className="h-4 w-4 text-purple-600" />
            Import References
          </DialogTitle>
          <DialogDescription className="text-xs">
            Bulk-import from BibTeX (.bib) or RIS (.ris) files exported by
            Zotero, Mendeley, EndNote, etc.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1">
          <div className="px-5 py-4 space-y-4">
            {/* ── Format selector ────────────────────────────────────────────── */}
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5 block">
                Format
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => setFormat("bib")}
                  className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                    format === "bib"
                      ? "border-purple-400/60 bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-300"
                      : "border-border/60 bg-card text-muted-foreground hover:bg-accent/30"
                  }`}
                >
                  <FileText className="h-3.5 w-3.5 inline mr-1.5" />
                  BibTeX (.bib)
                </button>
                <button
                  onClick={() => setFormat("ris")}
                  className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                    format === "ris"
                      ? "border-purple-400/60 bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-300"
                      : "border-border/60 bg-card text-muted-foreground hover:bg-accent/30"
                  }`}
                >
                  <FileText className="h-3.5 w-3.5 inline mr-1.5" />
                  RIS (.ris)
                </button>
              </div>
            </div>

            {/* ── Input tabs: Upload vs Paste ───────────────────────────────── */}
            {!data && (
              <Tabs defaultValue="upload">
                <TabsList className="grid w-full grid-cols-2 max-w-xs">
                  <TabsTrigger value="upload" className="text-xs gap-1.5">
                    <Upload className="h-3 w-3" />
                    Upload File
                  </TabsTrigger>
                  <TabsTrigger value="paste" className="text-xs gap-1.5">
                    <ClipboardPaste className="h-3 w-3" />
                    Paste Text
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="upload" className="mt-3">
                  <div
                    onDrop={handleDrop}
                    onDragOver={(e) => e.preventDefault()}
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed border-border/60 rounded-xl p-8 text-center cursor-pointer hover:border-purple-400/60 hover:bg-purple-50/30 dark:hover:bg-purple-950/10 transition-colors"
                  >
                    <Upload className="h-8 w-8 text-muted-foreground/50 mx-auto mb-3" />
                    <p className="text-xs font-medium mb-1">
                      {fileName || "Drop a .bib/.ris file here or click to browse"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      Format auto-detected from file extension
                    </p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".bib,.bibtex,.ris,.txt"
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                  </div>
                  {textContent && (
                    <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                      <span>
                        {textContent.length.toLocaleString()} chars loaded
                        {fileName && ` from ${fileName}`}
                      </span>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="paste" className="mt-3">
                  <Textarea
                    value={textContent}
                    onChange={(e) => setTextContent(e.target.value)}
                    placeholder={
                      format === "bib"
                        ? "@article{smith2024,\n  title = {Deep learning for protein structure},\n  author = {Smith, John and Doe, Jane},\n  journal = {Nature},\n  year = {2024},\n  doi = {10.1038/...},\n}"
                        : "TY  - JOUR\nAU  - Smith, John\nTI  - Deep learning for protein structure\nJO  - Nature\nPY  - 2024\nDO  - 10.1038/...\nER  -"
                    }
                    className="font-mono text-[11px] min-h-[200px] resize-y"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1.5">
                    Paste your {format === "bib" ? "BibTeX" : "RIS"} entries above. Multiple entries are supported.
                  </p>
                </TabsContent>
              </Tabs>
            )}

            {/* ── Import results ─────────────────────────────────────────────── */}
            {importMut.isPending && (
              <div className="flex flex-col items-center justify-center py-12 gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
                <p className="text-xs text-muted-foreground">
                  Parsing & importing references…
                </p>
              </div>
            )}

            {data && (
              <>
                {/* Summary stats */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg border border-emerald-200/60 dark:border-emerald-800/40 p-3 text-center bg-emerald-50/50 dark:bg-emerald-950/20">
                    <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                      {data.imported}
                    </div>
                    <div className="text-[9px] text-muted-foreground uppercase tracking-wide">
                      Imported
                    </div>
                  </div>
                  <div className="rounded-lg border border-amber-200/60 dark:border-amber-800/40 p-3 text-center bg-amber-50/40 dark:bg-amber-950/10">
                    <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
                      {data.skipped}
                    </div>
                    <div className="text-[9px] text-muted-foreground uppercase tracking-wide">
                      Skipped
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/60 p-3 text-center bg-card">
                    <div className="text-2xl font-bold text-foreground">
                      {data.total}
                    </div>
                    <div className="text-[9px] text-muted-foreground uppercase tracking-wide">
                      Total Parsed
                    </div>
                  </div>
                </div>

                {data.message && (
                  <p className="text-[11px] text-muted-foreground italic">
                    {data.message}
                  </p>
                )}

                {/* Per-reference details */}
                {data.details.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold mb-2">
                      Imported References ({data.details.length})
                    </h3>
                    <div className="space-y-1.5 max-h-64 overflow-y-auto rounded-lg border border-border/40 p-2">
                      {data.details.map((d, i) => (
                        <div
                          key={i}
                          className={`flex items-start gap-2 p-2 rounded-md text-[11px] ${
                            d.status === "imported"
                              ? "bg-emerald-50/40 dark:bg-emerald-950/10"
                              : "bg-amber-50/30 dark:bg-amber-950/10"
                          } ${i % 2 === 0 ? "" : "bg-muted/10"}`}
                        >
                          <div className="mt-0.5 shrink-0">
                            {d.status === "imported" ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                            ) : (
                              <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span className="font-medium truncate">
                                {d.title || "(untitled)"}
                              </span>
                              {d.citationKey && (
                                <Badge
                                  variant="outline"
                                  className="text-[7px] h-3 px-1 font-mono shrink-0"
                                >
                                  {d.citationKey}
                                </Badge>
                              )}
                            </div>
                            {d.fields.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {d.fields.map((f) => (
                                  <span
                                    key={f}
                                    className="text-[9px] px-1 py-0.5 rounded bg-purple-100/60 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300"
                                  >
                                    {f}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-[9px] text-amber-500">
                                {d.status === "duplicate" ? "Duplicate — already exists in project" : "No fields extracted"}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs gap-1.5"
                  onClick={handleReset}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Import Another File
                </Button>
              </>
            )}
          </div>
        </ScrollArea>

        {!data && (
          <DialogFooter className="px-5 py-3 border-t border-border/60 shrink-0 flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">
              {textContent
                ? `${textContent.length.toLocaleString()} chars ready`
                : "No content loaded yet"}
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => onOpenChange(false)}
                disabled={importMut.isPending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="text-xs gap-1.5"
                onClick={handleImport}
                disabled={!canImport}
              >
                {importMut.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                Import References
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
