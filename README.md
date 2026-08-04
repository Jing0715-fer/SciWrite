# SciWrite — AI Research Literature Writing Assistant

> AI-powered scholarly writing platform with citation-grade drafting, multi-database source gathering, LLM session continuity, and structured peer review.

[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Tailwind CSS 4](https://img.shields.io/badge/Tailwind-4-38bdf8?logo=tailwindcss)](https://tailwindcss.com/)
[![Prisma](https://img.shields.io/badge/Prisma-6-2d3748?logo=prisma)](https://www.prisma.io/)

---

## ✨ Overview

SciWrite helps researchers write publication-ready review articles backed by real scientific data sources. It integrates live database queries (RCSB PDB, UniProt, PubMed, NCBI Gene, NCBI BLAST), AI-assisted drafting with inline citations, structured peer review, and one-click full-article generation — all within a single cohesive workspace.

### Core Philosophy
- **No fabricated citations** — every `[n]` marker resolves to a real, gathered source
- **Session continuity** — all LLM tasks within a project share conversation context
- **Appearance-order numbering** — citations numbered by first appearance, no orphans
- **Multi-method gathering** — database queries + web search for maximum source coverage

---

## 🚀 Key Features

### 1. Multi-Database Source Gathering
- Query **PubMed** (papers), **RCSB PDB** (structures), **UniProt** (proteins), **NCBI Gene**, **NCBI BLAST** (sequences)
- AI designs 15–25 multi-database queries based on your research topic
- Supplementary **web search** (5–8 queries) for reviews, preprints, news
- LLM **curates** the most relevant sources (recent/seminal/review prioritized)
- All sources saved with full metadata (authors, journal, year, DOI, abstract)

### 2. AI Writing Hub (Unified)
A single dialog with 5 tabs consolidating all AI writing tools:

| Tab | Function |
|-----|----------|
| **Outline** | Generate structured paragraph plan from your topic |
| **Gather** | AI-organized multi-database search with adversarial critique |
| **Paragraph** | Draft citation-backed scholarly paragraph |
| **Compose** | Arrange paragraphs into a coherent research article |
| **Full Article** | One-click generation: gather → curate → plan → generate → compose |

### 3. Full Article Auto-Generation
- **Force re-gather**: clears existing sources, collects fresh data every run
- **Multi-method**: database queries (15–25) + web searches (5–8) in parallel
- **LLM curation**: selects most relevant references for the article scope
- **Outline planning**: LLM designs section structure from source content
- **Chunked generation**: sections >1,200 words split into sub-chunks to avoid max token
- **Large article assembly**: articles >8,000 words assembled directly (no LLM re-composition)
- **Target word count up to 50,000 words**
- **6-step real-time progress timeline**: gather → curate → relationships → plan → generate → compose

### 4. Citation System
- Numeric `[n]` citations numbered by **order of first appearance** per section
- **No orphan references** — uncited sources excluded from the reference list
- **Global renumbering** on article composition (deduplicated, sequential)
- Hover cards show reference metadata (title, authors, journal, year, DOI, link)
- Citation validation: detect missing/orphaned citations, AI auto-fix

### 5. LLM Session Manager
- All LLM tasks within a project share **conversation context**
- Prior messages loaded as context preamble before each LLM call
- Token-budget aware (max 8,000 tokens context, trims oldest messages)
- Tasks connect coherently: gather → curate → plan → generate → compose → review
- Conversation history persisted in DB (`ConversationSession` model)

### 6. Annotation & Revision
- **Text selection → annotate**: drag-select text, add comment/type/severity
- Selection highlight **persists** when annotation popover opens
- **AI revise**: address annotations, follow instructions, or polish
- **Diff view**: compare before/after revision
- **Undo**: revert to pre-revision content

### 7. AI Peer Review
- Multi-dimensional scoring: novelty, significance, clarity, methodology, citations, overall
- Verdict: accept / minor revision / major revision / reject
- Strengths, weaknesses, revision suggestions (per-section issue → fix)
- **Auto-iterate**: run N rounds of review + revision automatically

### 8. Source Relationship Analysis
- LLM analyzes thematic clusters, key connections, contradictions between sources
- Relationship network visualization
- Context used to write deeper, more connected discussion

### 9. Knowledge Panel
- **Tab-based source browser** grouped by type (PubMed, RCSB, UniProt, NCBI, etc.)
- All type counts visible at a glance: `🗂️ ALL 53 | 📄 PUBMED 10 | 🧬 RCSB 10 | 🧪 UNIPROT 20`
- One-click filtering by source type
- Deep-read: fetch full page content & AI-summarize for any source URL
- Manual reference add (PMID/DOI lookup via NCBI E-utilities + CrossRef)

### 10. Export & Templates
- **Export formats**: Word (.docx), PDF, Markdown
- **Journal templates**: Nature, Cell, Science, JBC, PLOS, IEEE, Generic
- Project backup/restore (JSON export/import)

### 11. Project Insights Dashboard
- Stat cards: paragraphs, words, citations, articles
- Citation coverage progress bar
- Annotation status (resolved/unresolved)
- Distribution charts: status, format, source types, reference types
- Writing timeline
- Batch citation audit across all paragraphs

### 12. UX Features
- **Bilingual i18n**: English + 中文 (full UI translation)
- **Dark mode** with next-themes
- **Command palette** (⌘K) with keyboard shortcuts
- **Drag-to-reorder** paragraphs (@dnd-kit/sortable)
- **Responsive** 3-panel resizable layout
- **Sticky footer** with command palette shortcut

---

## 🏗️ Architecture

### Tech Stack
| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS 4 + shadcn/ui (New York) |
| Database | Prisma ORM + SQLite |
| AI | z-ai-web-dev-sdk (LLM, web_search, page_reader) |
| State | TanStack React Query + React hooks |
| Real-time | Server-Sent Events (SSE) for streaming generation |
| Icons | Lucide React |

### Database Schema (10 models)
```
Project ──┬── Paragraph ──┬── Annotation
          │               └── Reference (citationOrder)
          ├── DataSource
          ├── Reference (project-level)
          ├── Article ──── ArticleParagraph ─── Paragraph
          │              └── Review
          ├── UserData
          ├── RelationshipAnalysis
          └── ConversationSession (LLM session history)
```

### Project Structure
```
src/
├── app/
│   ├── page.tsx                    # Single-page app (3-panel layout)
│   ├── api/
│   │   ├── ai/                     # AI routes (write, compose, review, gather, outline, generate-full, source-relationships)
│   │   ├── projects/[id]/          # Project CRUD + validate-citations + export/import
│   │   ├── paragraphs/[id]/        # Paragraph CRUD + revise + annotate + auto-fix-citations
│   │   ├── databases/              # Multi-database query proxy
│   │   └── articles/               # Article CRUD
│   └── globals.css                 # Custom styles (citations, annotations, paper texture)
├── components/sciwrite/            # All domain components
├── lib/
│   ├── ai.ts                       # z-ai-web-dev-sdk wrapper (chat, webSearch, readPage)
│   ├── llm-session.ts              # LLM session manager (context sharing)
│   ├── writing.ts                  # Writing prompts, citation renumbering, content cleaning
│   ├── databases.ts                # PubMed/UniProt/RCSB/NCBI/BLAST query functions
│   ├── i18n.tsx                    # Bilingual translations (en + zh)
│   ├── journal-templates.ts        # Journal formatting templates
│   └── db.ts                       # Prisma client
└── prisma/schema.prisma            # Database schema
```

---

## 📦 Installation & Setup

### Prerequisites
- Node.js 18+ / Bun
- SQLite (bundled, no external DB needed)

### Install
```bash
bun install
```

### Database Setup
```bash
bun run db:push    # Create SQLite DB + apply schema
bun run db:generate # Generate Prisma client
```

### Development
```bash
bun run dev        # Start dev server on http://localhost:3000
```

### Build
```bash
bun run build      # Production build
bun run start      # Start production server
```

### Lint
```bash
bun run lint       # ESLint check
```

---

## 🎯 Usage Guide

### 1. Create a Project
- Click **"New"** in the Projects sidebar
- Enter project title, research topic, and field

### 2. Gather Sources
- Click **AI Hub** → **Gather** tab
- AI designs multi-database queries and gathers sources
- Or manually query databases via the right-panel Database Query section

### 3. Write Paragraphs
- Click **AI Hub** → **Paragraph** tab
- Select format (background/intro/methods/results/discussion/conclusion)
- Select scenario (literature-review/protein-structure/sequence-analysis/mechanism/comparative/clinical)
- AI drafts a citation-backed paragraph using gathered sources

### 4. Annotate & Revise
- Drag-select text in any paragraph → annotation popover appears
- Add comment, type (revise-request/comment/question/highlight/praise), severity
- Click **AI Revise** to address annotations, follow instructions, or polish
- Use **Compare** to view diff, **Undo** to revert

### 5. Generate Full Article
- Click **AI Hub** → **Full Article** tab
- Set target word count (2,000–50,000)
- Click **Generate full article**
- Watch the 6-step progress timeline in real-time

### 6. Review & Compose
- Compose: AI stitches paragraphs into a coherent article
- Review: AI peer-review with multi-dimensional scoring
- Auto-iterate: run review + revision rounds automatically

### 7. Export
- Click **Export** on any paragraph or article
- Choose format: Word / PDF / Markdown
- Choose journal template if needed

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `⌘/Ctrl + K` | Open command palette |
| `N` | New paragraph (AI Hub → Paragraph) |
| `G` | Gather sources (AI Hub → Gather) |
| `O` | Generate outline (AI Hub → Outline) |
| `C` | Compose article (AI Hub → Compose) |
| `F` | Full article generation (AI Hub → Full Article) |
| `I` | Open Insights |
| `D` | Toggle dark mode |

*Shortcuts disabled when typing in inputs/textareas.*

---

## 🔧 Configuration

### LLM Configuration
- Click the CPU icon in the header to open LLM config
- Uses `z-ai-web-dev-sdk` (GLM model) by default
- No API key needed (SDK handles authentication)

### Environment Variables
```env
DATABASE_URL="file:./db/custom.db"  # SQLite database path
```

---

## 🧪 Testing & QA

### E2E Test Coverage (agent-browser)
- ✅ Page loads cleanly (HTTP 200, 0 runtime errors)
- ✅ Project selection + workspace rendering
- ✅ AI Hub dialog (5 tabs)
- ✅ Full Article generation (6-step progress)
- ✅ KnowledgePanel source type tabs
- ✅ Insights dialog (scroll, no overflow)
- ✅ Language toggle (EN ↔ ZH)
- ✅ Citation markers render
- ✅ Footer sticky positioning

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

## 🤝 Contributing

This project is developed as a research writing assistant. Issues and pull requests welcome at the [GitHub repository](https://github.com/Jing0715-fer/SciWrite).

---

**SciWrite** — AI-powered · citation-grade · multi-database · session-aware
