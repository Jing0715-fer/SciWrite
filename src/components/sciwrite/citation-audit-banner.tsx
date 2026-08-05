"use client";

import * as React from "react";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  ChevronDown,
  ChevronRight,
  Loader2,
  Sparkles,
  RefreshCw,
  AlertTriangle,
  CircleAlert,
  CircleX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface CitationFinding {
  n: number;
  marker: string;
  sentence: string;
  verdict: string;
  score?: number;
  reason: string;
  refIdentity?: string;
}

interface AuditReport {
  articleId: string;
  totalCitations: number;
  totalReferences: number;
  findings: CitationFinding[];
  orphans: { index: number; title: string; identity: string }[];
  duplicates: { index: number; identity: string }[];
  summary: {
    ok: number;
    outOfRange: number;
    missing: number;
    suspect: number;
    unsupported: number;
    orphan: number;
    duplicate: number;
    mismatch: number;
    blockingErrors: number;
  };
  numberingIntegrityOk: boolean;
  deep?: boolean;
}

type AuditState = "idle" | "loading" | "loaded" | "deep-loading" | "error";

const VERDICT_META: Record<
  string,
  { label: string; icon: React.ElementType; color: string; bg: string }
> = {
  "out-of-range": {
    label: "Out of range",
    icon: CircleX,
    color: "text-red-600 dark:text-red-400",
    bg: "bg-red-50/60 dark:bg-red-950/20",
  },
  missing: {
    label: "Missing",
    icon: CircleX,
    color: "text-red-600 dark:text-red-400",
    bg: "bg-red-50/60 dark:bg-red-950/20",
  },
  mismatch: {
    label: "Numbering mismatch",
    icon: CircleX,
    color: "text-red-600 dark:text-red-400",
    bg: "bg-red-50/60 dark:bg-red-950/20",
  },
  unsupported: {
    label: "Unsupported",
    icon: AlertTriangle,
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-50/50 dark:bg-amber-950/15",
  },
  suspect: {
    label: "Suspect",
    icon: CircleAlert,
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-50/50 dark:bg-amber-950/15",
  },
  orphan: {
    label: "Orphan",
    icon: CircleAlert,
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-50/50 dark:bg-amber-950/15",
  },
  duplicate: {
    label: "Duplicate",
    icon: CircleAlert,
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-50/50 dark:bg-amber-950/15",
  },
};

/**
 * CitationAuditBanner — non-dismissable adversarial-audit summary banner.
 *
 * Mounted above the composed article (Layer 3 of the citation-accuracy
 * guarantee). On mount it runs the cheap deterministic audit (range,
 * topicality, orphan, bidirectional, numbering-integrity, duplicate). The
 * user can click "Deep audit" to additionally run the LLM adversarial check
 * on suspect/unsupported citations.
 *
 * Visual states:
 *   - Clean (0 findings)      → green banner, shield-check icon
 *   - Warnings only (no blocking) → amber banner, shield-alert icon
 *   - Blocking errors (>0)    → red banner, shield-x icon (non-dismissable)
 */
export function CitationAuditBanner({ articleId }: { articleId: string }) {
  const [state, setState] = React.useState<AuditState>("idle");
  const [report, setReport] = React.useState<AuditReport | null>(null);
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const runAudit = React.useCallback(
    async (deep: boolean) => {
      setState(deep ? "deep-loading" : "loading");
      setError(null);
      try {
        const res = await fetch(
          `/api/articles/${articleId}/audit-citations${deep ? "?deep=true" : ""}`,
          { method: "POST" }
        );
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(txt || `Audit failed (${res.status})`);
        }
        const data = (await res.json()) as AuditReport;
        setReport(data);
        setState("loaded");
        // Auto-expand when there are blocking errors so the user sees them.
        if (data.summary.blockingErrors > 0) setOpen(true);
      } catch (err: any) {
        setError(err?.message || "Audit failed.");
        setState("error");
      }
    },
    [articleId]
  );

  React.useEffect(() => {
    runAudit(false);
  }, [runAudit]);

  if (state === "loading" || state === "idle") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-border/50 bg-muted/30 text-[11px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Running citation audit…
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-amber-300/50 bg-amber-50/40 dark:bg-amber-950/15 text-[11px] text-amber-700 dark:text-amber-400">
        <CircleAlert className="h-3.5 w-3.5 shrink-0" />
        <span>Citation audit unavailable: {error}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[10px]"
          onClick={() => runAudit(false)}
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </Button>
      </div>
    );
  }

  if (!report) return null;

  const { summary, findings, orphans, duplicates, deep } = report;
  const hasBlocking = summary.blockingErrors > 0;
  const hasWarnings =
    summary.suspect + summary.unsupported + summary.orphan + summary.duplicate > 0;

  const bannerClass = hasBlocking
    ? "border-red-300/60 bg-red-50/50 dark:bg-red-950/20"
    : hasWarnings
    ? "border-amber-300/50 bg-amber-50/40 dark:bg-amber-950/15"
    : "border-emerald-300/50 bg-emerald-50/40 dark:bg-emerald-950/15";

  const Icon = hasBlocking
    ? ShieldX
    : hasWarnings
    ? ShieldAlert
    : ShieldCheck;

  const iconClass = hasBlocking
    ? "text-red-600 dark:text-red-400"
    : hasWarnings
    ? "text-amber-600 dark:text-amber-400"
    : "text-emerald-600 dark:text-emerald-400";

  const title = hasBlocking
    ? "Citation audit found blocking errors"
    : hasWarnings
    ? "Citation audit found warnings"
    : "Citations passed audit";

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "rounded-md border overflow-hidden transition-colors",
        bannerClass
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className={cn("h-4 w-4 shrink-0", iconClass)} />
        <span className="text-[12px] font-semibold text-foreground/90">
          {title}
        </span>
        <div className="flex items-center gap-1 ml-1">
          {summary.blockingErrors > 0 && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[9px] border-red-300/60 text-red-700 dark:text-red-400 bg-red-50/40 dark:bg-red-950/20"
            >
              {summary.blockingErrors} blocking
            </Badge>
          )}
          {summary.missing > 0 && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[9px] border-red-300/60 text-red-700 dark:text-red-400"
            >
              {summary.missing} missing
            </Badge>
          )}
          {summary.outOfRange > 0 && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[9px] border-red-300/60 text-red-700 dark:text-red-400"
            >
              {summary.outOfRange} out-of-range
            </Badge>
          )}
          {summary.mismatch > 0 && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[9px] border-red-300/60 text-red-700 dark:text-red-400"
            >
              {summary.mismatch} mismatch
            </Badge>
          )}
          {summary.unsupported > 0 && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[9px] border-amber-300/60 text-amber-700 dark:text-amber-400"
            >
              {summary.unsupported} unsupported
            </Badge>
          )}
          {summary.suspect > 0 && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[9px] border-amber-300/60 text-amber-700 dark:text-amber-400"
            >
              {summary.suspect} suspect
            </Badge>
          )}
          {summary.orphan > 0 && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[9px] border-amber-300/60 text-amber-700 dark:text-amber-400"
            >
              {summary.orphan} orphan
            </Badge>
          )}
          {summary.duplicate > 0 && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[9px] border-amber-300/60 text-amber-700 dark:text-amber-400"
            >
              {summary.duplicate} dup
            </Badge>
          )}
          {summary.ok > 0 && !hasBlocking && !hasWarnings && (
            <Badge
              variant="outline"
              className="h-4 px-1 text-[9px] border-emerald-300/60 text-emerald-700 dark:text-emerald-400"
            >
              {summary.ok} ok
            </Badge>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground ml-1 hidden sm:inline">
          {report.totalCitations} citations · {report.totalReferences} refs
          {deep ? " · LLM-audited" : ""}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px] gap-1"
            disabled={state === "deep-loading"}
            onClick={() => runAudit(true)}
            title="Run the LLM adversarial check on suspect/unsupported citations"
          >
            {state === "deep-loading" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            Deep audit
          </Button>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
              {open ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </Button>
          </CollapsibleTrigger>
        </div>
      </div>
      <CollapsibleContent>
        <div className="border-t border-border/40 px-3 py-2 max-h-72 overflow-y-auto scroll-academic space-y-1.5">
          {findings.length === 0 && orphans.length === 0 && duplicates.length === 0 && (
            <p className="text-[11px] text-muted-foreground py-1">
              No issues found. All {report.totalCitations} citations resolve
              correctly and have adequate topical overlap with their references.
            </p>
          )}
          {findings.map((f, i) => {
            const meta = VERDICT_META[f.verdict] || VERDICT_META.suspect;
            const VIcon = meta.icon;
            return (
              <div
                key={i}
                className={cn(
                  "flex gap-2 rounded px-2 py-1.5 text-[11px]",
                  meta.bg
                )}
              >
                <VIcon className={cn("h-3.5 w-3.5 shrink-0 mt-0.5", meta.color)} />
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-mono font-semibold text-[10px]">
                      [{f.n}]
                    </span>
                    <Badge
                      variant="outline"
                      className="h-3.5 px-1 text-[8px] uppercase"
                    >
                      {meta.label}
                    </Badge>
                    {typeof f.score === "number" && (
                      <span className="text-[9px] text-muted-foreground">
                        overlap {Math.round((f.score || 0) * 100)}%
                      </span>
                    )}
                  </div>
                  <p className="text-foreground/80 leading-snug">
                    <span className="text-muted-foreground">Sentence:</span>{" "}
                    {f.sentence || "(empty)"}
                  </p>
                  <p className={cn("leading-snug", meta.color)}>{f.reason}</p>
                </div>
              </div>
            );
          })}
          {orphans.map((o, i) => (
            <div
              key={`orphan-${i}`}
              className="flex gap-2 rounded px-2 py-1.5 text-[11px] bg-amber-50/50 dark:bg-amber-950/15"
            >
              <CircleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <div className="flex-1 min-w-0">
                <span className="font-mono font-semibold text-[10px]">
                  [{o.index}]
                </span>{" "}
                <span className="text-foreground/80">
                  Reference never cited in the body —{" "}
                  <span className="italic">{o.title}</span>
                </span>
              </div>
            </div>
          ))}
          {duplicates.map((d, i) => (
            <div
              key={`dup-${i}`}
              className="flex gap-2 rounded px-2 py-1.5 text-[11px] bg-amber-50/50 dark:bg-amber-950/15"
            >
              <CircleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <div className="flex-1 min-w-0">
                <span className="font-mono font-semibold text-[10px]">
                  [{d.index}]
                </span>{" "}
                <span className="text-foreground/80">
                  Duplicate reference entry — {d.identity}
                </span>
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
