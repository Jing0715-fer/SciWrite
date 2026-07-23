"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  ShieldCheck,
  ShieldAlert,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Quote,
  BookX,
  Wand2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api-client";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  paragraphId: string | null;
  paragraphTitle?: string;
}

export function CitationValidationDialog({
  open,
  onOpenChange,
  paragraphId,
  paragraphTitle,
}: Props) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["validate-citations", paragraphId],
    queryFn: () => api.validateCitations(paragraphId!),
    enabled: open && !!paragraphId,
  });

  const autoFixMut = useMutation({
    mutationFn: () => api.autoFixCitations(paragraphId!),
    onSuccess: (data) => {
      toast.success(data.message);
      qc.invalidateQueries({ queryKey: ["validate-citations", paragraphId] });
      qc.invalidateQueries({ queryKey: ["project"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const allValid = data && data.missingCount === 0 && data.orphanedCount === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 text-base">
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : allValid ? (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            ) : data ? (
              <ShieldAlert className="h-4 w-4 text-amber-600" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-primary" />
            )}
            Citation Validation
          </DialogTitle>
          <DialogDescription className="text-xs">
            {paragraphTitle || "Check that every citation resolves to a reference"}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-6 py-4">
            {isLoading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            )}

            {data && (
              <div className="space-y-4">
                {/* Summary banner */}
                <div
                  className={`rounded-lg border p-3 ${
                    allValid
                      ? "border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/50 dark:bg-emerald-950/20"
                      : "border-amber-200/60 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-950/20"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    {allValid ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                    )}
                    <span
                      className={`text-sm font-semibold ${
                        allValid
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-amber-700 dark:text-amber-400"
                      }`}
                    >
                      {allValid
                        ? "All citations valid"
                        : `${data.missingCount} missing, ${data.orphanedCount} orphaned`}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {data.totalMarkers} citation markers found ·{" "}
                    {data.validCount} resolved · {data.savedReferenceCount} saved
                    references · {data.aiCitationCount} AI-cited
                  </p>
                </div>

                {/* Stat row */}
                <div className="grid grid-cols-4 gap-2">
                  <StatBox
                    label="Markers"
                    value={data.totalMarkers}
                    icon={<Quote className="h-3 w-3" />}
                    color="slate"
                  />
                  <StatBox
                    label="Valid"
                    value={data.validCount}
                    icon={<CheckCircle2 className="h-3 w-3" />}
                    color="emerald"
                  />
                  <StatBox
                    label="Missing"
                    value={data.missingCount}
                    icon={<XCircle className="h-3 w-3" />}
                    color="rose"
                  />
                  <StatBox
                    label="Orphaned"
                    value={data.orphanedCount}
                    icon={<BookX className="h-3 w-3" />}
                    color="amber"
                  />
                </div>

                {/* Missing citations */}
                {data.results.some((r: any) => r.status === "missing") && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] uppercase tracking-wider text-rose-600 font-semibold flex items-center gap-1">
                      <XCircle className="h-3 w-3" />
                      Missing citations ({data.missingCount})
                    </p>
                    {data.results
                      .filter((r: any) => r.status === "missing")
                      .map((r: any, i: number) => (
                        <div
                          key={i}
                          className="rounded-md border border-rose-200/60 dark:border-rose-900/40 bg-rose-50/40 dark:bg-rose-950/20 p-2"
                        >
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <code className="text-[11px] font-mono text-rose-700 dark:text-rose-400 font-semibold">
                              {r.marker}
                            </code>
                            <Badge
                              variant="outline"
                              className="text-[8px] h-3.5 uppercase"
                            >
                              {r.type}
                            </Badge>
                          </div>
                          {r.suggestion && (
                            <p className="text-[10px] text-muted-foreground leading-relaxed">
                              {r.suggestion}
                            </p>
                          )}
                        </div>
                      ))}
                  </div>
                )}

                {/* Orphaned references */}
                {data.orphaned.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] uppercase tracking-wider text-amber-600 font-semibold flex items-center gap-1">
                      <BookX className="h-3 w-3" />
                      Orphaned references ({data.orphaned.length})
                    </p>
                    <p className="text-[10px] text-muted-foreground mb-1">
                      These saved references are never cited in the paragraph:
                    </p>
                    {data.orphaned.map((o: any, i: number) => (
                      <div
                        key={i}
                        className="rounded-md border border-amber-200/60 dark:border-amber-900/40 bg-amber-50/40 dark:bg-amber-950/20 p-2 flex items-center gap-1.5"
                      >
                        <span className="text-[9px] font-mono text-amber-700 dark:text-amber-400 font-semibold shrink-0">
                          [{o.index}]
                        </span>
                        <span className="badge-slate px-1 py-0.5 rounded text-[8px] font-semibold uppercase shrink-0">
                          {o.type}:{o.externalId || "?"}
                        </span>
                        <span className="text-[10px] text-foreground/70 truncate">
                          {o.title}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Valid citations (collapsed) */}
                {data.validCount > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] uppercase tracking-wider text-emerald-600 font-semibold flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      Valid citations ({data.validCount})
                    </p>
                    <div className="space-y-1">
                      {data.results
                        .filter((r: any) => r.status === "valid")
                        .slice(0, 10)
                        .map((r: any, i: number) => (
                          <div
                            key={i}
                            className="flex items-center gap-1.5 text-[10px]"
                          >
                            <code className="font-mono text-emerald-700 dark:text-emerald-400 font-semibold shrink-0">
                              {r.marker}
                            </code>
                            <span className="text-foreground/70 truncate">
                              {r.resolvedTo || "resolved"}
                            </span>
                          </div>
                        ))}
                      {data.validCount > 10 && (
                        <p className="text-[9px] text-muted-foreground italic pl-1">
                          +{data.validCount - 10} more valid citations…
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
        {/* Auto-fix footer */}
        {data && data.missingCount > 0 && (
          <div className="px-6 py-3 border-t border-border/60 flex items-center justify-between gap-2 shrink-0">
            <span className="text-[10px] text-muted-foreground">
              AI will search databases to resolve missing citations
            </span>
            <Button
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => autoFixMut.mutate()}
              disabled={autoFixMut.isPending}
            >
              {autoFixMut.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wand2 className="h-3.5 w-3.5" />
              )}
              Auto-fix {data.missingCount} missing
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatBox({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string;
}) {
  const colorMap: Record<string, string> = {
    emerald:
      "border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400",
    rose: "border-rose-200/60 dark:border-rose-900/40 bg-rose-50/40 dark:bg-rose-950/20 text-rose-700 dark:text-rose-400",
    amber:
      "border-amber-200/60 dark:border-amber-900/40 bg-amber-50/40 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400",
    slate:
      "border-slate-200/60 dark:border-slate-800/40 bg-slate-50/40 dark:bg-slate-950/20 text-slate-700 dark:text-slate-400",
  };
  return (
    <div className={`rounded-md border p-2 ${colorMap[color]}`}>
      <div className="flex items-center gap-1 opacity-80 mb-0.5">{icon}</div>
      <p className="text-lg font-bold leading-none">{value}</p>
      <p className="text-[8px] uppercase tracking-wide mt-0.5 opacity-70">
        {label}
      </p>
    </div>
  );
}
