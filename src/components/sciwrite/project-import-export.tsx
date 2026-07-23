"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Download,
  Upload,
  Loader2,
  FileJson,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

interface Props {
  projectId?: string | null;
  variant?: "ghost" | "outline" | "default";
  size?: "sm" | "icon" | "default";
  onImported?: (projectId: string) => void;
}

export function ProjectImportExport({
  projectId,
  variant = "ghost",
  size = "sm",
  onImported,
}: Props) {
  const qc = useQueryClient();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = React.useState<{
    data: any;
    fileName: string;
  } | null>(null);

  const exportMut = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error("No project selected.");
      return api.exportProject(projectId);
    },
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slug(data.project.title)}.sciwrite.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Project exported as JSON backup.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const importMut = useMutation({
    mutationFn: async (data: unknown) => api.importProject(data),
    onSuccess: (data) => {
      toast.success(
        `Imported project "${data.project.title}" with ${data.stats.paragraphs} paragraphs, ${data.stats.articles} articles.`
      );
      qc.invalidateQueries({ queryKey: ["projects"] });
      setImportPreview(null);
      onImported?.(data.project.id);
    },
    onError: (e: Error) => {
      toast.error(e.message);
      setImportPreview(null);
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!data.version || !data.project) {
          toast.error("Invalid SciWrite export file.");
          return;
        }
        setImportPreview({ data, fileName: file.name });
      } catch {
        toast.error("Could not parse JSON file.");
      }
    };
    reader.readAsText(file);
    // reset input so the same file can be re-selected
    e.target.value = "";
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={variant} size={size} className="gap-1.5 text-[11px]">
            <FileJson className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Backup</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Project backup
          </DropdownMenuLabel>
          <DropdownMenuItem
            onClick={() => exportMut.mutate()}
            disabled={exportMut.isPending || !projectId}
          >
            <Download className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-xs">Export as JSON</span>
            {exportMut.isPending && (
              <Loader2 className="h-3 w-3 animate-spin ml-auto" />
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5 text-sky-600" />
            <span className="text-xs">Import from JSON</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="px-2 py-1 text-[9px] text-muted-foreground leading-relaxed">
            Export saves the entire project (paragraphs, annotations, references,
            sources, articles) as a portable .json file. Import creates a new
            project from the backup.
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Import preview dialog */}
      {importPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-card rounded-xl border border-border shadow-xl max-w-md w-full p-5 space-y-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-sky-100 dark:bg-sky-950/40 flex items-center justify-center">
                <Upload className="h-4 w-4 text-sky-600" />
              </div>
              <div>
                <h3 className="text-sm font-semibold">Import project</h3>
                <p className="text-[10px] text-muted-foreground">
                  {importPreview.fileName}
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-border/60 p-3 space-y-1.5 bg-muted/30">
              <p className="text-xs font-semibold">
                {importPreview.data.project.title}
              </p>
              <p className="text-[11px] text-muted-foreground line-clamp-2">
                {importPreview.data.project.topic}
              </p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <span className="badge-emerald px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase">
                  {importPreview.data.paragraphs?.length || 0} ¶
                </span>
                <span className="badge-teal px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase">
                  {importPreview.data.projectReferences?.length || 0} refs
                </span>
                <span className="badge-amber px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase">
                  {importPreview.data.dataSources?.length || 0} sources
                </span>
                <span className="badge-violet px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase">
                  {importPreview.data.articles?.length || 0} articles
                </span>
              </div>
            </div>

            <p className="text-[10px] text-muted-foreground">
              This will create a new project named &ldquo;{importPreview.data.project.title} (imported)&rdquo;.
            </p>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => setImportPreview(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="text-xs gap-1.5"
                onClick={() => importMut.mutate(importPreview.data)}
                disabled={importMut.isPending}
              >
                {importMut.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                Import project
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "project"
  );
}
