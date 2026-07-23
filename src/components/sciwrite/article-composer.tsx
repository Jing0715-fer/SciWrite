"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Layers,
  Loader2,
  ArrowUp,
  ArrowDown,
  FileStack,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MarkdownCitations } from "./markdown-citations";
import { ExportMenu } from "./export-menu";
import type { Paragraph } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  paragraphs: (Paragraph & { _count?: any })[];
}

export function ArticleComposer({
  open,
  onOpenChange,
  projectId,
  paragraphs,
}: Props) {
  const qc = useQueryClient();
  const [title, setTitle] = React.useState("");
  const [abstract, setAbstract] = React.useState("");
  const [depth, setDepth] = React.useState<"shallow" | "standard" | "deep">("standard");
  const [order, setOrder] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (open) {
      setOrder(paragraphs.map((p) => p.id));
      setTitle("");
      setAbstract("");
      setDepth("standard");
    }
  }, [open, paragraphs]);

  const move = (id: string, dir: -1 | 1) => {
    setOrder((prev) => {
      const i = prev.indexOf(id);
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const copy = [...prev];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  };

  const composeMut = useMutation({
    mutationFn: async () => {
      if (order.length < 2) throw new Error("Select at least 2 paragraphs to compose.");
      if (!title.trim()) throw new Error("Please provide an article title.");
      return api.aiCompose({
        projectId,
        title: title.trim(),
        abstract: abstract.trim() || undefined,
        paragraphIds: order,
        depth,
      });
    },
    onSuccess: () => {
      toast.success("Article composed & saved.");
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const orderedParagraphs = order
    .map((id) => paragraphs.find((p) => p.id === id))
    .filter(Boolean) as typeof paragraphs;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4 text-primary" />
            Compose Deeper Article
          </DialogTitle>
          <DialogDescription className="text-xs">
            Arrange paragraphs into a coherent, deeply-synthesized research article.
            The AI stitches sections, preserves citations, and adds a references list.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-6 py-4 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Article title</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Structural and Functional Insights into CRISPR-Cas9 Specificity"
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Abstract (optional)</Label>
              <Textarea
                value={abstract}
                onChange={(e) => setAbstract(e.target.value)}
                placeholder="Optional guiding abstract for the AI…"
                className="text-xs min-h-[56px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Composition depth</Label>
              <Select value={depth} onValueChange={(v) => setDepth(v as any)}>
                <SelectTrigger className="text-xs h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shallow" className="text-xs">
                    Shallow — light stitching
                  </SelectItem>
                  <SelectItem value="standard" className="text-xs">
                    Standard — smooth synthesis
                  </SelectItem>
                  <SelectItem value="deep" className="text-xs">
                    Deep — full synthesis &amp; discussion
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs flex items-center gap-1.5">
                  <FileStack className="h-3 w-3" /> Paragraph order ({order.length})
                </Label>
              </div>
              <div className="space-y-1.5 rounded-md border border-border/60 p-2">
                {orderedParagraphs.length === 0 && (
                  <p className="text-[11px] text-muted-foreground p-2">
                    No paragraphs available. Generate some first.
                  </p>
                )}
                {orderedParagraphs.map((p, i) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5"
                  >
                    <span className="text-[10px] font-mono text-muted-foreground w-5 text-center">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-medium truncate">{p.title}</p>
                      <p className="text-[9px] text-muted-foreground">
                        {p.format} · {p.scenario} · {p.wordCount}w
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => move(p.id, -1)}
                      disabled={i === 0}
                    >
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => move(p.id, 1)}
                      disabled={i === orderedParagraphs.length - 1}
                    >
                      <ArrowDown className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </ScrollArea>

        <DialogFooter className="px-6 py-3 border-t border-border/60">
          <Button
            onClick={() => composeMut.mutate()}
            disabled={composeMut.isPending || order.length < 2 || !title.trim()}
            className="gap-2"
          >
            {composeMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {composeMut.isPending ? "Composing…" : "Compose article"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ArticleViewer({
  article,
  onClose,
}: {
  article: { id: string; title: string; abstract?: string | null; content: string };
  onClose: () => void;
}) {
  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[88vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60">
          <DialogTitle className="text-base font-serif-text">
            {article.title}
          </DialogTitle>
          {article.abstract && (
            <DialogDescription className="text-xs italic mt-1">
              {article.abstract}
            </DialogDescription>
          )}
        </DialogHeader>
        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-8 py-5">
            <MarkdownCitations content={article.content} className="text-[13.5px]" />
          </div>
        </ScrollArea>
        <div className="px-6 py-3 border-t border-border/60 flex items-center justify-end gap-2">
          <ExportMenu type="article" id={article.id} variant="outline" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
