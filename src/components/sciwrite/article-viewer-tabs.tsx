"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  FileText,
  Layers,
  Gavel,
  Network,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Columns2,
  RotateCw,
  BookOpen,
  Wand2,
  Clock,
  Hash,
  Quote,
  FileStack,
  TrendingUp,
  ListTree,
  GitCompare,
  Search,
  X,
  ChevronUp,
  ChevronDown,
  Highlighter,
  Sparkles,
  BarChart3,
  Type,
  Copy,
  ArrowUpToLine,
  ArrowDownToLine,
  Check,
  Keyboard,
  SkipForward,
  Trash2,
  History,
  ShieldCheck,
  GitBranch,
  LayoutGrid,
  PenLine,
  Database,
  ClipboardCheck,
  Upload,
  RefreshCw,
  ScanSearch,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExportMenu } from "./export-menu";
import { ReviewDialog } from "./review-dialog";
import { MarkdownCitations, parseCitationsBlock } from "./markdown-citations";
import { CitationGraph } from "./citation-graph";
import { VirtualizedArticle, requestSectionMounts } from "./virtualized-article";
import { VersionHistoryDialog } from "./version-history-dialog";
import { CitationVerifyDialog } from "./citation-verify-dialog";
import { CommentsPanel } from "./comments-panel";
import { SummaryDialog } from "./summary-dialog";
import { DiagramDialog } from "./diagram-dialog";
import { StructureDialog } from "./structure-dialog";
import { StyleAnalysisDialog } from "./style-analysis-dialog";
import { EnrichReferencesDialog } from "./enrich-references-dialog";
import { SubmissionCheckDialog } from "./submission-check-dialog";
import { ImportReferencesDialog } from "./import-references-dialog";
import { CitationAuditBanner } from "./citation-audit-banner";
import { AuditReportViewer } from "./audit-report-viewer";
import { api } from "@/lib/api-client";
import { useI18n } from "@/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cleanArticleContent, countWords } from "@/lib/writing";
import { useKeyboardShortcuts, formatShortcut } from "@/hooks/use-keyboard-shortcuts";
import { ArticleInsights, ReadingProgressIndicator } from "./article-insights";
import type { ViewLang } from "./article-insights";

/* round-31: main-tab styling aligned to the `.tab-pill` language in
   globals.css — active = filled primary-tint pill with hairline ring;
   inactive = quiet muted + hover tint. Shared by all 5 viewer tabs. */
const TAB_TRIGGER_CLS =
  "h-7 gap-1.5 px-3 text-[11px] font-medium rounded-md transition-all " +
  "text-muted-foreground data-[state=inactive]:hover:text-foreground data-[state=inactive]:hover:bg-muted/60 " +
  "data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:font-semibold " +
  "data-[state=active]:ring-1 data-[state=active]:ring-primary/30 data-[state=active]:shadow-xs " +
  "dark:data-[state=active]:bg-primary/20 dark:data-[state=active]:text-primary";

interface Props {
  article: {
    id: string;
    title: string;
    titleZh?: string | null;
    abstract?: string | null;
    content: string;
    contentZh?: string | null;
    createdAt?: string | Date;
    updatedAt?: string | Date;
  };
  projectId: string;
  onClose: () => void;
}

/* round-44..47 — scroll-jump helpers shared by the viewer and its TOC rail.
 *
 * The article body is virtualized (VirtualizedArticle): a section far from
 * the viewport is an EMPTY placeholder shell whose height is the last
 * MEASURED height (or an ESTIMATE on the very first pass). Animating a
 * jump through unmeasured territory used to overshoot: the glide was
 * launched at a goal computed from estimates, then the mount waves along
 * the way corrected the goal backward and the viewport visibly bounced
 * back — "scrolls past the target, then jumps back".
 *
 * animatedScrollTo (round-47) — three steps, all animated, no teleport:
 *   0. PRE-MOUNT: force-mount every section the glide will pass through
 *      (plus the observer's rootMargin band above the landing spot) via
 *      requestSectionMounts — the layout becomes FINAL before moving.
 *   1. SETTLE: wait a few frames for the mount commit (goal stable across
 *      two frames, ~12-frame cap); if the user scrolls first, stand down.
 *   2. GLIDE: one smooth scroll from the current position to the exact
 *      heading; a supervisor re-targets (always smoothly) if anything
 *      still drifts and YIELDS instantly to user input. */

/** Nearest scrollable ancestor (overflowY auto/scroll and actually
 *  overflowing). Walks up from any element — works for both the Composed
 *  sheet and the TOC rail. */
function findScrollableAncestor(el: HTMLElement | null): HTMLElement | null {
  let node = el;
  while (node && node.parentElement) {
    node = node.parentElement;
    const style = window.getComputedStyle(node);
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
  }
  return null;
}

/** Resolve the jump target for h2 ordinal `idx` inside `root`:
 *  virtualized bodies mark every section shell with data-h2-idx (present
 *  even when the section is an empty placeholder); non-virtualized bodies
 *  fall back to the actual h2 elements. */
function resolveSectionTarget(root: HTMLElement | null, idx: number): HTMLElement | null {
  if (!root) return null;
  const shells = root.querySelectorAll("[data-h2-idx]");
  if (shells.length > 0) {
    return idx >= 0 && idx < shells.length ? (shells[idx] as HTMLElement) : null;
  }
  const h2s = root.querySelectorAll("h2");
  return idx >= 0 && idx < h2s.length ? (h2s[idx] as HTMLElement) : null;
}

/** Keys that signal the user is trying to scroll the viewport. */
const SCROLL_KEYS = new Set([
  "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ",
]);

/** Supervision token: starting a new glide cancels any supervisor loop
 *  still running from the previous jump (two loops would fight over the
 *  viewport). Module-level — every jump path shares the invariant. */
let jumpSupervision = 0;

/** Cancel the active supervised glide (for scroll paths that issue their
 *  own programmatic scrolls, e.g. search-match navigation). */
function cancelJumpSupervision() {
  jumpSupervision++;
}

/** User-intent guard shared by the settle wait and the glide: flips to
 *  "took over" on the first wheel / touch / scrollbar drag / scroll-key
 *  aimed at the viewport. keydown listens on document (focus may sit on
 *  the dialog root, not inside the scroll container). */
function attachUserIntentGuard(scrollEl: HTMLElement) {
  let took = false;
  const onInput = (e: Event) => {
    if (e.type === "keydown" && !SCROLL_KEYS.has((e as KeyboardEvent).key)) return;
    took = true;
  };
  const localEvents: ("wheel" | "touchstart" | "mousedown")[] = [
    "wheel", "touchstart", "mousedown",
  ];
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  for (const t of localEvents) scrollEl.addEventListener(t, onInput, opts);
  document.addEventListener("keydown", onInput, opts);
  return {
    tookOver: () => took,
    detach: () => {
      for (const t of localEvents) scrollEl.removeEventListener(t, onInput, opts);
      document.removeEventListener("keydown", onInput, opts);
    },
  };
}

/** round-47 step 0 — pre-mount the span the glide will pass through so
 *  the goal is FINAL before the animation starts. `targetShell` is the
 *  jump target's [data-section-idx] shell; upward jumps additionally pin
 *  the observer's rootMargin band ABOVE the landing spot (those sections
 *  mount during the final approach and their height swaps would shift
 *  the goal after arrival). No-op for non-virtualized bodies. */
function preMountJumpSpan(scrollEl: HTMLElement, targetShell: HTMLElement): void {
  const mountRoot = targetShell.parentElement;
  if (!mountRoot) return;
  const shells = Array.from(
    mountRoot.querySelectorAll<HTMLElement>("[data-section-idx]"),
  );
  if (shells.length === 0) return;
  const targetIdx = shells.indexOf(targetShell);
  if (targetIdx < 0) return;
  // Section at the viewport top (same 80px threshold the rail's spy uses).
  const scrollRect = scrollEl.getBoundingClientRect();
  let topIdx = 0;
  shells.forEach((sh, i) => {
    if (sh.getBoundingClientRect().top - scrollRect.top <= 80) topIdx = i;
  });
  let lo = Math.min(topIdx, targetIdx);
  const hi = Math.max(topIdx, targetIdx);
  if (targetIdx < topIdx) {
    // Upward jump — extend above the landing spot by ~1800px of sections
    // (placeholder shells report their placeholder height, mounted ones
    // their real height — both fine for this estimate).
    let acc = 0;
    let i = targetIdx - 1;
    while (i >= 0 && acc < 1800) {
      acc += shells[i].getBoundingClientRect().height;
      i -= 1;
    }
    lo = Math.min(lo, i + 1);
  }
  const indices: number[] = [];
  for (let i = lo; i <= hi; i++) indices.push(i);
  requestSectionMounts(mountRoot, indices);
}

/** round-47 step 1 — wait for the pin-mount commit + layout to settle
 *  (goal stable across two frames, ~12-frame cap so a huge article can't
 *  stall the click), then hand off. If the user scrolls first, stand down
 *  entirely (their intent wins even during the settle window). */
function waitForLayoutSettle(
  scrollEl: HTMLElement,
  getGoal: () => number,
  then: () => void,
) {
  const guard = attachUserIntentGuard(scrollEl);
  let stable = 0;
  let last: number | null = null;
  let frames = 0;
  const tick = () => {
    requestAnimationFrame(() => {
      const goal = getGoal();
      stable = last !== null && Math.abs(goal - last) <= 1 ? stable + 1 : 0;
      last = goal;
      frames += 1;
      if (guard.tookOver() || !scrollEl.isConnected) {
        guard.detach();
        return;
      }
      if (stable >= 2 || frames >= 12) {
        guard.detach();
        then();
        return;
      }
      tick();
    });
  };
  tick();
}

/** round-47 step 2 — supervised glide: issues a SMOOTH scroll toward
 *  getGoalTop() immediately and re-targets it if anything still drifts.
 *  Exits when the user scrolls (their intent wins), when a newer jump
 *  takes over, when the position settles on mounted content, or after a
 *  4s backstop. Corrections are always smooth — never an instant snap. */
function superviseGlide(
  scrollEl: HTMLElement,
  getGoalTop: () => number | null,
  targetEl?: HTMLElement | null,
) {
  const my = ++jumpSupervision;
  const guard = attachUserIntentGuard(scrollEl);

  // First glide — issued synchronously so the jump starts the moment the
  // settle wait hands off (the supervisor corrects residual drift later).
  const goal0 = getGoalTop();
  if (goal0 === null) {
    guard.detach();
    return;
  }
  let lastIssued: number = goal0;
  scrollEl.scrollTo({ top: Math.max(0, goal0), behavior: "smooth" });

  const start = performance.now();
  let lastNow = start;
  let lastTop = scrollEl.scrollTop;
  let lastProgressAt = start;
  let settledMs = 0;

  const step = () => {
    requestAnimationFrame(() => {
      const now = performance.now();
      const dt = Math.max(0, now - lastNow);
      lastNow = now;
      if (
        guard.tookOver() ||
        my !== jumpSupervision ||
        !scrollEl.isConnected ||
        (targetEl ? !targetEl.isConnected : false) ||
        now - start > 4000
      ) {
        guard.detach();
        return;
      }
      const goal = getGoalTop();
      if (goal === null) {
        guard.detach();
        return;
      }
      const delta = Math.abs(goal - scrollEl.scrollTop);
      const moving = Math.abs(scrollEl.scrollTop - lastTop) >= 0.5;
      lastTop = scrollEl.scrollTop;
      if (moving || delta <= 4) lastProgressAt = now;

      if (delta > 4) {
        // Re-issue only when the goal actually moved (residual drift) or
        // when the glide stalled (its animation was cancelled without
        // user input) — re-issuing every frame would restart the easing
        // and stutter.
        const goalMoved = Math.abs(goal - lastIssued) > 8;
        const stalled = now - lastProgressAt > 200;
        if (goalMoved || stalled) {
          lastIssued = goal;
          lastProgressAt = now;
          scrollEl.scrollTo({ top: Math.max(0, goal), behavior: "smooth" });
        }
        settledMs = 0;
      } else {
        // Settled — but only count it once the target's CONTENT is mounted
        // (virtualized placeholders are empty shells; a mounted section
        // contains its h2), and only after ~0.4s of stillness.
        const mounted = !targetEl || targetEl.tagName === "H2" || targetEl.querySelector("h2") !== null;
        if (mounted) {
          settledMs += dt;
          if (settledMs >= 400) {
            guard.detach();
            return;
          }
        } else {
          settledMs = 0;
        }
      }
      step();
    });
  };
  step();
}

/** Animated jump (round-47): pre-mount → settle → ONE smooth glide from
 *  the CURRENT position to the target heading (see the block comment). */
function animatedScrollTo(scrollEl: HTMLElement, targetEl: HTMLElement, offsetAdjust = 12) {
  const computeGoal = () =>
    targetEl.getBoundingClientRect().top -
    scrollEl.getBoundingClientRect().top +
    scrollEl.scrollTop -
    offsetAdjust;
  // Any supervision still running from a previous jump must not fight
  // the settle window — take over the token now.
  cancelJumpSupervision();
  const shell = targetEl.matches("[data-section-idx]")
    ? targetEl
    : (targetEl.closest("[data-section-idx]") as HTMLElement | null);
  if (shell) {
    preMountJumpSpan(scrollEl, shell);
    waitForLayoutSettle(scrollEl, computeGoal, () =>
      superviseGlide(scrollEl, computeGoal, targetEl),
    );
  } else {
    // Non-virtualized body — the layout is already final; glide at once.
    superviseGlide(scrollEl, computeGoal, targetEl);
  }
}

export function ArticleViewerWithTabs({ article, projectId, onClose }: Props) {
  const { t } = useI18n();
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [viewLang, setViewLang] = React.useState<ViewLang>("en");
  const [batchProgress, setBatchProgress] = React.useState<{ done: number; total: number; current?: string } | null>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = React.useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false);
  const [versionHistoryOpen, setVersionHistoryOpen] = React.useState(false);
  const [citationVerifyOpen, setCitationVerifyOpen] = React.useState(false);
  const [summaryOpen, setSummaryOpen] = React.useState(false);
  const [diagramOpen, setDiagramOpen] = React.useState(false);
  const [structureOpen, setStructureOpen] = React.useState(false);
  const [styleOpen, setStyleOpen] = React.useState(false);
  const [enrichOpen, setEnrichOpen] = React.useState(false);
  const [submissionOpen, setSubmissionOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const composedContentRef = React.useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  // v121: regenerated article title (overrides the prop until remount).
  // Existing articles composed before the fix stored `project.topic` (the
  // project-creation brief) as their title — one click here rewrites it from
  // the article's actual content, so exports name the file after the article.
  const [titleOverride, setTitleOverride] = React.useState<string | null>(null);
  // round-28: in the Chinese view show the Chinese article title when the
  // bilingual pipeline produced one (falls back to the English title).
  const displayTitle = titleOverride
    ?? (viewLang === "zh" && article.titleZh ? article.titleZh : article.title);
  const regenerateTitleMut = useMutation({
    mutationFn: () => api.regenerateArticleTitle(article.id),
    onSuccess: (res: any) => {
      const newTitle: string | undefined = res?.article?.title;
      if (newTitle) setTitleOverride(newTitle);
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      toast.success(t("articleViewer.titleRegenerated") || "New title applied");
    },
    onError: (err: any) => {
      toast.error(err?.message || "Failed to regenerate title");
    },
  });

  // Delete the current article. Uses the DELETE /api/articles/[id] endpoint.
  // On success: invalidate the project query so the Articles list re-renders
  // without the deleted item, show a toast, and close the viewer dialog.
  const deleteArticleMut = useMutation({
    mutationFn: () => api.deleteArticle(article.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      toast.success(t("articleViewer.deleted") || "Article deleted");
      setDeleteConfirmOpen(false);
      onClose();
    },
    onError: (err: any) => {
      toast.error(err?.message || "Failed to delete article");
    },
  });

  const hasZh = !!article.contentZh;
  React.useEffect(() => {
    if (!hasZh && viewLang !== "en") setViewLang("en");
  }, [hasZh, viewLang]);

  // Jump to a section by index — scrolls the composed content area to the
  // section's h2 heading. Virtualized bodies expose [data-h2-idx] shells
  // that exist even while the section is an empty placeholder (round-44 —
  // the old querySelectorAll("h2") missed unmounted sections);
  // non-virtualized bodies use the h2s directly. Index is clamped to
  // [0, total-1], so passing 999 jumps to the last section.
  // Supervised smooth scroll: see animatedScrollTo above — the single
  // smooth scrollTo used to miss mid-flight when virtualized sections
  // mounted along the way and changed the scrollHeight. round-46: one
  // animated glide from the current position, and it yields to user
  // input instantly.
  const jumpToSectionIdx = React.useCallback((idx: number) => {
    if (!composedContentRef.current) return;
    const root = composedContentRef.current;
    const shells = root.querySelectorAll("[data-h2-idx]");
    const h2s = root.querySelectorAll("h2");
    const total = shells.length > 0 ? shells.length : h2s.length;
    if (total === 0) return;
    const clampedIdx = Math.max(0, Math.min(idx, total - 1));
    const target = resolveSectionTarget(root, clampedIdx);
    if (!target) return;
    const scrollEl = findScrollableAncestor(target);
    if (scrollEl) animatedScrollTo(scrollEl, target);
  }, [composedContentRef]);

  // Jump to the next section that's missing a Chinese translation.
  // Returns true if found, false if all sections have translations.
  // Uses a ref to access paragraphs (which is declared later in the component)
  // to avoid the react-hooks/immutability rule. The ref is updated in the
  // render body AFTER paragraphs is declared (see "paragraphsRef.current = paragraphs"
  // below the paragraphs declaration).
  const paragraphsRef = React.useRef<any[]>([]);
  const jumpToNextUntranslated = () => {
    const pars = paragraphsRef.current;
    if (!pars.length) return false;
    // Find first untranslated section AFTER the current scroll position.
    // We detect "current position" by checking which section shell is at
    // the top — [data-h2-idx] shells exist even while virtualized away
    // (round-44; the old h2-only query missed unmounted sections).
    const root = composedContentRef.current;
    const shells = root ? root.querySelectorAll("[data-h2-idx]") : [];
    let currentIdx = 0;
    if (shells.length > 0) {
      const scrollEl = findScrollableAncestor(root);
      if (scrollEl) {
        const threshold = 80;
        shells.forEach((sh, i) => {
          const rect = sh.getBoundingClientRect();
          const scrollRect = scrollEl.getBoundingClientRect();
          if (rect.top - scrollRect.top <= threshold) {
            currentIdx = i;
          }
        });
      }
    }
    // Search forward from currentIdx+1 for a paragraph without contentZh
    for (let i = currentIdx + 1; i < pars.length; i++) {
      if (!pars[i]?.contentZh) {
        jumpToSectionIdx(i);
        return true;
      }
    }
    // Wrap around: search from 0 to currentIdx
    for (let i = 0; i <= currentIdx; i++) {
      if (!pars[i]?.contentZh) {
        jumpToSectionIdx(i);
        return true;
      }
    }
    return false; // all translated
  };

  // Keyboard shortcuts:
  //   Cmd/Ctrl+K  → toggle search (overrides global Command Palette)
  //   Esc         → close search / review / shortcuts help / dialog (cascade)
  //   1/2/3       → switch language to EN / ZH / Parallel (only when hasZh)
  //   Home/End    → jump to first/last section
  //   ?           → show keyboard shortcuts help dialog
  //   J           → jump to next untranslated section (parallel mode only)
  // Uses capture: true so these take priority over the global Command
  // Palette handler (which also listens for Cmd+K on window bubble phase).
  // stopImmediatePropagation in the hook prevents the bubble-phase listener
  // from firing.
  useKeyboardShortcuts(
    [
      {
        key: "k",
        mod: "cmd",
        handler: () => {
          setSearchOpen((v) => {
            if (v) setSearchQuery("");
            return !v;
          });
        },
      },
      {
        key: "Escape",
        mod: "none",
        handler: () => {
          if (searchOpen) {
            setSearchOpen(false);
            setSearchQuery("");
          } else if (reviewOpen) {
            setReviewOpen(false);
          } else if (shortcutsHelpOpen) {
            setShortcutsHelpOpen(false);
          } else {
            onClose();
          }
        },
      },
      {
        key: "1",
        mod: "none",
        handler: () => hasZh && setViewLang("en"),
        enabled: hasZh,
      },
      {
        key: "2",
        mod: "none",
        handler: () => hasZh && setViewLang("zh"),
        enabled: hasZh,
      },
      {
        key: "3",
        mod: "none",
        handler: () => hasZh && setViewLang("parallel"),
        enabled: hasZh,
      },
      {
        key: "Home",
        mod: "none",
        handler: () => jumpToSectionIdx(0),
      },
      {
        key: "End",
        mod: "none",
        handler: () => jumpToSectionIdx(99), // large index = last (clamped)
      },
      {
        key: "?",
        mod: "none",
        handler: () => setShortcutsHelpOpen(true),
      },
      {
        // Delete key → open the delete confirmation dialog (soft delete)
        key: "Delete",
        mod: "none",
        handler: () => setDeleteConfirmOpen(true),
      },
      {
        // S → open AI summary dialog
        key: "s",
        mod: "none",
        handler: () => setSummaryOpen(true),
      },
      {
        // V → open citation verification dialog
        key: "v",
        mod: "none",
        handler: () => setCitationVerifyOpen(true),
      },
      {
        // H → open version history dialog
        key: "h",
        mod: "none",
        handler: () => setVersionHistoryOpen(true),
      },
      {
        key: "j",
        mod: "none",
        handler: () => {
          const found = jumpToNextUntranslated();
          if (!found) {
            toast.info(t("articleViewer.allTranslated") || "All sections already have Chinese translations.");
          }
        },
        enabled: viewLang === "parallel" && hasZh,
      },
    ],
    { capture: true }
  );

  // Fetch paragraphs for the Sections tab
  const paragraphsQ = useQuery({
    queryKey: ["article-paragraphs", article.id],
    queryFn: () => api.getProject(projectId),
    enabled: !!article.id,
  });

  const paragraphs = (paragraphsQ.data?.project?.paragraphs || []).filter(
    // r37 fix: the `|| true` fallback made this filter a no-op — the
    // Sections tab / stats / TOC counted ALL project paragraphs even for
    // articles composed from a subset (or article B in a 2-article project).
    // The projects API now includes articleParagraph links (filtered to
    // this article) so the filter has real data; keep a safe fallback for
    // stale caches only when NO paragraph carries link data at all.
    (p: any) =>
      p.articleParagraph
        ? p.articleParagraph.some(
            (ap: any) => ap.articleId === article.id
          )
        : paragraphsQ.data?.project?.paragraphs?.every(
              (x: any) => !x.articleParagraph
            ) ?? false
  );
  // Update the ref in an effect so jumpToNextUntranslated (declared above)
  // can access the latest paragraphs without triggering react-hooks rules.
  React.useEffect(() => {
    paragraphsRef.current = paragraphs;
  }, [paragraphs]);

  // Fetch source relationships
  // Load saved relationship analysis from DB (GET). Only re-analyze (POST)
  // when the user explicitly clicks a "re-analyze" button. This prevents the
  // Relationships tab from being empty every time the user switches to it —
  // the saved analysis is loaded instantly.
  const relQ = useQuery({
    queryKey: ["source-relationships", projectId],
    queryFn: () =>
      fetch(`/api/ai/source-relationships?projectId=${projectId}`).then((r) =>
        r.json()
      ),
    enabled: !!projectId,
  });

  // Re-analyze mutation — triggered by a button, not on tab switch.
  const relReanalyzeMut = useMutation({
    mutationFn: () =>
      fetch(`/api/ai/source-relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["source-relationships", projectId] });
    },
  });

  // Fetch data sources for relationships view
  const dataSources = paragraphsQ.data?.project?.dataSources || [];

  // Pick the content based on the language toggle (parallel shows English)
  const displayContent = viewLang === "zh" && article.contentZh
    ? article.contentZh
    : article.content;

  // Parse the article-level "## References" section so that the Sections tab
  // (which renders each paragraph individually) can resolve global citation
  // numbers. When the article is composed, citations are globally renumbered
  // (e.g. [20] refers to the 20th reference in the article's ## References
  // section, not the 20th reference in the paragraph's local list).
  //
  // ALSO: extract the section content from the COMPOSED article (which has
  // globally renumbered citations) instead of using the paragraph's stored
  // content (which has local numbering). This ensures the Sections tab shows
  // the same citation numbers as the Composed tab.
  const globalArticleRefs = React.useMemo(() => {
    const content = article.content || "";
    const refHeaderIdx = content.indexOf("## References");
    const bareRefIdx = content.indexOf("\nREFERENCES\n");
    if (refHeaderIdx >= 0) {
      const refText = content.slice(refHeaderIdx);
      try {
        const parsed = parseCitationsBlock(refText);
        if (parsed.length > 0) return parsed;
      } catch {}
    }
    if (bareRefIdx >= 0) {
      const refText = content.slice(bareRefIdx + 1);
      try {
        const parsed = parseCitationsBlock(refText);
        if (parsed.length > 0) return parsed;
      } catch {}
    }
    return [];
  }, [article.content]);

  // Extract section content (with globally renumbered citations) from the
  // composed article content. Returns a map of paragraph index → section text.
  const composedSectionContents = React.useMemo(() => {
    if (globalArticleRefs.length === 0) return null;
    const content = article.content || "";
    // Remove the ## References section
    const refHeaderIdx = content.indexOf("## References");
    const bareRefIdx = content.indexOf("\nREFERENCES\n");
    let bodyContent = content;
    if (refHeaderIdx >= 0) bodyContent = content.slice(0, refHeaderIdx);
    else if (bareRefIdx >= 0) bodyContent = content.slice(0, bareRefIdx);

    // Split on ## headings
    const sections: string[] = [];
    const lines = bodyContent.split("\n");
    let currentHeading = "";
    let currentBody: string[] = [];
    for (const line of lines) {
      if (/^##\s+/.test(line) && !/^###\s/.test(line)) {
        if (currentHeading || currentBody.length > 0) {
          sections.push((currentHeading ? currentHeading + "\n\n" : "") + currentBody.join("\n").trim());
        }
        currentHeading = line;
        currentBody = [];
      } else {
        currentBody.push(line);
      }
    }
    if (currentHeading || currentBody.length > 0) {
      sections.push((currentHeading ? currentHeading + "\n\n" : "") + currentBody.join("\n").trim());
    }
    return sections;
  }, [article.content, globalArticleRefs]);

  // Article-level statistics for the metadata panel
  const articleStats = React.useMemo(() => {
    const enWordCount = countWords(article.content || "");
    const zhCharCount = article.contentZh ? countWords(article.contentZh) : 0;
    const sectionCount = paragraphs.length;
    // Count unique references cited across all paragraphs
    const refKeys = new Set<string>();
    paragraphs.forEach((p: any) => {
      (p.references || []).forEach((r: any) => {
        refKeys.add(`${r.type}:${r.externalId || r.title}`);
      });
    });
    const refCount = refKeys.size;
    // Translation coverage (only when hasZh)
    const translatedSections = paragraphs.filter((p: any) => p.contentZh).length;
    const translationCoverage = sectionCount > 0
      ? Math.round((translatedSections / sectionCount) * 100)
      : 0;
    // Last updated
    const updatedAt = article.updatedAt ? new Date(article.updatedAt as any) : null;
    return {
      enWordCount,
      zhCharCount,
      sectionCount,
      refCount,
      translatedSections,
      translationCoverage,
      updatedAt,
    };
  }, [article, paragraphs]);

  // Per-section re-translate mutation
  const retranslateMut = useMutation({
    mutationFn: async (paragraphId: string) => {
      const res = await fetch(`/api/paragraphs/${paragraphId}/retranslate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `Re-translate failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success(t("articleViewer.retranslateSuccess") || "Re-translated. Chinese version updated.");
      qc.invalidateQueries({ queryKey: ["article-paragraphs", article.id] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Batch re-translate all sections missing contentZh or titleZh.
  // round-28: titleZh joins the "missing" definition — legacy bilingual
  // articles (translated before round-28) have Chinese bodies but ENGLISH
  // headings, and the zh docx/export read like a patchwork. One batch pass
  // repairs both the heading and the body per section.
  const batchRetranslate = async () => {
    const missing = paragraphs.filter((p: any) => !p.contentZh || !p.titleZh);
    if (missing.length === 0) {
      toast.info(t("articleViewer.allTranslated") || "All sections already have Chinese translations.");
      return;
    }
    setBatchProgress({ done: 0, total: missing.length, current: missing[0]?.title });
    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < missing.length; i++) {
      const p = missing[i];
      setBatchProgress({ done: i, total: missing.length, current: p.title });
      try {
        const res = await fetch(`/api/paragraphs/${p.id}/retranslate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (res.ok) {
          successCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
      // Update progress after each section
      setBatchProgress({ done: i + 1, total: missing.length, current: missing[i + 1]?.title });
      // Brief delay between calls to avoid hammering the LLM
      if (i < missing.length - 1) await new Promise((r) => setTimeout(r, 1500));
    }
    setBatchProgress(null);
    qc.invalidateQueries({ queryKey: ["article-paragraphs", article.id] });
    qc.invalidateQueries({ queryKey: ["project", projectId] });
    if (failCount === 0) {
      toast.success(
        (t("articleViewer.batchDone") || "Translated {n} sections to Chinese.").replace("{n}", String(successCount))
      );
    } else {
      toast.warning(
        `Translated ${successCount}/${missing.length} sections. ${failCount} failed — try again or retranslate individually.`
      );
    }
  };

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      {/* round-32: the viewer fills ~96vw — the article reading surface
          uses the available screen width instead of a fixed max-w column
          (user request: no width cap, no wasted side margins on wide screens). */}
      <DialogContent className="max-w-[96vw] h-[90vh] max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60 shrink-0 bg-gradient-to-r from-primary/5 via-muted/10 to-transparent overflow-hidden">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-lg sm:text-xl font-semibold font-serif-text leading-snug line-clamp-2 break-words">
                {displayTitle}
              </DialogTitle>
              <button
                type="button"
                onClick={() => regenerateTitleMut.mutate()}
                disabled={regenerateTitleMut.isPending}
                title={t("articleViewer.regenerateTitle") || "Regenerate title from article content"}
                aria-label={t("articleViewer.regenerateTitle") || "Regenerate title from article content"}
                className="inline-flex items-center gap-1 mt-1 text-[10px] text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
              >
                {regenerateTitleMut.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                {regenerateTitleMut.isPending
                  ? t("articleViewer.regeneratingTitle") || "Generating title..."
                  : t("articleViewer.regenerateTitle") || "Regenerate title"}
              </button>
              {article.abstract && (
                <DialogDescription className="text-xs italic mt-1 line-clamp-2">
                  {article.abstract}
                </DialogDescription>
              )}
              {/* Article metadata stats panel */}
              <ArticleStatsPanel
                enWordCount={articleStats.enWordCount}
                zhCharCount={articleStats.zhCharCount}
                sectionCount={articleStats.sectionCount}
                refCount={articleStats.refCount}
                translatedSections={articleStats.translatedSections}
                translationCoverage={articleStats.translationCoverage}
                updatedAt={articleStats.updatedAt}
                hasZh={hasZh}
              />
            </div>
            {hasZh && (
              <div className="flex items-center gap-0.5 rounded-lg bg-muted/40 p-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setViewLang("en")}
                  className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-all flex items-center gap-1 ${
                    viewLang === "en"
                      ? "bg-primary/10 dark:bg-primary/20 text-primary ring-1 ring-primary/30"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  }`}
                  title={`English only (${formatShortcut({ key: "1", mod: "none" })})`}
                >
                  EN
                  <kbd className={`hidden sm:inline-flex items-center px-1 py-0 text-[7px] font-mono rounded leading-none h-3 ${
                    viewLang === "en"
                      ? "border border-primary/30 bg-primary/10"
                      : "border border-border/40 bg-muted/40"
                  }`}>1</kbd>
                </button>
                <button
                  type="button"
                  onClick={() => setViewLang("zh")}
                  className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-all flex items-center gap-1 ${
                    viewLang === "zh"
                      ? "bg-primary/10 dark:bg-primary/20 text-primary ring-1 ring-primary/30"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  }`}
                  title={`仅中文 (${formatShortcut({ key: "2", mod: "none" })})`}
                >
                  中文
                  <kbd className={`hidden sm:inline-flex items-center px-1 py-0 text-[7px] font-mono rounded leading-none h-3 ${
                    viewLang === "zh"
                      ? "border border-primary/30 bg-primary/10"
                      : "border border-border/40 bg-muted/40"
                  }`}>2</kbd>
                </button>
                <button
                  type="button"
                  onClick={() => setViewLang("parallel")}
                  className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-all flex items-center gap-1 ${
                    viewLang === "parallel"
                      ? "bg-primary/10 dark:bg-primary/20 text-primary ring-1 ring-primary/30"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  }`}
                  title={`Side-by-side / 并排对照 (${formatShortcut({ key: "3", mod: "none" })})`}
                >
                  <Columns2 className="h-3 w-3" />
                  对比
                  <kbd className={`hidden sm:inline-flex items-center px-1 py-0 text-[7px] font-mono rounded leading-none h-3 ${
                    viewLang === "parallel"
                      ? "border border-primary/30 bg-primary/10"
                      : "border border-border/40 bg-muted/40"
                  }`}>3</kbd>
                </button>
              </div>
            )}
          </div>
        </DialogHeader>

        <Tabs defaultValue="composed" className="flex-1 min-h-0 flex flex-col">
          <div className="px-6 py-2 border-b border-border/60 shrink-0 flex items-center gap-2 flex-wrap bg-gradient-to-r from-muted/20 to-transparent">
            <TabsList className="h-9 gap-1 min-w-0 max-w-full overflow-x-auto bg-transparent p-0.5">
              <TabsTrigger value="sections" className={TAB_TRIGGER_CLS}>
                <FileText className="size-3" />
                {t("articleViewer.sections")}
              </TabsTrigger>
              <TabsTrigger value="composed" className={TAB_TRIGGER_CLS}>
                <Layers className="size-3" />
                {t("articleViewer.composed")}
              </TabsTrigger>
              <TabsTrigger value="review" className={TAB_TRIGGER_CLS}>
                <Gavel className="size-3" />
                {t("articleViewer.review")}
              </TabsTrigger>
              <TabsTrigger value="relationships" className={TAB_TRIGGER_CLS}>
                <Network className="size-3" />
                {t("articleViewer.relationships")}
              </TabsTrigger>
              <TabsTrigger value="insights" className={TAB_TRIGGER_CLS}>
                <Sparkles className="size-3" />
                {t("articleViewer.insights") || "Analysis"}
              </TabsTrigger>
            </TabsList>
            {/* v116 compact action cluster — secondary tools live in the
                "More" dropdown so the toolbar never overflows the dialog.
                round-31: actions live in their own tight right-aligned group,
                separated from the tabs by a hairline. */}
            <div className="ml-auto flex items-center gap-1.5 pl-2.5 border-l border-border/60 flex-wrap justify-end">
              {/* Batch translate progress indicator */}
              {batchProgress && (
                <div className="flex items-center gap-2 text-[10px] text-fuchsia-700 dark:text-fuchsia-400 px-2 py-1 rounded-md border border-fuchsia-200/60 dark:border-fuchsia-800/50 bg-fuchsia-50/50 dark:bg-fuchsia-950/20">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span className="font-mono">{batchProgress.done}/{batchProgress.total}</span>
                  <span className="hidden md:inline truncate max-w-[140px]">{batchProgress.current}</span>
                </div>
              )}
              {/* Search toggle button */}
              <Button
                variant={searchOpen ? "default" : "outline"}
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => setSearchOpen(!searchOpen)}
                title={`${t("articleViewer.searchTitle") || "Search within article"} (${formatShortcut({ key: "k", mod: "cmd" })})`}
              >
                <Search className="h-3.5 w-3.5" />
                {t("articleViewer.search") || "Search"}
                <kbd className="hidden sm:inline-flex items-center gap-0.5 ml-1 px-1 py-0 text-[8px] font-mono rounded border border-border/40 bg-muted/40 leading-none h-3.5">
                  {formatShortcut({ key: "k", mod: "cmd" })}
                </kbd>
              </Button>
              <ExportMenu
                type="article"
                id={article.id}
                variant="outline"
                hasZh={hasZh}
              />
              {/* More tools — AI review, verification, analysis and reference
                  utilities consolidated into a single dropdown. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-xs"
                    title={t("articleViewer.moreTools") || "More tools"}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                    {t("articleViewer.moreTools") || "More"}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60 max-h-[60vh] overflow-y-auto">
                  <DropdownMenuItem className="gap-2 text-xs py-1.5" onClick={() => setReviewOpen(true)}>
                    <Gavel className="h-3.5 w-3.5 text-primary" />
                    {t("articleViewer.aiReview")}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2 text-xs py-1.5" onClick={() => setVersionHistoryOpen(true)}>
                    <History className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("version.historyBtn") || "History"}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2 text-xs py-1.5" onClick={() => setCitationVerifyOpen(true)}>
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    {t("citationVerify.btn") || "Verify"}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2 text-xs py-1.5" onClick={() => setSummaryOpen(true)}>
                    <Sparkles className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    {t("summary.btn") || "Summary"}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2 text-xs py-1.5" onClick={() => setDiagramOpen(true)}>
                    <GitBranch className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
                    {t("diagram.btn") || "Diagram"}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2 text-xs py-1.5" onClick={() => setStructureOpen(true)}>
                    <LayoutGrid className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                    Structure
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2 text-xs py-1.5" onClick={() => setStyleOpen(true)}>
                    <PenLine className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />
                    Style
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2 text-xs py-1.5" onClick={() => setEnrichOpen(true)}>
                    <Database className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                    Enrich
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2 text-xs py-1.5" onClick={() => setImportOpen(true)}>
                    <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                    Import
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2 text-xs py-1.5" onClick={() => setSubmissionOpen(true)}>
                    <ClipboardCheck className="h-3.5 w-3.5 text-primary" />
                    Check
                  </DropdownMenuItem>
                  {/* Translation helpers — only relevant in parallel mode with
                      untranslated sections remaining. */}
                  {viewLang === "parallel" && hasZh && articleStats.translatedSections < articleStats.sectionCount && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="gap-2 text-xs py-1.5"
                        onClick={() => {
                          const found = jumpToNextUntranslated();
                          if (!found) {
                            toast.info(t("articleViewer.allTranslated") || "All sections already have Chinese translations.");
                          }
                        }}
                      >
                        <SkipForward className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                        {t("articleViewer.nextUntranslated") || "Next untranslated"}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="gap-2 text-xs py-1.5"
                        onClick={batchRetranslate}
                        disabled={retranslateMut.isPending || !!batchProgress}
                      >
                        <Wand2 className="h-3.5 w-3.5 text-fuchsia-600 dark:text-fuchsia-400" />
                        {t("articleViewer.batchTranslate") || "Translate all missing"}
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="gap-2 text-xs py-1.5" onClick={() => setShortcutsHelpOpen(true)}>
                    <Keyboard className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("articleViewer.shortcutsTitle") || "Keyboard shortcuts"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* Delete article button — opens a confirmation dialog before
                  permanently removing the article. Placed at the end of the
                  toolbar so it's visually separated from the other actions. */}
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0 border-red-300/60 dark:border-red-700/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                onClick={() => setDeleteConfirmOpen(true)}
                title={t("articleViewer.deleteTitle") || "Delete this article"}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Search bar — appears below the tab bar when toggled */}
          {searchOpen && (
            <ArticleSearchBar
              query={searchQuery}
              onQueryChange={setSearchQuery}
              onClose={() => {
                setSearchOpen(false);
                setSearchQuery("");
              }}
              contentRef={composedContentRef}
            />
          )}

          {/* Sections tab - individual paragraphs */}
          <TabsContent value="sections" className="flex-1 mt-0 min-h-0 overflow-hidden">
            <ScrollArea className="h-full w-full scroll-academic">
              {/* round-31: reading surface — one canvas-paper sheet with generous
                  margins; sections separated by hairlines instead of bordered
                  cards so the tab reads as a document, not a dashboard.
                  round-32: no max-w cap — the sheet fills the panel width. */}
              <div className="px-6 sm:px-10 py-6">
                <div className="canvas-paper rounded-xl p-6 sm:p-8 space-y-6">
                {paragraphsQ.isLoading && paragraphs.length === 0 && (
                  <>
                    {[1, 2, 3].map((i) => (
                      <div
                        key={`skel-${i}`}
                        className="rounded-lg p-4 space-y-3"
                      >
                        <div className="flex items-center gap-2">
                          <Skeleton className="h-3 w-8" />
                          <Skeleton className="h-3.5 w-16 rounded-full" />
                          <Skeleton className="h-3 w-20" />
                        </div>
                        <Skeleton className="h-4 w-2/3" />
                        <div className="space-y-2 pt-1">
                          <Skeleton className="h-3 w-full" />
                          <Skeleton className="h-3 w-[95%]" />
                          <Skeleton className="h-3 w-[88%]" />
                          <Skeleton className="h-3 w-[60%]" />
                        </div>
                      </div>
                    ))}
                  </>
                )}
                {paragraphs.map((p: any, i: number) => {
                  // Use composed section content (with globally renumbered
                  // citations) when available, falling back to paragraph
                  // content (with local numbering) for un-composed articles.
                  // Match by TITLE, not by index — the paragraph order may
                  // differ from the article section order.
                  const composedContent = composedSectionContents
                    ? composedSectionContents.find((s: string) => {
                        // Extract the ## heading from the composed section
                        const headingMatch = s.match(/^##\s+(.+)$/m);
                        if (!headingMatch) return false;
                        const heading = headingMatch[1].trim().toLowerCase();
                        const paraTitle = (p.title || "").trim().toLowerCase();
                        return heading === paraTitle ||
                          heading.includes(paraTitle) ||
                          paraTitle.includes(heading);
                      })
                    : null;
                  const paraContent = composedContent
                    ? composedContent
                    : (viewLang === "zh" && p.contentZh ? p.contentZh : p.content);
                  // Citation resolution must match the numbering of the displayed
                  // content: composed sections use the article's GLOBAL numbering
                  // (## References), while un-composed paragraph content uses the
                  // paragraph's OWN local numbering ([n] = n-th attached reference).
                  // Mixing them produced red "?" chips for out-of-range markers.
                  const sectionRefs = composedContent
                    ? (globalArticleRefs.length > 0 ? globalArticleRefs : (p.references || []))
                    : (p.references || []).length > 0
                      ? p.references
                      : globalArticleRefs;
                  const isParallel = viewLang === "parallel" && hasZh;
                  const isRetranslating = retranslateMut.isPending && retranslateMut.variables === p.id;

                  return (
                    <div
                      key={p.id}
                      className={`${i > 0 ? "pt-6 border-t border-border/50" : ""} ${
                        isParallel ? "grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6" : ""
                      }`}
                    >
                      {/* Header row */}
                      <div className={`flex items-center gap-2 mb-2 ${isParallel ? "lg:col-span-2" : ""}`}>
                        <span className="text-[10px] font-mono text-muted-foreground/70">
                          §{String(i + 1).padStart(2, "0")}
                        </span>
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wide bg-muted/70 text-muted-foreground border border-border/50">
                          {p.format}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          {p.wordCount}w EN
                          {p.contentZh && ` · ${p.wordCountZh || 0}字 ZH`}
                        </span>
                        {viewLang === "zh" && !p.contentZh && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wide border border-amber-300/60 dark:border-amber-700/50 bg-amber-50/60 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400">
                            EN fallback
                          </span>
                        )}
                        {/* Per-section re-translate button — only in parallel mode */}
                        {isParallel && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ml-auto h-6 px-2 text-[9px] gap-1 text-fuchsia-700 dark:text-fuchsia-400 hover:bg-fuchsia-50 dark:hover:bg-fuchsia-950/30"
                            onClick={() => retranslateMut.mutate(p.id)}
                            disabled={retranslateMut.isPending}
                            title="Re-translate this section EN → 中文"
                          >
                            {isRetranslating ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCw className="h-3 w-3" />
                            )}
                            {isRetranslating ? "翻译中…" : "重译"}
                          </Button>
                        )}
                      </div>
                      <h3 className={`text-sm font-semibold mb-2 ${isParallel ? "lg:col-span-2" : ""}`}>
                        {viewLang === "zh" && p.titleZh ? p.titleZh : p.title}
                      </h3>

                      {/* Single-language view */}
                      {!isParallel && (
                        <MarkdownCitations
                          content={paraContent}
                          references={sectionRefs}
                          onlyCitedRefs
                          className="text-[13px]"
                        />
                      )}

                      {/* Parallel view: EN | ZH side-by-side */}
                      {isParallel && (
                        <>
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-1.5 sticky top-0">
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wide border-blue-300/60 dark:border-blue-700/50 bg-blue-50/60 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400">
                                EN
                              </span>
                              <span className="text-[9px] text-muted-foreground">{p.wordCount}w</span>
                            </div>
                            <MarkdownCitations
                              content={p.content}
                              references={sectionRefs}
                              onlyCitedRefs
                              className="text-[12px] leading-relaxed"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-1.5">
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wide border-fuchsia-300/60 dark:border-fuchsia-700/50 bg-fuchsia-50/60 dark:bg-fuchsia-950/30 text-fuchsia-700 dark:text-fuchsia-400">
                                中文
                              </span>
                              <span className="text-[9px] text-muted-foreground">{p.wordCountZh || 0}字</span>
                            </div>
                            {p.titleZh && (
                              <div className="text-[12px] font-semibold text-foreground/90">{p.titleZh}</div>
                            )}
                            {p.contentZh ? (
                              <MarkdownCitations
                                content={p.contentZh}
                                references={sectionRefs}
                                onlyCitedRefs
                                className="text-[12px] leading-relaxed"
                              />
                            ) : (
                              <div className="rounded-md border border-amber-200/60 dark:border-amber-800/50 bg-amber-50/40 dark:bg-amber-950/20 p-2 text-[11px] text-amber-700 dark:text-amber-400">
                                {t("articleViewer.noZhForSection") || "No Chinese version for this section. Click 重译 above to translate."}
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
                </div>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Composed tab - full article with optional TOC sidebar */}
          <TabsContent value="composed" className="flex-1 mt-0 min-h-0 overflow-hidden">
            <div className="h-full flex overflow-hidden">
              {/* TOC sidebar — only when ≥3 sections, hidden on small screens */}
              {paragraphs.length >= 3 && (
                <ArticleTOCSidebar
                  sections={paragraphs.map((p: any, i: number) => ({
                    id: p.id,
                    title: viewLang === "zh" && p.titleZh ? p.titleZh : p.title,
                    index: i,
                    format: p.format,
                    wordCount: p.wordCount,
                    hasZh: !!p.contentZh,
                  }))}
                  contentRef={composedContentRef}
                />
              )}
              <div className="flex-1 min-w-0 flex flex-col">
                {/* Reading progress indicator — thin bar at top of content */}
                <ReadingProgressIndicator contentRef={composedContentRef} />
                {viewLang === "parallel" && hasZh ? (
                  <ScrollArea className="flex-1 min-h-0 w-full scroll-academic">
                    <div ref={composedContentRef} className="px-6 py-6">
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                        {/* round-31: each language column is its own paper sheet. */}
                        <div className="canvas-paper rounded-xl p-5 sm:p-6 space-y-2">
                          <div className="sticky top-0 bg-background/80 backdrop-blur-sm py-1 z-10">
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wide border-blue-300/60 dark:border-blue-700/50 bg-blue-50/60 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400">
                              EN — English
                            </span>
                          </div>
                          <VirtualizedArticle content={cleanArticleContent(article.content)} className="text-[12.5px] leading-relaxed" />
                        </div>
                        <div className="canvas-paper rounded-xl p-5 sm:p-6 space-y-2">
                          <div className="sticky top-0 bg-background/80 backdrop-blur-sm py-1 z-10">
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wide border-fuchsia-300/60 dark:border-fuchsia-700/50 bg-fuchsia-50/60 dark:bg-fuchsia-950/30 text-fuchsia-700 dark:text-fuchsia-400">
                              中文 — Chinese
                            </span>
                          </div>
                          <VirtualizedArticle content={cleanArticleContent(article.contentZh || "")} className="text-[12.5px] leading-relaxed" />
                        </div>
                      </div>
                    </div>
                  </ScrollArea>
                ) : (
                  <ScrollArea className="flex-1 min-h-0 w-full scroll-academic">
                    <div ref={composedContentRef} className="px-6 sm:px-10 py-6 overflow-hidden">
                      {/* Adversarial citation-audit banner (Layer 3). Runs a
                          deterministic audit on mount and offers an optional
                          LLM deep-audit. Non-dismissable when blocking errors. */}
                      {article?.id && (
                        <div className="mb-4 sticky top-0 z-20">
                          <CitationAuditBanner articleId={article.id} />
                        </div>
                      )}
                      {/* round-31: document sheet — the article reads as a warm
                          paper page with generous margins, not raw text on
                          chrome. Title leads the sheet in serif. */}
                      <div className="canvas-paper rounded-xl px-6 py-6 sm:px-8 sm:py-8">
                        <h1 className="font-serif-text text-xl font-semibold tracking-tight leading-snug mb-5 pb-4 border-b border-border/50">
                          {displayTitle}
                        </h1>
                        <VirtualizedArticle content={cleanArticleContent(displayContent)} className="text-[13.5px]" contentRef={composedContentRef} />
                      </div>
                      {/* Comments panel — threaded comments at the bottom of the article */}
                      <div className="mt-5">
                        <CommentsPanel articleId={article.id} />
                      </div>
                    </div>
                  </ScrollArea>
                )}
              </div>
            </div>
          </TabsContent>

          {/* Review tab - embedded review */}
          <TabsContent value="review" className="flex-1 mt-0 min-h-0">
            <EmbeddedReview articleId={article.id} articleTitle={article.title} />
          </TabsContent>

          {/* Relationships tab - source relationship network */}
          <TabsContent value="relationships" className="flex-1 mt-0 min-h-0">
            <div className="h-full flex flex-col overflow-hidden">
              {/* Re-analyze button — lets the user re-run the relationship
                  analysis LLM call. The result is persisted to DB so the
                  next tab switch loads the saved data instantly. */}
              <div className="shrink-0 flex items-center justify-between px-4 py-1.5 border-b border-border/40 bg-muted/20">
                <span className="text-[10px] text-muted-foreground">
                  {relQ.data?.createdAt
                    ? `Last analyzed: ${new Date(relQ.data.createdAt).toLocaleString()}`
                    : "No saved analysis"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px] gap-1"
                  disabled={relReanalyzeMut.isPending}
                  onClick={() => relReanalyzeMut.mutate()}
                >
                  {relReanalyzeMut.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  {relReanalyzeMut.isPending ? "Analyzing..." : "Re-analyze"}
                </Button>
              </div>
              <div className="flex-1 min-h-0">
                <RelationshipView
                  data={relQ.data}
                  isLoading={relQ.isLoading || relReanalyzeMut.isPending}
                  dataSources={dataSources}
                  noDataMessage={t("articleViewer.noRelData")}
                  sectionsLabel={t("articleViewer.sources")}
                  connectionsLabel={t("articleViewer.connections")}
                  themesLabel={t("articleViewer.themes")}
                  thematicClustersLabel={t("articleViewer.thematicClusters")}
                  summaryLabel={t("articleViewer.relSummary")}
                  keyInsightsLabel={t("articleViewer.keyInsights")}
                  contradictionsLabel={t("articleViewer.contradictions")}
                  sourceConnectionsLabel={t("articleViewer.sourceConnections")}
                />
              </div>
            </div>
          </TabsContent>

          {/* Insights tab - word frequency, keyword cloud, article metrics */}
          <TabsContent value="insights" className="flex-1 mt-0 min-h-0 overflow-hidden">
            <AnalysisTab
              article={article}
              paragraphs={paragraphs}
              viewLang={viewLang}
              contentRef={composedContentRef}
              projectId={projectId}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>

      {reviewOpen && (
        <ReviewDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          articleId={article.id}
          articleTitle={article.title}
        />
      )}

      {/* Keyboard shortcuts help dialog */}
      <KeyboardShortcutsHelp
        open={shortcutsHelpOpen}
        onOpenChange={setShortcutsHelpOpen}
        hasZh={hasZh}
        isParallel={viewLang === "parallel"}
      />

      {/* Version history dialog — save/compare/restore article snapshots */}
      <VersionHistoryDialog
        open={versionHistoryOpen}
        onOpenChange={setVersionHistoryOpen}
        articleId={article.id}
        articleTitle={article.title}
      />

      {/* Citation verification dialog — heuristic check of [n] citations */}
      <CitationVerifyDialog
        open={citationVerifyOpen}
        onOpenChange={setCitationVerifyOpen}
        articleId={article.id}
      />

      {/* AI summary dialog — generates TL;DR + per-section summaries */}
      <SummaryDialog
        open={summaryOpen}
        onOpenChange={setSummaryOpen}
        articleId={article.id}
      />

      {/* AI diagram dialog — generates table + flowchart + key findings */}
      <DiagramDialog
        open={diagramOpen}
        onOpenChange={setDiagramOpen}
        articleId={article.id}
      />

      {/* AI structure analysis + figure/table caption generation */}
      <StructureDialog
        open={structureOpen}
        onOpenChange={setStructureOpen}
        articleId={article.id}
      />

      {/* AI writing style analysis — readability + academic register */}
      <StyleAnalysisDialog
        open={styleOpen}
        onOpenChange={setStyleOpen}
        articleId={article.id}
      />

      {/* CrossRef batch enrichment — fill missing reference metadata */}
      <EnrichReferencesDialog
        open={enrichOpen}
        onOpenChange={setEnrichOpen}
        projectId={projectId}
      />

      {/* Submission readiness check — 8-dimension quality report */}
      <SubmissionCheckDialog
        open={submissionOpen}
        onOpenChange={setSubmissionOpen}
        articleId={article.id}
      />

      {/* Import references from .bib/.ris files */}
      <ImportReferencesDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        projectId={projectId}
      />

      {/* Delete confirmation dialog — prevents accidental permanent deletion.
          The article's title is shown so the user can verify they're deleting
          the right item. Paragraphs linked to the article are NOT deleted
          (they remain in the project and can be re-composed into a new article
          via the Compose tab). */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0" />
              {t("articleViewer.deleteConfirmTitle") || "Delete this article?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-relaxed">
              {t("articleViewer.deleteConfirmDesc") || "This will move the article to the trash:"}{" "}
              <strong className="text-foreground break-words">{article.title}</strong>
              {"."}
              {" "}
              {t("articleViewer.deleteConfirmWarning") || "The article will be moved to the trash and can be restored from there within 30 days. The individual paragraphs (sections) that make up this article will NOT be deleted — they remain in the project and can be re-composed into a new article later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs" disabled={deleteArticleMut.isPending}>
              {t("common.cancel") || "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              className="text-xs gap-1.5 bg-red-600 hover:bg-red-700 text-white"
              onClick={(e) => {
                e.preventDefault();
                deleteArticleMut.mutate();
              }}
              disabled={deleteArticleMut.isPending}
            >
              {deleteArticleMut.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {deleteArticleMut.isPending
                ? (t("common.deleting") || "Deleting...")
                : (t("articleViewer.deleteBtn") || "Delete article")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

/**
 * KeyboardShortcutsHelp — a dialog showing all available keyboard shortcuts
 * in the article viewer. Triggered by pressing the ? key.
 */
function KeyboardShortcutsHelp({
  open,
  onOpenChange,
  hasZh,
  isParallel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  hasZh: boolean;
  isParallel: boolean;
}) {
  const { t } = useI18n();

  const shortcuts: { keys: string; desc: string; available: boolean }[] = [
    {
      keys: formatShortcut({ key: "k", mod: "cmd" }),
      desc: t("articleViewer.scSearch") || "Toggle in-article search",
      available: true,
    },
    {
      keys: formatShortcut({ key: "Esc", mod: "none" }),
      desc: t("articleViewer.scEsc") || "Close search / dialog",
      available: true,
    },
    {
      keys: formatShortcut({ key: "1", mod: "none" }),
      desc: t("articleViewer.scEN") || "Switch to English view",
      available: hasZh,
    },
    {
      keys: formatShortcut({ key: "2", mod: "none" }),
      desc: t("articleViewer.scZH") || "Switch to Chinese view",
      available: hasZh,
    },
    {
      keys: formatShortcut({ key: "3", mod: "none" }),
      desc: t("articleViewer.scParallel") || "Switch to side-by-side view",
      available: hasZh,
    },
    {
      keys: formatShortcut({ key: "Home", mod: "none" }),
      desc: t("articleViewer.scHome") || "Jump to first section",
      available: true,
    },
    {
      keys: formatShortcut({ key: "End", mod: "none" }),
      desc: t("articleViewer.scEnd") || "Jump to last section",
      available: true,
    },
    {
      keys: formatShortcut({ key: "j", mod: "none" }),
      desc: t("articleViewer.scJumpUntranslated") || "Jump to next untranslated section",
      available: isParallel && hasZh,
    },
    {
      keys: formatShortcut({ key: "?", mod: "none" }),
      desc: t("articleViewer.scHelp") || "Show this help dialog",
      available: true,
    },
    {
      keys: formatShortcut({ key: "S", mod: "none" }),
      desc: t("articleViewer.scSummary") || "Open AI summary",
      available: true,
    },
    {
      keys: formatShortcut({ key: "V", mod: "none" }),
      desc: t("articleViewer.scVerify") || "Open citation verification",
      available: true,
    },
    {
      keys: formatShortcut({ key: "H", mod: "none" }),
      desc: t("articleViewer.scHistory") || "Open version history",
      available: true,
    },
    {
      keys: formatShortcut({ key: "Del", mod: "none" }),
      desc: t("articleViewer.scDelete") || "Delete article (with confirmation)",
      available: true,
    },
    {
      keys: "Enter",
      desc: t("articleViewer.scEnter") || "Next search match (in search)",
      available: true,
    },
    {
      keys: "Shift+Enter",
      desc: t("articleViewer.scShiftEnter") || "Previous search match (in search)",
      available: true,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[80vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-5 pt-4 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Keyboard className="h-4 w-4 text-primary" />
            {t("articleViewer.shortcutsTitle") || "Keyboard Shortcuts"}
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            {t("articleViewer.shortcutsDesc") || "Press ? anytime to show this dialog. Press Esc to close."}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-5 py-3 space-y-1">
            {shortcuts.map((sc, i) => (
              <div
                key={i}
                className={`flex items-center justify-between gap-3 px-2 py-1.5 rounded-md transition-colors ${
                  sc.available
                    ? "hover:bg-muted/40"
                    : "opacity-40"
                }`}
              >
                <span className="text-[11px] text-foreground/80">
                  {sc.desc}
                </span>
                <kbd className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded border border-border/60 bg-muted/40 shrink-0">
                  {sc.keys}
                </kbd>
              </div>
            ))}
          </div>
        </ScrollArea>
        <div className="px-5 py-2.5 border-t border-border/60 shrink-0 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/60 italic">
            {t("articleViewer.shortcutsFooter") || "Shortcuts work when the article viewer is open"}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="text-[11px] h-7"
            onClick={() => onOpenChange(false)}
          >
            {t("common.close") || "Close"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EmbeddedReview({ articleId, articleTitle }: { articleId: string; articleTitle: string }) {
  const { t } = useI18n();
  const [reviewData, setReviewData] = React.useState<any>(null);

  // Load saved review on mount — this prevents the Review tab from being
  // empty every time the user switches to it. If a saved review exists,
  // it's loaded instantly; the user can click "Run review" to re-review.
  const savedReviewQ = useQuery({
    queryKey: ["saved-review", articleId],
    queryFn: () => fetch(`/api/reviews?articleId=${articleId}`).then((r) => r.json()),
    enabled: !!articleId,
  });

  // When saved review loads, populate reviewData.
  React.useEffect(() => {
    if (savedReviewQ.data && !savedReviewQ.data.notFound && !reviewData) {
      setReviewData(savedReviewQ.data);
    }
  }, [savedReviewQ.data, reviewData]);

  const reviewMut = useMutation({
    mutationFn: () => api.aiReview({ mode: "review", articleId }),
    onSuccess: (data) => {
      setReviewData(data);
      toast.success(t("toast.reviewCompleted"));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <ScrollArea className="h-full scroll-academic">
      <div className="px-8 py-5">
        {!reviewData && !reviewMut.isPending && (
          <div className="text-center py-12">
            <div className="h-14 w-14 mx-auto rounded-2xl bg-primary/10 ring-1 ring-primary/15 flex items-center justify-center mb-4">
              <Gavel className="h-7 w-7 text-primary" />
            </div>
            <h3 className="text-sm font-semibold">{t("articleViewer.aiPeerReview")}</h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto mb-4">
              {t("articleViewer.reviewDesc")}
            </p>
            <Button size="sm" className="gap-1.5 text-xs" onClick={() => reviewMut.mutate()}>
              <Gavel className="h-3.5 w-3.5" />
              {t("articleViewer.runReview")}
            </Button>
          </div>
        )}

        {reviewMut.isPending && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        )}

        {reviewData && (
          <div className="space-y-4">
            {/* Verdict */}
            {reviewData.verdict && (
              <div className={`rounded-lg border p-3 ${
                reviewData.verdict === "accept"
                  ? "border-emerald-200/60 dark:border-emerald-800/50 bg-emerald-50/50 dark:bg-emerald-950/20"
                  : "border-amber-200/60 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20"
              }`}>
                <span className={`text-sm font-semibold ${
                  reviewData.verdict === "accept" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"
                }`}>
                  {reviewData.verdict === "accept" ? t("articleViewer.acceptVerdict") : `⚠ ${reviewData.verdict}`}
                </span>
              </div>
            )}

            {/* Scores */}
            {reviewData.scores && (
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(reviewData.scores).map(([key, val]: [string, any]) => (
                  <div key={key} className="surface-card rounded-lg p-2.5 text-center">
                    <p className="text-sm font-bold tabular-nums">{val}/10</p>
                    <p className="eyebrow mt-1">{key}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Summary */}
            {reviewData.review?.summary && (
              <div className="rounded-lg border border-border/60 p-3">
                <p className="eyebrow mb-1.5">{t("articleViewer.summary")}</p>
                <p className="text-xs leading-relaxed">{reviewData.review.summary}</p>
              </div>
            )}

            {/* Strengths & Weaknesses */}
            {reviewData.review && (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-emerald-200/50 dark:border-emerald-800/50 bg-emerald-50/30 dark:bg-emerald-950/20 p-2.5">
                  <p className="text-[10px] uppercase tracking-wider font-semibold text-emerald-700 dark:text-emerald-300 mb-1">{t("articleViewer.strengths")}</p>
                  {safeParse(reviewData.review.strengths).map((s: string, i: number) => (
                    <p key={i} className="text-[10px] mb-1">• {s}</p>
                  ))}
                </div>
                <div className="rounded-lg border border-rose-200/50 dark:border-rose-800/50 bg-rose-50/30 dark:bg-rose-950/20 p-2.5">
                  <p className="text-[10px] uppercase tracking-wider font-semibold text-rose-700 dark:text-rose-300 mb-1">{t("articleViewer.weaknesses")}</p>
                  {safeParse(reviewData.review.weaknesses).map((w: string, i: number) => (
                    <p key={i} className="text-[10px] mb-1">• {w}</p>
                  ))}
                </div>
              </div>
            )}

            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-xs w-full"
              onClick={() => reviewMut.mutate()}
              disabled={reviewMut.isPending}
            >
              <Loader2 className={reviewMut.isPending ? "h-3.5 w-3.5 animate-spin" : "hidden"} />
              {t("articleViewer.rerunReview")}
            </Button>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function RelationshipView({
  data,
  isLoading,
  dataSources,
  noDataMessage,
  sectionsLabel,
  connectionsLabel,
  themesLabel,
  thematicClustersLabel,
  summaryLabel,
  keyInsightsLabel,
  contradictionsLabel,
  sourceConnectionsLabel,
}: {
  data: any;
  isLoading: boolean;
  dataSources: any[];
  noDataMessage: string;
  sectionsLabel: string;
  connectionsLabel: string;
  themesLabel: string;
  thematicClustersLabel: string;
  summaryLabel: string;
  keyInsightsLabel: string;
  contradictionsLabel: string;
  sourceConnectionsLabel: string;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full py-12">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!data || data.error) {
    return (
      <div className="text-center py-12">
        <div className="mx-auto mb-4 h-14 w-14 rounded-2xl bg-primary/10 ring-1 ring-primary/15 flex items-center justify-center">
          <Network className="h-7 w-7 text-primary/70" />
        </div>
        <p className="text-xs text-muted-foreground">
          {data?.error || noDataMessage}
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full scroll-academic">
      <div className="px-8 py-5 space-y-4">
        {/* Interactive citation graph — visualizes themes + connections as
            a radial node-edge graph. Hover a node to highlight its
            connections. Rendered above the text summary so users get a
            visual overview before reading the details. */}
        {data && dataSources.length > 0 && (
          <CitationGraph
            data={data}
            dataSources={dataSources}
            themesLabel={themesLabel}
            connectionsLabel={connectionsLabel}
          />
        )}

        {/* Summary */}
        {data.summary && (
          <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
            <p className="text-[10px] uppercase tracking-wider text-primary font-semibold mb-1.5">
              {summaryLabel}
            </p>
            <p className="text-xs leading-relaxed">{data.summary}</p>
          </div>
        )}

        {/* Nodes count */}
        <div className="grid grid-cols-3 gap-2">
          <div className="surface-card rounded-lg p-2.5 text-center">
            <p className="text-lg font-bold tabular-nums">{data.nodes?.length || dataSources.length}</p>
            <p className="eyebrow mt-0.5">{sectionsLabel}</p>
          </div>
          <div className="surface-card rounded-lg p-2.5 text-center">
            <p className="text-lg font-bold tabular-nums">{data.edges?.length || 0}</p>
            <p className="eyebrow mt-0.5">{connectionsLabel}</p>
          </div>
          <div className="surface-card rounded-lg p-2.5 text-center">
            <p className="text-lg font-bold tabular-nums">{data.themes?.length || 0}</p>
            <p className="eyebrow mt-0.5">{themesLabel}</p>
          </div>
        </div>

        {/* Themes */}
        {data.themes?.length > 0 && (
          <div className="space-y-2">
            <p className="eyebrow">{thematicClustersLabel}</p>
            {data.themes.map((t: any, i: number) => (
              <div key={i} className="rounded-lg border border-border/60 p-3">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wide bg-muted/70 text-muted-foreground border border-border/50">
                    {t.sourceLabels?.join(", ") || t.sourceIds?.length || "?"}
                  </span>
                  <span className="text-xs font-semibold">{t.name}</span>
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {t.description}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Key insights */}
        {data.keyInsights?.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-primary font-semibold">
              {keyInsightsLabel}
            </p>
            {data.keyInsights.map((insight: string, i: number) => (
              <div key={i} className="flex items-start gap-1.5 text-[11px]">
                <CheckCircle2 className="h-3 w-3 text-primary mt-0.5 shrink-0" />
                <span>{insight}</span>
              </div>
            ))}
          </div>
        )}

        {/* Contradictions */}
        {data.contradictions?.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-rose-600 dark:text-rose-400 font-semibold">
              {contradictionsLabel}
            </p>
            {data.contradictions.map((c: any, i: number) => (
              <div key={i} className="rounded-md border border-rose-200/50 dark:border-rose-800/50 bg-rose-50/30 dark:bg-rose-950/20 p-2">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <AlertTriangle className="h-3 w-3 text-rose-600 dark:text-rose-400" />
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wide bg-muted/70 text-muted-foreground border border-border/50">
                    {c.sourceLabels?.join(" vs ") || c.sourceIds?.join(" vs ")}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground">{c.description}</p>
              </div>
            ))}
          </div>
        )}

        {/* Edges */}
        {data.edges?.length > 0 && (
          <div className="space-y-1.5">
            <p className="eyebrow">
              {sourceConnectionsLabel.replace("{n}", String(data.edges.length))}
            </p>
            {data.edges.slice(0, 20).map((e: any, i: number) => (
              <div key={i} className="flex items-center gap-2 text-[10px] rounded-md bg-muted/30 px-2.5 py-1.5">
                <span className="font-mono text-muted-foreground">{e.from}</span>
                <span className="text-primary">→</span>
                <span className="font-mono text-muted-foreground">{e.to}</span>
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-wide bg-muted/70 text-muted-foreground border border-border/50">
                  {e.type}
                </span>
                <span className="text-muted-foreground truncate flex-1">{e.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function safeParse(raw: string): any[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Article metadata stats panel — small inline row of stats shown in the
 * article viewer header. Provides at-a-glance overview of the article.
 */
function ArticleStatsPanel({
  enWordCount,
  zhCharCount,
  sectionCount,
  refCount,
  translatedSections,
  translationCoverage,
  updatedAt,
  hasZh,
}: {
  enWordCount: number;
  zhCharCount: number;
  sectionCount: number;
  refCount: number;
  translatedSections: number;
  translationCoverage: number;
  updatedAt: Date | null;
  hasZh: boolean;
}) {
  const { t } = useI18n();
  const formatNum = (n: number) => n.toLocaleString();

  // Format relative time for "updated X ago"
  const relTime = React.useMemo(() => {
    if (!updatedAt) return "";
    const diff = Date.now() - updatedAt.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t("articleViewer.justNow") || "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return updatedAt.toLocaleDateString();
  }, [updatedAt, t]);

  // Reading time estimate — ~200 wpm for English, ~400 cpm for Chinese.
  // For bilingual mode, we use the max of the two (since the reader likely
  // reads one then the other, but we cap at the longer one to avoid
  // double-counting).
  const readingTimeMin = React.useMemo(() => {
    const enMin = Math.ceil(enWordCount / 200);
    const zhMin = hasZh ? Math.ceil(zhCharCount / 400) : 0;
    // For bilingual: use the max (not sum) — assumes reader picks one language
    return Math.max(enMin, zhMin);
  }, [enWordCount, zhCharCount, hasZh]);

  const readingTimeLabel = React.useMemo(() => {
    if (readingTimeMin < 1) return "<1m";
    if (readingTimeMin < 60) return `${readingTimeMin}m`;
    const hrs = Math.floor(readingTimeMin / 60);
    const mins = readingTimeMin % 60;
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  }, [readingTimeMin]);

  return (
    <div className="mt-3 inline-flex flex-wrap items-center gap-x-1 gap-y-1 sm:gap-x-0 sm:gap-y-0 sm:divide-x sm:divide-border/60 rounded-lg surface-card text-[10px]">
      <StatCell
        icon={FileText}
        label="EN"
        value={formatNum(enWordCount)}
        title="English word count"
      />
      {hasZh && (
        <StatCell
          icon={FileText}
          label="中"
          value={formatNum(zhCharCount)}
          title="中文字符数 / Chinese character count"
        />
      )}
      <StatCell
        icon={Layers}
        label={t("articleViewer.sections") || "§"}
        value={formatNum(sectionCount)}
        title="Number of sections"
      />
      <StatCell
        icon={Quote}
        label={t("articleViewer.refs") || "refs"}
        value={formatNum(refCount)}
        title="Cited references"
      />
      {hasZh && (
        <StatCell
          icon={TrendingUp}
          label={t("articleViewer.coverage") || "ZH"}
          value={`${translationCoverage}%`}
          valueClass={
            translationCoverage === 100
              ? "text-emerald-700 dark:text-emerald-400"
              : translationCoverage >= 50
              ? "text-amber-700 dark:text-amber-400"
              : "text-rose-700 dark:text-rose-400"
          }
          title={`Translation coverage: ${translatedSections}/${sectionCount} sections have Chinese versions`}
        />
      )}
      {/* Reading time estimate */}
      <StatCell
        icon={BookOpen}
        label={t("articleViewer.readTime") || "read"}
        value={readingTimeLabel}
        title={`Estimated reading time: ${readingTimeMin} min (EN ~200 wpm${hasZh ? ", ZH ~400 cpm" : ""})`}
      />
      {relTime && (
        <StatCell
          icon={Clock}
          value={relTime}
          valueClass="text-muted-foreground"
          title="Last updated"
        />
      )}
    </div>
  );
}

/* round-31: one cell of the quiet header stats strip — muted icon +
   tabular-nums value + tiny muted label, separated by divide-x hairlines. */
function StatCell({
  icon: Icon,
  label,
  value,
  valueClass,
  title,
}: {
  icon: any;
  label?: string;
  value: string;
  valueClass?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 whitespace-nowrap"
    >
      <Icon className="size-3 shrink-0 text-muted-foreground/70" />
      <span className={`font-semibold tabular-nums tracking-tight ${valueClass || ""}`}>
        {value}
      </span>
      {label && (
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground/80">
          {label}
        </span>
      )}
    </span>
  );
}

/**
 * Article TOC sidebar — appears on the left side of the Composed tab when
 * the article has 3+ sections. Lets users jump to any section by clicking.
 *
 * Behavior:
 * - Clicking a section scrolls the content area so that section's `## ` header
 *   is at the top (or as close as possible)
 * - Active section is highlighted based on scroll position (scroll spy)
 * - Shows section number, title, format badge, word count
 * - ZH indicator (•) on sections that have a Chinese translation
 * - Collapsible on small screens via lg: breakpoint
 */
function ArticleTOCSidebar({
  sections,
  contentRef,
}: {
  sections: { id: string; title: string; index: number; format: string; wordCount: number; hasZh: boolean }[];
  contentRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const [activeIdx, setActiveIdx] = React.useState(0);
  const [copiedIdx, setCopiedIdx] = React.useState<number | null>(null);

  // Scroll spy — listen to scroll events on the closest scrollable ancestor
  // (the ScrollArea viewport) and update activeIdx based on which `## ` heading
  // is currently in view at the top of the viewport.
  React.useEffect(() => {
    if (!contentRef.current) return;
    // Find the closest scrollable ancestor (the ScrollArea's viewport div)
    let scrollEl: HTMLElement | null = contentRef.current;
    while (scrollEl && scrollEl.parentElement) {
      scrollEl = scrollEl.parentElement;
      const style = window.getComputedStyle(scrollEl);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        scrollEl.scrollHeight > scrollEl.clientHeight
      ) {
        break;
      }
    }
    if (!scrollEl) return;

    const handleScroll = () => {
      // Find section markers inside contentRef — [data-h2-idx] shells are
      // present for EVERY section (mounted or placeholder, round-44), so
      // the spy works across the whole article; non-virtualized bodies
      // fall back to real h2 elements.
      const root = contentRef.current;
      if (!root) return;
      const markers = root.querySelectorAll("[data-h2-idx]");
      const headings = markers.length > 0 ? markers : root.querySelectorAll("h2");
      if (headings.length === 0) return;
      // Pick the last heading whose top is <= scrollEl's top + threshold
      const threshold = 80;
      let currentIdx = 0;
      headings.forEach((h, i) => {
        const rect = h.getBoundingClientRect();
        const scrollRect = scrollEl!.getBoundingClientRect();
        if (rect.top - scrollRect.top <= threshold) {
          currentIdx = i;
        }
      });
      setActiveIdx(currentIdx);
    };

    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll(); // initial sync
    return () => scrollEl?.removeEventListener("scroll", handleScroll);
  }, [contentRef]);

  // Find the scrollable ancestor (helper used by jump + scroll-to-top/bottom)
  const findScrollEl = (): HTMLElement | null => {
    if (!contentRef.current) return null;
    let scrollEl: HTMLElement | null = contentRef.current;
    while (scrollEl && scrollEl.parentElement) {
      scrollEl = scrollEl.parentElement;
      const style = window.getComputedStyle(scrollEl);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        scrollEl.scrollHeight > scrollEl.clientHeight
      ) {
        break;
      }
    }
    return scrollEl;
  };

  // Jump to a section by scrolling the closest scrollable ancestor.
  // Targets [data-h2-idx] shells (present even while the section is a
  // virtualized placeholder, round-44) and uses the supervised smooth
  // scroll (round-46): one animated glide from the current position,
  // re-targeted when mount waves move the goal, yielded on user input.
  const jumpToSection = (idx: number) => {
    if (!contentRef.current) return;
    const root = contentRef.current;
    const target = resolveSectionTarget(root, idx);
    if (!target) return;
    const scrollEl = findScrollableAncestor(target);
    if (scrollEl) {
      animatedScrollTo(scrollEl, target);
      setActiveIdx(idx);
    }
  };

  // Jump to the very top of the article (scroll position 0)
  const jumpToTop = () => {
    const scrollEl = findScrollEl();
    scrollEl?.scrollTo({ top: 0, behavior: "smooth" });
    setActiveIdx(0);
  };

  // Jump to the very bottom of the article. round-47: pre-mount the span
  // so the bottom (maxScroll) is final BEFORE gliding — the mount waves
  // used to shrink the bottom mid-glide and the viewport bounced back.
  const jumpToBottom = () => {
    const scrollEl = findScrollEl();
    if (!scrollEl) return;
    cancelJumpSupervision();
    const goal = () => scrollEl.scrollHeight - scrollEl.clientHeight;
    const shells = scrollEl.querySelectorAll<HTMLElement>("[data-section-idx]");
    const lastShell = shells.length > 0 ? shells[shells.length - 1] : null;
    if (lastShell) {
      preMountJumpSpan(scrollEl, lastShell);
      waitForLayoutSettle(scrollEl, goal, () => superviseGlide(scrollEl, goal));
    } else {
      superviseGlide(scrollEl, goal);
    }
    setActiveIdx(sections.length - 1);
  };

  // Copy a section's text content to clipboard
  const copySection = async (idx: number, title: string) => {
    if (!contentRef.current) return;
    const headings = contentRef.current.querySelectorAll("h2");
    if (idx < 0 || idx >= headings.length) return;

    // Extract text from this h2 to the next h2 (or end of content)
    const startHeading = headings[idx] as HTMLElement;
    const endHeading = headings[idx + 1] as HTMLElement | undefined;
    let sectionText = `## ${title}\n\n`;

    // Walk siblings until the next h2 or end of parent
    let el = startHeading.nextElementSibling as HTMLElement | null;
    while (el && el !== endHeading) {
      if (el.tagName === "H2") break;
      sectionText += (el.textContent || "") + "\n\n";
      el = el.nextElementSibling as HTMLElement | null;
    }
    sectionText = sectionText.trimEnd();

    try {
      await navigator.clipboard.writeText(sectionText);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 2000);
      toast.success(
        (t("articleViewer.sectionCopied") || "Section copied to clipboard") + `: ${title}`
      );
    } catch {
      toast.error(t("articleViewer.copyFailed") || "Failed to copy to clipboard");
    }
  };

  return (
    <aside className="hidden lg:flex flex-col w-56 shrink-0 border-r border-border/40 bg-muted/20 overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-1.5">
          <ListTree className="h-3 w-3 text-muted-foreground" />
          <span className="eyebrow">
            {t("articleViewer.toc") || "Contents"}
          </span>
          <span className="text-[9px] text-muted-foreground/60 ml-1">{sections.length}</span>
          {/* Jump to top / bottom buttons */}
          <div className="ml-auto flex items-center gap-0.5">
            <button
              onClick={jumpToTop}
              className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
              title={t("articleViewer.jumpTop") || "Jump to top (Home)"}
            >
              <ArrowUpToLine className="h-3 w-3" />
            </button>
            <button
              onClick={jumpToBottom}
              className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
              title={t("articleViewer.jumpBottom") || "Jump to bottom (End)"}
            >
              <ArrowDownToLine className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0 scroll-academic">
        <nav className="px-2 py-2 space-y-0.5">
          {sections.map((s, i) => {
            const isActive = i === activeIdx;
            const isCopied = copiedIdx === i;
            return (
              <div
                key={s.id}
                className={`group relative rounded-md transition-colors ${
                  isActive
                    ? "bg-primary/10 ring-1 ring-primary/20"
                    : "hover:bg-muted/60"
                }`}
              >
                <button
                  onClick={() => jumpToSection(i)}
                  className="w-full text-left px-2 py-1.5 pr-7"
                  title={`${s.title} · ${s.wordCount}w${s.hasZh ? " · ZH" : ""}`}
                >
                  <div className="flex items-start gap-1.5">
                    <span
                      className={`text-[9px] font-mono shrink-0 mt-0.5 ${
                        isActive ? "text-primary font-bold" : "text-muted-foreground/60"
                      }`}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p
                        className={`text-[10.5px] leading-tight line-clamp-2 ${
                          isActive
                            ? "text-primary font-medium"
                            : "text-foreground/80 group-hover:text-foreground"
                        }`}
                      >
                        {s.title}
                      </p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="text-[9px] text-muted-foreground/60 font-mono">
                          {s.wordCount}w
                        </span>
                        {s.hasZh && (
                          <span
                            className="text-[9px] text-fuchsia-600 dark:text-fuchsia-400"
                            title="Has Chinese translation"
                          >
                            •中
                          </span>
                        )}
                      </div>
                    </div>
                    {isActive && (
                      <span className="w-0.5 h-3 rounded-full bg-primary self-center shrink-0" />
                    )}
                  </div>
                </button>
                {/* Copy section button — appears on hover */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    copySection(i, s.title);
                  }}
                  className={`absolute top-1.5 right-1 p-0.5 rounded transition-all ${
                    isCopied
                      ? "text-emerald-600 dark:text-emerald-400 opacity-100"
                      : "text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted/80 hover:text-foreground"
                  }`}
                  title={isCopied
                    ? (t("articleViewer.copied") || "Copied!")
                    : (t("articleViewer.copySection") || "Copy section to clipboard")
                  }
                >
                  {isCopied ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              </div>
            );
          })}
        </nav>
      </ScrollArea>
      {/* Footer hint */}
      <div className="px-3 py-1.5 border-t border-border/40 shrink-0">
        <p className="text-[9px] text-muted-foreground/50 italic">
          {t("articleViewer.tocHint") || "Click to jump · scroll to track"}
        </p>
      </div>
    </aside>
  );
}

/**
 * In-article search bar — appears below the tab bar when the Search button is
 * toggled on. Lets users find any phrase in the article (EN or ZH) and jump
 * between matches with prev/next buttons.
 *
 * Behavior:
 * - Searches the textContent of the composedContentRef element
 * - Highlights all matches with <mark> elements (yellow background)
 * - Shows match count "X / Y" and current match index
 * - Prev/Next buttons scroll to the previous/next match
 * - Esc clears the search; Enter goes to next match
 * - Case-insensitive by default
 * - Clears highlights when query is empty or search is closed
 */
function ArticleSearchBar({
  query,
  onQueryChange,
  onClose,
  contentRef,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  onClose: () => void;
  contentRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [matchCount, setMatchCount] = React.useState(0);
  const [currentMatch, setCurrentMatch] = React.useState(0);
  const marksRef = React.useRef<HTMLElement[]>([]);

  // Focus the input when the search bar opens
  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Clear all highlights when component unmounts or query changes
  const clearHighlights = React.useCallback(() => {
    if (!contentRef.current) return;
    const marks = contentRef.current.querySelectorAll("mark.search-highlight");
    marks.forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(m.textContent || ""), m);
      parent.normalize();
    });
    marksRef.current = [];
    setMatchCount(0);
    setCurrentMatch(0);
  }, [contentRef]);

  // Apply highlights whenever the query changes
  React.useEffect(() => {
    clearHighlights();
    if (!query.trim() || !contentRef.current) return;

    const q = query.trim();
    const qLower = q.toLowerCase();
    const root = contentRef.current;
    const found: HTMLElement[] = [];

    // Walk all text nodes inside the content area
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        // Skip empty text nodes and nodes inside <mark> already
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        let parent = node.parentElement;
        while (parent && parent !== root) {
          if (parent.tagName === "MARK" && parent.classList.contains("search-highlight")) {
            return NodeFilter.FILTER_REJECT;
          }
          parent = parent.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const text = (n as Text).nodeValue || "";
      if (text.toLowerCase().includes(qLower)) {
        textNodes.push(n as Text);
      }
    }

    // For each text node containing the query, split it and wrap matches in <mark>
    for (const textNode of textNodes) {
      const text = textNode.nodeValue || "";
      const lower = text.toLowerCase();
      let idx = lower.indexOf(qLower);
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      while (idx >= 0) {
        if (idx > lastIdx) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
        }
        const mark = document.createElement("mark");
        mark.className = "search-highlight";
        mark.style.backgroundColor = "rgba(250, 204, 21, 0.4)"; // yellow-400/40
        mark.style.color = "inherit";
        mark.style.borderRadius = "2px";
        mark.style.padding = "0 1px";
        mark.textContent = text.slice(idx, idx + q.length);
        frag.appendChild(mark);
        found.push(mark);
        lastIdx = idx + q.length;
        idx = lower.indexOf(qLower, lastIdx);
      }
      if (lastIdx < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      }
      textNode.parentNode?.replaceChild(frag, textNode);
    }

    marksRef.current = found;
    setMatchCount(found.length);
    setCurrentMatch(found.length > 0 ? 1 : 0);

    // Scroll to first match (inline to avoid function-hoisting lint error)
    if (found.length > 0) {
      let scrollEl: HTMLElement | null = contentRef.current;
      while (scrollEl && scrollEl.parentElement) {
        scrollEl = scrollEl.parentElement;
        const style = window.getComputedStyle(scrollEl);
        if (
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          scrollEl.scrollHeight > scrollEl.clientHeight
        ) {
          break;
        }
      }
      if (scrollEl) {
        const scrollRect = scrollEl.getBoundingClientRect();
        const elRect = found[0].getBoundingClientRect();
        const offset = elRect.top - scrollRect.top + scrollEl.scrollTop - scrollEl.clientHeight / 3;
        // round-45: take over from any active jump supervision first —
        // otherwise the two smooth scrolls fight over the viewport.
        cancelJumpSupervision();
        scrollEl.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
      }
      // Highlight first match more strongly
      found.forEach((m, i) => {
        if (i === 0) {
          m.style.backgroundColor = "rgba(250, 204, 21, 0.8)";
          m.style.outline = "2px solid rgb(202, 138, 4)";
        } else {
          m.style.backgroundColor = "rgba(250, 204, 21, 0.4)";
          m.style.outline = "none";
        }
      });
    }
  }, [query, contentRef, clearHighlights]);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => clearHighlights();
  }, [clearHighlights]);

  // Find the closest scrollable ancestor and scroll to a match
  const scrollToMatch = (el: HTMLElement, idx: number) => {
    let scrollEl: HTMLElement | null = contentRef.current;
    while (scrollEl && scrollEl.parentElement) {
      scrollEl = scrollEl.parentElement;
      const style = window.getComputedStyle(scrollEl);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        scrollEl.scrollHeight > scrollEl.clientHeight
      ) {
        break;
      }
    }
    if (scrollEl) {
      const scrollRect = scrollEl.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const offset = elRect.top - scrollRect.top + scrollEl.scrollTop - scrollEl.clientHeight / 3;
      // round-45: take over from any active jump supervision first —
      // otherwise the two smooth scrolls fight over the viewport.
      cancelJumpSupervision();
      scrollEl.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
    }
    // Highlight current match more strongly
    marksRef.current.forEach((m, i) => {
      if (i === idx) {
        m.style.backgroundColor = "rgba(250, 204, 21, 0.8)"; // yellow-400/80
        m.style.outline = "2px solid rgb(202, 138, 4)"; // yellow-700
      } else {
        m.style.backgroundColor = "rgba(250, 204, 21, 0.4)";
        m.style.outline = "none";
      }
    });
    setCurrentMatch(idx + 1);
  };

  const goNext = () => {
    if (marksRef.current.length === 0) return;
    const next = currentMatch % marksRef.current.length; // wrap
    scrollToMatch(marksRef.current[next], next);
  };

  const goPrev = () => {
    if (marksRef.current.length === 0) return;
    const prev = (currentMatch - 2 + marksRef.current.length) % marksRef.current.length;
    scrollToMatch(marksRef.current[prev], prev);
  };

  // Keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    }
  };

  return (
    <div className="px-6 py-2 border-b border-border/60 shrink-0 bg-muted/20 flex items-center gap-2">
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("articleViewer.searchPlaceholder") || "Find in article… (Esc to close)"}
          className="w-full h-8 pl-8 pr-20 text-xs rounded-lg border border-border/60 bg-card shadow-xs transition-shadow focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40"
        />
        {/* Match count badge */}
        {query.trim() && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {matchCount > 0 ? (
              <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                {currentMatch}/{matchCount}
              </span>
            ) : (
              <span className="text-[10px] text-muted-foreground/60">
                {t("articleViewer.noMatches") || "no matches"}
              </span>
            )}
          </div>
        )}
      </div>
      {/* Prev / Next match buttons */}
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={goPrev}
          disabled={matchCount === 0}
          title="Previous match (Shift+Enter)"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={goNext}
          disabled={matchCount === 0}
          title="Next match (Enter)"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </div>
      {/* Match count summary */}
      {query.trim() && matchCount > 0 && (
        <Badge variant="outline" className="text-[9px] gap-1 border-yellow-300/60 dark:border-yellow-700/50 text-yellow-700 dark:text-yellow-400">
          <Highlighter className="h-2.5 w-2.5" />
          {matchCount} {matchCount === 1 ? "match" : "matches"}
        </Badge>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0 ml-auto"
        onClick={onClose}
        title="Close search (Esc)"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}


/**
 * AnalysisTab — combines Insights + Audit Report into a single tab with
 * sub-tabs. This reduces the top-level tab count from 6 to 5, preventing
 * tab overflow/truncation on smaller screens.
 */
function AnalysisTab({
  article,
  paragraphs,
  viewLang,
  contentRef,
  projectId,
}: {
  article: any;
  paragraphs: any[];
  viewLang: any;
  contentRef: React.RefObject<HTMLDivElement | null>;
  projectId: string;
}) {
  const [subTab, setSubTab] = React.useState<"insights" | "audit">("insights");

  // Listen for the "open-audit-trail" custom event dispatched by the
  // CitationHealthDashboard's "Review N warnings" button. When received,
  // switch to the Audit Trail sub-tab so the user can review the issues.
  React.useEffect(() => {
    const handler = () => setSubTab("audit");
    window.addEventListener("open-audit-trail", handler);
    return () => window.removeEventListener("open-audit-trail", handler);
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Sub-tab bar */}
      <div className="shrink-0 flex items-center gap-1 px-4 py-1.5 border-b border-border/40 bg-muted/20">
        <button
          onClick={() => setSubTab("insights")}
          className={`inline-flex items-center gap-1.5 h-7 px-3 text-[11px] rounded-md font-medium transition-all ${
            subTab === "insights"
              ? "bg-primary/10 dark:bg-primary/20 text-primary ring-1 ring-primary/30 font-semibold"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
          }`}
        >
          <Sparkles className="size-3" />
          Metrics
        </button>
        <button
          onClick={() => setSubTab("audit")}
          className={`inline-flex items-center gap-1.5 h-7 px-3 text-[11px] rounded-md font-medium transition-all ${
            subTab === "audit"
              ? "bg-primary/10 dark:bg-primary/20 text-primary ring-1 ring-primary/30 font-semibold"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
          }`}
        >
          <ScanSearch className="size-3" />
          Audit Trail
        </button>
      </div>
      {/* Sub-tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {subTab === "insights" && (
          <ArticleInsights
            article={article}
            paragraphs={paragraphs}
            viewLang={viewLang}
            contentRef={contentRef}
          />
        )}
        {subTab === "audit" && (
          <ScrollArea className="h-full scroll-academic">
            <div className="px-6 py-5">
              <div className="flex items-center gap-2 mb-3">
                <ScanSearch className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                <h3 className="text-sm font-semibold">
                  Citation Audit Report History
                </h3>
              </div>
              <p className="text-[11px] text-muted-foreground mb-4">
                Every citation audit (auto-triggered after generation, or
                manually triggered via the Audit button) is recorded here.
                Expand a report to see which citations were checked, which
                were mismatches, and what corrections were applied.
              </p>
              <AuditReportViewer projectId={projectId} />
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
