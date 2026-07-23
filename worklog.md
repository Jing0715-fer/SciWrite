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
