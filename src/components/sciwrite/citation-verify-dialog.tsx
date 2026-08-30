"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
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
import { api } from "@/lib/api-client";
import { useMutation } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  articleId: string;
}

/**
 * Citation Verification Dialog
 *
 * Runs a heuristic citation verification on the article: for each [n]
 * citation marker, checks whether the corresponding reference's title +
 * abstract shares enough keywords with the citing sentence to plausibly
 * support the claim.
 *
 * Results are shown as a list with color-coded status badges:
 *  - green: supported (≥15% keyword overlap)
 *  - amber: weak (5–15% overlap — may not directly support the claim)
 *  - red: unsupported (<5% overlap — likely incorrect or missing abstract)
 *  - gray: missing (reference [n] doesn't exist in the list)
 */
export function CitationVerifyDialog({ open, onOpenChange, articleId }: Props) {
  const { t } = useI18n();

  const verifyMut = useMutation({
    mutationFn: () => api.verifyCitations(articleId),
    onError: (e: any) => toast.error(e?.message || "Verification failed"),
  });

  // Auto-run verification when dialog opens
  React.useEffect(() => {
    if (open && !verifyMut.data && !verifyMut.isPending) {
      verifyMut.mutate();
    }
  }, [open]);

  const results = verifyMut.data?.results || [];
  const summary = verifyMut.data?.summary;

  const statusConfig = {
    supported: { icon: CheckCircle2, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/20", border: "border-emerald-300/40 dark:border-emerald-700/50", label: "Supported" },
    weak: { icon: AlertTriangle, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950/20", border: "border-amber-300/40 dark:border-amber-700/50", label: "Weak" },
    unsupported: { icon: XCircle, color: "text-red-600 dark:text-red-400", bg: "bg-red-50 dark:bg-red-950/20", border: "border-red-300/40 dark:border-red-700/50", label: "Unsupported" },
    missing: { icon: ShieldAlert, color: "text-muted-foreground", bg: "bg-muted/20", border: "border-border/40", label: "Missing" },
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden rounded-xl">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border/60 shrink-0 bg-gradient-to-r from-primary/5 to-transparent">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            {t("citationVerify.title") || "Citation Verification"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("citationVerify.desc") || "Heuristic check: each [n] citation is scored by keyword overlap between the citing sentence and the reference's title/abstract. Low scores may indicate incorrect citations or missing abstracts."}
          </DialogDescription>
        </DialogHeader>

        {/* Summary bar */}
        {summary && (
          <div className="px-5 py-2 border-b border-border/40 shrink-0 flex items-center gap-3 bg-muted/10">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span className="text-[10px] font-mono font-semibold text-emerald-600 dark:text-emerald-400">{summary.supported}</span>
              <span className="text-[9px] text-muted-foreground">supported</span>
            </div>
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
              <span className="text-[10px] font-mono font-semibold text-amber-600 dark:text-amber-400">{summary.weak}</span>
              <span className="text-[9px] text-muted-foreground">weak</span>
            </div>
            <div className="flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
              <span className="text-[10px] font-mono font-semibold text-red-600 dark:text-red-400">{summary.unsupported}</span>
              <span className="text-[9px] text-muted-foreground">unsupported</span>
            </div>
            {summary.missing > 0 && (
              <div className="flex items-center gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] font-mono font-semibold text-muted-foreground">{summary.missing}</span>
                <span className="text-[9px] text-muted-foreground">missing</span>
              </div>
            )}
            <div className="flex-1" />
            <span className="text-[10px] text-muted-foreground">{summary.total} citations checked</span>
            <Button
              variant="ghost"
              size="sm"
              className="text-[10px] h-6 gap-1"
              onClick={() => verifyMut.mutate()}
              disabled={verifyMut.isPending}
            >
              {verifyMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
              {t("citationVerify.rerun") || "Re-run"}
            </Button>
          </div>
        )}

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-5 py-3 space-y-1.5">
            {verifyMut.isPending && !verifyMut.data && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {!verifyMut.isPending && results.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <ShieldCheck className="h-8 w-8 text-muted-foreground/40 mb-2" />
                <p className="text-xs text-muted-foreground">
                  {t("citationVerify.noCitations") || "No citations found in this article."}
                </p>
              </div>
            )}

            {results.map((r, i) => {
              const cfg = statusConfig[r.status as keyof typeof statusConfig] || statusConfig.unsupported;
              const Icon = cfg.icon;
              return (
                <div
                  key={i}
                  className={`rounded-md border ${cfg.border} ${cfg.bg} p-2.5 space-y-1`}
                >
                  <div className="flex items-start gap-2">
                    <Icon className={`h-3.5 w-3.5 ${cfg.color} shrink-0 mt-0.5`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className={`text-[8px] h-3.5 ${cfg.border} ${cfg.color}`}>
                          [{r.citation}]
                        </Badge>
                        <span className="text-[10px] font-medium text-foreground truncate">
                          {r.refTitle || "—"}
                        </span>
                        <span className={`text-[9px] font-mono ${cfg.color} ml-auto shrink-0`}>
                          {Math.round(r.score * 100)}%
                        </span>
                      </div>
                      <p className="text-[9px] text-muted-foreground mt-0.5 line-clamp-2">
                        {r.sentence}
                      </p>
                      <p className={`text-[9px] ${cfg.color} mt-0.5`}>
                        {r.message}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>

        <div className="px-5 py-3 border-t border-border/60 shrink-0 flex items-center justify-between">
          <span className="text-[9px] text-muted-foreground italic">
            {t("citationVerify.disclaimer") || "Heuristic only — keyword overlap is not a substitute for manual verification."}
          </span>
          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => onOpenChange(false)}>
            {t("common.close") || "Close"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
