"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2, GitBranch, Table as TableIcon, Lightbulb } from "lucide-react";
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
import { api } from "@/lib/api-client";
import { useMutation } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  articleId: string;
}

/**
 * Diagram Dialog
 *
 * AI-generated visual representations of the article:
 *  - Comparison table (rendered from Markdown)
 *  - Flow diagram (Mermaid syntax, rendered as text with instructions)
 *  - Key findings (bulleted list)
 *
 * The user can regenerate at any time. The Mermaid flowchart is shown as
 * source code (the user can paste it into mermaid.live or any Mermaid
 * renderer).
 */
export function DiagramDialog({ open, onOpenChange, articleId }: Props) {
  const { t } = useI18n();

  const genMut = useMutation({
    mutationFn: () => api.generateDiagram(articleId),
    onError: (e: any) => toast.error(e?.message || "Generation failed"),
  });

  React.useEffect(() => {
    if (open && !genMut.data && !genMut.isPending) {
      genMut.mutate();
    }
  }, [open]);

  const data = genMut.data;

  // Parse Markdown table into rows for rendering
  const renderTable = (md: string) => {
    if (!md) return null;
    const lines = md.trim().split("\n").filter(l => l.trim().startsWith("|"));
    if (lines.length < 2) return <pre className="text-[10px] font-mono whitespace-pre-wrap">{md}</pre>;
    const headers = lines[0].split("|").filter(c => c.trim()).map(c => c.trim());
    const rows = lines.slice(2).map(line => line.split("|").filter(c => c.trim()).map(c => c.trim()));
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] border-collapse">
          <thead>
            <tr className="border-b border-border/60">
              {headers.map((h, i) => (
                <th key={i} className="text-left p-1.5 font-semibold text-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-border/30">
                {row.map((cell, j) => (
                  <td key={j} className="p-1.5 text-muted-foreground">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <GitBranch className="h-4 w-4 text-primary" />
            {t("diagram.title") || "AI-Generated Diagrams"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("diagram.desc") || "Auto-generated comparison table, flow diagram, and key findings from the article."}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-2 border-b border-border/40 shrink-0 flex items-center justify-end bg-muted/10">
          <Button
            variant="ghost"
            size="sm"
            className="text-[10px] h-6 gap-1"
            onClick={() => genMut.mutate()}
            disabled={genMut.isPending}
          >
            {genMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
            {t("diagram.regenerate") || "Regenerate"}
          </Button>
        </div>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-5 py-3 space-y-4">
            {genMut.isPending && !data && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            )}

            {data && (
              <>
                {/* Comparison Table */}
                {data.table && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5">
                      <TableIcon className="h-3.5 w-3.5 text-primary" />
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                        {t("diagram.table") || "Comparison Table"}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-muted/10 p-2.5">
                      {renderTable(data.table)}
                    </div>
                  </div>
                )}

                {/* Flow Diagram (Mermaid source) */}
                {data.flowchart && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5">
                      <GitBranch className="h-3.5 w-3.5 text-primary" />
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                        {t("diagram.flowchart") || "Flow Diagram (Mermaid)"}
                      </p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-muted/10 p-2.5">
                      <pre className="text-[10px] font-mono whitespace-pre-wrap break-words leading-relaxed">
                        {data.flowchart}
                      </pre>
                      <p className="text-[8px] text-muted-foreground/60 mt-1.5 italic">
                        {t("diagram.mermaidHint") || "Paste this into mermaid.live to render the diagram."}
                      </p>
                    </div>
                  </div>
                )}

                {/* Key Findings */}
                {data.keyFindings?.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5">
                      <Lightbulb className="h-3.5 w-3.5 text-amber-500" />
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                        {t("diagram.findings") || "Key Findings"}
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      {data.keyFindings.map((finding, i) => (
                        <div key={i} className="flex items-start gap-2 rounded-md border border-border/50 bg-muted/20 p-2">
                          <Badge variant="outline" className="text-[8px] h-3.5 shrink-0 mt-0.5">
                            {i + 1}
                          </Badge>
                          <p className="text-[10px] text-foreground leading-relaxed">{finding}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!data.table && !data.flowchart && (!data.keyFindings || data.keyFindings.length === 0) && (
                  <p className="text-xs text-muted-foreground text-center py-8">
                    {t("diagram.empty") || "No diagrams could be generated for this article."}
                  </p>
                )}
              </>
            )}
          </div>
        </ScrollArea>

        <div className="px-5 py-3 border-t border-border/60 shrink-0 flex items-center justify-between">
          <span className="text-[9px] text-muted-foreground italic">
            {t("diagram.disclaimer") || "AI-generated — verify accuracy before use."}
          </span>
          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => onOpenChange(false)}>
            {t("common.close") || "Close"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
