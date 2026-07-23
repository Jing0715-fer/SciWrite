"use client";

import * as React from "react";
import type { Annotation } from "@/lib/types";

interface Segment {
  type: "text" | "cite" | "highlight";
  text: string;
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
    // Prefer stored offset; fall back to indexOf.
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

export function MarkdownCitations({
  content,
  annotations = [],
  onAnnotationClick,
  className = "",
}: {
  content: string;
  annotations?: Annotation[];
  onAnnotationClick?: (a: Annotation) => void;
  className?: string;
}) {
  const { bodySegments, citationsBlock } = React.useMemo(() => {
    const highlights = buildHighlightRanges(content, annotations);
    const citeRe = new RegExp(CITE_RE_SOURCE, "g");
    const segments: Segment[] = [];
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
        segments.push({ type: "cite", text: m[0] });
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

    const citeHeaderIdx = content.indexOf("### Citations");
    if (citeHeaderIdx === -1) {
      return { bodySegments: segments, citationsBlock: null };
    }
    let acc = 0;
    const body: Segment[] = [];
    const rest: Segment[] = [];
    for (const s of segments) {
      const segStart = acc;
      const segEnd = acc + s.text.length;
      if (segEnd <= citeHeaderIdx) {
        body.push(s);
      } else if (segStart >= citeHeaderIdx) {
        rest.push(s);
      } else {
        const splitAt = citeHeaderIdx - segStart;
        body.push({ ...s, text: s.text.slice(0, splitAt) });
        rest.push({ ...s, text: s.text.slice(splitAt) });
      }
      acc = segEnd;
    }
    const citText = rest.map((s) => s.text).join("");
    return { bodySegments: body, citationsBlock: citText };
  }, [content, annotations]);

  return (
    <div className={`prose-academic ${className}`}>
      <p className="whitespace-pre-wrap break-words m-0">
        {bodySegments.map((s, idx) => {
          if (s.type === "cite") {
            const inner = s.text.replace(/^\[|\]$/g, "");
            return (
              <span key={idx} className="cite-marker" title={`Citation: ${inner}`}>
                {inner}
              </span>
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
      {citationsBlock && (
        <div className="mt-3 pt-3 border-t border-dashed border-border/70 text-xs text-muted-foreground font-mono whitespace-pre-wrap leading-relaxed">
          {citationsBlock}
        </div>
      )}
    </div>
  );
}
