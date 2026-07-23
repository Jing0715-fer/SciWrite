"use client";

import * as React from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { ExternalLink } from "lucide-react";
import type { Annotation } from "@/lib/types";

export interface CitationRef {
  id?: string;
  type?: string;
  externalId?: string | null;
  title: string;
  authors?: string | null;
  journal?: string | null;
  year?: string | null;
  url?: string | null;
  doi?: string | null;
}

interface Segment {
  type: "text" | "cite" | "highlight";
  text: string;
  citeKey?: string;
  annotation?: Annotation;
}

interface HighlightRange {
  start: number;
  end: number;
  annotation: Annotation;
}

const CITE_RE_SOURCE =
  "\\[(\\d{1,3}(?:[,\\-\\u2013\\s]\\d{1,3})*|[A-Z]{2,12}:\\s?[^\\]\\n]{1,60})\\]";

const SEVERITY_TO_CLASS: Record<string, string> = {
  critical: "ann-highlight-critical",
};

function buildHighlightRanges(
  content: string,
  annotations: Annotation[]
): HighlightRange[] {
  const ranges: HighlightRange[] = [];
  for (const a of annotations) {
    if (!a.selectedText || a.resolved) continue;
    const needle = a.selectedText;
    let start = a.startOffset ?? -1;
    if (start < 0 || content.slice(start, start + needle.length) !== needle) {
      start = content.indexOf(needle);
    }
    if (start >= 0) {
      ranges.push({ start, end: start + needle.length, annotation: a });
    }
  }
  const prio: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  ranges.sort(
    (a, b) =>
      a.start - b.start ||
      (prio[a.annotation.severity] ?? 2) - (prio[b.annotation.severity] ?? 2)
  );
  const out: HighlightRange[] = [];
  let lastEnd = -1;
  for (const r of ranges) {
    if (r.start >= lastEnd) {
      out.push(r);
      lastEnd = r.end;
    }
  }
  return out;
}

/**
 * Resolve a citation marker inner-text (e.g. "1", "2,3", "PMID:12345") to one
 * or more reference records. Numeric markers map to the 1-indexed references
 * array; SOURCE:ID markers match by type+externalId.
 */
function resolveCitation(
  inner: string,
  references: CitationRef[]
): CitationRef[] {
  const trimmed = inner.trim();
  // SOURCE:ID form
  const srcMatch = trimmed.match(/^([A-Z]{2,12}):\s?(.+)$/);
  if (srcMatch) {
    const rawSource = srcMatch[1].toLowerCase();
    // Normalize aliases
    const source =
      rawSource === "pmid" ? "pubmed" :
      rawSource === "pdb" ? "rcsb" :
      rawSource;
    const id = srcMatch[2].trim();
    const found = references.find(
      (r) => {
        const rType =
          r.type?.toLowerCase() === "pmid" ? "pubmed" :
          r.type?.toLowerCase() === "pdb" ? "rcsb" :
          r.type?.toLowerCase();
        return rType === source && (
          r.externalId?.toLowerCase() === id.toLowerCase() ||
          r.externalId?.toLowerCase().includes(id.toLowerCase()) ||
          id.toLowerCase().includes(r.externalId?.toLowerCase() || "___")
        );
      }
    );
    return found ? [found] : [];
  }
  // Numeric / range form, e.g. "1", "2,3", "1-3", "2–4"
  const nums: number[] = [];
  const parts = trimmed.split(/[,;]\s*/);
  for (const p of parts) {
    const rangeMatch = p.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      for (let n = a; n <= b; n++) nums.push(n);
    } else {
      const n = parseInt(p, 10);
      if (!isNaN(n)) nums.push(n);
    }
  }
  return nums
    .map((n) => references[n - 1])
    .filter(Boolean) as CitationRef[];
}

/**
 * Parse the AI-generated "### Citations" block into structured references.
 * Handles multiple formats the AI may emit:
 *   [1] PDB:5F9R
 *   [2] PMID:29162691
 *   [3] Authors (2021) Journal. Title. — https://...
 *   [4] Author (year) Journal. Title. [SOURCE:ID] — url
 */
function parseCitationsBlock(text: string): CitationRef[] {
  const lines = text.split("\n").filter((l) => l.trim());
  const refs: CitationRef[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*\[(\d+)\]\s*(.+)$/);
    if (!m) continue;
    const body = m[2].trim();
    const yearMatch = body.match(/\((\d{4}[a-z]?)\)/);
    const year = yearMatch?.[1];

    // Source:ID may appear with or without brackets: "PDB:5F9R" or "[PDB:5F9R]"
    const sourceMatch =
      body.match(/\[([A-Z]{2,12}):\s?([^\]]+)\]/) ||
      body.match(/\b([A-Z]{2,12}):\s?([A-Za-z0-9_\-\.]+)/);
    const rawType = sourceMatch?.[1]?.toLowerCase();
    // Normalize common aliases
    const type =
      rawType === "pmid" ? "pubmed" :
      rawType === "pdb" ? "rcsb" :
      rawType;
    const externalId = sourceMatch?.[2]?.trim();

    const urlMatch = body.match(/(https?:\/\/[^\s]+)/);
    let url = urlMatch?.[1];
    // Build URL from source:ID if not explicitly provided
    if (!url && type && externalId) {
      const id = externalId.trim();
      if (type === "pubmed" || type === "pmid")
        url = `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
      else if (type === "pmc") url = `https://www.ncbi.nlm.nih.gov/pmc/articles/${id}/`;
      else if (type === "uniprot") url = `https://www.uniprot.org/uniprotkb/${id}`;
      else if (type === "rcsb" || type === "pdb") url = `https://www.rcsb.org/structure/${id}`;
      else if (type === "ncbi" || type === "gene") url = `https://www.ncbi.nlm.nih.gov/gene/${id}`;
      else if (type === "doi") url = `https://doi.org/${id}`;
    }

    // Build a human-readable title
    let cleaned = body;
    if (sourceMatch) {
      // remove the source:ID token (with or without brackets)
      cleaned = cleaned.replace(/\[?[A-Z]{2,12}:\s?[^\]\s]+]?/g, "");
    }
    cleaned = cleaned
      .replace(/\(\d{4}[a-z]?\)/, "")
      .replace(/https?:\/\/[^\s]+/, "")
      .replace(/[—–-]\s*$/, "")
      .replace(/^\s*[—–-]\s*/, "")
      .trim();

    // If all we have is a source:ID, construct a title from it
    const fallbackTitle = type && externalId ? `${type.toUpperCase()}:${externalId}` : body;

    refs.push({
      type: type || "manual",
      externalId,
      title: cleaned.slice(0, 200) || fallbackTitle,
      year,
      url,
      authors: undefined,
      journal: undefined,
    });
  }
  return refs;
}

export function MarkdownCitations({
  content,
  annotations = [],
  references = [],
  onAnnotationClick,
  className = "",
}: {
  content: string;
  annotations?: Annotation[];
  references?: CitationRef[];
  onAnnotationClick?: (a: Annotation) => void;
  className?: string;
}) {
  const { bodySegments, citationsBlock, citedRefs, allRefs } = React.useMemo(() => {
    const highlights = buildHighlightRanges(content, annotations);
    const citeRe = new RegExp(CITE_RE_SOURCE, "g");
    const segments: Segment[] = [];
    const citedList: CitationRef[] = [];
    const citedKeys = new Set<string>();

    // Pre-parse the AI "### Citations" block (if any) to build a fallback
    // reference list for hover tooltips + the bottom reference list.
    const citeHeaderIdx = content.indexOf("### Citations");
    const aiCitationsText =
      citeHeaderIdx >= 0 ? content.slice(citeHeaderIdx) : "";
    const parsedAiRefs = aiCitationsText ? parseCitationsBlock(aiCitationsText) : [];
    // Merge: saved references take priority (by index), then AI-parsed refs fill gaps.
    const merged: CitationRef[] = [];
    const maxLen = Math.max(references.length, parsedAiRefs.length);
    for (let k = 0; k < maxLen; k++) {
      const saved = references[k];
      const ai = parsedAiRefs[k];
      merged.push(
        saved || ai || { type: "manual", title: ai?.title || `Reference ${k + 1}` }
      );
    }

    const pushCited = (ref: CitationRef) => {
      const key = ref.id || `${ref.type}:${ref.externalId}` || ref.title;
      if (!citedKeys.has(key)) {
        citedKeys.add(key);
        citedList.push(ref);
      }
    };

    let i = 0;
    while (i < content.length) {
      const hl = highlights.find((h) => h.start === i);
      if (hl) {
        segments.push({
          type: "highlight",
          text: content.slice(hl.start, hl.end),
          annotation: hl.annotation,
        });
        i = hl.end;
        continue;
      }
      citeRe.lastIndex = i;
      const m = citeRe.exec(content);
      if (m && m.index === i) {
        const inner = m[1];
        const refs = resolveCitation(inner, merged);
        refs.forEach(pushCited);
        segments.push({ type: "cite", text: m[0], citeKey: inner });
        i += m[0].length;
        continue;
      }
      let nextStop = content.length;
      for (const h of highlights) {
        if (h.start > i) {
          nextStop = Math.min(nextStop, h.start);
          break;
        }
      }
      citeRe.lastIndex = i + 1;
      const m2 = citeRe.exec(content);
      if (m2 && m2.index > i) {
        nextStop = Math.min(nextStop, m2.index);
      }
      segments.push({ type: "text", text: content.slice(i, nextStop) });
      i = nextStop;
    }

    const citeHeaderIdx2 = content.indexOf("### Citations");
    if (citeHeaderIdx2 === -1) {
      return { bodySegments: segments, citationsBlock: null, citedRefs: citedList, allRefs: merged };
    }
    let acc = 0;
    const body: Segment[] = [];
    const rest: Segment[] = [];
    for (const s of segments) {
      const segStart = acc;
      const segEnd = acc + s.text.length;
      if (segEnd <= citeHeaderIdx2) {
        body.push(s);
      } else if (segStart >= citeHeaderIdx2) {
        rest.push(s);
      } else {
        const splitAt = citeHeaderIdx2 - segStart;
        body.push({ ...s, text: s.text.slice(0, splitAt) });
        rest.push({ ...s, text: s.text.slice(splitAt) });
      }
      acc = segEnd;
    }
    const citText = rest.map((s) => s.text).join("");
    return { bodySegments: body, citationsBlock: citText, citedRefs: citedList, allRefs: merged };
  }, [content, annotations, references]);

  return (
    <div className={`prose-academic ${className}`}>
      <p className="whitespace-pre-wrap break-words m-0">
        {bodySegments.map((s, idx) => {
          if (s.type === "cite") {
            const inner = s.text.replace(/^\[|\]$/g, "");
            const refs = resolveCitation(inner, allRefs);
            const firstRef = refs[0];
            const label = firstRef
              ? `${firstRef.authors || "Anon"}${
                  firstRef.year ? ` ${firstRef.year}` : ""
                }${firstRef.journal ? ` ${firstRef.journal}` : ""}`
              : inner;
            return (
              <HoverCard key={idx} openDelay={120} closeDelay={120}>
                <HoverCardTrigger asChild>
                  <span className="cite-marker cursor-help" tabIndex={0}>
                    {inner}
                  </span>
                </HoverCardTrigger>
                <HoverCardContent
                  side="top"
                  align="center"
                  className="w-72 p-3 text-xs shadow-lg z-50"
                >
                  {refs.length > 0 ? (
                    <div className="space-y-1.5">
                      {refs.map((r, ri) => (
                        <div key={ri} className="space-y-0.5">
                          <p className="font-semibold leading-snug font-sans text-[11px]">
                            {r.title}
                          </p>
                          <p className="text-[10px] text-muted-foreground leading-snug">
                            {r.authors && <span>{r.authors}</span>}
                            {r.authors && (r.year || r.journal) && (
                              <span> · </span>
                            )}
                            {r.year && <span>{r.year}</span>}
                            {r.journal && (
                              <span className="italic"> {r.journal}</span>
                            )}
                          </p>
                          <div className="flex flex-wrap items-center gap-1">
                            {r.type && r.externalId && (
                              <span className="badge-slate px-1 py-0.5 rounded text-[8px] font-semibold uppercase">
                                {r.type}:{r.externalId}
                              </span>
                            )}
                            {r.doi && (
                              <span className="text-[9px] font-mono text-muted-foreground">
                                DOI:{r.doi}
                              </span>
                            )}
                            {r.url && (
                              <a
                                href={r.url}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[9px] text-primary hover:underline inline-flex items-center gap-0.5"
                              >
                                <ExternalLink className="h-2.5 w-2.5" /> open
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <p className="font-semibold text-[11px]">
                        Citation [{inner}]
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        No matching reference record found. This marker may
                        reference a source listed in the AI-generated citation
                        block below.
                      </p>
                    </div>
                  )}
                </HoverCardContent>
              </HoverCard>
            );
          }
          if (s.type === "highlight" && s.annotation) {
            return (
              <span
                key={idx}
                className={`ann-highlight ${
                  SEVERITY_TO_CLASS[s.annotation.severity] || ""
                }`}
                title={`${s.annotation.type}: ${s.annotation.comment}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onAnnotationClick?.(s.annotation!);
                }}
              >
                {s.text}
              </span>
            );
          }
          return <span key={idx}>{s.text}</span>;
        })}
      </p>

      {/* Fallback: raw AI-generated citation block (only if no structured refs) */}
      {citationsBlock && citedRefs.length === 0 && (
        <div className="mt-3 pt-3 border-t border-dashed border-border/70 text-xs text-muted-foreground font-mono whitespace-pre-wrap leading-relaxed">
          {citationsBlock}
        </div>
      )}

      {/* Complete reference list (from saved records + parsed AI citations) */}
      {citedRefs.length > 0 && (
        <div className="mt-4 pt-3 border-t border-border/70">
          <p className="divider-academic mb-2">
            <span>References</span>
          </p>
          <ol className="space-y-1.5 list-none">
            {citedRefs.map((r, i) => (
              <li
                key={r.id || i}
                className="text-[11px] leading-snug flex gap-1.5 font-sans text-foreground/85"
              >
                <span className="font-mono text-primary font-semibold shrink-0">
                  [{i + 1}]
                </span>
                <span className="flex-1">
                  {r.authors && <span>{r.authors} </span>}
                  {r.year && (
                    <span className="text-muted-foreground">({r.year}) </span>
                  )}
                  <span className="font-medium">{r.title}.</span>
                  {r.journal && (
                    <span className="italic text-muted-foreground">
                      {" "}
                      {r.journal}.
                    </span>
                  )}
                  {r.type && r.externalId && (
                    <span className="ml-1 badge-slate px-1 py-0.5 rounded text-[8px] font-semibold uppercase align-middle">
                      {r.type}:{r.externalId}
                    </span>
                  )}
                  {r.doi && (
                    <span className="ml-1 text-[9px] font-mono text-muted-foreground">
                      doi:{r.doi}
                    </span>
                  )}
                  {r.url && (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-1 text-primary hover:underline inline-flex items-center gap-0.5 text-[9px]"
                    >
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
