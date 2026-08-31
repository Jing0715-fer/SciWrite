"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  MessageSquare,
  Pencil,
  Trash2,
  Loader2,
  MoreHorizontal,
  PenLine,
  Copy,
  Undo2,
  GitCompare,
  RotateCw,
  ShieldCheck,
  Quote,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api-client";
import {
  PARAGRAPH_FORMATS,
  PARAGRAPH_SCENARIOS,
  STATUS_STYLES,
} from "@/lib/constants";
import type { Annotation, Paragraph } from "@/lib/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MarkdownCitations, parseCitationsBlock, type CitationRef } from "./markdown-citations";
import { ExportMenu } from "./export-menu";
import { DiffView } from "./diff-view";
import { CitationValidationDialog } from "./citation-validation-dialog";
import { Icon } from "./icon";
import { useI18n } from "@/lib/i18n";
import { FormatSelect } from "./paragraph/format-select";
import { SelectionToolbar } from "./paragraph/selection-toolbar";
import { RevisePopover } from "./paragraph/revise-popover";
import { InsertStructureAnalysisButton } from "./paragraph/insert-structure-analysis-button";
import { AnnotationsSection } from "./paragraph/annotations-section";

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
  // r37 fix: keep `draft` synced with server content while NOT editing.
  // After Revise/Regenerate the query refetches and this same card
  // (key=p.id) re-renders with NEW paragraph.content — but the stale
  // `draft` init value survived, so Edit showed the pre-revision text and
  // Save silently reverted the AI revision. Sync only outside editing so
  // mid-edit typing is never clobbered.
  React.useEffect(() => {
    if (!editing) setDraft(paragraph.content);
  }, [paragraph.content, editing]);
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
    // Snapshot BEFORE revising (for undo). onMutate is the idiomatic
    // TanStack hook for pre-flight state — it runs synchronously before
    // the async request, so the snapshot can never race a re-render
    // (setState used to live inside mutationFn).
    onMutate: () => setUndoSnapshot(paragraph.content),
    mutationFn: (input: { mode?: string; instructions?: string }) =>
      api.reviseParagraph(paragraph.id, input),
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

  return (
    <div
      className={`surface-card rounded-xl overflow-hidden transition-all duration-200 hover:shadow-md hover:border-primary/30 acad-fade-in${
        editing ? " ring-academic" : ""
      }`}
    >
      {/* Header */}
      <div className="glass-subtle flex items-start gap-3 px-4 py-3 border-b hairline">
        <span className="text-[10px] font-mono text-muted-foreground/80 mt-1 shrink-0 tabular-nums">
          §{String(index + 1).padStart(2, "0")}
        </span>
        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              defaultValue={paragraph.title}
              onBlur={(e) =>
                updateMut.mutate({ title: e.target.value })
              }
              className="text-sm font-semibold bg-transparent border-b border-dashed border-primary/40 focus:outline-none w-full font-serif-text tracking-tight"
            />
          ) : (
            <h3 className="text-sm font-semibold leading-tight truncate font-serif-text tracking-tight">
              {paragraph.title}
            </h3>
          )}
          <div className="flex flex-wrap items-center gap-1 mt-1.5">
            <span
              className={`badge-${status.color} inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wide`}
            >
              <Icon name={status.icon} className="h-2.5 w-2.5" />
              {status.label}
            </span>
            <span className="text-[9px] text-muted-foreground">
              {formatMeta?.label || paragraph.format}
            </span>
            <span className="text-[9px] text-muted-foreground">·</span>
            <span className="text-[9px] text-muted-foreground tabular-nums">
              {viewLang === "zh" && hasZh
                ? `${(paragraph as any).wordCountZh || 0}字`
                : t("para.wordsCount", { n: paragraph.wordCount })}
            </span>
            {/* v101-4: Citation count badge */}
            {(() => {
              const citCount = (displayContent?.match(/\[\d+(?:[,\-–\s]\d+)*\]/g) || []).length;
              if (citCount > 0) {
                return (
                  <span className="badge-amber inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wide">
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
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <MessageSquare className="h-2.5 w-2.5" />
                {unresolvedCount}
              </span>
            )}
            {/* EN/ZH toggle — only when the paragraph has a Chinese translation */}
            {hasZh && !editing && (
              <div className="ml-auto flex items-center gap-0.5 rounded-md border hairline bg-muted/30 p-0.5">
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

      {/* Body — the reading surface gets an extra notch of vertical air
          for comfortable academic line spacing. */}
      <div className="px-4 py-4 relative paper-surface prose-academic" ref={bodyRef} onMouseUp={handleMouseUp}>
        {editing ? (
          <div className="space-y-2">
            {/* Editing canvas — a dedicated paper sheet rather than a flat
                form field. */}
            <div className="canvas-paper rounded-lg">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="font-serif-text text-sm min-h-[180px] leading-[1.85] border-0 bg-transparent dark:bg-transparent shadow-none rounded-lg px-4 py-3.5"
              />
            </div>
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
          <div className="prose-academic">
            <MarkdownCitations
              content={displayContent}
              annotations={paragraph.annotations}
              references={effectiveRefs}
              onAnnotationClick={(a) => setActiveAnnotation(a)}
            />
          </div>
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
        <AnnotationsSection
          annotations={paragraph.annotations}
          annOpen={annOpen}
          setAnnOpen={setAnnOpen}
          resolveAnnMut={resolveAnnMut}
          deleteAnnMut={deleteAnnMut}
        />
      )}

      {/* Action bar */}
      <div className="glass-toolbar px-4 py-2 border-t hairline flex items-center gap-1">
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
              className="h-7 text-[11px] gap-1 text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-950/30"
              onClick={() => setDiffOpen(true)}
              title={t("para.compareTitle")}
            >
              <GitCompare className="h-3 w-3" />
              {t("para.compare")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px] gap-1 text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30"
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
          className="h-7 text-[11px] gap-1 ml-auto"
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
