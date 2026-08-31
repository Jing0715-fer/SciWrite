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
  abstract?: string | null;
  /** Adversarial-audit verdict for this reference (Layer 3 rendering guard). */
  auditStatus?: "ok" | "suspect" | "unsupported" | "missing";
  auditReason?: string | null;
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
  "\\[(\\d{1,3}(?:[,\\-\\u2013]\\s*\\d{1,3})*|[A-Z]{2,12}:\\s?[^\\]\\n]{1,60})\\]";

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
 * Parse the AI-generated "### Citations" block OR the article "## References"
 * section into structured references. Both use the same "[n] ..." format.
 * Returns a sparse array indexed by the citation number (so [1] = index 0,
 * [3] = index 2, with undefined for gaps like [9] if not cited).
 */
export function parseCitationsBlock(text: string): CitationRef[] {
  const lines = text.split("\n").filter((l) => l.trim());
  const refMap: Map<number, CitationRef> = new Map();
  let maxNum = 0;
  for (const line of lines) {
    const m = line.match(/^\s*\[(\d+)\]\s*(.+)$/);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (num > maxNum) maxNum = num;
    const body = m[2].trim();

    // Extract URL (— https://... or just https://...)
    const urlMatch = body.match(/https?:\/\/[^\s]+/);
    let url = urlMatch?.[1]?.replace(/[—–-]\s*$/, "").trim();

    // Extract DOI (doi:...)
    const doiMatch = body.match(/doi:(10\.\S+)/i);
    const doi = doiMatch?.[1]?.replace(/[.,;]\s*$/, "");

    // Extract year (YYYY)
    const yearMatch = body.match(/\((\d{4}[a-z]?)\)/);
    const year = yearMatch?.[1];

    // Extract PMID (pubmed:NNNNN or PMID:NNNNN)
    const pmidMatch = body.match(/(?:pubmed|PMID)[:\s]+(\d+)/i);
    const pmid = pmidMatch?.[1];

    // Extract source:ID (PDB:XXXX, PMID:NNNNN, etc.)
    const sourceMatch =
      body.match(/\[([A-Z]{2,12}):\s?([^\]]+)\]/) ||
      body.match(/\b([A-Z]{2,12}):\s?([A-Za-z0-9_\-\.]+)/);
    const rawType = sourceMatch?.[1]?.toLowerCase();
    const type =
      rawType === "pmid" ? "pubmed" :
      rawType === "pdb" ? "rcsb" :
      rawType;
    const externalId = sourceMatch?.[2]?.trim() || pmid;

    // Build URL from PMID or source:ID if not explicitly provided
    if (!url && pmid) {
      url = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
    } else if (!url && type && externalId) {
      const id = externalId.trim();
      if (type === "pubmed" || type === "pmid")
        url = `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
      else if (type === "pmc") url = `https://www.ncbi.nlm.nih.gov/pmc/articles/${id}/`;
      else if (type === "uniprot") url = `https://www.uniprot.org/uniprotkb/${id}`;
      else if (type === "rcsb" || type === "pdb") url = `https://www.rcsb.org/structure/${id}`;
      else if (type === "ncbi" || type === "gene") url = `https://www.ncbi.nlm.nih.gov/gene/${id}`;
      else if (type === "doi") url = `https://doi.org/${id}`;
    }

    // Parse "Authors (Year) Journal. Title. — URL" format
    // The body format is: "Authors (Year) Journal. Title. — URL"
    // or: "Authors (Year), Journal. Title. [SOURCE:ID] — URL"
    let authors: string | undefined;
    let journal: string | undefined;
    let title: string = body;

    // Try to extract authors (everything before the year)
    if (yearMatch && yearMatch.index !== undefined) {
      authors = body.slice(0, yearMatch.index).trim().replace(/[,\s]+$/, "");
      const afterYear = body.slice(yearMatch.index + yearMatch[0].length).trim();

      // Try to extract journal (text between year and the title, ending with .)
      // Format: "(Year) Journal. Title." or "(Year), Journal. Title."
      const journalMatch = afterYear.match(/^,?\s*([^.,]+)\.\s+(.+)$/);
      if (journalMatch) {
        journal = journalMatch[1].trim();
        title = journalMatch[2].trim();
      } else {
        title = afterYear;
      }
    }

    // Clean up title: remove source:ID, URL, DOI
    if (sourceMatch) {
      title = title.replace(/\[?[A-Z]{2,12}:\s?[^\]\s]+]?/g, "");
    }
    title = title
      .replace(/https?:\/\/[^\s]+/g, "")
      .replace(/doi:\S+/gi, "")
      .replace(/[—–-]\s*$/, "")
      .replace(/^\s*[—–-]\s*/, "")
      .replace(/\.$/, "")
      .trim();

    // If all we have is a source:ID, construct a title from it
    const fallbackTitle = type && externalId ? `${type.toUpperCase()}:${externalId}` : body.slice(0, 200);

    refMap.set(num, {
      type: type || "manual",
      externalId,
      title: title.slice(0, 200) || fallbackTitle,
      year,
      url,
      doi,
      authors,
      journal,
    });
  }
  // Return a sparse array: index 0 = ref [1], index 8 = ref [9] (or undefined if not cited)
  const result: CitationRef[] = [];
  for (let k = 1; k <= maxNum; k++) {
    result.push(refMap.get(k) || null as any);
  }
  return result;
}

/**
 * Render content segments as properly structured HTML:
 * - Lines starting with ## or ### become styled headings (h2/h3)
 * - Other content becomes paragraphs with inline citations/highlights
 */
function renderContentBlocks(
  segments: Segment[],
  ctx: {
    allRefs: CitationRef[];
    onCitationClick?: (ref: CitationRef, index: number) => void;
    onAnnotationClick?: (a: Annotation) => void;
  }
): React.ReactNode {
  const { allRefs, onCitationClick, onAnnotationClick } = ctx;

  // Group segments into blocks: heading blocks and paragraph blocks
  const blocks: { type: "heading" | "paragraph"; level: number; segments: Segment[] }[] = [];
  let currentBlock: { type: "heading" | "paragraph"; level: number; segments: Segment[] } | null = null;

  for (const seg of segments) {
    const text = seg.text;
    const headingMatch = text.match(/^(#{2,4})\s+(.+)$/m);

    if (seg.type === "text" && headingMatch) {
      if (currentBlock) {
        blocks.push(currentBlock);
        currentBlock = null;
      }

      const headingLine = headingMatch[0];
      const headingLevel = headingMatch[1].length;
      const headingText = headingMatch[2];
      const beforeHeading = text.slice(0, headingMatch.index).trim();
      const afterHeading = text.slice(headingMatch.index! + headingLine.length).trim();

      if (beforeHeading) {
        blocks.push({ type: "paragraph", level: 0, segments: [{ type: "text", text: beforeHeading }] });
      }
      blocks.push({ type: "heading", level: headingLevel, segments: [{ type: "text", text: headingText }] });

      if (afterHeading) {
        currentBlock = { type: "paragraph", level: 0, segments: [{ type: "text", text: afterHeading }] };
      }
    } else {
      if (!currentBlock || currentBlock.type === "heading") {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = { type: "paragraph", level: 0, segments: [] };
      }
      currentBlock.segments.push(seg);
    }
  }
  if (currentBlock) blocks.push(currentBlock);

  if (blocks.length === 0) {
    return (
      <p className="whitespace-pre-wrap break-words m-0">
        {segments.map((s, idx) => renderSegment(s, idx, allRefs, onCitationClick, onAnnotationClick))}
      </p>
    );
  }

  return blocks.map((block, bi) => {
    if (block.type === "heading") {
      const level = block.level;
      const headingText = block.segments[0]?.text || "";
      const headingClass = level === 2
        ? "text-base font-serif-text font-semibold text-foreground mt-5 mb-2 pb-1 border-b border-border/40"
        : level === 3
        ? "text-sm font-semibold text-foreground/90 mt-4 mb-1.5"
        : "text-xs font-semibold text-muted-foreground mt-3 mb-1 uppercase tracking-wide";
      return React.createElement(
        level === 2 ? "h2" : level === 3 ? "h3" : "h4",
        { key: `heading-${bi}`, className: headingClass },
        headingText
      );
    }
    return (
      <p key={`para-${bi}`} className="whitespace-pre-wrap break-words m-0 mb-3 leading-relaxed">
        {block.segments.map((s, idx) => renderSegment(s, bi * 1000 + idx, allRefs, onCitationClick, onAnnotationClick))}
      </p>
    );
  });
}

/** Render a single segment (cite, highlight, or text) with full HoverCard support */
/**
 * Parse inline markdown in a text segment and return React nodes.
 *
 * Supports:
 *   **bold**    → <strong>
 *   *italic*    → <em>
 *   `code`      → <code>
 *
 * Bold is matched before italic (** is greedier than *). Code is matched
 * first so that `**not bold**` inside backticks stays literal.
 *
 * This is a lightweight inline parser — it does NOT handle block-level
 * markdown (headings, lists, links) because those are handled elsewhere
 * (renderContentBlocks splits on ## headings). It only fixes the common
 * case where the LLM emits **TMC1** or *C. elegans* in the body text and
 * the raw asterisks would otherwise show up verbatim.
 */
function renderInlineMarkdown(text: string, baseKey: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Regex matches: `code` OR **bold** OR *italic*
  // Order matters: code first (so ** inside backticks is literal), then
  // bold (**), then italic (*).
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let lastIndex = 0;
  let matchIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Push preceding plain text
    if (m.index > lastIndex) {
      nodes.push(text.slice(lastIndex, m.index));
    }
    const token = m[0];
    const key = `${baseKey}-${matchIndex++}`;
    if (token.startsWith("`") && token.endsWith("`")) {
      // inline code
      nodes.push(
        <code key={key} className="px-1 py-0.5 rounded bg-muted/60 text-[0.85em] font-mono">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      // bold
      nodes.push(
        <strong key={key} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      // italic
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>,
      );
    }
    lastIndex = m.index + token.length;
  }
  // Push trailing plain text
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes.length > 0 ? nodes : [text];
}

function renderSegment(
  s: Segment,
  idx: number,
  allRefs: CitationRef[],
  onCitationClick?: (ref: CitationRef, index: number) => void,
  onAnnotationClick?: (a: Annotation) => void
): React.ReactNode {
  if (s.type === "cite") {
    const inner = s.text.replace(/^\[|\]$/g, "");
    const refs = resolveCitation(inner, allRefs);
    const firstRef = refs[0];
    // Layer 3 rendering guard: detect unresolved / suspect citations.
    // - No refs resolved at all → the [n] points to nothing (hallucinated or
    //   out-of-range). Render the marker in red with a "?" suffix.
    // - A resolved ref carries an auditStatus of "suspect"/"unsupported"/
    //   "missing" → render with a warning icon + colored ring.
    const isUnresolved = refs.length === 0;
    const auditFlag = refs.find(
      (r) => r.auditStatus && r.auditStatus !== "ok"
    )?.auditStatus;
    const auditReason = refs.find(
      (r) => r.auditStatus && r.auditStatus !== "ok"
    )?.auditReason;
    const markerClass = isUnresolved
      ? "cite-marker cite-marker-unresolved cursor-pointer"
      : auditFlag
      ? `cite-marker cite-marker-${auditFlag} cursor-pointer`
      : "cite-marker cursor-pointer";
    return (
      <HoverCard key={idx} openDelay={120} closeDelay={120}>
        <HoverCardTrigger asChild>
          <span
            className={markerClass}
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              if (firstRef && onCitationClick) {
                const refIndex = allRefs.findIndex(
                  (r) =>
                    (r.externalId === firstRef.externalId &&
                      r.type === firstRef.type) ||
                    r.title === firstRef.title
                );
                onCitationClick(firstRef, refIndex);
              }
            }}
          >
            {isUnresolved ? `${inner}` : inner}
            {auditFlag && (
              <span className="cite-audit-icon" aria-hidden="true">
                ⚠
              </span>
            )}
          </span>
        </HoverCardTrigger>
        <HoverCardContent
          side="top"
          align="center"
          sideOffset={6}
          className="w-80 max-w-[calc(100vw-1.5rem)] p-3 text-xs shadow-xl z-50 rounded-lg border bg-popover text-popover-foreground ring-1 ring-black/5 dark:ring-white/10"
        >
          {refs.length > 0 ? (
            <div className="space-y-1.5">
              {refs.map((r, ri) => (
                <div key={ri} className="space-y-0.5">
                  <p className="font-semibold leading-snug font-sans text-[11px] break-words">
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
                  {r.abstract && (
                    <p className="text-[9px] text-muted-foreground/80 leading-relaxed line-clamp-3 italic">
                      {r.abstract.slice(0, 200)}{r.abstract.length > 200 ? "…" : ""}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1">
                    {r.type && r.externalId && (
                      <span className="badge-slate px-1 py-0.5 rounded text-[8px] font-semibold uppercase">
                        {r.type}:{r.externalId}
                      </span>
                    )}
                    {r.doi && (
                      <span className="text-[9px] font-mono text-muted-foreground break-all">
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
              <p className="font-semibold text-[11px] text-amber-700 dark:text-amber-400">
                [{inner}] — 未收录于参考文献列表
              </p>
              <p className="text-[10px] text-muted-foreground">
                该编号未能在当前文献列表中解析。可能原因：编号超出了本段/本文的文献数量，或文献列表与正文编号不同步。
              </p>
            </div>
          )}
          {/* When refs resolved but flagged by the audit (suspect/unsupported),
              append the audit reason to the hover card so the user sees WHY. */}
          {auditFlag && auditReason && refs.length > 0 && (
            <div className="mt-1.5 pt-1.5 border-t border-amber-300/40 dark:border-amber-700/50 text-[9px] text-amber-700 dark:text-amber-400 leading-snug">
              <span className="font-semibold">Audit:</span> {auditReason}
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
  // Text segment: parse inline markdown (**bold**, *italic*, `code`) so
  // that the LLM's formatting markers don't show up as literal asterisks.
  return <span key={idx}>{renderInlineMarkdown(s.text, `seg-${idx}`)}</span>;
}

export function MarkdownCitations({
  content,
  annotations = [],
  references = [],
  onAnnotationClick,
  onCitationClick,
  className = "",
  suppressRefList = false,
  onlyCitedRefs = false,
}: {
  content: string;
  annotations?: Annotation[];
  references?: CitationRef[];
  onAnnotationClick?: (a: Annotation) => void;
  onCitationClick?: (ref: CitationRef, index: number) => void;
  className?: string;
  /** When true, suppress the component-generated reference list at the bottom.
   * Used by VirtualizedArticle for body sections — the article's ## References
   * section (rendered as its own section) already contains the full list. */
  suppressRefList?: boolean;
  /** When true, the component-generated reference list shows ONLY the
   * references actually cited in this content (per-section view). */
  onlyCitedRefs?: boolean;
}) {
  const { bodySegments, citationsBlock, contentRefText, citedRefs, allRefs, hasContentRefs, citedIdx } = React.useMemo(() => {
    const highlights = buildHighlightRanges(content, annotations);
    const citeRe = new RegExp(CITE_RE_SOURCE, "g");
    const segments: Segment[] = [];
    const citedList: CitationRef[] = [];
    const citedKeys = new Set<string>();

    // Pre-parse the AI "### Citations" block (if any) to build a fallback
    // reference list for hover tooltips + the bottom reference list.
    const citeHeaderIdx = content.indexOf("### Citations");
    // Also check for "## References" header (articles have this).
    // Also check for "## 参考文献" (Chinese reference section header) so that
    // Chinese-translated articles (contentZh) can resolve [n] citations.
    const refHeaderIdx =
      content.indexOf("## References") >= 0
        ? content.indexOf("## References")
        : content.indexOf("## 参考文献");
    // Also check for bare "REFERENCES" header
    const bareRefIdx = content.indexOf("\nREFERENCES\n");

    // The earliest reference/citations section header
    const refSectionIdx = Math.min(
      ...[citeHeaderIdx, refHeaderIdx, bareRefIdx].filter((i) => i >= 0),
      content.length
    );

    // Parse BOTH "### Citations" AND "## References" blocks for hover tooltips.
    // The "### Citations" block is paragraph-level; "## References" is article-level.
    // We parse whichever one exists (or both) to build the reference list for
    // hover tooltips. This ensures citations like [1], [2] etc. resolve to the
    // correct reference even when the content has a "## References" section
    // instead of a "### Citations" block.
    const aiCitationsText =
      citeHeaderIdx >= 0 ? content.slice(citeHeaderIdx) : "";
    const parsedAiRefs = aiCitationsText ? parseCitationsBlock(aiCitationsText) : [];

    // Also parse the "## References" or "REFERENCES" section if it exists.
    // This is the article-level reference list that the compose step appends.
    let parsedArticleRefs: CitationRef[] = [];
    if (refHeaderIdx >= 0) {
      const refText = content.slice(refHeaderIdx);
      parsedArticleRefs = parseCitationsBlock(refText);
    } else if (bareRefIdx >= 0) {
      const refText = content.slice(bareRefIdx + 1); // +1 to skip the \n
      parsedArticleRefs = parseCitationsBlock(refText);
    }

    // Merge: article refs (from ## References) take priority, then AI-parsed
    // refs, then saved DB refs (which are indexed differently and should NOT
    // override article-level references).
    // CRITICAL: The `references` prop from page.tsx is a flat array of ALL
    // project references (including web search results with paragraphId=null).
    // These are indexed by insertion order, NOT by citation number. Using them
    // as references[0] = [1] causes [1] to resolve to a random web search
    // result instead of the article's actual first reference.
    // Fix: Only use `references` prop when there are NO article-level refs
    // AND NO AI-parsed refs (i.e., for standalone paragraph views without
    // a composed article).
    // Merge article-level refs (## References) and AI-parsed refs (### Citations).
    // Gaps (sparse entries) are filled with a `missing` sentinel so the
    // rendering guard (Layer 3) can flag the corresponding [n] marker in red
    // instead of fabricating a misleading "Reference N" tooltip.
    const merged: CitationRef[] = [];
    const maxLen = Math.max(parsedArticleRefs.length, parsedAiRefs.length);
    for (let k = 0; k < maxLen; k++) {
      const articleRef = parsedArticleRefs[k];
      const ai = parsedAiRefs[k];
      merged.push(
        articleRef || ai || {
          type: "missing",
          title: `Reference ${k + 1} (missing)`,
          auditStatus: "missing",
          auditReason: `No entry [${k + 1}] found in the References section.`,
        }
      );
    }
    // If no article/AI refs were found, fall back to the `references` prop
    // (for standalone paragraph rendering without a composed article).
    if (merged.length === 0 && references.length > 0) {
      merged.push(...references);
    }

    const pushCited = (ref: CitationRef) => {
      const key = ref.id || `${ref.type}:${ref.externalId}` || ref.title;
      if (!citedKeys.has(key)) {
        citedKeys.add(key);
        citedList.push(ref);
      }
    };

    // Track which numeric indices into `merged` are actually cited, so the
    // per-section reference list can show only the references used here.
    const citedIdxSet = new Set<number>();

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
        // Record numeric citation indices (index into merged, 0-based)
        const nums: number[] = [];
        const innerTrim = inner.trim();
        for (const partOf of innerTrim.split(/[,;]\s*/)) {
          const rangeMatch = partOf.match(/^(\d+)\s*[-–]\s*(\d+)$/);
          if (rangeMatch) {
            const a = parseInt(rangeMatch[1], 10);
            const b = parseInt(rangeMatch[2], 10);
            for (let n = a; n <= b; n++) nums.push(n);
          } else {
            const n = parseInt(partOf, 10);
            if (!isNaN(n)) nums.push(n);
          }
        }
        for (const n of nums) {
          if (n >= 1 && n <= merged.length && merged[n - 1]) citedIdxSet.add(n - 1);
        }
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

    // Split body from reference/citations section at the earliest header found.
    // The content may have "### Citations" (paragraph) or "## References" (article)
    // or bare "REFERENCES" (AI-generated). We split at the earliest one.
    if (refSectionIdx >= content.length) {
      // No reference section header found — entire content is body
      return { bodySegments: segments, citationsBlock: null, citedRefs: citedList, allRefs: merged, hasContentRefs: false, citedIdx: citedIdxSet };
    }
    let acc = 0;
    const body: Segment[] = [];
    const rest: Segment[] = [];
    for (const s of segments) {
      const segStart = acc;
      const segEnd = acc + s.text.length;
      if (segEnd <= refSectionIdx) {
        body.push(s);
      } else if (segStart >= refSectionIdx) {
        rest.push(s);
      } else {
        const splitAt = refSectionIdx - segStart;
        body.push({ ...s, text: s.text.slice(0, splitAt) });
        rest.push({ ...s, text: s.text.slice(splitAt) });
      }
      acc = segEnd;
    }
    const citText = rest.map((s) => s.text).join("");
    // Only treat as citationsBlock (for fallback rendering) if it's a "### Citations" block.
    // For "## References" or "REFERENCES", we render the text as-is via contentRefText.
    const isCitationsBlock = citeHeaderIdx >= 0 && citeHeaderIdx === refSectionIdx;
    return {
      bodySegments: body,
      citationsBlock: isCitationsBlock ? citText : null,
      contentRefText: !isCitationsBlock ? citText : null,
      citedRefs: citedList,
      allRefs: merged,
      hasContentRefs: !isCitationsBlock,
      citedIdx: citedIdxSet,
    };
  }, [content, annotations, references]);

  return (
    <div className={`prose-academic ${className}`}>
      {/* Render content blocks: headings as styled h2/h3, body as paragraph */}
      {renderContentBlocks(bodySegments, { allRefs, onCitationClick, onAnnotationClick })}

      {/* Fallback: raw AI-generated citation block (only if no structured refs) */}
      {citationsBlock && citedRefs.length === 0 && (
        <div className="mt-3 pt-3 border-t border-dashed border-border/70 text-xs text-muted-foreground font-mono whitespace-pre-wrap break-words leading-relaxed">
          {citationsBlock}
        </div>
      )}

      {/* Article's own reference section (from "## References" or "REFERENCES" in content).
          Rendered as literal text — no duplicate component-generated list is added. */}
      {contentRefText && (
        <div className="mt-4 pt-3 border-t border-border/70">
          <div className="text-[11px] leading-snug font-sans text-foreground/85 whitespace-pre-wrap break-words">
            {contentRefText}
          </div>
        </div>
      )}

      {/* Component-generated reference list — only shown if the content does NOT
          already have its own reference section AND suppressRefList is false.
          When onlyCitedRefs is true, only the references actually cited in this
          content are listed (per-section bibliography). */}
      {!hasContentRefs && !suppressRefList && allRefs.length > 0 && (
        <div className="mt-4 pt-3 border-t border-border/70">
          <p className="divider-academic mb-2">
            <span>{onlyCitedRefs ? `References (${citedIdx.size})` : "References"}</span>
          </p>
          {/* v97-1: Enhanced reference list with rounded-lg + shadow-sm */}
          <ol className="list-none rounded-lg overflow-hidden border border-border/40 shadow-sm">
            {allRefs.map((r, i) => {
              if (onlyCitedRefs && !citedIdx.has(i)) return null;
              return (
              <li
                id={`ref-${i + 1}`}
                key={r.id || i}
                className={`text-[11px] leading-snug flex gap-1.5 font-sans text-foreground/85 px-2.5 py-1.5 transition-colors hover:bg-accent/30 scroll-mt-16 ${
                  r.auditStatus === "missing"
                    ? "bg-red-50/60 dark:bg-red-950/20"
                    : r.auditStatus === "unsupported" || r.auditStatus === "suspect"
                    ? "bg-amber-50/50 dark:bg-amber-950/15"
                    : i % 2 === 0
                    ? "bg-transparent"
                    : "bg-muted/25"
                }`}
              >
                <span className="font-mono text-primary font-semibold shrink-0">
                  [{i + 1}]
                </span>
                <span className="flex-1 min-w-0 break-words">
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
                    <span className="ml-1 text-[9px] font-mono text-muted-foreground break-all">
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
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
