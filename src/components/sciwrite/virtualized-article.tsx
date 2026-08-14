"use client";

import * as React from "react";
import { MarkdownCitations, parseCitationsBlock, type CitationRef } from "./markdown-citations";
import { cleanArticleContent } from "@/lib/writing";
import type { Annotation, Reference } from "@/lib/types";

/**
 * VirtualizedArticle — renders long article content in sections, only
 * mounting the sections that are near the viewport. This prevents the
 * browser from creating tens of thousands of DOM nodes for a 50,000-word
 * article, which would cause janky scrolling and high memory usage.
 *
 * Strategy:
 * 1. Split the article content on ## headings into sections.
 * 2. Each section is wrapped in a <div> with a sentinel observer.
 * 3. An IntersectionObserver tracks which sections are visible (with a
 *    rootMargin of ~1000px so sections above/below the viewport stay
 *    mounted for smooth scrolling).
 * 4. Non-visible sections render a placeholder div with the estimated
 *    height (based on char count) to maintain scroll position accuracy.
 *
 * For articles under VIRTUALIZE_THRESHOLD chars, the content is rendered
 * normally (no virtualization) — the overhead isn't worth it for small
 * articles.
 */

const VIRTUALIZE_THRESHOLD = 15000; // ~3000 words — below this, render normally
const ROOT_MARGIN = "1500px 0px"; // pre-mount sections within 1500px of viewport

interface Props {
  content: string;
  className?: string;
  annotations?: Annotation[];
  references?: Reference[];
  onCitationClick?: (ref: Reference, index: number) => void;
  onAnnotationClick?: (a: Annotation) => void;
  contentRef?: React.RefObject<HTMLDivElement>;
}

interface Section {
  heading: string; // "## Title" including the ## prefix
  body: string;    // content after the heading (may include sub-headings ###)
  charCount: number;
}

/**
 * Split article content into sections on ## headings. Lines starting with
 * # (h1) or ### (h3) are kept WITH the section they appear in — only ##
 * (h2) starts a new section. Content before the first ## heading becomes
 * the first section (with an empty heading).
 */
function splitIntoSections(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let currentHeading = "";
  let currentBody: string[] = [];

  for (const line of lines) {
    if (/^##\s+/.test(line) && !/^###\s/.test(line)) {
      // New h2 section — flush the previous one
      if (currentHeading || currentBody.length > 0) {
        const body = currentBody.join("\n");
        sections.push({
          heading: currentHeading,
          body,
          charCount: currentHeading.length + body.length,
        });
      }
      currentHeading = line;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  // Flush the last section
  if (currentHeading || currentBody.length > 0) {
    const body = currentBody.join("\n");
    sections.push({
      heading: currentHeading,
      body,
      charCount: currentHeading.length + body.length,
    });
  }
  return sections;
}

/**
 * Estimate the rendered height of a section based on its character count.
 * Rough heuristic: ~0.6px per character at 13.5px font size with
 * leading-relaxed, plus padding. This is used for the placeholder div
 * so the scrollbar stays accurate when the section is not mounted.
 */
function estimateSectionHeight(charCount: number): number {
  // Average: 80 chars per line, 22px per line, plus 32px section padding
  const lines = Math.ceil(charCount / 80);
  return Math.max(60, lines * 22 + 32);
}

export function VirtualizedArticle({
  content,
  className = "",
  annotations = [],
  references = [],
  onCitationClick,
  onAnnotationClick,
  contentRef,
}: Props) {
  const cleanedContent = React.useMemo(() => cleanArticleContent(content), [content]);
  const sections = React.useMemo(() => splitIntoSections(cleanedContent), [cleanedContent]);

  // Extract the "## References" section from the FULL article content so that
  // body sections (which don't contain the References section) can still
  // resolve citation markers like [1], [2] to the correct reference.
  // This is critical for the virtualized case: each section is rendered
  // independently by MarkdownCitations, which can only see its own content.
  // Without this, body sections have no reference data for hover tooltips.
  const globalArticleRefs = React.useMemo<CitationRef[]>(() => {
    // If DB references are passed, use them (they take priority).
    if (references.length > 0) return references as CitationRef[];

    // Otherwise, parse the "## References" or "REFERENCES" section from the
    // full article content. Also check "## 参考文献" for Chinese-translated
    // articles (contentZh) so citations resolve correctly in the ZH view.
    const refHeaderIdx =
      cleanedContent.indexOf("## References") >= 0
        ? cleanedContent.indexOf("## References")
        : cleanedContent.indexOf("## 参考文献");
    const bareRefIdx = cleanedContent.indexOf("\nREFERENCES\n");
    if (refHeaderIdx >= 0) {
      const refText = cleanedContent.slice(refHeaderIdx);
      const parsed = parseCitationsBlock(refText);
      if (parsed.length > 0) return parsed;
    }
    if (bareRefIdx >= 0) {
      const refText = cleanedContent.slice(bareRefIdx + 1);
      const parsed = parseCitationsBlock(refText);
      if (parsed.length > 0) return parsed;
    }
    return [];
  }, [cleanedContent, references]);

  // For small articles, skip virtualization entirely.
  if (cleanedContent.length < VIRTUALIZE_THRESHOLD) {
    return (
      <div ref={contentRef} className={`${className} scroll-academic`}>
        <MarkdownCitations
          content={cleanedContent}
          annotations={annotations}
          references={globalArticleRefs}
          onCitationClick={onCitationClick}
          onAnnotationClick={onAnnotationClick}
        />
      </div>
    );
  }

  return (
    <div ref={contentRef} className={`${className} scroll-academic`}>
      <VirtualizedSections
        sections={sections}
        annotations={annotations}
        references={globalArticleRefs}
        onCitationClick={onCitationClick}
        onAnnotationClick={onAnnotationClick}
      />
    </div>
  );
}

/**
 * VirtualizedSections — the actual IntersectionObserver-driven virtualizer.
 * Each section is a <VirtualSection> that mounts/unmounts based on visibility.
 */
function VirtualizedSections({
  sections,
  annotations,
  references,
  onCitationClick,
  onAnnotationClick,
}: {
  sections: Section[];
  annotations: Annotation[];
  references: Reference[];
  onCitationClick?: (ref: Reference, index: number) => void;
  onAnnotationClick?: (a: Annotation) => void;
}) {
  const [visibleSet, setVisibleSet] = React.useState<Set<number>>(new Set());
  const observerRef = React.useRef<IntersectionObserver | null>(null);
  const sectionRefs = React.useRef<Map<number, HTMLDivElement>>(new Map());

  React.useEffect(() => {
    // Create an IntersectionObserver that tracks which sections are within
    // the rootMargin of the scroll container. When a section enters/leaves,
    // we add/remove its index from visibleSet.
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleSet((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const idx = Number(entry.target.getAttribute("data-section-idx"));
            if (entry.isIntersecting) {
              next.add(idx);
            } else {
              next.delete(idx);
            }
          }
          return next;
        });
      },
      { rootMargin: ROOT_MARGIN },
    );
    observerRef.current = observer;

    // Observe all section sentinels
    sectionRefs.current.forEach((el) => observer.observe(el));

    return () => {
      observer.disconnect();
    };
  }, [sections.length]);

  return (
    <>
      {sections.map((section, idx) => {
        const isVisible = visibleSet.has(idx);
        const estimatedHeight = estimateSectionHeight(section.charCount);
        const sectionContent = section.heading
          ? `${section.heading}\n\n${section.body}`
          : section.body;

        // Check if this section is the "## References" section.
        // If so, render it normally (it contains the reference list).
        // If NOT (body section), pass a flag to suppress the component-generated
        // reference list — the article's ## References section will render it.
        const isReferencesSection = section.heading &&
          /^##\s+(References|REFERENCES|Citations|Bibliography|文献|参考文献)/.test(section.heading);

        return (
          <div
            key={idx}
            data-section-idx={idx}
            ref={(el) => {
              if (el) sectionRefs.current.set(idx, el);
              else sectionRefs.current.delete(idx);
            }}
            style={{ minHeight: isVisible ? undefined : estimatedHeight }}
          >
            {isVisible ? (
              <MarkdownCitations
                content={sectionContent}
                annotations={annotations}
                references={references}
                onCitationClick={onCitationClick}
                onAnnotationClick={onAnnotationClick}
                suppressRefList={!isReferencesSection && references.length > 0}
              />
            ) : (
              // Placeholder — keeps scroll height stable. The minHeight on
              // the parent div ensures the scrollbar doesn't jump.
              <div className="opacity-0" aria-hidden="true">
                <MarkdownCitations content={sectionContent} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
