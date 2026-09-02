"use client";

import * as React from "react";
import { MarkdownCitations, parseCitationsBlock, type CitationRef } from "./markdown-citations";
import { cleanArticleContent } from "@/lib/writing";
import type { Annotation } from "@/lib/types";

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

/**
 * round-44: how the virtualizer used to break scrolling (both symptoms the
 * user reported — "section jump gets stuck" + "mouse wheel feels blocked"):
 *
 * 1. PLACEHOLDER GHOST CONTENT: an unmounted section rendered its FULL
 *    MarkdownCitations output wrapped in `opacity-0` — zero DOM savings, and
 *    the opacity-0 subtree still hit-tested (hover chips inside invisible
 *    sections could swallow pointer events).
 * 2. HEIGHT ESTIMATE DRIFT: the placeholder minHeight used a fixed heuristic
 *    (~80 chars/line) that over-estimates real rendered height by ~40% for
 *    English on the wide round-32 sheets. Every mount event collapsed the
 *    section by ~100px → viewport scrollHeight changed MID-SCROLL → the
 *    browser dragged the viewport down (wheel feels "blocked") and every
 *    jumpToSection offset computed from the old layout missed its target
 *    ("jump gets stuck").
 *
 * The fix, in two parts:
 *   A. MEASURED-HEIGHT CACHE: the first frame after a section mounts, its
 *      real height is recorded (per resize/width). When the section unmounts,
 *      the placeholder uses the RECORDED height instead of the estimate, so
 *      scrollHeight stays constant after the first pass — no mid-scroll
 *      jumps, and jump offsets stay valid.
 *   B. PRE-MOUNTED LIVE GLIDE: callers jump via [data-h2-idx] markers
 *      which exist on BOTH mounted and placeholder section shells (see
 *      jumpToSection in article-viewer-tabs.tsx). The span the glide will
 *      pass through is force-mounted FIRST (requestSectionMounts below,
 *      whose round-48 ack tells the caller when the commit landed), then
 *      a live-goal rAF glide runs to the exact heading — re-reading the
 *      goal every frame so any residual drift bends the trajectory
 *      smoothly instead of triggering a second animation, and cancelled
 *      by the first user input (round-46..48 — no teleport, never an
 *      instant snap, never a native smooth restart).
 */

/** round-47/48: jump pre-mount channel. The jump code (article-viewer-tabs)
 *  asks the virtualizer to force-mount a span of sections BEFORE the
 *  animated glide starts, so the goal is final for the whole animation —
 *  gliding through unmeasured placeholders made jumps overshoot and then
 *  bounce back when the mount waves corrected the goal. Dispatched on the
 *  VirtualizedArticle wrapper (the section shells' parent node);
 *  VirtualizedSections listens there and merges the indices into its
 *  visible set. Pinned sections unmount naturally when the viewport
 *  leaves them (the observer's boundary-crossing flow) — no TTL needed.
 *
 *  round-48: the request RESOLVES (ack) once the virtualizer has COMMITTED
 *  the pin — the detail carries an `ack` callback fired after the mount
 *  commit's passive effects (or synchronously when nothing needs
 *  mounting). The caller's settle wait gates on this Promise, closing the
 *  race where the goal looked "stable" before React had even committed
 *  and the glide launched at a stale estimate-based goal. A 250ms safety
 *  timeout covers listeners that never ack. */
export const SECTION_MOUNT_REQUEST = "sciwrite:section-mount-request";

export function requestSectionMounts(root: HTMLElement, indices: number[]): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const ack = () => {
      if (done) return;
      done = true;
      resolve();
    };
    // bubbles: true — the listener may sit on an ancestor of the dispatch
    // node (the caller's ref can be co-attached to outer nodes), so the
    // event must climb to reach it.
    root.dispatchEvent(
      new CustomEvent(SECTION_MOUNT_REQUEST, { detail: { indices, ack }, bubbles: true }),
    );
    window.setTimeout(ack, 250);
  });
}

/**
 * Estimate the rendered height of a section based on its character mix.
 * CJK-aware (round-44): CJK glyphs are ~full-width, latin ~0.45 of that.
 * This is only the FIRST-PASS approximation — the measured-height cache
 * takes over as soon as a section has been mounted once, so a ~15% error
 * here only affects the very first scroll pass over each section.
 */
function estimateSectionHeight(charCount: number, cjkCount: number): number {
  // Effective "full-width units": CJK chars count 1, latin ~0.45.
  const units = cjkCount + (charCount - cjkCount) * 0.45;
  // On a ~1500px sheet at 13.5px font: ~100 full-width units per line.
  // 22px line height (13.5 × 1.625 leading-relaxed) + 32px section spacing.
  const lines = Math.ceil(units / 100);
  return Math.max(60, lines * 22 + 32);
}

function countCjk(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) ||
        (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) n++;
  }
  return n;
}

interface Props {
  content: string;
  className?: string;
  annotations?: Annotation[];
  references?: CitationRef[];
  onCitationClick?: (ref: CitationRef, index: number) => void;
  onAnnotationClick?: (a: Annotation) => void;
  contentRef?: React.RefObject<HTMLDivElement | null>;
}

interface Section {
  heading: string; // "## Title" including the ## prefix
  body: string;    // content after the heading (may include sub-headings ###)
  charCount: number;
  cjkCount: number; // round-44: CJK-aware height estimation
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
          cjkCount: countCjk(currentHeading + body),
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
      cjkCount: countCjk(currentHeading + body),
    });
  }
  return sections;
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

  // round-47 fix: the mount-request listener must sit on THIS wrapper (the
  // shells' direct parent). The caller's contentRef can be co-attached to an
  // ancestor node elsewhere — last-writer-wins makes which node it points at
  // non-deterministic — so anchor the listener with an internal ref merged
  // onto the same div. The dispatch node (shells' parentElement) then always
  // matches the listener node.
  const localWrapperRef = React.useRef<HTMLDivElement | null>(null);
  const setWrapperRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      localWrapperRef.current = node;
      if (contentRef) contentRef.current = node;
    },
    [contentRef],
  );

  // Extract the "## References" section from the FULL article content so that
  // body sections (which don't contain the References section) can still
  // resolve citation markers like [1], [2] to the correct reference.
  // This is critical for the virtualized case: each section is rendered
  // independently by MarkdownCitations, which can only see its own content.
  // Without this, body sections have no reference data for hover tooltips.
  // Note: DB `Reference` rows are structurally compatible with CitationRef,
  // so callers may pass either.
  const globalArticleRefs = React.useMemo<CitationRef[]>(() => {
    // If DB references are passed, use them (they take priority).
    if (references.length > 0) return references;

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
    <div ref={setWrapperRef} className={`${className} scroll-academic`}>
      <VirtualizedSections
        sections={sections}
        annotations={annotations}
        references={globalArticleRefs}
        onCitationClick={onCitationClick}
        onAnnotationClick={onAnnotationClick}
        rootRef={localWrapperRef}
      />
    </div>
  );
}

/**
 * VirtualizedSections — the actual IntersectionObserver-driven virtualizer.
 * Each section is a <VirtualSection> that mounts/unmounts based on visibility.
 *
 * round-44 changes:
 * - The placeholder for an unmounted section is now an EMPTY div (no
 *   MarkdownCitations render at opacity-0 — that rendered the full DOM
 *   anyway and ghost subtrees still hit-tested). Real DOM savings now.
 * - Measured-height cache: one frame after a section mounts, its actual
 *   height is recorded and reused as the placeholder height when it
 *   unmounts — scrollHeight no longer jumps mid-scroll.
 * - Every section shell (mounted or not) carries data-section-idx, and
 *   shells whose content starts with a ## heading also carry data-h2-idx
 *   (the ordinal of that heading among all h2 headings). Jump logic in
 *   article-viewer-tabs.tsx targets [data-h2-idx] so targets ALWAYS exist
 *   in the DOM, mounted or not.
 */
function VirtualizedSections({
  sections,
  annotations,
  references,
  onCitationClick,
  onAnnotationClick,
  rootRef,
}: {
  sections: Section[];
  annotations: Annotation[];
  references: CitationRef[];
  onCitationClick?: (ref: CitationRef, index: number) => void;
  onAnnotationClick?: (a: Annotation) => void;
  rootRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const [visibleSet, setVisibleSet] = React.useState<Set<number>>(new Set());
  const observerRef = React.useRef<IntersectionObserver | null>(null);
  const sectionRefs = React.useRef<Map<number, HTMLDivElement>>(new Map());
  // round-44: measured real heights per section idx — STATE (not a ref) so
  // the render below can read it legally (React compiler rule: no ref
  // access during render). Written one frame after a section mounts via
  // MeasureOnMount; read when the section unmounts (placeholder height).
  const [measuredHeights, setMeasuredHeights] = React.useState<Map<number, number>>(new Map());

  React.useEffect(() => {
    // Create an IntersectionObserver that tracks which sections are within
    // the rootMargin of the scroll container. When a section enters/leaves,
    // we add/remove its index from visibleSet.
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleSet((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            const idx = Number(entry.target.getAttribute("data-section-idx"));
            if (entry.isIntersecting) {
              if (!next.has(idx)) { next.add(idx); changed = true; }
            } else {
              if (next.has(idx)) { next.delete(idx); changed = true; }
            }
          }
          return changed ? next : prev;
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

  // Invalidate the measured-height cache when the layout width changes —
  // recorded heights are only valid for the width they were measured at.
  React.useEffect(() => {
    const onResize = () => setMeasuredHeights(new Map());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // round-47/48: jump pre-mount channel — see requestSectionMounts above.
  // Merges the requested indices into the visible set; the observer's
  // natural boundary-crossing flow unmounts them once the viewport moves
  // on (no IO entry fires for a far pinned section until the viewport
  // actually crosses its boundary, so pins persist). round-48: the ack
  // callback resolves the caller's pin Promise — synchronously when
  // nothing needs mounting (no commit would follow), otherwise after the
  // commit (the [visibleSet] effect below).
  const visibleSetRef = React.useRef(visibleSet);
  React.useEffect(() => {
    visibleSetRef.current = visibleSet;
  }, [visibleSet]);
  const pendingAckRef = React.useRef<(() => void) | null>(null);
  React.useEffect(() => {
    const ack = pendingAckRef.current;
    if (ack) {
      pendingAckRef.current = null;
      ack();
    }
  }, [visibleSet]);
  React.useEffect(() => {
    const root = rootRef?.current;
    if (!root) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { indices?: number[]; ack?: () => void }
        | undefined;
      const indices = detail?.indices;
      if (!indices || indices.length === 0) {
        detail?.ack?.();
        return;
      }
      const cur = visibleSetRef.current;
      const needsMount = indices.some((i) => i >= 0 && i < sections.length && !cur.has(i));
      if (!needsMount) {
        // Everything requested is already visible — no commit will follow,
        // so ack at once (otherwise the caller's settle would hang on the
        // frame cap).
        detail?.ack?.();
        return;
      }
      if (detail?.ack) pendingAckRef.current = detail.ack;
      setVisibleSet((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const i of indices) {
          if (i >= 0 && i < sections.length && !next.has(i)) {
            next.add(i);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    root.addEventListener(SECTION_MOUNT_REQUEST, handler);
    return () => root.removeEventListener(SECTION_MOUNT_REQUEST, handler);
  }, [rootRef, sections.length]);

  // Callback for MeasureOnMount — records a section's real height.
  const handleMeasured = React.useCallback((idx: number, h: number) => {
    setMeasuredHeights((prev) => {
      if (prev.get(idx) === h) return prev;
      const next = new Map(prev);
      next.set(idx, h);
      return next;
    });
  }, []);

  // h2 ordinal (only sections that START with a ## heading get one — matches
  // the querySelectorAll("h2") ordering the jump/TOC code relies on).
  // Computed inside useMemo — reassigning a render-scope variable in the
  // map callback trips the React compiler's reassign-after-render rule.
  const h2IdxBySection = React.useMemo(() => {
    const map: number[] = [];
    let counter = -1;
    for (const s of sections) {
      if (s.heading && /^##\s+/.test(s.heading)) {
        counter += 1;
        map.push(counter);
      } else {
        map.push(-1);
      }
    }
    return map;
  }, [sections]);

  return (
    <>
      {sections.map((section, idx) => {
        const isVisible = visibleSet.has(idx);
        const measured = measuredHeights.get(idx);
        const estimated = estimateSectionHeight(section.charCount, section.cjkCount);
        // Real measured height wins once available — the estimate only
        // covers the never-scrolled first pass.
        const placeholderH = measured ?? estimated;
        const sectionContent = section.heading
          ? `${section.heading}\n\n${section.body}`
          : section.body;

        // Check if this section is the "## References" section.
        // If so, render it normally (it contains the reference list).
        // If NOT (body section), pass a flag to suppress the component-generated
        // reference list — the article's ## References section will render it.
        const isReferencesSection = section.heading &&
          /^##\s+(References|REFERENCES|Citations|Bibliography|文献|参考文献)/.test(section.heading);

        const h2Idx = h2IdxBySection[idx];

        return (
          <div
            key={idx}
            data-section-idx={idx}
            {...(h2Idx >= 0 ? { "data-h2-idx": h2Idx } : {})}
            ref={(el) => {
              if (el) sectionRefs.current.set(idx, el);
              else sectionRefs.current.delete(idx);
            }}
            style={{ minHeight: isVisible ? undefined : placeholderH }}
          >
            {isVisible ? (
              <>
                <MarkdownCitations
                  content={sectionContent}
                  annotations={annotations}
                  references={references}
                  onCitationClick={onCitationClick}
                  onAnnotationClick={onAnnotationClick}
                  suppressRefList={!isReferencesSection && references.length > 0}
                />
                {/* round-44: record the real height at mount so the
                    placeholder can reuse it on unmount (stable
                    scrollHeight). */}
                <MeasureOnMount idx={idx} onMeasured={handleMeasured} />
              </>
            ) : (
              // Placeholder — an EMPTY div at the recorded/estimated height.
              // (round-44: previously this rendered the full section content
              // at opacity-0, which saved no DOM and ghost-hit-tested.)
              <div aria-hidden="true" style={{ height: placeholderH }} />
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * MeasureOnMount — invisible sentinel rendered inside a MOUNTED section.
 *
 * round-47 fix: this used to look the shell up in the parent's ref map,
 * but React's bottom-up commit order runs this component's layout effect
 * BEFORE the shell's ref callback populates that map — every lookup came
 * back undefined, so heights were NEVER recorded and every unmount fell
 * back to the estimate (scrollHeight changed on each unmount — the
 * "jumps down past the target, then bounces back" symptom). Instead the
 * sentinel measures its OWN parentElement (the shell): the sentinel's
 * host ref is guaranteed to attach before this effect runs — same
 * bottom-up order, used to our advantage. Measuring synchronously in the
 * same commit (before paint) keeps the recorded height the layout's final
 * value for that frame, and React batches the setStates from all sections
 * mounting in one commit into a single re-render.
 *
 * round-48: the synchronous measurement can still be STALE — markdown is
 * a multi-pass render (citation chips, footnote positions) and web fonts
 * settle a few frames after the mount commit. A stale entry is exactly
 * what the placeholder uses on unmount, and the E2E probe caught a
 * -121px goal jump from it mid-glide ("position still wrong, one bounce
 * back"). Re-measure ~90ms later and let the later value win; the extra
 * setState is render-only (mounted sections don't read the placeholder
 * height) so it never disturbs the live layout.
 */
function MeasureOnMount({
  idx,
  onMeasured,
}: {
  idx: number;
  onMeasured: (idx: number, h: number) => void;
}) {
  const sentinelRef = React.useRef<HTMLSpanElement | null>(null);
  const measure = React.useCallback(() => {
    const shell = sentinelRef.current?.parentElement;
    if (shell && shell.isConnected) {
      // Full footprint: distance to the NEXT shell's top (height + the
      // inter-section gap). The gap comes from the mounted content's
      // trailing margin and vanishes on unmount — the placeholder must
      // reserve it too, or every unmount shrinks the layout by the gap and
      // mid-glide goals drift (round-47: observed -20px per passed section).
      const next = shell.nextElementSibling;
      const h = next
        ? next.getBoundingClientRect().top - shell.getBoundingClientRect().top
        : shell.getBoundingClientRect().height;
      if (h > 0) onMeasured(idx, h);
    }
  }, [idx, onMeasured]);
  React.useLayoutEffect(() => {
    measure();
    // round-48: deferred re-measure — the layout may still be settling
    // (multi-pass markdown, font swap) when the synchronous pass runs.
    // The cleanup also covers unmount-before-90ms (sentinel detached →
    // the re-measure no-ops).
    const t = window.setTimeout(measure, 90);
    return () => window.clearTimeout(t);
  }, [measure]);
  return <span ref={sentinelRef} aria-hidden="true" style={{ display: "none" }} />;
}
