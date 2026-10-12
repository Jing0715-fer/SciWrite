# SciWrite RT8 — Dev-Mode Memory Ceiling + One-Orchestrator Merge (2026-10-12)

RT8 executes the RT7 backlog (IMPROVEMENT_PLAN-RT7 §6, items 1 + 3 + 5):
the dev-runtime memory ceiling behind the RT7 E2E OOM kill, the v1+v2
"one orchestrator" merge, and the degraded-skills UI surfacing. Two more
backlog items (#2 generate/translate as skills, #6 knowledge-summary →
gap-design merge) are resolved as DATA-DRIVEN NO-GOs this round (see §5).

## 1. What RT8 changed

### A. Dev-mode memory ceiling (RT7 backlog #3)

The RT7 E2E incident: after a clean 34.3-min full-generation run, the
post-pipeline adversarial re-review pushed the `next dev` server to 2.3GB
RSS and the 3.9GB container OOM-killed it. Root-cause audit (call-graph +
process-tree) found the re-review itself well-bounded — it was the LAST
allocation on a heap that had been ratcheting for 34 minutes with zero GC
pressure, plus per-call DB reads and dual serialization churn:

| Fix | File | What |
| --- | ---- | ---- |
| A1 | `lib/llm-cache.ts` | **LRU entry cap (500)** — the Map had TTL-only expiry; a bursty run wrote 50-100 entries × ≤32KB and held them 30 min. Now: expired sweep on every set (r37, kept), insertion-order LRU eviction at 500 entries, and read-refreshes-recency so the eviction wave hits the least-recently-USED entries. A cache miss is always a safe outcome; an OOM kill mid-run is not. |
| A2 | `lib/llm-session.ts` | **Stateless task types skip `loadSessionContext`** — the adversarial verify (`taskType: "verify"`, 14+ calls/run) and the standalone re-review (`adversarial-review`, ~4 calls) each deserialized 20 session rows (≤28KB each) per LLM call just to build a 4-message generation-chatter preamble a hostile reviewer has no business seeing. Session rows are still SAVED (observability intact); only the context LOAD is skipped. Same edit extracts the duplicated prompt-assembly into `assembleFinalPrompt` and fixes its **O(n²) re-join** (the drop-oldest loop re-joined the whole array per splice; now incremental length tracking, join at most once). |
| A3 | `api/articles/[id]/adversarial-review` | **DB projection** (was `include: { references }` — every column of every paragraph×reference row deserialized right before the batch loop; now `select` of exactly the 6 fields the prompt consumes) · **`VERIFY_BATCH_SIZE`/`VERIFY_REMOVE_CONFIDENCE` from v2-config** (was the last =10 holdout while the in-pipeline verifier runs 20 — one tuning source of truth) · **per-batch GC hint + RSS watermark log** (mirrors the pipeline's round-cs-4 block — the next incident is diagnosable from the log). |
| A4 | `api/ai/generate-full-v2/route.ts` | **Checkpoint pool payload serialized once** (was stringified twice per upsert — create + update branches both evaluated, upsert executes one; the pool payload is the largest object graph the run ever strings) · **post-`complete` working-set release** (savedDataSources / savedReferences / repairRounds cleared, fullTexts Map cleared, GC hint — previously the whole run's working set sat in the start() closure until the stream was collected, which on a no-pressure dev heap meant "never"). |
| A5 | ops | **Dev server launched with `NODE_OPTIONS=--max-old-space-size=1536`** — V8 GC pressure now ramps as the heap approaches the cap instead of letting RSS walk to the container ceiling; the parent-repo :3000 server and the SciWrite :3001 server share the 4GB box, so a ceiling matters. |

### B. One orchestrator: v1 → v2 (RT7 backlog #1)

Pre-merge audit (whole-repo): v1's ONLY live consumer was the dialog's
UI-local toggle (default v2, never persisted); every script/watchdog/E2E
harness/test posts to -v2; the one other caller (`topic-composer.tsx`)
was dead code. The v2 SSE envelope is a deliberate superset of v1's.
The merge is delegation, not redirect:

- `api/ai/generate-full/route.ts`: **4007 lines → 28** — declares
  `runtime`/`maxDuration` locally (route-segment config can't be
  re-exported — Next.js requires static per-file parsing) and re-exports
  v2's `POST`. Stray clients/bookmarks keep working; the URL runs the v2
  pipeline.
- `components/sciwrite/topic-composer.tsx` **deleted** (dead code, zero
  imports).
- `unified-writing-dialog.tsx`: the v1/v2 selector card is replaced by a
  static v2 identity card; all `pipeline === "v1"` branches collapsed to
  their v2 arms (STEPS memo loses the v1 step list; the stall watchdog and
  resume-banner gates that were v2-only are now unconditional; the launch
  payload drops the v1-only `sectionRefTopN`/`sectionDsTopN` knobs; the
  advanced-settings "Per-section reference filtering" section removed —
  v2 always ignored those inputs).
- `lib/generate-full-helpers.ts`: v1-only `ncbiItemsCount` +
  helpers-local `extractKeywords` deleted (the canonical Set-returning
  `extractKeywords` lives in `citation-audit.ts` and is untouched).
- i18n: 8 dead `oneClick.*` keys removed from both locales (16 lines);
  `timeline.step.relationships` kept — historical v1 TaskRun rows still
  replay their step labels.
- Behavior disclosure (by design, documented in the route stub): v1 users
  now get keyed `{{Rn}}` citations + adversarial verification +
  checkpoint/resume + knowledge/evidence/repair/polish stages — v2's
  wall clock is correspondingly longer than v1's.

### C. Degraded-count UI surfacing (RT7 backlog #5)

`run-timeline-dialog.tsx`: the complete-event stats block has carried
`skillDegraded` since RT7, but nothing showed it. The expanded run card
now renders an amber badge row (⚠ "Skills degraded": `skill×n` chips)
whenever the set is non-empty — a run that quietly degraded three skills
no longer looks identical to a clean one. Clean runs add zero noise
(non-empty-only render). New i18n keys: `timeline.skillDegraded` /
`降级技能`.

## 2. QA results

| Suite | RT7 baseline | RT8 |
| ----- | ------------ | --- |
| Unit | 312/320 (8 known suite-order flakes) | **328/328, deterministic** |
| Integration (live :3001) | 26/26 | **26/26** |
| ESLint | 0 errors / 193 warnings | **0 errors / 187 warnings** |
| tsc --noEmit | 4 baseline errors | **4 baseline errors, 0 new** |

**The 8 historical "env-dependent" unit failures are fixed, not dodged.**
Root cause: bun runs test files in ONE process in non-alphabetical order,
and `mock.module` is process-global with no rollback (a later
`mock.module` call does not override — verified against bun 1.3.14).
`skill-executor.test.ts`'s module-level llm-cache mock leaked into
`llm-cache.test.ts` whenever the latter loaded later — the failure mode
RT6/RT7 documented as "suite-order interference". Fix in
`skill-executor.test.ts`: a query-suffixed dynamic import
(`import("@/lib/llm-cache?real")`) bypasses the path-keyed mock registry
and loads the REAL module; every mocked function delegates to it once the
`mockActive` flag flips false in `afterAll`; the mock's namespace now
also passthrough-exports `clearLLMCache`/`getLLMCacheStats` (a mock
replaces the WHOLE namespace — missing exports resolve to `undefined` in
later files). Pattern documented in the file header for future mocks.

New unit coverage this round:

- `llm-cache.test.ts` +4: LRU never exceeds cap · oldest-first eviction ·
  read-refreshes-recency (touched entry survives the next wave) · exactly
  one eviction per overflow write (no over-eviction).
- `llm-session-stateless.test.ts` +3: verification taskTypes stateless ·
  generation-side taskTypes keep context · unknown/empty fail safe to
  context loading (no prefix matching by design).
- v1 delegation verified live: `POST /api/ai/generate-full` with an empty
  body returns v2's `{"error":"Missing 'projectId'."}` (400) — the URL is
  served by the v2 handler. (First probe caught a real bug: re-exporting
  `runtime`/`maxDuration` is rejected by Next.js route-segment config
  parsing — config declared locally, only `POST` re-exported.)

## 3. E2E full generation (1500 words)

**PASS — see §4 for the numbers.** Run: `full-generation-test.ts
--base http://localhost:3001 --words 1500`, dev server freshly launched
with the 1536MB heap cap, including the [4/4] post-pipeline adversarial
re-review leg (autoFix: false — the exact RT7 OOM trigger path).

## 4. STATUS

- [x] A-family memory ceiling: LRU cap + stateless sessions + DB
      projection + single-serialize checkpoint + post-complete release +
      heap cap on the dev runtime
- [x] One orchestrator: v1 route is a 28-line delegation stub; dialog is
      v2-only; dead component + v1-only helpers + dead i18n keys removed
- [x] skillDegraded badge row in the run timeline (non-empty only)
- [x] Unit suite deterministic (328/328) — mock-leak root cause fixed
- [x] E2E + adversarial re-review leg on the capped heap — details in
      the E2E-RESULTS appendix below

### E2E-RESULTS (appendix — filled from tool-results/full-gen-test-report.json)

- **PASS — 34.72 min, 81 stage events, server SURVIVED the full cycle
  including the re-review leg (RT7's OOM point).** Peak RSS ~2.03GB on
  the 1536MB-capped heap; the [mem] watermarks show the ratchet is dead:
  1907 → 1900 → 1900 → 1901 → 1918MB across sections 2-6 (per-section
  full-text pruning + GC hints; RT7 climbed monotonically to 2.3GB+), and
  RSS **fell** to ~1.83GB after compose (post-stage GC).
- Article: **1,664 words composed / 1,409 EN body words (94% of
  target)**, 6 paragraphs, **12 references** (32 markers, 12/12 listed),
  8 full texts used. Mechanical audit: **0 blocking errors, 0 orphans**,
  21 topicality warnings, 5 cross-section-duplicate advisories.
- In-pipeline adversarial verify: **28 citations checked, 0 removed,
  8 flagged**; per-section verify ran pipelined (one section behind the
  writer) as designed.
- **This window was NOT clean** (unlike RT7's): a provider-side 429
  storm mid-run (consecutiveStorms=3 → 30-min abort TTL) degraded the
  run exactly the way the architecture intends:
  - score: **8/8 batches took the mechanical fallback** →
    `skillDegraded: {score: 8, curate-smart: 1}` in the complete stats —
    the RT8 timeline badge row rendered it live in the browser
    (score×8, curate-smart×1 chips, screenshot shots/rt8-timeline-degraded.png);
  - plan: LLM citation map fell back to mechanical
    (`citationPlanLLMDriven: false`, 13 planned refs, core covered 13);
  - repair loop: stopped early ("previous call aborted"), 0 rounds;
  - coherence polish: **skipped on the rate-limit abort** — "the article
    stands as repaired" (honest skip message);
  - the standalone [4/4] re-review leg: its LLM batches hit the
    still-active abort flag → "The operation timed out" — the route's
    graceful failure, no server impact (see the re-run note below).
- **Stateless-session skip verified in production logs**: every
  `taskType=verify` / `taskType=adversarial-review` chatWithSession call
  shows `+0ms` to the chat() handoff (previously a 20-row findMany per
  call); the standalone route's first batch prompt was 21,058 chars for
  20 checks (batch 20 now honored — RT7's standalone route ran 10).
- Post-run verification: `POST /api/ai/generate-full` (v1 URL) with an
  empty body returns v2's `{"error":"Missing 'projectId'."}` — the
  delegation works end-to-end.
- Browser (agent-browser): home + article view render with zero
  console/page errors; run-timeline badge row live (see above);
  Full-Article dialog is v2-only (no v1 selector; v2 identity card +
  DEFAULT badge; advanced settings lost the v1-only filtering knobs);
  mobile 390px: scrollWidth = 390 (no horizontal overflow). Screenshots:
  shots/rt8-home.png, rt8-article.png, rt8-timeline-degraded.png,
  rt8-dialog-v2only.png, rt8-home-mobile.png.
- **Re-review re-run after abort expiry** (the [4/4] leg swallowed by
  the in-run abort flag): the abort's 30-min TTL expired at 13:25, and a
  manual re-run at 13:33 executed the route's full non-LLM mechanics —
  DB-projected reference metadata assembled into a 21,058-char batch-20
  prompt, stateless session skip active (+0ms handoff), server alive at
  ~2.0GB through 6.7 min of retry/waitout cycles — but the LLM pass hit
  a FRESH account-level 429 storm (429×5 retries → abort storm #4,
  1-hour TTL), the same RT3-class provider outage, not a code defect.
  Verdict-class adjudication remains demonstrated by the in-pipeline
  STEP 7 (same adversarial machinery: 28 checks, 0 removed, 8 flagged,
  run before the storm peaked). A clean-window standalone pass is armed
  as a night-runner (scripts/rt8-adv-rereview.ts — polls quota-status
  every 3 min, fires the leg once the storm clears, writes
  tool-results/adv-rereview-rt8.json; 40 probes ≈ 2h coverage).

## 5. Data-driven NO-GOs (RT7 backlog #2 and #6)

- **#2 generate/translate as skills — stays hand-rolled BY DESIGN.** The
  skillCalls telemetry from the RT7 E2E (41 invocations / 12 of 15
  skills) shows the un-skill-ified surface is exactly the
  adopt/reject-loop stages: per-section generate (word-count retries,
  density gates, format-contract gates) and translate. These need
  "streaming + adopt/reject loop" executor semantics (compare candidate
  vs incumbent, keep the better) that the current runSkill contract
  (build → chat → parse → validate → fallback) cannot express without
  bloating every simple skill's contract. Revisit only if a second
  prose-loop consumer appears.
- **#6 knowledge-summary → gap-design merge ("coverage-audit") —
  deferred.** RT7 data: knowledge-summary×1 + gap-design×1 per run —
  merging saves 1 of 41 calls (~2.4%) while coupling two skills with
  different fallback contracts (additive-stage empty-ok vs
  caller-wraps-error). The 5th E2E run's timing data should re-rank this
  before it's built.

## 6. RT9 backlog (ranked)

1. **i18n label unification** (RT7 backlog #4, rolled): derive
   `oneClick.stepXxx` / `timeline.stepXxx` keys from the STEP namespace —
   kills the dual label sets; the RT8 dialog edit removed the last v1
   step-label consumer, so the merge surface is now minimal.
2. **Production-build smoke path for E2E**: the memory ceiling work
   targets the dev runtime; a `next build && next start` E2E leg would
   validate the production memory profile (and the standalone build that
   `npm start` uses).
3. **v2 route decomposition**: 5405 lines in one `POST` — the skill
   framework owns the business logic; the orchestration could split into
   per-stage modules (gather/knowledge/score/curate/plan/generate/
   repair/polish/export) with the SSE closure owning only sequencing.
   This is the real long-term home for "one orchestrator".
4. **`review` taskType stateless evaluation**: this round deliberately
   kept `review` context-loaded (fact-check ×8, review ×2,
   coherence-review ×2 ride it); if the next E2E shows no verdict drift
   from the stateless verify family, flip `review` too for the same DB
   + RSS win.
5. **Session-context cost telemetry**: `assembleFinalPrompt` now counts
   join lengths — surface per-call context bytes in the stats block so
   the next context-budget decision is data-driven.
6. **Timeline "skills invoked" tile**: `skillCalls` totals ride the
   stats block already; a MiniStat would make the 12-of-15 coverage
   visible without opening the JSON.

### Migration rules (unchanged from RT5/RT6/RT7, enforced by review)

- A skill is the ONLY place its prompt text lives.
- Every skill MUST declare fallback semantics (mechanical, or explicit
  hard-fail = no fallback) — degraded results are flagged, never silent.
- Telemetry rides the SkillTelemetry envelope; no new console.log at
  call-sites.
- Article-text outputs go through applyFormatContract OR the documented
  chunked combinator — adding a gate means editing FORMAT_GATES, never a
  per-exit sequence.
