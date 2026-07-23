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

