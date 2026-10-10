# SciWrite Agent Layer — Skill Standardization (RT5, 2026-10-10)

Answering the architecture question "does the agent layer have a skill-like
mechanism?" — before RT5: NO. The audit found 64 LLM call-sites across 31
files with a "half-abstraction": parsing (llm-json) and format functions
(writing.ts) were shared, but prompts (inline templates), validation
(per-site field checks), degradation (per-site try/catch), telemetry (154
scattered console.log) and naming (THREE parallel vocabularies:
taskType / metadata.step / SSE step) were all hand-rolled per site — with
v1/v2 dual pipelines duplicating plan/generate/translate.

## 1. What RT5 built (this session)

| Piece | File | Role |
| ----- | ---- | ---- |
| **Skill types** | `src/lib/skill/types.ts` | `SkillDefinition<I,O>`: id / taskType / sseStep (the three legacy names unified on ONE definition) + buildPrompt / parse / postProcess / validate / fallback / chat slots |
| **Executor** | `src/lib/skill/executor.ts` | THE one copy of the skeleton: cache-key → cache-hit replay → chatWithSession → shared robust parse → postProcess → validation ("fatal:" escalates) → fallback → structured telemetry envelope. chatOverrides per invocation; injected scoped logger |
| **Registry** | `src/lib/skill/registry.ts` | Declarative skill catalog; first entry: `score` (prompt contract + per-item fill + batch mechanical fallback, migrated VERBATIM from citation-planner) |
| **Format contract** | `src/lib/skill/format-contract.ts` | ARTICLE_FORMAT_RULES (the fixed output-format requirements, 6 documented rules) + ordered gate chain (sanitize → citation-keys → uniform-section → cjk-residual) via `applyFormatContract()` — registry order is enforced, callers may subset but never reorder; language "zh" skips english-only gates |
| **Step constants** | `src/lib/skill/steps.ts` | Single source of truth for the SSE step namespace (client-safe); kills the FOUR drifted copies (server inline literals + 3 client sets — topic-composer's stale "Step n/9" v1 subset FIXED) |
| **Scoring kernel** | `src/lib/scoring.ts` | Pure scoring functions extracted from citation-planner (breaks the registry↔planner cycle); re-exported from citation-planner for zero-change compatibility |

### Migrations landed (pattern proofs for the three copy-paste families)

- **A-family (cache→chat→parse→mechanical-fallback triplets)**: `score` now
  runs through `runSkill` — scoreSources keeps only the batch/pool
  orchestration. Behavior-identical (llmBatches/fallbackBatches counters,
  per-item mechanical fill, session rows).
- **C-family (per-exit hand-assembled format gate sequences)**: v2's
  generate enforce-tail and translate post-processing now call
  `applyFormatContract` with the FIXED order (was: two hand-assembled
  sequences with order/subset drift; ~8 more exits remain, see backlog).
- **Client drift**: topic-composer progress now derives from
  V2_MAIN_SEQUENCE (14 v2 steps) instead of the stale 9-step v1 map.

### Output-document fixed format (the user-facing contract)

Every article-text exit expresses its requirements through
`applyFormatContract`, which documents and enforces: one `## Title` head +
2-4 prose paragraphs per section (no lists/tables/internal headings);
numeric [n] citation markers with near-miss key normalization; no protocol
residue; no CJK in English text; no residual keys; balanced bold; the rules
are machine-readable (ARTICLE_FORMAT_RULES) and injectable into prompts.

## 2. QA results (all green)

| Suite | Result |
| ----- | ------ |
| Unit | **243 / 243** (211 prior + 32 new: steps/contract/registry 21, executor I/O paths 11 with mocked llm-session/cache) |
| Integration (live dev server) | **26 / 26** |
| ESLint | 0 errors (187 warnings) |
| tsc --noEmit | 4 pre-existing baseline errors, 0 new |
| Browser | home renders, 0 console errors (shots/rt5-home.png) |
| **Live skill smoke** (real project, 1 LLM call) | score skill end-to-end through the executor: 4/4 refs scored (rel 8-9, core tiers), contract checks pass (sequential indexes, valid ranges, count), session row carries the UNIFIED metadata `{step:"score", skill:"score", batch, total, refs}` — SKILL_SMOKE_PASS |

Contract tests pinned the subtle behaviors: sanitize strips only a LEADING
role-label line (mid-text "User:" in prose is legitimate); the format chain
cannot be reordered by callers; zh skips english-only gates; fatal-prefixed
validation issues escalate to fallback while advisory ones are recorded.

## 3. Migration backlog (RT6, ~40 call-sites → ~15-18 skills, ranked)

1. **A-family remainder**: `curate` + `curate-smart` (generate-full-helpers
   :415-432, citation-planner :449-458) — line-by-line isomorphic with the
   migrated score pattern; mechanical, low risk.
2. **B-family (STRICT-JSON reviewers)**: review-engine (:202/:514/:643),
   fact-check (:367), evidence-pipeline (:148/:299) — same skeleton plus
   field-whitelist normalization; pooled fact-check keeps its pool at the
   orchestration layer.
3. **C-family remainder**: v1 generate/compose/translate exits, v2 compose
   (:3184 — needs a `section-markdown` gate or keep its prelude), write/
   regenerate/revise/retranslate routes — each becomes one
   applyFormatContract call.
4. **plan / generate / verify / review v1+v2 merge**: the biggest win —
   each stage currently exists twice; one skill definition per stage, with
   the v2 pipeline as the only orchestrator.
5. **SSE step literals → PIPELINE_STEPS constants** in v2 route send()
   calls (~60 inline strings) and the i18n timeline labels.
6. **gather-coverage / knowledge / gap agent skills** — they carry
   non-JSON outputs and multi-turn semantics; needs a "prose skill" parse
   slot + coverage-decision hooks (extends the executor, do NOT bypass it).

### Rules for migration (so the framework doesn't rot)

- A skill is the ONLY place its prompt text lives; prompt edits happen in
  registry.ts, never at call-sites.
- Every skill MUST declare fallback semantics (mechanical or explicit
  hard-fail) — degraded results are flagged, never silent.
- Telemetry rides the SkillTelemetry envelope; no new console.log at
  call-sites.
- Article-text outputs go through applyFormatContract; adding a gate means
  editing FORMAT_GATES (registry order), never a per-exit sequence.
