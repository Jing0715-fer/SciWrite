# SciWrite RT9 — Label Unification, Stateless Review, Context Telemetry, Route Decomposition Waves 1-3 (2026-10-12)

RT9 executes the RT8 backlog (IMPROVEMENT_PLAN-RT8 §6, items 1, 3, 4, 5, 6):
the i18n label unification, the v2 route decomposition (first three seams
of the audit-ranked plan), the `review` taskType stateless flip, the
session-context cost telemetry, and the timeline skills-invoked tiles.
Backlog item #2 (production-build smoke path) is an environment-constrained
NO-GO this round — see §5.

## 1. What RT9 changed

### A. i18n label unification (RT8 backlog #1)

The repo carried three parallel step-label sets: `oneClick.stepXxx`
(dialog stepper, 14 keys × 2 locales), `timeline.step.xxx` (run timeline,
20 keys × 2), and `STEP_TITLES` (steps.ts, test-only). RT8 removed the
last v1 consumer of the oneClick set, so the merge surface was minimal:

- New `src/lib/skill/step-labels.ts` — `STEP_LABEL_KEYS` is now the ONLY
  place a step wire-name maps to an i18n key. `Record<PipelineStep,
  TranslationKey>` keeps it exhaustive against `PIPELINE_STEPS` (a new
  STEP without a label fails tsc; a deleted key fails the TranslationKey
  type). Type-only `TranslationKey` import keeps the module client-safe.
- `run-timeline-dialog.tsx` and `unified-writing-dialog.tsx` both derive
  labels from the shared map; the dialog's `t(key) || "English fallback"`
  chains are gone (the type guarantees the key exists).
- 28 dead `oneClick.step*` dictionary lines deleted (en+zh). The stepper
  now shows the imperative timeline wording ("Gather sources" instead of
  "Gathering data sources") — one wording style across the whole UI.
- 4 new i18n tests pin: map exhaustiveness over PIPELINE_STEPS, every
  mapped key exists in both dictionaries, V2_MAIN_SEQUENCE steps all map
  to timeline.step.*, and no oneClick.step* keys remain.

### B. `review` taskType stateless (RT8 backlog #4)

RT8 flipped the verify family stateless and explicitly gated the review
family on "next E2E shows no verdict drift" — the RT8 E2E provided that
evidence (28 checks, 0 removed, 8 flagged, adjudication behavior
unchanged). RT9 flips it:

- `STATELESS_TASK_TYPES` now includes `review` — covering fact-check ×8,
  review ×2, coherence-review ×2 per run (~12 × 20-row findMany
  deserializations removed). All three skills' prompts are fully
  self-contained (claim+metadata / article+weaknesses / full sections).
- `revise` stays context-loaded BY DESIGN (generation-side; the data
  covers verdict passes only) — documented in the set's comment block.
- RT9's E2E re-verifies verdict behavior post-flip (citations
  checked/removed/flagged vs the RT8 baseline).

### C. Session-context cost telemetry (RT8 backlog #5)

- New `src/lib/session-context-stats.ts` — observer-only, in-process
  aggregate mirroring the skill telemetry collector: per-taskType
  {calls, totalChars, maxChars}, reset by the route at pipeline start.
- `llm-session.ts` records the ASSEMBLED prompt size (context preamble +
  task prompt + ASSISTANT suffix — what the provider actually receives)
  right after `assembleFinalPrompt` in both `chatWithSession` and
  `chatWithSessionStream`. Chars, not bytes: the 28K context budget is
  char-based.
- The complete-event stats block gains `sessionContext` — the next
  context-budget decision (shrink the 28K cap? which taskType actually
  consumes it? stateless vs loaded prompt cost) is data-driven.
- Stateless calls record their self-contained prompt size too, so the
  two families are comparable per taskType.

### D. Timeline skills-invoked + cache-hits tiles (RT8 backlog #6)

- `skillCalls` rode the stats payload since RT7 with zero UI consumers;
  `skillCacheHits` existed in the collector but never reached the
  payload. Both now render as MiniStat tiles (10-tile 2×5 grid) — the
  12-of-15 skill coverage of a run is visible without opening the JSON.
- Old runs without the fields show "—" (non-breaking replay).
- Browser-verified on real RT8 run data (see §3).

### E. Route decomposition, seams 1-3 (RT8 backlog #3)

A full call-graph audit of the 5,439-line v2 POST ranked six extraction
seams by risk. RT9 executes the first three — **5,439 → 4,680 lines
(-14%)**, with the route's zero-direct-test-coverage problem addressed
where the extraction makes logic unit-testable:

| Seam | What moved | Where | Risk | Tests |
| ---- | ---------- | ----- | ---- | ----- |
| 1 | `adversarialVerifySection` + VerifyCheck/VerifySectionResult (STEP 7 machinery, ~200 lines) | `src/lib/adversarial-verify.ts` | lowest (already module-level, no closure deps) | behavior contract preserved verbatim; consumer probe live |
| 2 | compose pure transforms: local→global renumber + adjacent-merge, OOR strip, orphan filter+remap, ref-list builders (EN+ZH duplicates collapsed to one), translate citation-drift extractor (~180 lines) | `src/lib/compose-transforms.ts` | low (string/array in-out; counters RETURNED so stats stay caller-owned) | **26 new unit tests** — the compose mechanical core was previously untested; two load-bearing quirks pinned (see below) |
| 3 | gather stage: query design (LLM+fallback), parallel DB execution, web-search supplement, dedup+sort, coverage-driven top-up, save pool (~465 lines) | `src/lib/orchestrator/gather-stage.ts` | low-medium (ctx-parameterized; SSE/db/arrays injected) | E2E (the stage is DB+LLM-bound, not unit-testable) |

**Preserved by design (the audit's "do not touch" list):**
- The crash-rollback preamble (snapshot + force-clear + clearSession +
  clearLLMCache) stays INLINE in the route — the catch handler must see
  `snapshot`/`hadPriorWork` even when a later gather line throws.
  Hoisting that assignment into the stage module would break rollback
  on mid-stage failure.
- All events ride the caller's `send()` (progress-tracker + recorder
  stay authoritative — nothing touches rawSend).
- Abort/disconnect probes pass as GETTERS (mid-stage flips observed at
  the exact points the inline code observed them, not frozen at entry).
- `savedDataSources`/`savedReferences` stay route-hoisted; the stage
  pushes into them (the later knowledge/gap stages and the complete
  stats read the same arrays).

**Quirks pinned by the new compose-transforms tests (documented, not
"fixed" — a future change must consciously decide):** the global-marker
regex admits `[1 3]` (space-separated) but the inner parser splits on
commas/semicolons only, so such a marker contributes only its FIRST
number (parseInt leading-digit semantics). Faithful to the route's
original scan; flagged for an RT10 decision.

**Seams 4-6 (deliberately deferred to RT10, audit-ranked):**
knowledge/score/curate/tier/fulltext (medium), repair/polish loops
(medium-high — the articleContent/globalRefs/renumberedContents
re-sync contract), generate loop (highest — pendingVerify pipeline,
digest, OOM pruning, resume skip).

## 2. QA results

| Suite | RT8 baseline | RT9 |
| ----- | ------------ | --- |
| Unit | 328/328 | **364/364** (+36: compose-transforms 26 / i18n step-labels 4 / session-context-stats 5 / stateless-review 1) |
| Integration (live :3001) | 26/26 | **26/26** |
| ESLint | 0 errors / 187 warnings | **0 errors / 187 warnings** |
| tsc --noEmit | 4 baseline errors | **4 baseline errors, 0 new** |
| Route probes (live) | v1 delegation 400 | v2 empty-body 400 + v1 delegation 400 (the heavily-edited route compiles and serves; delegation intact) |

Dev-server incident during QA (fixed): the :3001 server had died
silently mid-session (no OOM trace available; kernel log access
denied). Restarted with the RT8 1536MB heap cap — first attempt hit the
RT2-era DATABASE_URL trap (shell env created an empty `SciWrite/db/
custom.db`); the real database is `/home/z/my-project/db/custom.db`
(4.2MB). The stray empty file was removed and the server relaunched on
the correct path; all subsequent QA green on the real data.

## 3. Browser verification (agent-browser, live server)

- Home renders with **0 console/page errors** (shots/rt9-home.png).
- Run-timeline expanded card on the REAL RT8 run: **10-tile grid
  renders including the new SKILL CALLS (19) and CACHE HITS (—) tiles**
  — the em-dash is the designed old-run fallback (skillCacheHits first
  shipped in RT9); the RT8 skillDegraded badge row (score×8) still
  renders alongside (shots/rt9-timeline-tiles.png).
- Full-Article dialog: the old "Gathering data sources" wording is GONE
  from the DOM (label derivation now goes through STEP_LABEL_KEYS);
  TranslationKey typing + the 4 i18n tests pin the rest of the key set.
- Mobile 390px: `scrollWidth = 390` — no horizontal overflow
  (shots/rt9-mobile.png).

## 4. E2E full generation (1500 words)

**PASS — see the E2E-RESULTS appendix.** The manual launch at 14:26Z
fast-failed on the pre-flight 503 (storm #5: the local abort flag had
expired ten seconds earlier, but the provider-side account quota was
still exhausted — the same RT3/RT8 account-level outage class, not a
code defect; the guard did exactly its job: 348ms, no state consumed).
`scripts/rt9-e2e-runner.ts` rode out storms #5/#6 (~2h) and fired
`full-generation-test.ts --base :3001 --words 1500` automatically in the
first clean window (16:28Z); the report landed in
`tool-results/full-gen-test-report.json`.

What this E2E validates beyond the standard audit (decomposition
regression coverage):
- the extracted gather stage drives the real pipeline end-to-end
  (events, coverage top-up, save pool, junk guard);
- the compose-transforms renumber/OOR/orphan chain produces the same
  mechanical-audit results (0 CJK / 0 lists / 0 residual keys / ** balance
  / refs 1:1) as the inline code did;
- the review-stateless flip produces RT8-comparable verdicts
  (citations checked/removed/flagged, repair-round findings);
- the new stats fields (skillCacheHits, sessionContext) ride the
  complete event;
- the memory ceiling still holds (1536MB cap, per-section watermarks).

## 5. Data-driven NO-GOs and deferrals

- **RT8 backlog #2 (production-build smoke E2E leg) — environment-
  constrained NO-GO.** The sandbox policy forbids production builds
  (`next build`), and the 4GB box already hosts two dev servers. The
  memory-ceiling work targets the dev runtime; the production profile
  stays unvalidated until a build-permitted environment exists.
  Re-ranked into the RT10 backlog as "first build-permitted round".
- **Seams 4-6 of the route decomposition** — deferred with the audit's
  risk ranking and the seam-3 ctx pattern as the template. The generate
  loop (seam 6) is the last and needs its own SSE-timing regression
  harness first.

## 6. RT10 backlog (ranked)

1. **Route decomposition seams 4-5** (knowledge/score/curate/tier/
   fulltext as one sources-pipeline module; repair + polish loops with
   an explicit mutable {articleContent, globalRefs, renumberedContents}
   context) — the seam-3 GatherStageCtx pattern is the template; the
   route is at 4,680 lines.
2. **SSE event-sequence regression harness for the v2 route** — a
   scripted full-pipeline replay (recorded SSE stream → assert event
   order/shape) so seam 6 (the generate loop) and future refactors
   have a contract test that doesn't burn LLM quota. This is the
   prerequisite for touching the loop.
3. **`[1 3]` space-marker decision** (the pinned quirk): expand
   space-separated markers in expandCitationNumbers or keep
   first-number semantics — either way, one line + the existing test
   flip, but it changes what counts as "cited" for orphan filtering.
4. **adversarial-review route dedup onto @/lib/adversarial-verify** —
   the standalone route still carries a sibling implementation (its
   RT8 rework diverged: DB projection, batch-20). Unify behind the
   shared module with the projection as an option.
5. **`revise` taskType stateless evaluation** — if RT9's E2E confirms
   the review-family flip clean, the same evidence template applies to
   the revision/coherence-edit skills (self-contained prompts too).
6. **Production-build smoke E2E leg** (rolled from RT9 §5) — first
   build-permitted environment validates the prod memory profile and
   the standalone `next start` path.
7. **Context-budget decision from the new sessionContext data** — once
   2-3 clean E2E runs accumulate per-taskType prompt-size stats, decide
   whether SESSION_MAX_TOTAL_CHARS (28K) shrinks or the preamble
   construction changes.

### Migration rules (unchanged from RT5-RT8, enforced by review)

- A skill is the ONLY place its prompt text lives.
- Every skill MUST declare fallback semantics — degraded results are
  flagged, never silent.
- Telemetry rides the SkillTelemetry / stats envelope; no new
  console.log at call-sites.
- Article-text outputs go through applyFormatContract OR the documented
  chunked combinator — adding a gate means editing FORMAT_GATES, never
  a per-exit sequence.

## E2E-RESULTS (appendix — filled from tool-results/full-gen-test-report.json)

**PASS — 32.99 min (1,979s), 106 stage events, ZERO degraded skills
(`skillDegraded: {}` — the cleanest full-pipeline run on record; RT8's
comparable run degraded score×8 + curate-smart×1 through a mid-run
storm).** Fired automatically by the armed runner at 16:28Z after riding
out storms #5/#6 (account-level 429, ~2h); dev server survived the full
cycle on the 1536MB heap cap.

- **Decomposition regression: NONE.** The extracted gather stage drove the
  real pipeline (10 queries → 199 sources → 157 refs saved; coverage
  check: 12/12 facets covered → top-up correctly skipped at ratio 1.0);
  the compose-transforms chain produced the same mechanical-audit
  results as the inline code ever did — **0 blocking errors, 0 orphans**,
  10 topicality warnings; 37 citation markers ↔ 14/14 listed references.
- **Article**: 2,502 words composed / 1,472 EN body words (98% of the
  1,500 target), 6 sections, 8 full texts used, 26 curated → 14 final
  references; `citationPlanLLMDriven: true` (clean window — the LLM
  citation map ran, unlike RT8's mechanical fallback).
- **Review-stateless flip verdict check (the RT8 backlog #4 gate)**:
  in-pipeline adversarial verify **27 checked / 1 removed / 2 flagged**;
  the removal applied with clean renumbering (removed cite #6,
  "reference focuses on off-target effects, not conformational
  dynamics"). RT8 baseline was 28/0/8 in a storm-degraded window — the
  verdict MACHINERY is unchanged (removal threshold behavior, flag
  classes, contradiction guard all firing normally); the count deltas
  track article content, not the context-loading change. Repair loop
  converged in 3 rounds (2 scoped revisions, final verdict
  minor-revision overall 6/10, stop reason "review clean — no actionable
  findings"); numeric sweep 23 sentences / 22 covered / 1 advisory gap;
  coherence polish 2 passes, 5/5 findings addressed.
- **The RT8-pending standalone adversarial leg ALSO completed in this
  window** (E2E [4/4]): 25 checked / 23 supported / 0 partial /
  2 unsupported / **0 removed**, in 49.7s with batch-20 prompts — the
  RT8 plan's night-runner gap is closed by RT9's clean window.
- **New stats fields live in the complete payload**: `skillCacheHits`
  (all 0 — expected: full fresh runs clear the LLM cache at gather
  start; the metric matters for resumed runs) and `sessionContext` —
  real per-taskType assembled-prompt data at last: gather 8 calls /
  46.7K chars (max 15.6K), score 8 calls / 78.5K chars (max 12.4K),
  curate-smart 1 call / 23.4K chars. The RT10 context-budget decision
  now has numbers to stand on.
- **Skill coverage**: 12+ distinct skills invoked (knowledge 3, score 8,
  curate-smart 1, gap-design 1, gap-research 1, evidence-extract 3,
  fact-check 3, review 3, revision 8, coherence-review 2, …) — the new
  timeline tiles surface exactly this.
- **Memory**: per-section RSS watermarks 1826 → 1826 → 1827 → 1827 →
  1827 → 1828 MB (flat — the RT8 ratchet fix holds), post-complete
  working-set release logged at 1,880 MB, standalone re-review batches
  at 1,892 MB — every phase comfortably under the RT7 OOM death line
  (~2.3GB).
- **Run lifecycle**: pool checkpoint saved (26 refs, 6 sections, 8 full
  texts) → cleared on completion — the resume machinery round-tripped
  cleanly through the extracted gather stage.
