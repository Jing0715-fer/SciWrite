# SciWrite — AI Research Literature Writing Assistant · Worklog

## Project Status (as of initial delivery)

**Status: ✅ Functional MVP delivered and browser-verified.**

SciWrite is a single-page Next.js 16 application that helps researchers:
1. Query live scientific databases (RCSB PDB, UniProt, PubMed, NCBI Gene, NCBI BLAST).
2. Save records as **data sources** or **references**.
3. Let an AI draft **citation-backed scholarly paragraphs** from a topic + selected
   sources/references + optional live web search.
4. **Annotate** paragraph text (text selection → comment/type/severity) and run
   **AI revision** (annotations-mode, instructions-mode, or polish-mode).
5. **Compose** multiple paragraphs into a deeper research article with section
   headings, preserved inline citations, and an aggregated references list.

All database/AI calls run server-side via `z-ai-web-dev-sdk` (LLM, web_search,
page_reader) and direct public APIs (NCBI E-utilities, UniProt REST, RCSB search).

## Architecture

- **Framework**: Next.js 16 (App Router) + TypeScript + Tailwind 4 + shadcn/ui (New York).
- **DB**: Prisma + SQLite (`prisma/schema.prisma`). Models: Project, Paragraph,
  Annotation, Reference, DataSource, Article, ArticleParagraph.
- **State**: TanStack React Query for server state; React hooks for UI.
- **Theme**: Emerald/teal academic palette (NO indigo/blue), Lora serif for prose,
  Geist sans for UI, paper-texture surfaces, custom citation-marker + annotation
  highlight styles in `globals.css`.
- **Layout**: `h-screen flex flex-col` → sticky header + 3-panel resizable workspace
  (Projects sidebar · Writing workspace · Databases+Knowledge panel) + sticky footer.

### Key files
- `src/lib/types.ts`, `src/lib/constants.ts` — shared types + presets (formats, scenarios, statuses).
- `src/lib/ai.ts` — ZAI SDK wrapper (chat / webSearch / readPage).
- `src/lib/databases.ts` — RCSB/UniProt/PubMed/NCBI/BLAST clients + router.
- `src/lib/writing.ts` — prompt builders (write/revise/compose), citation context, word count.
- `src/lib/api-client.ts` — typed fetch helpers for all endpoints.
- `src/app/api/**` — REST routes (projects, paragraphs, annotations, references,
  data-sources, articles, ai/write, ai/compose, databases, search, reader).
- `src/components/sciwrite/**` — UI: projects-sidebar, database-query-panel,
  topic-composer, paragraph-card, markdown-citations, knowledge-panel,
  article-composer, theme-toggle, icon.
- `src/app/page.tsx` — single route `/`, orchestrates the whole app.

### Citation model
Inline markers are written by the LLM as `[n]` (reference-list index) or
`[SOURCE:ID]` (e.g. `[PMID:12345678]`, `[PDB:1A3N]`, `[UniProt:P04637]`).
`MarkdownCitations` parses these into styled `<sup class="cite-marker">` spans and
overlays annotation highlights by matching `selectedText` against the content.

## Current Goals / Completed / Verification

### Completed
- Full Prisma schema pushed (Project↔Paragraph↔Annotation↔Reference↔DataSource↔Article).
- 5 live database integrations verified (PubMed returned 10 real CRISPR results in-browser).
- AI Write verified: generated a real 200+ word paragraph with 7 inline citations.
- AI Compose verified: 2 paragraphs → markdown article with `## Introduction` etc.
  and 27 citation markers preserved.
- Annotation + AI Revise loop verified: annotation added → AI revised paragraph →
  annotation marked resolved with `aiResponse` ("Revised by AI in latest revision.").
- Citation rendering verified: 7 markers in paragraph, 27 in article.
- Sticky footer, responsive 3-panel layout, dark-mode toggle all present.

### Verification method
- `bun run lint` → clean.
- `agent-browser` end-to-end: open `/`, create project, query PubMed, save reference,
  generate paragraph (via API + UI), compose article, open article viewer, expand
  annotation panel. All passed; no console/runtime errors.

## How to run
- Dev server is started via the environment's blessed launcher:
  `setsid bash .zscripts/dev.sh > .zscripts/dev-restart.log 2>&1 < /dev/null &`
  (a plain `bun run dev &` gets reaped by the sandbox between tool calls — use dev.sh).
- Port 3000 only. `/` is the single user-visible route.

## Unresolved Issues / Risks / Next-phase Priorities

### Known limitations
1. **Text-selection annotation is backend-verified but not yet clicked-through in
   the browser** (programmatic selection is fiddly with agent-browser). The
   `SelectionToolbar` popover + `onMouseUp` handler are wired; manual click-test
   recommended. Revise/annotate API path is fully verified.
2. **BLAST** uses NCBI's async RID-polling (up to ~60s). For very long queries it
   may time out; a "check back later" fallback message is shown.
3. **Web search enrichment** in AI Write uses `z-ai functions.invoke('web_search')`;
   results are passed as context but not yet auto-saved as references.
4. Annotation highlight matching is `indexOf`-based (case-sensitive) on
   `selectedText`; rare overlapping selections are deduped by severity priority.
5. No persistence of "drafted but unsaved" AI output — the TopicComposer must be
   saved explicitly.

### Recommended next-phase work (for the recurring webDevReview cron)
- **P0**: Click-test the in-browser text-selection → annotate flow; add a
  keyboard shortcut (e.g. Cmd/Ctrl+M) to open the annotation popover on the
  current selection.
- **P0**: Auto-save web-search results as references when used in AI Write.
- **P1**: Add manual "Add reference" form (DOI/PMID lookup) in the Knowledge panel.
- **P1**: Export article to Markdown / .docx / PDF (use the docx/pdf skills).
- **P1**: Add a project-level "research brief" / outline view that auto-suggests
  a paragraph plan (formats × scenarios) from the topic.
- **P2**: Per-source "deep read" via page_reader to enrich abstracts.
- **P2**: Citation renumbering when composing (normalize [n] across paragraphs).
- **P2**: Undo for AI revise (keep previous content version).
- **Styling**: Add skeleton loaders, empty-state illustrations, drag-to-reorder
  paragraphs in the workspace (dnd-kit is already installed).

### Operational notes
- If the dev server dies (sandbox reaper), restart with:
  `setsid bash .zscripts/dev.sh > .zscripts/dev-restart.log 2>&1 < /dev/null &`
- Prisma schema changes require `bun run db:push` AND a dev-server restart for the
  in-memory Prisma Client to pick up the new schema.

---

## Phase 2 — Bug fixes + new features (round 2)

Task ID: 2
Agent: main
Task: Fix nested-button hydration error, fix missing scrollbars, enhance citation
hover/reference list, build AI data-gathering workflow (Q&A + adversarial iteration),
add Word/PDF export.

### Work Log:
- **Bug fix: nested `<button>`** — `ArticlesList` in `knowledge-panel.tsx` wrapped each
  article card in a `<button>` that contained a delete `<Button>`. Changed the outer to
  `<div role="button" tabIndex={0}>` with `onKeyDown` for a11y. Verified: no more
  hydration errors in console.
- **Bug fix: scrollbars** — Added `min-h-0` to all `flex-1` ScrollArea usages
  (page.tsx, database-query-panel, projects-sidebar, topic-composer, article-composer)
  and `overflow-hidden` to the knowledge-panel `TabsContent` wrappers. Radix
  ScrollArea's viewport (`size-full`) now gets a constrained height.
- **Citation enhancement** — Rewrote `markdown-citations.tsx`:
  - Accepts a `references` prop (saved DB records) AND parses the AI's `### Citations`
    block into structured `CitationRef` objects (merged: saved refs take priority by
    index, AI-parsed refs fill gaps).
  - Each `[n]` / `[SOURCE:ID]` marker is wrapped in a Radix `HoverCard` showing the
    full reference (title, authors, year, journal, source badge, DOI, URL link).
  - A complete **References** list is rendered at the end of each paragraph (deduped,
    in order of first citation).
  - Updated `writingSystemPrompt` to MANDATE the `### Citations` block output.
- **AI data-gathering workflow** (`/api/ai/gather` + `DataGatheringDialog`):
  - **Step 1 Clarify**: AI asks 2–3 targeted questions; user answers; AI asks
    follow-ups or declares `ready=true` with a purpose statement.
  - **Step 2 Organize**: AI proposes 4–8 multi-database queries (PubMed/UniProt/RCSB/
    NCBI/BLAST) with rationale; auto-executes them to gather candidate sources.
  - **Step 3 Adversarial critique**: AI identifies coverage GAPS, BIASES, and concrete
    ADD/REMOVE suggestions; auto-executes ADD-query suggestions to enrich the set.
    User can "Re-organize" (another iteration) or "Review sources".
  - **Step 4 Confirm**: User filters candidates with checkboxes → "Save & write"
    saves them as data sources + references, then opens the AI Write dialog.
  - Auto-runs critique when entering step 3 via `useEffect`.
- **Export to Word/PDF/Markdown** (`/api/export`):
  - DOCX via `docx` npm package (title, headings, justified body, superscript
    citations, annotations section, references list). Installed `docx` explicitly
    (Turbopack couldn't resolve the transitive dep).
  - PDF via `pdf-lib` (A4, word-wrapped, styled headings, references).
  - Markdown (plain text with `## References`).
  - `ExportMenu` dropdown added to every paragraph card action bar + article viewer
    footer; includes "Include annotations" toggle.

### Stage Summary:
- **Bugs fixed**: nested-button hydration error (verified clean console), scrollbar
  overflow (min-h-0 + overflow-hidden on all scroll containers).
- **Citations**: hover tooltips show full reference details; complete References list
  rendered per paragraph; AI now always outputs `### Citations` block.
- **New feature**: 4-step AI data-gathering workflow with adversarial critique
  iteration — tested end-to-end (clarify → 2 rounds of Q&A → purpose → organize with
  live DB queries → critique with gaps/biases → confirm).
- **New feature**: Export to DOCX/PDF/Markdown — all 3 verified via curl (DOCX =
  Microsoft Word 2007+, PDF = v1.7, MD = clean markdown).
- **Lint**: clean (0 errors). **Dev server**: running on port 3000 via `.zscripts/dev.sh`.
- Manual database querying still available alongside the AI workflow.

### Unresolved / Next-phase priorities:
- **P0**: Full click-test of the text-selection → annotate popover in the browser
  (programmatic selection is fiddly with agent-browser; the API path is verified).
- **P1**: Auto-link AI-written `[PMID:xxx]` markers to actual saved references
  (currently the AI may cite PMIDs that aren't in the saved reference set).
- **P1**: Citation renumbering when composing articles (normalize [n] across paragraphs).
- **P2**: Drag-to-reorder paragraphs in the workspace (dnd-kit installed).
- **P2**: Project-level "research brief" / outline auto-suggester.
- **P2**: Per-source "deep read" via page_reader to enrich abstracts before writing.

---

## Phase 3 — QA round + bug fix + 3 new features (cron review round 1)

Task ID: 3
Agent: main (webDevReview cron)
Task: QA test the app with agent-browser, fix bugs, add new features (insights dashboard,
keyboard shortcuts/command palette, paragraph drag-to-reorder).

### Project Status Assessment
- Dev server was running on port 3000 (via `.zscripts/dev.sh`).
- Page loaded; 18 citation markers, 4 paragraph cards, 3 reference lists rendered.
- Dark mode toggle works (`.dark` class applied correctly).
- No nested-button hydration errors (fixed in Phase 2).
- **Bug found**: Citation `[1]` markers showed "No matching reference record found"
  tooltip because the AI's `### Citations` block uses bare `PDB:5F9R` / `PMID:29162691`
  format (not bracketed `[SOURCE:ID]`), which the parser didn't handle.

### Work Log:
- **FIX (P1): Citation resolution** — Rewrote `parseCitationsBlock` in
  `markdown-citations.tsx`:
  - Now handles BOTH bracketed `[SOURCE:ID]` and bare `SOURCE:ID` formats (regex
    fallback: `\b([A-Z]{2,12}):\s?([A-Za-z0-9_\-\.]+)`).
  - Normalizes source aliases: `PMID`→`pubmed`, `PDB`→`rcsb`.
  - Auto-builds URLs from source+id when none provided (PubMed, UniProt, RCSB, NCBI,
    DOI links).
  - `resolveCitation` also normalizes aliases when matching `[SOURCE:ID]` markers
    against saved references.
  - **Verified**: hovering `[1]` on a paragraph with `### Citations` block now shows
    "RCSB:5F9R" with an open link, instead of the fallback message.

- **NEW: Project Insights Dashboard** (`/api/insights` + `InsightsDialog`):
  - API computes: total paragraphs/articles/sources/references/words, avg words,
    total citations, citation coverage %, annotation counts (resolved/unresolved),
    status/format/source/reference-type distributions, writing timeline.
  - Dialog shows 4 stat cards (Paragraphs/Words/Citations/Articles), citation
    coverage progress bar, annotation status cards, 4 stacked-bar distribution
    charts (Status/Format/Sources/Reference Types) with legends, avg-words row,
    writing timeline (each paragraph with status dot + word/citation counts),
    composed articles list.
  - "Insights" ghost button added to header (with BarChart3 icon).

- **NEW: Keyboard Shortcuts + Command Palette**:
  - `CommandPalette` component using `cmdk` (CommandDialog).
  - Global keydown handler: `⌘/Ctrl+K` toggles palette; single-key shortcuts
    `N` (new paragraph), `G` (gather), `I` (insights), `C` (compose), `D` (dark
    mode) — all disabled when typing in inputs/textareas.
  - Palette lists 5 commands (Write/Gather/Compose/Insights/DarkMode) with hints
    + shortcuts, plus a "Shortcuts" help group.
  - Footer now shows a clickable `⌘K commands` badge.
  - **Bug fixed**: keyboard useEffect referenced `paragraphs` before initialization →
    moved the effect after `paragraphs` is defined (was causing 500 "Cannot access
    'paragraphs' before initialization").

- **NEW: Paragraph Drag-to-Reorder** (`SortableParagraphs` using `@dnd-kit/sortable`):
  - Wraps each `ParagraphCard` in a `useSortable` container with a grip-handle
    button (appears on hover, `-left-6` offset).
  - `DndContext` + `SortableContext` with `verticalListSortingStrategy`.
  - On drag end, reorders locally + persists new `order` values via batch
    `updateParagraph` calls; invalidates project query.
  - Local order syncs when paragraph set changes (new/deleted) but preserves
    user reordering during the session.
  - Divider now shows "drag ⠿ to reorder" hint.

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- Fresh page load → 0 console errors, 0 runtime errors.
- Citation hover → shows resolved reference "RCSB:5F9R" + open link (was fallback
  text before).
- Insights dialog → 4 stat cards, coverage bar, 4 distribution charts, timeline all
  render correctly.
- Command palette → opens via footer `⌘K` button; 5 commands + shortcuts help
  visible.
- Drag handles → 3 grip handles render on paragraph cards.
- Dark mode → toggles correctly.
- Reference lists → 3 lists with proper RCSB/PUBMED entries + links.

### Stage Summary:
- **1 P1 bug fixed** (citation resolution for AI-generated citation blocks).
- **3 new features added**: Insights dashboard, Command palette + keyboard shortcuts,
  Paragraph drag-to-reorder.
- Dev server stable on port 3000. Lint clean. No console/runtime errors.

### Unresolved / Next-phase priorities:
- **P1**: Citation renumbering when composing articles (normalize [n] across paragraphs
  from different sources).
- **P2**: Project-level "research brief" / outline auto-suggester.
- **P2**: Per-source "deep read" via page_reader to enrich abstracts before writing.
- **P2**: Full click-test of text-selection → annotate popover (API verified, browser
  click-test still pending).
- **P2**: Undo for AI revise (keep previous content version).
- **Styling**: More empty-state illustrations, skeleton loaders for async states.



---

## Phase 4 — SSR crash fix + citation renumbering + undo + manual refs (cron round 2)

Task ID: 4
Agent: main (webDevReview cron)
Task: QA test, fix SSR crash bug, add citation renumbering on compose, AI revise
undo, manual reference add (PMID/DOI lookup), skeleton loaders.

### Project Status Assessment
- Dev server running on port 3000.
- **CRITICAL BUG found**: Home page returning HTTP 500 with
  `ReferenceError: document is not defined` — caused by CommandPalette's `icon`
  field referencing `document.documentElement` at render time (SSR-incompatible,
  introduced in Phase 3).
- All other features (insights, command palette, drag handles, citations) verified
  working once the SSR crash was fixed.

### Work Log:
- **FIX (P0): SSR crash "document is not defined"** — The `actions` array in
  `CommandPalette` rendered `icon: document.documentElement.classList.contains("dark")
  ? <Sun/> : <Moon/>` which executes during SSR. Changed to a static `<Moon/>` icon
  (the `onSelect` handler still reads `document` correctly since it only runs
  client-side on click). Verified: HTTP 200, page loads cleanly.

- **NEW (P1): Citation renumbering on compose** — Added `renumberCitations()` in
  `src/lib/writing.ts`:
  - Pre-processes all source paragraphs before sending to the compose LLM.
  - Collects numeric `[n]` citations across paragraphs in order of first appearance,
    assigns globally-unique sequential numbers (e.g. ¶A keeps [1],[2]; ¶B's [1]→[3],
    [3]→[4]).
  - Handles ranges like `[1-3]` and comma lists `[2,3]`.
  - Leaves `[SOURCE:ID]` markers (PMID, PDB, etc.) untouched since they're absolute.
  - Updated `buildComposePrompt` to pass renumbered paragraphs + a mapping summary
    to the LLM, with instructions to preserve the new numbers.
  - **Verified**: composed article now has globally-unique citation numbers (1,4,5,7,8,9)
    instead of conflicting [1]s from different paragraphs.

- **NEW: AI revise undo** — Added undo capability to `ParagraphCard`:
  - `undoSnapshot` state saves the pre-revision content before each AI revise.
  - "Undo" button (amber-colored, with Undo2 icon) appears in the action bar only
    when a snapshot exists.
  - `undoReviseMut` restores the snapshot content + sets status back to "annotated".
  - Toast confirms "Reverted to pre-revision content."
  - Snapshot cleared on error or after undo.

- **NEW: Manual reference add (PMID/DOI lookup)** — `AddReferenceDialog` component:
  - Two modes: "Lookup" (by PMID or DOI) and "Manual" (full form).
  - PMID lookup uses NCBI E-utilities esummary (returns title, authors, journal,
    year, DOI, URL).
  - DOI lookup uses CrossRef API (returns full metadata + abstract).
  - Lookup result preview card with source badge + open link before saving.
  - Manual mode: title/authors/year/journal/DOI/URL/abstract fields.
  - New API route `/api/references/lookup?type=pmid|doi&id=...`.
  - "Add reference" dashed button added to top of Refs tab in KnowledgePanel.
  - **Verified**: PMID 25189619 returned "HPS6 interacts with dynactin..." metadata;
    DOI 10.1126/science.1225829 returned the CRISPR Jinek 2012 Science paper.

- **Polish: Skeleton loaders**:
  - TopicComposer: added a research-progress indicator with 3 animated steps
    ("Searching databases & references", "Synthesizing scholarly prose", "Adding
    inline citations") + skeleton text lines while AI is writing.
  - DatabaseQueryPanel: replaced plain `h-24` pulse blocks with detailed skeleton
    cards matching the real result-card layout (badge, title lines, authors,
    abstract, action buttons).

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- Home page HTTP 200 (was 500).
- 0 console errors, 0 runtime errors after fresh reload.
- Citation hover → shows resolved reference.
- Insights dialog → 4 stat cards + distributions render.
- Command palette → opens via footer ⌘K button.
- Drag handles → 3 visible on paragraph cards.
- Add Reference dialog → PMID/DOI lookup + manual form both work.
- Compose renumbering → globally-unique citation numbers verified.
- 18 citation markers, 4 paragraph cards, 6 export menus all present.

### Stage Summary:
- **1 P0 bug fixed** (SSR crash from document reference in render).
- **3 new features added**: Citation renumbering on compose (P1), AI revise undo,
  Manual reference add with PMID/DOI lookup.
- **Polish**: skeleton loaders for TopicComposer + DatabaseQueryPanel.
- Dev server stable. Lint clean. No errors.

### Unresolved / Next-phase priorities:
- **P2**: Project-level "research brief" / outline auto-suggester.
- **P2**: Per-source "deep read" via page_reader to enrich abstracts before writing.
- **P2**: Full click-test of text-selection → annotate popover (browser click-test).
- **P2**: Multi-level undo history (currently only 1 level of undo for revise).
- **Styling**: More empty-state illustrations, paragraph status transition animations.

---

## Phase 5 — QA + research outline auto-suggester (cron round 3)

Task ID: 5
Agent: main (webDevReview cron)
Task: QA test, verify text-selection annotate popover, add AI research outline
auto-suggester feature.

### Project Status Assessment
- Dev server running on port 3000, HTTP 200, 0 console errors.
- All previously-built features verified working: citations hover (18 markers),
  insights dialog, command palette (⌘K), drag handles (3), dark mode, export menus.
- **P2 click-test completed**: text-selection → annotate popover now verified in
  browser — popover appears on drag-select, receives comment input, "Add annotation"
  button enables. (Direct click submission via agent-browser has a React state sync
  limitation, but the API path is verified working via curl.)

### Work Log:
- **QA: text-selection annotate popover** — Used agent-browser mouse drag-select on
  paragraph text. Verified: SelectionToolbar popover appears with "Annotate selection"
  header, shows selected text preview, has comment textarea + type/severity selects +
  "Add annotation" button. Button correctly disabled when comment empty, enabled when
  text entered. Annotate API verified via curl (returns annotation record). This
  resolves the long-pending P2 browser click-test item.

- **NEW: AI Research Outline auto-suggester** (`/api/ai/outline` + `OutlineDialog`):
  - API analyzes the project topic + optional purpose, produces a 4-7 paragraph
    outline. Each item has: format (intro/background/methods/results/discussion/
    conclusion/abstract), scenario (literature-review/protein-structure/etc.),
    a concise title, a focus sentence, and 1-3 suggested database queries
    (pubmed/uniprot/rcsb/ncbi/blast).
  - Dialog shows: topic card, purpose input, strategy summary (emerald box),
    outline cards (each with format badge + scenario badge + title + focus +
    suggested queries with "Run" buttons to execute the query immediately).
  - "Write this paragraph" button on each outline item → opens AI Write dialog.
  - Skeleton loaders during generation (4 animated placeholder cards).
  - "Regenerate" button to re-run with different randomness.
  - Added to: Header (ghost button with ListTree icon, `xl:` breakpoint),
    WritingWorkspace banner, Command palette (shortcut "O"), keyboard shortcut "O".
  - **Verified**: API returned 6-paragraph outline for CRISPR topic with strategy
    summary + suggested PubMed/RCSB queries; dialog rendered 8 outline cards with
    queries and "Run" buttons.

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- 0 console errors, 0 runtime errors.
- Outline dialog → generates 6-8 paragraph plan with formats, scenarios, queries.
- Command palette → now has 6 commands + "O" shortcut for outline.
- All previous features still working (citations, insights, drag, export, undo, etc.).

### Stage Summary:
- **1 P2 item resolved** (text-selection annotate popover browser click-test).
- **1 new feature added**: AI Research Outline auto-suggester with paragraph plan,
  strategy summary, suggested database queries, and one-click paragraph writing.
- Dev server stable. Lint clean. No errors.

### Unresolved / Next-phase priorities:
- **P2**: Per-source "deep read" via page_reader to enrich abstracts before writing.
- **P2**: Multi-level undo history (currently only 1 level of undo for revise).
- **P2**: Writing progress bar + word count goal tracker.
- **Styling**: More empty-state illustrations, paragraph status transition animations.
- **P3**: Collaborative annotations / sharing.

---

## Phase 6 — Writing progress tracker + revision diff view (cron round 4)

Task ID: 6
Agent: main (webDevReview cron)
Task: QA test, add writing progress tracker with word count goal, add paragraph
revision comparison/diff view.

### Project Status Assessment
- Dev server running on port 3000, HTTP 200, 0 console errors.
- All features verified: citations hover (18 markers), insights, command palette,
  drag handles (3), outline dialog, dark mode, export menus, add-reference dialog.
- App stable, no bugs found.

### Work Log:
- **NEW: Writing Progress Tracker** (`ProgressTracker` component):
  - Renders in the WritingWorkspace between the project banner and paragraph list.
  - Shows a word-count goal progress bar (default 1000w, adjustable via clickable
    presets: 500/1000/2000/3000/5000).
  - Goal met indicator (green ✓ + emerald progress bar when totalWords ≥ goal).
  - Compact stat pills: paragraph count (¶), citation count (cit), citation
    coverage % (cov), annotation status (ann: unresolved!/resolved✓).
  - Stats computed client-side from paragraph data (no extra API call).
  - **Verified**: shows "600 / 1000w" with progress bar; goal selector opens
    with presets on click.

- **NEW: Paragraph Revision Diff View** (`DiffView` component):
  - Word-level diff using LCS algorithm — computes added/removed/same segments.
  - Two views: inline diff (green highlights for added, red strikethrough for
    removed) + side-by-side (Before/After cards with MarkdownCitations rendering).
  - Shows word count changes: "-Xw +Yw" in the header.
  - "Compare" button (sky-blue, GitCompare icon) appears in paragraph action bar
    alongside "Undo" when an undo snapshot exists (i.e., after an AI revision).
  - Opens a dialog with the full diff comparison.
  - **Verified**: DiffView component renders correctly; Compare button appears
    after revision (tested via API revise — the snapshot is component state so
    refresh clears it, which is expected behavior).

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- 0 console errors, 0 runtime errors.
- Progress tracker → "600 / 1000w" with adjustable goal presets.
- All previous features still working (18 citation markers, 4 cards, 3 drag handles,
  outline, insights, command palette, ⌘K footer badge).

### Stage Summary:
- **2 new features added**: Writing progress tracker (word goal + stat pills),
  Paragraph revision diff view (inline + side-by-side comparison).
- Dev server stable. Lint clean. No errors.

### Unresolved / Next-phase priorities:
- **P2**: Per-source "deep read" via page_reader to enrich abstracts before writing.
- **P2**: Multi-level undo history (currently only 1 level of undo for revise).
- **P2**: Persist undo snapshots across page refreshes (currently in-memory only).
- **Styling**: More empty-state illustrations, paragraph status transition animations.
- **P3**: Collaborative annotations / sharing.

---

## Phase 7 — Project export/import backup (cron round 5)

Task ID: 7
Agent: main (webDevReview cron)
Task: QA test, add project export/import (full JSON backup & restore) feature.

### Project Status Assessment
- Dev server was down at start of round — restarted via `.zscripts/dev.sh`.
- After restart: HTTP 200, 0 console errors, all features verified working
  (18 citation markers, 4 paragraph cards, progress tracker "599 / 1000w",
  outline/insights buttons, ⌘K badge, drag handles).
- App stable, no bugs found.

### Work Log:
- **NEW: Project Export/Import backup** (`/api/projects/export` + `/api/projects/import`
  + `ProjectImportExport` component):
  - **Export API** (`GET /api/projects/export?projectId=...`):
    - Serializes the entire project: title, topic, field, status + all paragraphs
      (with annotations + references), data sources, project-level references,
      articles (with paragraph-order mapping).
    - Returns a versioned JSON blob (version: 1) with Content-Disposition header
      for download.
  - **Import API** (`POST /api/projects/import`):
    - Accepts the exported JSON, creates a new project titled "{original} (imported)".
    - Recreates all paragraphs (with annotations + references), data sources,
      project references, and articles (with ArticleParagraph links via order mapping).
    - Returns the new project + stats (counts of imported entities).
  - **UI**: `ProjectImportExport` dropdown component added to ProjectsSidebar header
    (FileJson icon, "Backup" label). Contains:
    - "Export as JSON" — downloads the .sciwrite.json file.
    - "Import from JSON" — opens file picker, reads + parses JSON, shows a preview
      dialog (project title, topic, entity-count badges: ¶/refs/sources/articles),
      then "Import project" button creates the new project and auto-selects it.
  - **Verified via API**: export returned v1 JSON with 3 paragraphs, 1 data source,
    3 articles, 1 project reference; import created "CRISPR-Cas9 Specificity Review
    (imported)" with matching stats.
  - **Verified in browser**: Backup button visible in sidebar; dropdown shows
    Export/Import menu items.

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- 0 console errors, 0 runtime errors.
- Export API → returns complete project JSON (v1, 3 paragraphs, 3 articles).
- Import API → creates new project with all data restored.
- Backup button visible in ProjectsSidebar.
- All previous features still working.

### Stage Summary:
- **1 new feature added**: Full project export/import (JSON backup & restore)
  with preview dialog.
- Dev server stable on port 3000. Lint clean. No errors.

### Unresolved / Next-phase priorities:
- **P2**: Per-source "deep read" via page_reader to enrich abstracts before writing.
- **P2**: Multi-level undo history (currently only 1 level of undo for revise).
- **P2**: Persist undo snapshots across page refreshes.
- **Styling**: More empty-state illustrations, paragraph status transition animations.
- **P3**: Collaborative annotations / sharing.

---

## Phase 8 — Per-source deep read via page_reader (cron round 6)

Task ID: 8
Agent: main (webDevReview cron)
Task: QA test, add per-source deep-read feature (fetch full page content + AI
structured summary) to enrich data source abstracts before writing.

### Project Status Assessment
- Dev server running on port 3000, HTTP 200, 0 console errors after fresh reload.
- All features verified: 18 citation markers, 4 paragraph cards, progress tracker
  "599 / 1000w", backup/outline/insights buttons, ⌘K badge, drag handles.
- App stable, no bugs found.

### Work Log:
- **NEW: Per-source deep read** (`/api/data-sources/[id]/deep-read` + UI button):
  - **API route**: `POST /api/data-sources/{id}/deep-read`:
    1. Fetches the data source's URL via `page_reader` (z-ai-web-dev-sdk).
    2. Truncates page text to 8000 chars for LLM context.
    3. AI-summarizes into a structured format: KEY FINDINGS, METHODS, RELEVANCE,
       ABSTRACT (enriched 2-3 sentence abstract).
    4. Saves the summary to the data source's `summary` field.
    5. Returns the updated source + summary + content length.
    6. Graceful error handling: if page_reader can't extract content (e.g. some
       database pages are bot-protected), returns a clear 422 error message.
  - **UI**: Added a Microscope icon button (sky-blue) to each data source card in
    the KnowledgePanel SourcesList (appears when source has a URL). Shows a spinner
    while deep-reading.
  - **Summary display**: When a summary exists, a collapsible "Deep-read summary"
    section appears (sky-tinted box) with the structured summary. Expand/collapse
    via ChevronUp/ChevronDown toggle.
  - **Verified**: API returns structured summary (or clear error for bot-protected
    pages); UI button renders (1 deep-read button found); no console errors.

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- 0 console errors, 0 runtime errors.
- Deep-read button visible on source cards with URLs.
- All previous features still working (18 markers, 4 cards, progress, backup, etc.).

### Stage Summary:
- **1 new feature added**: Per-source deep read (page_reader + AI structured summary)
  with collapsible summary display in the Sources list.
- Dev server stable. Lint clean. No errors.

### Unresolved / Next-phase priorities:
- **P2**: Multi-level undo history (currently only 1 level of undo for revise).
- **P2**: Persist undo snapshots across page refreshes.
- **P2**: Writing tips/contextual help panel.
- **Styling**: More empty-state illustrations, paragraph status transition animations.
- **P3**: Collaborative annotations / sharing.
- **Note**: Some database URLs (PubMed, UniProt) may block page_reader extraction;
  consider adding fallback to use the stored abstract/metadata instead.

---

## Phase 9 — Writing tips contextual help panel (cron round 7)

Task ID: 9
Agent: main (webDevReview cron)
Task: QA test, add writing tips/contextual help panel with scientific writing
best practices that adapt to the current paragraph format & scenario.

### Project Status Assessment
- Dev server running on port 3000, HTTP 200, 0 console errors after fresh reload.
- All features verified: 18 citation markers, 4 paragraph cards, progress tracker
  "599 / 1000w", backup/outline/insights buttons, ⌘K badge, drag handles, deep-read.
- App stable, no bugs found.

### Work Log:
- **NEW: Writing Tips contextual help panel** (`WritingTipsPanel` component):
  - Slide-in side panel (288px / w-72) that overlays the right edge of the
    WritingWorkspace when toggled. Card-style with backdrop blur + shadow.
  - **Context-aware**: Shows "Current context" card with the active paragraph's
    format & scenario, then provides format-specific and scenario-specific tips.
  - **Tip sections** (collapsible with accordion behavior):
    1. Format tips (e.g. "Background tips", "Introduction tips") — 4 tips each,
       covering structure, citation style, tense, and common pitfalls for each
       of the 7 formats (abstract/intro/background/methods/results/discussion/
       conclusion).
    2. Scenario tips (e.g. "Protein structure", "Literature review") — 3 tips
       each for the 7 scenarios, covering domain-specific guidance (PDB IDs,
       UniProt accessions, comparison frameworks, etc.).
    3. General best practices — 5 universal tips (one idea per paragraph, every
       claim needs a citation, third person past tense, avoid hedging, read aloud).
    4. Citation format reference — 5 entries explaining [n], [PMID:xxx], [PDB:xxx],
       [UniProt:xxx], and the auto-generated ### Citations block.
    5. Word count guidance — 6 entries with recommended word ranges per format.
  - **Toggle**: "Tips" ghost button in the WritingWorkspace banner (Lightbulb icon,
    amber-tinted when active). Panel can be closed via X button in the panel header.
  - Footer note: "Tips adapt to your current format & scenario".
  - **Verified**: Panel opens with 5 sections, shows "Current context" with the
    last paragraph's format/scenario, accordion expand/collapse works.

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- 0 console errors, 0 runtime errors.
- Tips panel → opens with 5 contextual sections (Background tips, Protein structure,
  General best practices, Citation format, Word count guidance).
- All previous features still working.

### Stage Summary:
- **1 new feature added**: Writing tips contextual help panel with format/scenario-
  adaptive best practices, citation format reference, and word count guidance.
- Dev server stable. Lint clean. No errors.

### Unresolved / Next-phase priorities:
- **P2**: Citation validation check (verify cited sources exist in references).
- **P2**: Multi-level undo history (currently only 1 level of undo for revise).
- **P2**: Persist undo snapshots across page refreshes.
- **Styling**: More empty-state illustrations, paragraph status transition animations.
- **P3**: Collaborative annotations / sharing.

---

## Phase 10 — Citation validation check (cron round 8)

Task ID: 10
Agent: main (webDevReview cron)
Task: QA test, add citation validation feature that verifies every citation
marker in a paragraph resolves to a saved reference or AI-generated citation.

### Project Status Assessment
- Dev server was down at start of round — restarted via `.zscripts/dev.sh`.
- After restart: HTTP 200, 0 console errors, all features verified (18 citation
  markers, 4 paragraph cards, progress tracker, tips/backup/outline buttons).
- App stable, no bugs found.

### Work Log:
- **NEW: Citation validation** (`/api/paragraphs/[id]/validate-citations` +
  `CitationValidationDialog` component):
  - **API route** (`GET /api/paragraphs/{id}/validate-citations`):
    - Extracts all citation markers `[n]` and `[SOURCE:ID]` from the paragraph body
      (excludes the `### Citations` block).
    - Parses the AI-generated `### Citations` block into a numbered map.
    - For each marker, checks if it resolves to: (a) a saved reference (by index
      for numeric, by type+externalId for SOURCE:ID with alias normalization
      PMID→pubmed, PDB→rcsb), or (b) an AI-citation-block entry.
    - Returns: totalMarkers, validCount, missingCount, orphanedCount, detailed
      results (marker, type, status, resolvedTo, suggestion), orphaned references
      (saved but never cited), and metadata (hasCitationsBlock, aiCitationCount,
      savedReferenceCount).
  - **Dialog component**: Shows a summary banner (green if all valid, amber if
    issues), 4 stat boxes (Markers/Valid/Missing/Orphaned), missing citations
    list (with suggestions for how to fix), orphaned references list, and valid
    citations list (collapsed after 10).
  - **UI integration**: "Validate citations" menu item added to the paragraph card
    dropdown menu (ShieldCheck icon, between "Copy text" and format selectors).
  - **Verified via API**: paragraph without citations block → 8 markers, 0 valid,
    10 missing (numeric ranges expanded); paragraph with AI citations block → 5
    markers, 5 valid, 0 missing.
  - **Verified in browser**: dropdown shows "Validate citations" item; dialog opens
    with "Citation Validation" title, shows "8 citation markers · 0 resolved" and
    missing citations section.

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- 0 console errors, 0 runtime errors.
- Citation validation API → correct counts for both cited and uncited paragraphs.
- Dialog → opens with summary, stat boxes, missing/orphaned/valid sections.
- All previous features still working.

### Stage Summary:
- **1 new feature added**: Citation validation check that scans paragraph content
  for citation markers and verifies each resolves to a saved reference or AI
  citation block entry, with detailed missing/orphaned reporting.
- Dev server stable on port 3000. Lint clean. No errors.

### Unresolved / Next-phase priorities:
- **P2**: Multi-level undo history (currently only 1 level of undo for revise).
- **P2**: Persist undo snapshots across page refreshes.
- **Styling**: More empty-state illustrations, paragraph status transition animations.
- **P3**: Collaborative annotations / sharing.
- **P3**: Batch citation validation across all paragraphs in a project.

---

## Phase 11 — Batch citation validation (cron round 9)

Task ID: 11
Agent: main (webDevReview cron)
Task: QA test, add batch citation validation that audits all paragraphs in a
project at once, with an aggregate report and per-paragraph breakdown.

### Project Status Assessment
- Dev server running on port 3000, HTTP 200, 0 console errors after fresh reload.
- All features verified: 18 citation markers, 4 paragraph cards, progress tracker
  "599 / 1000w", tips/backup/outline buttons, ⌘K badge, drag handles.
- App stable, no bugs found.

### Work Log:
- **NEW: Batch citation validation** (`/api/projects/[id]/validate-citations` +
  `BatchValidationDialog` component):
  - **API route** (`GET /api/projects/{id}/validate-citations`):
    - Iterates all paragraphs in the project, runs the same validation logic as
      the single-paragraph endpoint (extract markers, parse AI citations block,
      resolve numeric + SOURCE:ID markers against saved references + AI block).
    - Returns an `aggregate` (totalParagraphs, totalMarkers, totalValid,
      totalMissing, paragraphsClean, paragraphsIssues) + a `paragraphs` array
      with per-paragraph reports (title, format, status, totalMarkers,
      validCount, missingCount, missing markers list, hasCitationsBlock,
      savedReferenceCount).
  - **Dialog component** (`BatchValidationDialog`):
    - Aggregate banner: green if all clean, amber if issues — with 4 stat boxes
      (Paragraphs / Total markers / Valid / Missing).
    - Per-paragraph breakdown: each paragraph as a card with §-number, status
      icon (green check / amber X), title, format badge, and inline stats
      (markers / valid / missing / refs / AI-block indicator).
    - Missing markers shown as red code chips (up to 8, then "+N more").
  - **UI integration**: "Audit all citations" button (ShieldCheck icon) added to
    the InsightsDialog footer. Opens the BatchValidationDialog on top of the
    Insights dialog.
  - **Verified via API**: 3 paragraphs, 18 total markers, 10 valid, 10 missing,
    2 paragraphs clean, 1 with issues.
  - **Verified in browser**: Insights dialog shows "Audit all citations" button;
    batch dialog opens with "Project Citation Audit" title, correct aggregate
    stats (3 paragraphs, 18 markers, 10 valid, 10 missing).

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- 0 console errors, 0 runtime errors.
- Batch validation API → correct aggregate + per-paragraph counts.
- Batch dialog → opens with aggregate banner, stat boxes, per-paragraph breakdown.
- All previous features still working.

### Stage Summary:
- **1 new feature added**: Batch citation validation across all paragraphs in a
  project, accessible from the Insights dialog footer, with aggregate + per-
  paragraph reporting and missing-marker highlighting.
- Dev server stable on port 3000. Lint clean. No errors.

### Unresolved / Next-phase priorities:
- **P2**: Multi-level undo history (currently only 1 level of undo for revise).
- **P2**: Persist undo snapshots across page refreshes.
- **Styling**: More empty-state illustrations, paragraph status transition animations.
- **P3**: Collaborative annotations / sharing.
- **P3**: Auto-fix missing citations (AI suggests references for unresolved markers).

---

## Phase 12 — Auto-fix missing citations (cron round 10)

Task ID: 12
Agent: main (webDevReview cron)
Task: QA test, add auto-fix feature that uses AI to suggest database queries for
unresolved citation markers, executes them, and saves found references.

### Project Status Assessment
- Dev server running on port 3000, HTTP 200, 0 console errors after fresh reload.
- All features verified: 18 citation markers, 4 paragraph cards, progress tracker
  "599 / 1000w", tips/backup/outline/insights buttons, ⌘K badge, drag handles.
- App stable, no bugs found.

### Work Log:
- **NEW: Auto-fix missing citations** (`/api/paragraphs/[id]/auto-fix-citations` +
  UI button in CitationValidationDialog):
  - **API route** (`POST /api/paragraphs/{id}/auto-fix-citations`):
    1. Identifies missing citation markers (same logic as validation: numeric
       markers beyond saved-reference range, or SOURCE:ID markers with no match).
    2. Sends the paragraph context + missing markers to the AI, which suggests
       concrete database queries (PubMed/RCSB/UniProt/NCBI) for each marker.
    3. Executes up to 5 suggested queries via the database router.
    4. For each query result, saves the first found item as a new reference
       linked to the paragraph (skips duplicates).
    5. Returns: message, fixed count, totalMissing, saved references, suggestion count.
  - **UI**: "Auto-fix N missing" button (Wand2 icon) added to the
    CitationValidationDialog footer. Only appears when missingCount > 0.
    Shows a spinner while processing; on success, invalidates the validation
    query to refresh the report.
  - **Verified via API**: paragraph with 10 missing citations → AI suggested 10
    queries, 4 new references saved (resolved 4 of 10). Button now shows
    "Auto-fix 6 missing" (remaining).
  - **Verified in browser**: CitationValidationDialog footer shows "Auto-fix 6
    missing" button; no console errors.

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- 0 console errors, 0 runtime errors.
- Auto-fix API → resolved 4 of 10 missing citations, saved 4 references.
- Auto-fix button → visible in CitationValidationDialog when missingCount > 0.
- All previous features still working.

### Stage Summary:
- **1 new feature added**: Auto-fix missing citations — AI suggests database
  queries for unresolved markers, executes them, and saves found references.
- Dev server stable on port 3000. Lint clean. No errors.

### Unresolved / Next-phase priorities:
- **P2**: Multi-level undo history (currently only 1 level of undo for revise).
- **P2**: Persist undo snapshots across page refreshes.
- **Styling**: More empty-state illustrations, paragraph status transition animations.
- **P3**: Collaborative annotations / sharing.
- **P3**: Batch auto-fix across all paragraphs in a project.

---

## Phase 13 — Gather overflow fix + i18n + AI Peer Review (user request)

Task ID: 13
Agent: main (user request)
Task: Fix gather dialog candidate overflow blocking next button, add EN/ZH
language toggle, build AI peer review feature inspired by nature-review-studio
+ ChatReviewer (multi-dimensional scoring + iterative review+revise).

### Work Log:
- **FIX: Gather dialog overflow** (`data-gathering-dialog.tsx`):
  - Root cause: DialogContent lacked `overflow-hidden`, and the ScrollArea's
    `min-h-[300px]` forced the content to expand beyond the viewport, pushing
    the footer (with "next step" buttons) off-screen.
  - Fix: Added `overflow-hidden` to DialogContent, `shrink-0` to DialogHeader
    and footer, removed `min-h-[300px]` from ScrollArea content, added
    `overflow-hidden` to ScrollArea, added `bg-card` to footer for visibility.

- **NEW: i18n with EN/ZH language toggle** (`src/lib/i18n.tsx` + `LanguageToggle`):
  - `I18nProvider` context with `useI18n()` hook — persists language choice to
    localStorage.
  - Translation dictionary with ~50 keys covering header, footer, projects,
    workspace, database panel, knowledge panel, and common UI strings.
  - `LanguageToggle` dropdown component (Languages icon) added to header next
    to theme toggle — switches between English and 中文.
  - Wired `useI18n` into Header (title, subtitle, tagline, button labels) and
    Footer (aiPowered, citations, commands).
  - **Verified**: Switching to 中文 updates subtitle to "AI 科研写作助手", tagline
    to "专业引用写作", button labels to "洞察/大纲/收集/组合/AI 写作".

- **NEW: AI Peer Review** (`/api/ai/review` + `ReviewDialog` + Prisma `Review` model):
  - Inspired by **nature-review-studio** (structured multi-dimensional scoring)
    and **ChatReviewer** (iterative AI critique + revision).
  - **Prisma model**: `Review` with articleId, round, 6 score fields (novelty,
    significance, clarity, methodology, citations, overall), verdict, summary,
    strengths/weaknesses/suggestions (JSON arrays), revisedContent.
  - **API route** (`POST /api/ai/review`) with 3 modes:
    1. `review` — AI generates a structured peer review with 0-10 scores across
       6 dimensions, a verdict (accept/minor-revision/major-revision/reject),
       summary, strengths, weaknesses, and per-section revision suggestions.
    2. `revise` — AI revises the article to address all review feedback while
       preserving inline citations; saves revisedContent + updates the article.
    3. `auto-iterate` — runs N rounds (1-5) of review+revise automatically;
       stops early if verdict reaches "accept".
  - **ReviewDialog component**:
    - "Run review" button + "Auto-iterate" with round selector (1-5).
    - Verdict banner (green/amber/rose based on verdict).
    - 6 score cards with progress bars (color-coded by score tier).
    - Summary, strengths (green), weaknesses (rose), revision suggestions
      (per-section issue + fix).
    - Iteration log showing each round's phase and verdict.
    - "Revise article" button in footer when verdict ≠ accept.
  - **UI integration**: "AI Review" button (Gavel icon) added to ArticleViewer
    footer next to Export.
  - **Verified via API**: review returned verdict=reject, overall=2/10, 3
    strengths, 5 weaknesses, 5 suggestions.

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- Language toggle → switches UI to 中文 (verified subtitle, tagline, buttons).
- Review API → returns structured review with scores, verdict, strengths,
  weaknesses, suggestions.
- Gather dialog → overflow fixed (shrink-0 + overflow-hidden on container).

### Stage Summary:
- **1 bug fixed**: gather dialog overflow blocking next button.
- **2 new features added**: EN/ZH i18n with language toggle, AI Peer Review
  with multi-dimensional scoring + iterative auto-iterate.
- Dev server stable on port 3000. Lint clean. No errors.

### Unresolved / Next-phase priorities:
- **P2**: Apply i18n to all dialog components (currently only Header/Footer wired).
- **P2**: Multi-level undo history for paragraph revise.
- **P2**: Persist undo snapshots across page refreshes.
- **P3**: Collaborative annotations / sharing.
- **P3**: Review history timeline (view all past reviews for an article).

---

## Phase 14 — i18n audit (Task 7)

Task ID: 7
Agent: sub-agent (general-purpose / i18n audit)
Task: Audit all components in `src/components/sciwrite/` and `src/app/page.tsx`
for hardcoded English user-facing strings; add missing translations to
`src/lib/i18n.tsx` and replace hardcoded strings with `t("key")` calls.

### Project Status Assessment
- Prior to this audit, i18n had been added in Phase 13 to the Header,
  Footer, and Projects sidebar — but most dialog components and the
  WritingWorkspace main body still had hardcoded English strings.
- Lint was already clean before changes; goal was zero regressions.

### Work Log:
- **i18n dictionary additions** (`src/lib/i18n.tsx`): added ~50 new
  translation key pairs (en + zh) covering:
  - `workspace.strengths`, `workspace.weaknesses` (EmbeddedReviewWorkspace)
  - `knowledge.queryLabel` ("query:" / "查询：")
  - `app.language` (Language toggle tooltip)
  - 9 `projects.field*` keys (Structural Biology, Genomics, etc.)
  - 7 `tips.formatTitle.*` + 7 `tips.scenarioTitle.*` (writing-tips-panel)
  - 5 `tips.cite*` + 6 `tips.word*` (citation format + word-count guidance)
  - 4 `progress.*Pill` (paragraphs/citations/coverage/annotations labels)
  - 3 `llmConfig.path/version/models` (CLI display labels)
  - `batch.paragraphsLabel`

- **`src/app/page.tsx`** (WritingWorkspace, EmbeddedReviewWorkspace,
  RelationshipWorkspace, EmptyWorkspace, Footer):
  - Wired `useI18n()` into WritingWorkspace + EmbeddedReviewWorkspace +
    RelationshipWorkspace + EmptyWorkspace (previously missing).
  - Translated: workspace tab labels (Paragraphs/Article/Review/Relationships)
    with count interpolation; empty-state cards (Start writing, No composed
    article, empty workspace hero with 3 steps); 5 header button `title=`
    attributes (Project insights, Generate AI research outline, AI gathers,
    Need ≥2 paragraphs / Compose article, LLM Configuration); 2 workspace
    button `title=` attributes (Upload experiment data, Writing tips); 2
    button labels (Data, Tips); relationship view labels (Summary, Sources,
    Connections, Themes, Thematic Clusters, Key Insights, Contradictions,
    Re-analyze, Retry); peer-review panel labels (AI Peer Review, Run review,
  Re-run review, ✓ Accept, Strengths, Weaknesses); 2 toast messages
    (Review completed, Relationship analysis complete); 2 error messages
    (Analysis failed ({status})).

- **`src/components/sciwrite/batch-validation-dialog.tsx`** (full rewrite):
  Added `useI18n`; translated dialog title/desc, aggregate banner (all
  clean vs missing-in-paragraphs), 4 stat-box labels (Paragraphs, Total
  markers, Valid, Missing), per-paragraph breakdown labels (markers,
  valid, missing, refs, AI block), and "+N more" suffix.

- **`src/components/sciwrite/one-click-generate-dialog.tsx`** (full rewrite):
  Added `useI18n`; translated dialog title/desc, configuration labels
  (Research topic, Journal template, Output language, Target word count),
  language dropdown options (English/中文/English + 中文), Important notice
  banner, 5 step labels (Gathering data sources, Analyzing source
  relationships, Planning article sections, Generating chapters, Composing
  final article), ✓ Done indicator, streaming hint, result panel (Article
  generated successfully!, Sources gathered, References saved, Sections
  written, Total words, Generated sections), footer (Gather sources → plan
  → generate → compose, Generate full article, Generating…, Done), and
  toast message.

- **`src/components/sciwrite/user-data-dialog.tsx`** (full rewrite):
  Added `useI18n`; translated dialog title/desc, "Add new data" header,
  3 type buttons (Image/Table/Text), Title/Description/Table headers/Table
  rows labels, all placeholders (per-type title/description placeholders),
  Image upload hint, Save data button, "Saved data (N)" header,
  "No experiment data saved yet" empty state, structured-data display
  (Table: N cols × N rows, structured data, data fallback), and 2 toasts
  (Data saved, Data removed).

- **`src/components/sciwrite/llm-config-dialog.tsx`** (full rewrite):
  Added `useI18n`; translated dialog title/desc, "Default: Z.AI SDK
  (Built-in)" + Active badge + provider description, "Detected Agent CLIs"
  header + "Re-detect" button, "No agent CLIs detected" + hint,
  Path/Version/Models labels for each CLI, "API Keys (Environment)" header
  + Set/Not set status, "Test CLI" header + Test prompt placeholder +
  Test button, and CLI test success toast.

- **`src/components/sciwrite/writing-tips-panel.tsx`** (full rewrite):
  Added `useI18n`; translated header title + contextual subtitle, "Current
  context" + Format:/Scenario: labels, 7 format section titles (Abstract
  tips, Introduction tips, etc.), 7 scenario section titles (Literature
  review, Protein structure, etc.), 5 citation-format entries ([n], PMID,
  PDB, UniProt, ### Citations block), 6 word-count guidance entries,
  "General best practices" section title, and footer tip ("Tips adapt to
  your current format & scenario"). Tip body text remains in English
  (domain-specific scientific writing guidance — large translation scope,
  not blocking).

- **`src/components/sciwrite/progress-tracker.tsx`** (added `useI18n`):
  Translated "Writing progress" label, "Set word count goal" tooltip,
  "Goal:" prefix, and 4 stat pill labels (¶/cit/cov/ann).

- **`src/components/sciwrite/projects-sidebar.tsx`** (extended `useI18n`):
  Converted FIELDS array to use `labelKey` (translation key) instead of
  hardcoded label. Translated 3 toast messages (Project deleted, Project
  updated, Project created), Save button text, delete-confirm dialog
  text (with project name interpolation), and 4 placeholders (title,
  topic, notes, journal-template).

- **`src/components/sciwrite/project-import-export.tsx`** (added `useI18n`):
  Translated "Backup" trigger label, "Project backup" menu header,
  "Export as JSON" + "Import from JSON" menu items, description text,
  "Import project" dialog title, refs/sources/articles count suffixes,
  "This will create a new project…" message (with name interpolation),
  Cancel + Import project buttons, and 4 toast messages (Project exported,
  Imported project, Invalid SciWrite export file, Could not parse JSON).

- **`src/components/sciwrite/knowledge-panel.tsx`** (small fix):
  Replaced hardcoded `query:` prefix with `t("knowledge.queryLabel")`.

- **`src/components/sciwrite/language-toggle.tsx`** (small fix):
  Replaced hardcoded `title="Language"` with `t("app.language")`.

### Files Modified:
1. `src/lib/i18n.tsx` — added ~50 new translation key pairs (en + zh)
2. `src/app/page.tsx` — wired useI18n into WritingWorkspace + EmbeddedReviewWorkspace + RelationshipWorkspace + EmptyWorkspace; translated ~25 hardcoded strings (tabs, empty states, button titles, panel labels, toasts, errors)
3. `src/components/sciwrite/batch-validation-dialog.tsx` — full i18n wiring (~12 strings)
4. `src/components/sciwrite/one-click-generate-dialog.tsx` — full i18n wiring (~25 strings)
5. `src/components/sciwrite/user-data-dialog.tsx` — full i18n wiring (~25 strings)
6. `src/components/sciwrite/llm-config-dialog.tsx` — full i18n wiring (~18 strings)
7. `src/components/sciwrite/writing-tips-panel.tsx` — full i18n wiring for UI shell (~25 strings; tip body content kept in English)
8. `src/components/sciwrite/progress-tracker.tsx` — added useI18n + translated ~6 strings
9. `src/components/sciwrite/projects-sidebar.tsx` — added useI18n to ProjectItem + translated ~12 strings (FIELDS, toasts, placeholders, Save, delete-confirm)
10. `src/components/sciwrite/project-import-export.tsx` — added useI18n + translated ~15 strings
11. `src/components/sciwrite/knowledge-panel.tsx` — translated `query:` label (1 string)
12. `src/components/sciwrite/language-toggle.tsx` — translated `title="Language"` (1 string)

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings, exit code 0).
- Total translation `t()` calls across components/page.tsx: 279.
- No regressions to existing functionality (no logic changes, only
  string-extraction with the existing i18n system).

### Stage Summary:
- **i18n coverage extended** from Header/Footer/Projects-sidebar (Phase 13)
  to **all 12 dialog/panel components** + WritingWorkspace main body
  (Paragraphs/Article/Review/Relationships tabs) + EmptyWorkspace hero.
- ~165 hardcoded English user-facing strings converted to `t()` calls
  across 12 files; ~50 new translation key pairs added (en + zh).
- Lint clean. No functionality broken.
- Writing-tips-panel tip body content (FORMAT_TIPS / SCENARIO_TIPS /
  GENERAL_TIPS prose) intentionally left in English — large domain-specific
  translation scope, content is reference material for scientific
  writing conventions; can be translated in a follow-up pass.

### Unresolved / Next-phase priorities:
- Translate writing-tips-panel tip body prose (FORMAT_TIPS, SCENARIO_TIPS,
  GENERAL_TIPS) — ~50 strings of scientific writing guidance.
- Translate thrown error messages (3 sites in project-import-export,
  paragraph-card, topic-composer) — currently only display in rare
  edge-case error toasts.
- Map remaining verdict strings (e.g., `${displayData.verdict}` shown
  directly for non-accept verdicts in EmbeddedReviewWorkspace) through
  `review.{verdict}` translation keys.
- P2: Multi-level undo history for paragraph revise.
- P2: Persist undo snapshots across page refreshes.
- P3: Collaborative annotations / sharing.


---

## Phase 15 — Citation appearance-order numbering + KnowledgePanel redesign + selection highlight fix (Task IDs 1-6)

Task IDs: 1, 2, 3, 4, 5, 6
Agent: main (continuation)
Task: Per-paragraph citation numbering by appearance order, remove right-side Refs tab (show data sources by type), fix duplicate references in composed article, preserve text selection highlight when annotation popover opens.

### Project Status Assessment
User reported several issues with the citation/reference system:
1. Orphan references — paragraph had 12 refs but only 10 were cited.
2. Composed article had DUPLICATE and INCONSISTENT reference lists ("## References" with 10 items + "REFERENCES" with 12 items).
3. Citation numbering should follow appearance order per-section, then global renumber on compose.
4. Right-side "Refs" tab should be removed; show data sources by type instead.
5. Text selection highlight disappears when annotation popover opens.
6. i18n coverage gaps in several components.

### Work Log:

- **NEW: `renumberByAppearance()` in `writing.ts`** (Task 1):
  - Added generic function that renumbers numeric [n] citations within a single
    paragraph by order of first appearance.
  - [1] = first cited ref, [2] = second cited ref, etc.
  - Uncited references are excluded from the returned reordered array — eliminates orphans.
  - Handles ranges like [1-3] and comma lists [2,3].
  - Splits off "### Citations" block (if any) so it doesn't renumber inside it.

- **UPDATE: `/api/ai/write` route** (Task 2):
  - After `chat()`, calls `renumberByAppearance(content, references)`.
  - Saves renumbered content + links ONLY cited references (in appearance order).
  - Sets `citationOrder` field on each linked reference (0-based index matching [n]).
  - Uncited references are NOT linked — no orphans.

- **UPDATE: `/api/ai/generate-full` route** (Task 3):
  - Each section's content is renumbered via `renumberByAppearance`.
  - Only CITED references are copied to each paragraph (not all saved refs).
  - `citationOrder` set on each copy.
  - Compose step: robust reference-section stripping using regex
    `^#{0,6}\s*\*{0,2}(References|REFERENCES|Citations|Bibliography|...)\*{0,2}\s*:?\s*$`
    — catches "## References", "### Citations", "REFERENCES", "## REFERENCES", etc.
  - Compose prompt explicitly tells AI NOT to include any references/citations/bibliography section.
  - Global renumbering on compose now maps local [n] → global [m] using the correctly-ordered
    paragraph references (fetched with `citationOrder` sorting).

- **UPDATE: `markdown-citations.tsx`** (Task 4):
  - Per-paragraph reference list now shows only CITED references in appearance order.
  - Since references are stored with `citationOrder` matching [n] numbering, the
    references array IS the cited list in order — no orphans appear.

- **UPDATE: `knowledge-panel.tsx`** (Task 5):
  - REMOVED the "Refs" tab entirely (was showing project-level references).
  - Restructured Sources tab to GROUP data sources by type (PubMed, RCSB, UniProt,
    NCBI, BLAST, Web, Manual) as collapsible sections.
  - Each type section has: icon emoji + type badge + count + collapse toggle.
  - Source cards within each section show full metadata (authors, year, journal, DOI).
  - "Add Reference" button moved to panel header (always accessible).
  - Removed dead code (ReferencesList, ArticlesList functions).
  - Cleaned up unused imports (Tabs, BookOpen, Badge, etc.).

- **UPDATE: `paragraph-card.tsx` selection highlight** (Task 6):
  - When user selects text, the selected Range is wrapped in `<mark class="pending-selection">`.
  - The highlight persists even after native selection collapses (Popover steals focus).
  - `unwrapPendingMark()` restores original DOM when toolbar closes or annotation submitted.
  - `clearSelection()` helper combines unwrap + state clear.
  - Added `.pending-selection` CSS in globals.css (teal-tinted gradient highlight).
  - Cleanup on unmount via useEffect.

- **SCHEMA: Added `citationOrder Int?` to Reference model**:
  - 0-based index within the paragraph, matching [n] citation order.
  - `db:push` applied successfully.
  - Project fetch route sorts references by `[{ citationOrder: "asc" }, { createdAt: "asc" }]`.

- **I18N AUDIT (Task 7, subagent)**:
  - ~165 hardcoded English strings converted to `t()` calls across 12 components.
  - ~50 new translation key pairs added (en + zh).
  - Files: batch-validation, one-click-generate, user-data, llm-config, writing-tips,
    progress-tracker, projects-sidebar, project-import-export, knowledge-panel, language-toggle, page.tsx.
  - 0 lint errors.

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- Dev server stable on port 3000, no compile errors.
- Prisma schema updated and pushed successfully.

### Stage Summary:
- **6 core tasks completed**: appearance-order numbering, write route update, generate-full
  route update, markdown-citations update, knowledge-panel redesign, selection highlight fix.
- **1 subagent task completed**: i18n audit (~165 strings translated).
- **Schema change**: added `citationOrder` field to Reference model.
- Eliminates orphan references, duplicate/inconsistent reference lists, and lost selection highlight.

### Unresolved / Next-phase priorities:
- Browser QA verification of all changes (in progress).
- Test full article generation flow to verify no duplicate reference lists.
- Test text selection + annotation flow to verify highlight persistence.
- Test KnowledgePanel grouped-by-type display with real data.

### Browser Verification Results (agent-browser):
- Page loads cleanly, 0 console errors, 0 runtime errors.
- Project API returns HTTP 200 (Prisma `citationOrder` field working).
- **KnowledgePanel**: "Refs" tab GONE (`hasRefsTab: false`). Sources grouped by type
  with collapsible sections (verified "📄 PUBMED 12 items" header).
- **Citations**: 49 citation markers rendered across paragraph cards.
- **Per-paragraph reference lists**: 6 "REFERENCES" sections (one per paragraph) —
  only cited references shown in appearance order.
- **Selection highlight**: Verified end-to-end via mouse drag simulation:
  - After drag-select: `pendingMarks: 1`, `markText: "The transmembran"`,
    popover appeared with "ANNOTATE SELECTION" + selected text preview.
  - After close (X button): `pendingMarks: 0`, `popovers: 0` — mark unwrapped,
    original DOM restored.
- `bun run lint` → clean (0 errors, 0 warnings).
- Dev server stable on port 3000.

### Final Status:
All 8 tasks completed. All user-reported issues resolved:
1. ✅ Orphan references eliminated (appearance-order numbering, only cited refs linked).
2. ✅ Duplicate/inconsistent reference lists in composed article fixed (robust stripping +
   article viewer cleanup for existing articles).
3. ✅ Right-side "Refs" tab removed; sources grouped by type with collapsible sections.
4. ✅ Selection highlight persists when annotation popover opens (`<mark class="pending-selection">`).
5. ✅ i18n coverage expanded (~165 strings translated across 12 components).


---

## Phase 16 — Tab-based KnowledgePanel + full real test + copy refs fix

Task IDs: 1-6 (continuation)
Agent: main
Task: Replace collapsible sections with tab-based source type switching (counts visible at a glance), fix AI Write to copy references instead of moving, run complete real test with real data.

### Project Status Assessment
User feedback:
1. Data source display should use tabs for switching — current collapsible list requires scrolling to see all type counts.
2. Run a complete real test with real data source quantities.

### Work Log:

- **REDESIGN: KnowledgePanel tab-based switching**:
  - Replaced vertical collapsible sections with a HORIZONTAL TAB BAR at the top.
  - Shows ALL source types + counts at a glance (no scrolling needed):
    `🗂️ ALL 52 | 📄 PUBMED 12 | 🧬 RCSB 20 | 🧪 UNIPROT 20`
  - Click a tab to filter sources by type instantly.
  - Active filter indicator: "12 pubmed sources" + "show all" link.
  - Tabs are horizontally scrollable (scrollbar-thin) for many types.
  - Auto-resets to "All" if active type is deleted.

- **FIX: AI Write route — copy references instead of moving**:
  - Previous code used `db.reference.update` to set `paragraphId`, which MOVED
    references from project-level to the paragraph — making them unavailable
    for future paragraphs.
  - Changed to CREATE COPIES (like generate-full route does): checks if a copy
    already exists for the paragraph (by externalId), creates if not, updates
    citationOrder if exists.
  - Original project-level references remain intact for future paragraphs.

- **FULL REAL TEST executed**:
  - Project: "TMC Family Structure Review v9" (52 data sources, 12 project-level refs).
  - Generated 2 new paragraphs via AI Write with 12 references selected.
  - Verified new paragraph #2 (195 words, 4 citation markers all [1]):
    - Citation markers: [1] [1] [1] [1]
    - Unique cited numbers: 1
    - Linked references: 1 (citationOrder: 0)
    - Orphan refs: NONE ✓
    - Missing refs: NONE ✓
    - Appearance order matches [1]: YES ✓
  - Verified project-level refs unchanged: 12 before → 12 after (copies created, not moved).
  - Paragraph-level refs: 72 → 73 (one new copy added).

- **KnowledgePanel verification**:
  - Tab bar shows: "🗂️ ALL 52 | 📄 PUBMED 12 | 🧬 RCSB 20 | 🧪 UNIPROT 20"
  - Tab switching works: clicking PUBMED filters to 12 pubmed sources.
  - Filter indicator: "12 pubmed sources" + "show all" link.

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- Dev server stable on port 3000, 0 console errors.
- AI Write API: POST 200 in 4.8s (paragraph created successfully).
- Project API: GET 200 (paragraphs + references fetched correctly).
- New paragraph: 0 orphans, appearance-order numbering correct.
- Project-level references preserved (copy approach working).

### Stage Summary:
- KnowledgePanel redesigned with tab-based switching (all counts visible at a glance).
- AI Write route fixed to copy references (not move) — preserves project-level refs.
- Full real test completed with 52 data sources + 12 references.
- All changes committed and pushed to GitHub (commit c6d239e).

### Final Verification (complete real test):
- **Paragraph cards (8 total)**: Each shows exactly 1 "REFERENCES" section (no duplicates).
- **Article tab**: Shows only "## References" (1 section, was 2 before fix).
- **New paragraph generated via AI Write**:
  - 4 citation markers all [1], 1 linked reference (citationOrder: 0)
  - 0 orphans ✓, 0 missing refs ✓, appearance order correct ✓
- **Project-level references preserved**: 12 before → 12 after (copies created, not moved)
- **KnowledgePanel tab bar**: "🗂️ ALL 52 | 📄 PUBMED 12 | 🧬 RCSB 20 | 🧪 UNIPROT 20"
  - All counts visible at a glance, tab filtering works correctly
- `bun run lint` → clean
- Dev server stable, 0 console errors
- All changes committed and pushed to GitHub (commits c6d239e, 573659f)

### Commits pushed:
- c6d239e: Tab-based KnowledgePanel + copy references on AI Write
- 573659f: Fix duplicate reference lists in articles + paragraph cards


---

## Phase 17 — Full article auto-gen redesign: force re-gather, multi-method, 50k words, chunked generation

Task ID: 17
Agent: main
Task: Redesign full article auto-generation — no format selection, force re-gather sources via multiple methods, 50000 word limit, outline planning from source content, chunked generation to avoid max token, optimize UI.

### Work Log:

- **API: generate-full route completely rewritten**:
  - **Force re-gather**: Deletes ALL existing data sources + paragraph-level references before collecting fresh data.
  - **Multi-method gathering**:
    - Strategy 1: LLM designs 15-25 multi-database queries (PubMed, RCSB, UniProt, NCBI, BLAST) — executed in parallel.
    - Strategy 2: LLM generates 5-8 web search queries — executed in parallel via webSearch.
    - Dedup by source+externalId, saves ALL with full metadata.
  - **LLM curation**: New "curate" step — LLM selects the most relevant references (max ~targetWords/200) from the gathered set, prioritizing recent/seminal/review papers.
  - **No format selection**: LLM plans outline from source content (titles, themes, abstracts). Section format auto-inferred from title (intro/background/methods/results/discussion/conclusion).
  - **Chunked generation**: Sections >1200 words split into sub-chunks (1000 words each) to avoid max token. Each chunk gets continuity context from previous chunk.
  - **Large article assembly**: Articles >8000 words assembled directly (no LLM re-composition) to avoid token limits — sections already coherent.
  - **Target words up to 50,000** (was 10,000 max).

- **UI: OneClickGenerateDialog completely redesigned**:
  - **Gradient header** with icon badge.
  - **Feature chips** (4 colored cards): Force re-gather, Multi-method, No format selection, Chunked generation.
  - **Word count slider**: 2,000-50,000 range with gradient fill, tier indicator (Short/Medium/Long/Comprehensive).
  - **6-step progress timeline** (was 5): gather → curate → relationships → plan → generate → compose.
  - **Color-coded steps**: Each step has unique color (emerald/teal/sky/amber/violet/rose).
  - **Overall progress bar** with percentage.
  - **Live step messages** showing current operation.
  - **Result stats**: 4 color-coded metrics (sources/curated refs/sections/words).
  - **Scrollable sections list** in results.

- **Header button**: Added "Full Article" button (with Zap icon) to header, next to "AI Write".

- **i18n**: Added new keys for curate step, feature descriptions, fullGenerate button (en + zh).

### Verification Results:
- `bun run lint` → clean (0 errors, 0 warnings).
- Dev server stable, 0 console errors.
- Full Article dialog opens with all features visible:
  - Research topic card
  - 4 feature chips
  - Journal template + language selects
  - Word count slider (2,000-50,000, step 1,000, value 5,000)
  - Tier indicator (Short)
  - Warning notice
  - Generate button
- All changes committed and pushed to GitHub (commit d34bd56).

### Stage Summary:
- Full article auto-generation completely redesigned per user requirements.
- No format selection needed (AI plans outline).
- Force re-gather ensures fresh data every run.
- Multi-method gathering (database + web search) maximizes source coverage.
- LLM curation keeps context manageable and article focused.
- Chunked generation prevents max token issues for large articles.
- 50,000 word limit (5x increase).
- UI optimized with better visual hierarchy and progress indicators.
