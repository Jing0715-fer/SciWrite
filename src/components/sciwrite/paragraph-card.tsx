"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  FileText,
  MessageSquare,
  Pencil,
  Trash2,
  CheckCircle2,
  Loader2,
  Wand2,
  MoreHorizontal,
  ChevronDown,
  ChevronUp,
  PenLine,
  Copy,
  X,
  Undo2,
  GitCompare,
  RotateCw,
  ShieldCheck,
  Box,
  Quote,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { api } from "@/lib/api-client";
import {
  PARAGRAPH_FORMATS,
  PARAGRAPH_SCENARIOS,
  STATUS_STYLES,
  ANNOTATION_TYPES,
  SEVERITY_STYLES,
} from "@/lib/constants";
import type { Annotation, Paragraph } from "@/lib/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MarkdownCitations, parseCitationsBlock, type CitationRef } from "./markdown-citations";
import { ExportMenu } from "./export-menu";
import { DiffView } from "./diff-view";
import { CitationValidationDialog } from "./citation-validation-dialog";
import { Icon } from "./icon";
import { useI18n } from "@/lib/i18n";

interface Props {
  paragraph: Paragraph & { annotations: Annotation[]; references: any[] };
  projectId: string;
  index: number;
  /** The latest composed article content — used to extract global reference
   * data so that hover tooltips resolve [20] etc. correctly. */
  articleContent?: string;
}

export function ParagraphCard({ paragraph, projectId, index, articleContent }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(paragraph.content);
  const [annOpen, setAnnOpen] = React.useState(false);
  const [activeAnnotation, setActiveAnnotation] = React.useState<Annotation | null>(null);
  const [selection, setSelection] = React.useState<{ text: string; rect: DOMRect } | null>(null);
  const [undoSnapshot, setUndoSnapshot] = React.useState<string | null>(null);
  const [diffOpen, setDiffOpen] = React.useState(false);
  const [validateOpen, setValidateOpen] = React.useState(false);
  const [viewLang, setViewLang] = React.useState<"en" | "zh">("en");
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const pendingMarkRef = React.useRef<HTMLElement | null>(null);

  // Check if this paragraph has a Chinese translation
  const hasZh = !!(paragraph as any).contentZh;
  // Pick the content to display based on the language toggle
  const displayContent = viewLang === "zh" && hasZh
    ? (paragraph as any).contentZh
    : paragraph.content;

  // Extract global article references from the composed article's
  // ## References section. This allows hover tooltips to resolve globally
  // numbered citations like [20] even when the paragraph's own references
  // list is local (7 entries).
  const globalArticleRefs = React.useMemo<CitationRef[]>(() => {
    if (!articleContent) return [];
    const refHeaderIdx = articleContent.indexOf("## References");
    const bareRefIdx = articleContent.indexOf("\nREFERENCES\n");
    if (refHeaderIdx >= 0) {
      const refText = articleContent.slice(refHeaderIdx);
      try {
        const parsed = parseCitationsBlock(refText);
        if (parsed.length > 0) return parsed;
      } catch {}
    }
    if (bareRefIdx >= 0) {
      const refText = articleContent.slice(bareRefIdx + 1);
      try {
        const parsed = parseCitationsBlock(refText);
        if (parsed.length > 0) return parsed;
      } catch {}
    }
    return [];
  }, [articleContent]);

  // Resolve citations against the PARAGRAPH'S OWN reference list. The
  // paragraph body carries its own numbering ([n] = the n-th reference
  // attached to this paragraph, ordered by citationOrder), so local refs are
  // the only correct resolver here. Using the composed article's global
  // "## References" list caused out-of-range markers (e.g. [14] vs a 13-ref
  // article) to render as red "?" chips.
  // The global list is only a fallback for paragraphs with no refs attached.
  const effectiveRefs =
    (paragraph.references?.length ?? 0) > 0
      ? paragraph.references
      : globalArticleRefs;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["project", projectId] });

  const updateMut = useMutation({
    mutationFn: (input: Partial<Paragraph>) =>
      api.updateParagraph(paragraph.id, input),
    onSuccess: () => {
      toast.success(t("toast.paragraphUpdated"));
      setEditing(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.deleteParagraph(paragraph.id),
    onSuccess: () => {
      toast.success(t("toast.paragraphDeleted"));
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addAnnMut = useMutation({
    mutationFn: (input: Partial<Annotation>) =>
      api.addAnnotation(paragraph.id, input),
    onSuccess: () => {
      toast.success(t("toast.annotationAdded"));
      clearSelection();
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resolveAnnMut = useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) =>
      api.updateAnnotation(id, { resolved }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteAnnMut = useMutation({
    mutationFn: (id: string) => api.deleteAnnotation(id),
    onSuccess: () => {
      toast.success(t("toast.annotationRemoved"));
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reviseMut = useMutation({
    mutationFn: async (input: { mode?: string; instructions?: string }) => {
      // Save snapshot before revising (for undo)
      setUndoSnapshot(paragraph.content);
      return api.reviseParagraph(paragraph.id, input);
    },
    onSuccess: () => {
      toast.success(t("toast.paragraphRevised"));
      invalidate();
    },
    onError: (e: Error) => {
      setUndoSnapshot(null);
      toast.error(e.message);
    },
  });

  const regenerateMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/paragraphs/${paragraph.id}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `Regenerate failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success(t("toast.paragraphRegenerated") || "Section regenerated.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const undoReviseMut = useMutation({
    mutationFn: async () => {
      if (!undoSnapshot) throw new Error("No undo snapshot available.");
      return api.updateParagraph(paragraph.id, {
        content: undoSnapshot,
        status: "annotated",
      });
    },
    onSuccess: () => {
      toast.success(t("toast.paragraphReverted"));
      setUndoSnapshot(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Unwrap any pending-selection <mark> element (restore original DOM)
  const unwrapPendingMark = React.useCallback(() => {
    const mark = pendingMarkRef.current;
    if (!mark || !mark.parentNode) {
      pendingMarkRef.current = null;
      return;
    }
    const parent = mark.parentNode;
    // Move all children out of the mark, then remove it
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    // Normalize adjacent text nodes
    try { parent.normalize(); } catch {}
    pendingMarkRef.current = null;
  }, []);

  // Capture text selection within this paragraph body
  const handleMouseUp = React.useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      return;
    }
    const text = sel.toString().trim();
    if (text.length < 2) {
      return;
    }
    const range = sel.getRangeAt(0);
    const bodyEl = bodyRef.current;
    if (!bodyEl || !bodyEl.contains(range.commonAncestorContainer)) {
      return;
    }
    const rect = range.getBoundingClientRect();

    // Unwrap any previous pending mark
    unwrapPendingMark();

    // Wrap the selected range in a <mark class="pending-selection"> so the
    // highlight persists even after the native selection collapses (which
    // happens when the Popover steals focus).
    try {
      const contents = range.extractContents();
      const mark = document.createElement("mark");
      mark.className = "pending-selection";
      mark.appendChild(contents);
      range.insertNode(mark);
      pendingMarkRef.current = mark;
    } catch {
      // If DOM manipulation fails, the selection toolbar still works —
      // just without the persistent highlight
    }

    // Clear the native selection (it will be lost anyway when popover opens)
    sel.removeAllRanges();

    setSelection({ text, rect });
  }, [unwrapPendingMark]);

  // Cleanup pending mark on unmount
  React.useEffect(() => {
    return () => unwrapPendingMark();
  }, [unwrapPendingMark]);

  // Clear selection + unwrap the pending highlight mark
  const clearSelection = React.useCallback(() => {
    unwrapPendingMark();
    setSelection(null);
  }, [unwrapPendingMark]);

  const unresolvedCount = paragraph.annotations.filter((a) => !a.resolved).length;
  const status = STATUS_STYLES[paragraph.status] || STATUS_STYLES.draft;
  const formatMeta = PARAGRAPH_FORMATS.find((f) => f.id === paragraph.format);

  const ANN_CARD_CLASS: Record<string, string> = {
    emerald: "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20",
    teal: "border-teal-200 bg-teal-50/50 dark:border-teal-900/50 dark:bg-teal-950/20",
    amber: "border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20",
    rose: "border-rose-200 bg-rose-50/50 dark:border-rose-900/50 dark:bg-rose-950/20",
    violet: "border-violet-200 bg-violet-50/50 dark:border-violet-900/50 dark:bg-violet-950/20",
    sky: "border-sky-200 bg-sky-50/50 dark:border-sky-900/50 dark:bg-sky-950/20",
  };

  return (
    <div className="rounded-xl border border-border/70 bg-card shadow-sm hover:shadow-md transition-shadow overflow-hidden acad-fade-in">
      {/* Header */}
      <div className="flex items-start gap-3 px-4 py-3 border-b border-border/50 bg-gradient-to-r from-muted/40 to-transparent">
        <span className="text-[10px] font-mono text-muted-foreground mt-1 shrink-0">
          §{String(index + 1).padStart(2, "0")}
        </span>
        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              defaultValue={paragraph.title}
              onBlur={(e) =>
                updateMut.mutate({ title: e.target.value })
              }
              className="text-sm font-semibold bg-transparent border-b border-dashed border-primary/40 focus:outline-none w-full"
            />
          ) : (
            <h3 className="text-sm font-semibold leading-tight truncate">
              {paragraph.title}
            </h3>
          )}
          <div className="flex flex-wrap items-center gap-1 mt-1.5">
            <span
              className={`badge-${status.color} inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide`}
            >
              <Icon name={status.icon} className="h-2.5 w-2.5" />
              {status.label}
            </span>
            <span className="text-[9px] text-muted-foreground">
              {formatMeta?.label || paragraph.format}
            </span>
            <span className="text-[9px] text-muted-foreground">·</span>
            <span className="text-[9px] text-muted-foreground">
              {viewLang === "zh" && hasZh
                ? `${(paragraph as any).wordCountZh || 0}字`
                : t("para.wordsCount", { n: paragraph.wordCount })}
            </span>
            {/* v101-4: Citation count badge */}
            {(() => {
              const citCount = (displayContent?.match(/\[\d+(?:[,\-–\s]\d+)*\]/g) || []).length;
              if (citCount > 0) {
                return (
                  <span className="inline-flex items-center gap-0.5 text-[9px] text-amber-600 dark:text-amber-400 font-medium bg-amber-500/10 px-1.5 py-0.5 rounded">
                    <Quote className="h-2.5 w-2.5" />
                    {citCount} cit
                  </span>
                );
              }
              return null;
            })()}
            {hasZh && (
              <span className="text-[9px] text-fuchsia-600 dark:text-fuchsia-400 font-medium">
                · 中文
              </span>
            )}
            {unresolvedCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[9px] text-amber-600 dark:text-amber-400 font-medium">
                <MessageSquare className="h-2.5 w-2.5" />
                {unresolvedCount}
              </span>
            )}
            {/* EN/ZH toggle — only when the paragraph has a Chinese translation */}
            {hasZh && !editing && (
              <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border/40 bg-muted/30 p-0.5">
                <button
                  type="button"
                  onClick={() => setViewLang("en")}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-semibold transition-colors ${
                    viewLang === "en"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title="English"
                >
                  EN
                </button>
                <button
                  type="button"
                  onClick={() => setViewLang("zh")}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-semibold transition-colors ${
                    viewLang === "zh"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title="中文"
                >
                  中
                </button>
              </div>
            )}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => setEditing((v) => !v)}>
              <Pencil className="h-3.5 w-3.5" /> {editing ? t("para.stopEditing") : t("para.editContent")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                navigator.clipboard.writeText(paragraph.content).then(() =>
                  toast.success(t("toast.copiedToClipboard"))
                )
              }
            >
              <Copy className="h-3.5 w-3.5" /> {t("para.copyText")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setValidateOpen(true)}>
              <ShieldCheck className="h-3.5 w-3.5" /> {t("para.validateCitations")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => regenerateMut.mutate()}
              disabled={regenerateMut.isPending}
            >
              {regenerateMut.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
              {t("para.regenerate") || "Regenerate section"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <FormatSelect
              value={paragraph.format}
              onChange={(v) => updateMut.mutate({ format: v })}
              options={PARAGRAPH_FORMATS.map((f) => ({ value: f.id, label: f.label }))}
            />
            <FormatSelect
              value={paragraph.scenario}
              onChange={(v) => updateMut.mutate({ scenario: v })}
              options={PARAGRAPH_SCENARIOS.map((s) => ({ value: s.id, label: s.label }))}
            />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => deleteMut.mutate()}
            >
              <Trash2 className="h-3.5 w-3.5" /> {t("para.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Body */}
      <div className="px-4 py-3 relative paper-surface" ref={bodyRef} onMouseUp={handleMouseUp}>
        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="font-serif-text text-sm min-h-[160px] leading-relaxed"
            />
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                onClick={() => updateMut.mutate({ content: draft })}
                disabled={updateMut.isPending}
              >
                {updateMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t("common.save")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(paragraph.content);
                  setEditing(false);
                }}
              >
                {t("common.cancel")}
              </Button>
              <InsertStructureAnalysisButton
                projectId={projectId}
                onInsert={(markdown) => {
                  setDraft((d) => d + (d && !d.endsWith("\n") ? "\n\n" : "") + markdown);
                  toast.success(t("structure.insertedAnalysis"));
                }}
              />
            </div>
          </div>
        ) : (
          <MarkdownCitations
            content={displayContent}
            annotations={paragraph.annotations}
            references={effectiveRefs}
            onAnnotationClick={(a) => setActiveAnnotation(a)}
          />
        )}

        {/* Floating selection toolbar */}
        {selection && !editing && (
          <SelectionToolbar
            text={selection.text}
            onSubmit={(comment, type, severity) => {
              const startOffset = paragraph.content.indexOf(selection.text);
              addAnnMut.mutate({
                selectedText: selection.text,
                startOffset: startOffset >= 0 ? startOffset : 0,
                endOffset: startOffset >= 0 ? startOffset + selection.text.length : 0,
                comment,
                type,
                severity,
              });
            }}
            onClose={() => clearSelection()}
            pending={addAnnMut.isPending}
          />
        )}
      </div>

      {/* Footer: annotations + revise */}
      {paragraph.annotations.length > 0 && (
        <Collapsible open={annOpen} onOpenChange={setAnnOpen} className="border-t border-border/50">
          <div className="px-4 py-2 flex items-center justify-between bg-muted/30">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5">
                <MessageSquare className="h-3.5 w-3.5" />
                {t("para.annotationsCount", { n: paragraph.annotations.length })}
                {annOpen ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div className="px-4 py-2 space-y-2 bg-muted/10">
              {paragraph.annotations.map((a) => {
                const meta = ANNOTATION_TYPES.find((t) => t.id === a.type) || ANNOTATION_TYPES[0];
                const sev = SEVERITY_STYLES[a.severity as keyof typeof SEVERITY_STYLES] || SEVERITY_STYLES.info;
                return (
                  <div
                    key={a.id}
                    className={`rounded-md border p-2.5 text-xs ${
                      a.resolved ? "opacity-60" : ""
                    } ${ANN_CARD_CLASS[meta.color] || "border-border bg-muted/30"}`}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <Icon name={meta.icon} className="h-3 w-3" />
                      <span className="font-semibold text-[10px] uppercase tracking-wide">
                        {meta.label}
                      </span>
                      <span className={`badge-${sev.color} px-1 py-0.5 rounded text-[8px] uppercase`}>
                        {sev.label}
                      </span>
                      {a.resolved && (
                        <span className="text-[9px] text-emerald-600 flex items-center gap-0.5">
                          <CheckCircle2 className="h-2.5 w-2.5" /> {t("para.resolved")}
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          onClick={() =>
                            resolveAnnMut.mutate({ id: a.id, resolved: !a.resolved })
                          }
                          title={a.resolved ? t("para.reopen") : t("para.resolve")}
                        >
                          <CheckCircle2 className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 text-destructive"
                          onClick={() => deleteAnnMut.mutate(a.id)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    {a.selectedText && (
                      <p className="text-[10px] italic text-muted-foreground mb-1 line-clamp-1">
                        “{a.selectedText}”
                      </p>
                    )}
                    <p className="text-foreground/90">{a.comment}</p>
                    {a.aiResponse && (
                      <p className="mt-1.5 text-[10px] text-primary italic border-l-2 border-primary/40 pl-2">
                        {t("para.aiPrefix")} {a.aiResponse}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Action bar */}
      <div className="px-4 py-2 border-t border-border/50 flex items-center gap-1.5 bg-card">
        <RevisePopover
          unresolvedCount={unresolvedCount}
          isRevising={reviseMut.isPending}
          onRevise={(mode, instructions) =>
            reviseMut.mutate({ mode, instructions })
          }
        />
        {undoSnapshot && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px] gap-1.5 text-sky-600 hover:text-sky-700 hover:bg-sky-50 dark:hover:bg-sky-950/30"
              onClick={() => setDiffOpen(true)}
              title={t("para.compareTitle")}
            >
              <GitCompare className="h-3 w-3" />
              {t("para.compare")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px] gap-1.5 text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/30"
              onClick={() => undoReviseMut.mutate()}
              disabled={undoReviseMut.isPending}
              title={t("para.undoTitle")}
            >
              {undoReviseMut.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Undo2 className="h-3 w-3" />
              )}
              {t("para.undo")}
            </Button>
          </>
        )}
        <ExportMenu
          type="paragraph"
          id={paragraph.id}
          hasAnnotations={paragraph.annotations.length > 0}
          hasZh={hasZh}
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[11px] gap-1.5 ml-auto"
          onClick={() => setEditing((v) => !v)}
        >
          <PenLine className="h-3 w-3" />
          {editing ? t("common.preview") : t("common.edit")}
        </Button>
      </div>

      {undoSnapshot && (
        <DiffView
          open={diffOpen}
          onOpenChange={setDiffOpen}
          before={undoSnapshot}
          after={paragraph.content}
          title={paragraph.title}
        />
      )}

      <CitationValidationDialog
        open={validateOpen}
        onOpenChange={setValidateOpen}
        paragraphId={paragraph.id}
        paragraphTitle={paragraph.title}
      />
    </div>
  );
}

function FormatSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="px-2 py-1">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-7 text-[11px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SelectionToolbar({
  text,
  onSubmit,
  onClose,
  pending,
}: {
  text: string;
  onSubmit: (comment: string, type: string, severity: string) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const { t } = useI18n();
  const [comment, setComment] = React.useState("");
  const [type, setType] = React.useState("revise-request");
  const [severity, setSeverity] = React.useState("warning");

  return (
    <Popover open={true} onOpenChange={(o) => !o && onClose()}>
      <PopoverTrigger asChild>
        <span
          className="absolute"
          style={{
            left: 0,
            top: 0,
            width: 1,
            height: 1,
          }}
        />
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3 shadow-lg"
        side="top"
        align="center"
        sideOffset={8}
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-primary font-semibold flex items-center gap-1">
              <MessageSquare className="h-3 w-3" /> {t("para.annotateSelection")}
            </span>
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => {
                  navigator.clipboard.writeText(text).then(() => toast.success(t("toast.copiedToClipboard")));
                  onClose();
                }}
                title={t("para.copySelectedText")}
              >
                <Copy className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onClose}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <p className="text-[10px] italic text-muted-foreground line-clamp-2 border-l-2 border-primary/40 pl-2">
            “{text.slice(0, 100)}{text.length > 100 ? "…" : ""}”
          </p>
          <Textarea
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t("para.revisePlaceholder")}
            className="text-xs min-h-[56px]"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="h-7 text-[10px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANNOTATION_TYPES.map((t) => (
                  <SelectItem key={t.id} value={t.id} className="text-[10px]">
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger className="h-7 text-[10px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="info" className="text-[10px]">{t("para.info")}</SelectItem>
                <SelectItem value="warning" className="text-[10px]">{t("para.warning")}</SelectItem>
                <SelectItem value="critical" className="text-[10px]">{t("para.critical")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            className="w-full h-7 text-[11px]"
            disabled={!comment.trim() || pending}
            onClick={() => onSubmit(comment.trim(), type, severity)}
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {t("para.addAnnotation2")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RevisePopover({
  unresolvedCount,
  isRevising,
  onRevise,
}: {
  unresolvedCount: number;
  isRevising: boolean;
  onRevise: (mode: string, instructions?: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"annotations" | "instructions" | "polish">("annotations");
  const [instructions, setInstructions] = React.useState("");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-[11px] gap-1.5">
          {isRevising ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Wand2 className="h-3 w-3" />
          )}
          {t("para.aiRevise")}
          {unresolvedCount > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center h-3.5 min-w-3.5 px-1 rounded-full bg-amber-500 text-white text-[8px] font-bold">
              {unresolvedCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start">
        <div className="space-y-2.5">
          <span className="text-[10px] uppercase tracking-wider text-primary font-semibold flex items-center gap-1">
            <Wand2 className="h-3 w-3" /> {t("para.revisionMode")}
          </span>
          <div className="grid grid-cols-3 gap-1">
            {(
              [
                ["annotations", t("para.modeAnnotations"), unresolvedCount > 0],
                ["instructions", t("para.modeInstructions"), true],
                ["polish", t("para.modePolish"), true],
              ] as const
            ).map(([id, label, enabled]) => (
              <button
                key={id}
                disabled={!enabled}
                onClick={() => setMode(id)}
                className={`text-[10px] px-2 py-1.5 rounded-md border transition-colors ${
                  mode === id
                    ? "border-primary bg-primary/10 text-primary font-medium"
                    : "border-border hover:bg-muted"
                } ${!enabled ? "opacity-40 cursor-not-allowed" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === "annotations" && (
            <p className="text-[10px] text-muted-foreground">
              {t("para.willAddressAnnotations", { n: unresolvedCount })}
            </p>
          )}
          {mode === "instructions" && (
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={t("para.reviseInstructionsPlaceholder")}
              className="text-xs min-h-[64px]"
            />
          )}
          {mode === "polish" && (
            <p className="text-[10px] text-muted-foreground">
              {t("para.polishDesc")}
            </p>
          )}
          <Button
            size="sm"
            className="w-full h-7 text-[11px] gap-1.5"
            disabled={
              isRevising ||
              (mode === "annotations" && unresolvedCount === 0) ||
              (mode === "instructions" && !instructions.trim())
            }
            onClick={() => {
              onRevise(mode, mode === "instructions" ? instructions.trim() : undefined);
              setOpen(false);
              setInstructions("");
            }}
          >
            {isRevising ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
            {t("para.runRevision")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * InsertStructureAnalysisButton — a popover that lists all analyzed RCSB
 * structures in the current project and inserts a compact markdown summary of
 * the selected structure's key metrics into the paragraph draft. This is the
 * "quick insert" counterpart to the full ProteinStructureAnalysisDialog —
 * instead of viewing all 12 tabs, the user picks a structure and gets a
 * one-paragraph summary they can edit into their prose.
 */
function InsertStructureAnalysisButton({
  projectId,
  onInsert,
}: {
  projectId: string;
  onInsert: (markdown: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [analyses, setAnalyses] = React.useState<any[]>([]);

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .listProjectStructures(projectId)
      .then((res) => setAnalyses(res.analyses || []))
      .catch(() => setAnalyses([]))
      .finally(() => setLoading(false));
  }, [open, projectId]);

  function buildInsertMarkdown(a: any): string {
    // Parse the contextMarkdown to extract key metrics, or build a compact
    // summary from the fields we have.
    const lines: string[] = [];
    lines.push(`> **Structure PDB:${a.pdbId}** — ${a.title || "untitled"}`);
    lines.push(`> - ${a.chainCount} chain(s) · ${a.residueCount} residues · ${a.atomCount} atoms${a.ligandCount > 0 ? ` · ${a.ligandCount} ligand(s)` : ""}`);
    // Try to extract a few key lines from the full context markdown.
    const md = a.contextMarkdown || "";
    const extract = (re: RegExp) => {
      const m = md.match(re);
      return m ? m[1] : null;
    };
    const method = extract(/Method: ([^|]+)/);
    const resolution = extract(/Resolution: ([^|Å]+Å)/);
    const ramaFav = extract(/Favoured \(core\+allowed\): (\S+)%/);
    const ramaOut = extract(/Outliers: (\S+)%/);
    const bfMean = extract(/Mean: ([\d.]+)/);
    const sasaExp = extract(/Exposed: (\S+)%/);
    const sasaBur = extract(/Buried: (\S+)%/);
    const hbonds = extract(/Hydrogen bonds[^:]*: (\d+)/);
    const netCharge = extract(/Net charge at pH 7: ([\d.\-+]+)/);
    const pI = extract(/Isoelectric point \(pI\): ([\d.]+)/);
    const meta: string[] = [];
    if (method) meta.push(`Method: ${method.trim()}`);
    if (resolution) meta.push(`Resolution: ${resolution.trim()}`);
    if (ramaFav) meta.push(`Ramachandran: ${ramaFav}% favoured / ${ramaOut}% outliers`);
    if (bfMean) meta.push(`B̄=${bfMean}`);
    if (sasaExp) meta.push(`SASA: ${sasaExp}% exposed / ${sasaBur}% buried`);
    if (hbonds) meta.push(`${hbonds} H-bonds`);
    if (netCharge) meta.push(`net charge ${netCharge} (pH 7)`);
    if (pI) meta.push(`pI=${pI}`);
    if (meta.length) lines.push(`> - ${meta.join(" · ")}`);
    // Ligands
    const ligMatch = md.match(/Ligands & Cofators \((\d+) detected\):([\s\S]*?)(?=\n\*\*|$)/);
    if (ligMatch && ligMatch[1] !== "0") {
      const ligLines = ligMatch[2].split("\n").filter((l) => l.trim().startsWith("-")).slice(0, 6);
      if (ligLines.length) lines.push(`> - Ligands: ${ligLines.map((l) => l.replace(/^\s*-\s*/, "").replace(/—.*$/, "").trim()).join(", ")}`);
    }
    lines.push(`> _All metrics computed from the actual PDB file via Molcraft structure analysis._`);
    return lines.join("\n");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-[10px] border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-950/30"
          title={t("structure.insertAnalysisTitle")}
        >
          <Box className="h-3 w-3" />
          {t("structure.insertAnalysis")}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-2 max-h-80 overflow-y-auto"
      >
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : analyses.length === 0 ? (
          <div className="text-center py-4 text-[11px] text-muted-foreground">
            <Box className="h-6 w-6 mx-auto mb-1 opacity-30" />
            {t("structure.noAnalyzedSources")}
          </div>
        ) : (
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold px-1 pb-1">
              {t("structure.chooseStructure")}
            </div>
            {analyses.map((a) => (
              <button
                key={a.pdbId}
                onClick={() => {
                  onInsert(buildInsertMarkdown(a));
                  setOpen(false);
                }}
                className="w-full text-left rounded-md border border-border/60 hover:border-amber-300 hover:bg-amber-50/50 dark:hover:bg-amber-950/20 p-2 transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <Badge
                    variant="secondary"
                    className="text-[9px] font-mono bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                  >
                    {a.pdbId}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    {a.chainCount}ch · {a.residueCount}res{a.ligandCount > 0 ? ` · ${a.ligandCount}lig` : ""}
                  </span>
                </div>
                <div className="text-[11px] font-medium mt-0.5 line-clamp-1">
                  {a.title || "untitled"}
                </div>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
