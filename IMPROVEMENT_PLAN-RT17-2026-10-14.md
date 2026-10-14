# IMPROVEMENT_PLAN — RT17 (2026-10-14)

## 0. Round context

RT16 ended with the disaster-recovered codebase at `809dfc8` (RT9 completion
`37ee9e5` + storm resilience re-landed + first successful push). The RT17
backlog (from IMPROVEMENT_PLAN-RT16 §5) prioritized the dependency chain of
the lost RT10–RT12 work:

1. **SSE event-sequence regression framework** (the prerequisite safety net),
2. **Seam extractions re-run** (the route was a 4,690-line monolith again),
3. **RT10 concomitants** ([1 3] marker expansion, adversarial route dedup,
   revise statelessness),
4. Storm-window armed E2E for the wait/retry hooks' live datapoint.

All three development legs landed this round. The E2E leg fired into yet
another account-level storm — the armed runner stayed autonomous through
finalization of this document.

---

## 1. RT17 backlog disposition (from RT16-Final)

| # | Item | Disposition |
|---|------|-------------|
| 1 | SSE event-sequence regression framework (prerequisite) | **DONE** — `tests/unit/sse-sequence.test.ts` + `tests/fixtures/sse/` (tiny scenario). Golden-hash scenario runner rebuilt from the RT17-a audit: mock edge at `@/lib/llm-session` (skill + direct calls) + `@/lib/ai` (webSearch + taskType-less chat) + `@/lib/databases` + `@/lib/db` (scratch Prisma per scenario) + `z-ai-web-dev-sdk` (the 8-token storm probe). 8 assertion classes: terminal XOR / zero-ping / SPINE order / SHAPES payload keys / INVARIANTS (clean-run zero degradation) / generate-verify pairing / **GOLDEN hash** / **RECORDER PARITY** (wire step projection ≡ TaskRun.stepsJson). RECORD mode `SCIWRITE_RECORD_SSE=<scenario>`. First scenario run: 13 s wall-clock, hash reproduced byte-identical on the second (non-record) run. Mock-pollution guards: `clearAbort()` per scenario (the storm-recovery.test.ts in-process flag was the first failure — fixed), afterAll delegate-to-real (RT8 discipline). |
| 2 | Seam extractions re-run (4a → 5 → 4b → 6 → 8) | **DONE — all five, one commit each, golden hash unchanged after every splice.** route.ts: **4,690 → 1,674 lines (-64%)**; six orchestrator modules total 6,001 lines. See §2. |
| 3 | RT10 concomitants | **DONE** — `[1 3]` space-separated markers now expand fully in every cited-set view (compose-transforms + fact-check + numeric-sweep + review-engine + citation-audit; dash-adjacent-space collapse preserves the LOCAL "1- 3" range parsing byte-for-byte); adversarial-review route deduped onto `@/lib/adversarial-verify` (386→354 lines; honest rate-skip report; unverified/llmCalls fields); `revise` taskType stateless. +45 unit tests. Golden hash intact (tiny scenario carries no space-separated markers). |
| 4 | Storm-window armed E2E (live datapoint for the wait/retry hooks) | **DONE — E2E data point #6, verdict 10/10 PASS (see §5).** The 10.3-h account storm cleared at 16:02Z; the armed runner fired autonomously (PID 18708, probe→launch with zero waste during the storm). The **web-retry hook hit its live proving ground**: 4/6 web queries rate-limited at gather → 36 wait rounds (9 min, every round disclosed on the wire) → live probe → 2/4 healed — the full saga persisted in `stats.stormRecovery[0]`. First E2E on the five-seam orchestrator stack: zero pipeline errors, zero skill degradation, 41.3 min end-to-end. The re-landed verdict ledger (added during the wait window, commit eef9a76) ran on this launch — 10/10 checks PASS in report. |
| 5 | Adversarial band accumulation (passive) | **ROLLED** — no E2E adversarial leg this round (storm). |
| 6 | Verdict ledger + translate disposal | **ROLLED** (RT13 decisions riding the E2E cadence — no completed E2E run to feed the ledger). |
| 7 | Production build leg (round 8) | **NO-GO (environment)** — sandbox forbids `next build`; unchanged. |
| 8 | Push discipline (every round) | **GO at round end** — see §6. |

---

## 2. The seam campaign (five extractions, hash-gated)

Every module was extracted **verbatim** (bodies preserve the original route
indentation so multi-line template literals keep exact wire bytes; client
disconnects pass through getters; terminal bindings are returned and re-bound
by the route). The acceptance gate for each splice: `bun test
tests/unit/sse-sequence.test.ts` → GOLDEN hash unchanged.

| Seam | Module | Lines | Scope (route STEPs) | Commit |
|---|---|---|---|---|
| 4a | `orchestrator/sources-stage.ts` | 399 | 1.5–2.5 (knowledge cross-check → score+rescore → curate → tier gate → fulltext) | 806e38f |
| 5 | `orchestrator/repair-polish-stage.ts` | 1,230 | 8.5 → finalization (repair loop → coherence polish → paragraph sync → article save → review rows → audit → **compose:done last**) | f497e8f |
| 4b | `orchestrator/planning-stage.ts` | 835 | 3–5 (plan+stormRetry → coverage backfill → gap agent → analyze → allocate), fresh-run phase interior | 447a1ce |
| 6 | `orchestrator/generate-loop.ts` | 934 | 6–7 (section loop + validation gates + **pipelined verify** + digest derivation + working-set GC), ends at the all-failed hard exit | 06ad9cd |
| 8 | `orchestrator/compose-stage.ts` | 232 | 8 (heading uniforming → renumber → cross-section dedup → OOR strip → orphan filter → refList → title) | 7bbf3f8 |

**Contract decisions worth pinning (the load-bearing ones):**

- **Shared-reference arrays cross seams by identity** — `savedDataSources`,
  `savedReferences` (gather + gap agent persist push into them),
  `generatedParagraphs`, `sectionsCheckpointData` (generate loop + resume
  pre-population), `renumberedContents` / `globalRefs` (repair/polish adoption
  rewrites elements and re-syncs in place), `repairRounds` (route gates the
  review event on it and clears it at release).
- **Terminal-value returns** — curatedRefs/sections/allocations
  (planning re-binds; the pool checkpoint serializes the terminals, splice
  order load-bearing), articleContent/article/audit/repairTelemetry
  (repair-polish returns finals; complete payload reads them).
- **Cross-seam linkage CR-B#13** — `generateLoop.abortedDueToRateLimit`
  returns as a terminal value; the route's hoisted let feeds the STEP 9
  translate guard.
- **Digest derivation equivalence** (seam 6): the module derives
  `digestEntryTexts` from `resumeSectionsDone` via the same
  `buildDigestEntry` the loop uses; the inline resume path's running
  slice(-24) clamp is byte-equivalent to join-then-clamp-once (induction:
  the clamp depends only on the trailing 24 lines of the same append
  sequence). Argued in the module header.
- **`curatedScores` is planning-internal** — verified last consumer is the
  gap merge itself; not returned.
- **repair-polish keeps the three-layer DB error asymmetry** verbatim
  ($transaction/article.create propagate fatally; per-round review.create
  log-and-continue; repairSummary/coherence rows log only) and the
  compose:done-after-every-DB-write module-level golden.

Route 1,674 lines remaining: init/resume/checkpoint/complete-payload wiring,
STEP 9 translate (route-owned-forever per RT13-3), satellites
(relationships/review self-fetch), the catch/rollback, and the SSE
send/recorder/keepalive scaffolding.

---

## 3. QA state

- **Unit: 431/431 (22 files)** — RT16 baseline 378 + SSE framework 8 +
  RT17-3b 32 ([1 3] expansion: compose-transforms flip+7, citation-audit 14
  new, fact-check 3, numeric-sweep 3, review-engine 5) + RT17-3c 13
  (adversarial-dedup 11, stateless 2).
- **SSE golden hash: unchanged through five seam splices AND the [1 3]
  expansion** (six consecutive objective zero-regression proofs).
- tsc: 4 baseline errors only (page.tsx / database-query-panel ×2 / sidebar).
- lint: 0 errors / 189 warnings — message-level diff vs the post-seam HEAD
  baseline is empty (the 187→189 drift is line-number shifts from the seam
  commits, verified by the file-swap method).

## 4. Browser verification (agent-browser)

Home page 0 console / 0 page errors; project card renders the partial
storm-run state gracefully. **Timeline: the STORM RECOVERY badge rendered
from a REAL run's data** — an unexpected 06:03Z run (a launch that slipped
past the pre-flight guard during RT16's round-2 window) left a TaskRun whose
stepsJson carries the full wait/retry saga: `gather-web: 3/3 recovered · 3m`
(emerald) alongside `score: provider still throttled · 2m` (slate), with the
round-by-round wait messages visible. That is the live data-path validation
RT16 could only reach via synthetic injection — the RT17 #4 gap is partially
closed by it. 390 px: scrollW = innerW = 390 (no horizontal overflow), footer
bottom = 844 = viewport height (sticky). Screenshot:
`tool-results/rt17-timeline-storm-recovery.png`.

**Anomaly logged for RT18**: that 06:03Z TaskRun is marked `status:
completed` with dur=0 ms, 5 steps, 0 words — the pipeline died mid-score
(OOM or process reaping) with no complete/fail call. The 20-min zombie sweep
in the timeline route is the only net. The recorder needs a
death-marks-the-row discipline (see RT18 #3).

## 5. E2E — data point #6 (fired 16:02Z, report PASS)

The 13:53Z deployment probed into a 10.3-h account-level storm (05:45Z →
16:02Z — deeper than RT15's 7.2-h record; every probe fail-fast, zero
quota waste). At 16:02:38Z the first clean probe fired the E2E
autonomously. 41.3 min end-to-end:

- **Article**: 2,323 words / 38 markers / 16 unique = 16 listed refs
  (0 orphans) / 6 paragraphs; adversarial leg 29 checked → 26 supported /
  3 partial / 0 unsupported / 0 removed (19 s).
- **Pipeline**: zero errors, zero skill degradation (score 8/8 batches all
  LLM); repair loop 3 rounds — 2 scoped revisions applied, 0 guard
  rejections, final verdict major-revision (5/10); polish 2 passes;
  skillCalls 54 across 12 skills.
- **web-retry live saga** (the RT17 #4 target): gather 4/6 queries
  rate-limited → 36-round clean-window wait (9 min, windowCount decay
  visible on the wire every 15 s) → live probe → single retry pass healed
  2/4 — `stormRecovery[0] = {stage: gather-web, outcome: recovered,
  rounds: 36, waitedMs: 540061, retriedCount: 4, recoveredCount: 2}`.
- **Verdict ledger (re-landed during the wait window)**: 10/10 PASS —
  citationsChecked 33 ∈ [30,40] / auditOrphans 0 / revisions 2 ≤ 2 / guard
  rejections 0 / wordCount 2323 ≥ 900 / uniqueRefs 16 ∈ [1,40] / adv
  supported 26 ≥ 15 / partial 3 ≤ 5 / unsupported 0 ≤ 3 / removed 0 ≤ 2.
  First fully automated E2E acceptance in project history.

Also during the wait window: SSE scenarios three and four re-landed
(web-retry-window + rescore-window — the four-fixture golden-hash system
complete, commit 2f7331e; suite 438).

## 6. RT18 backlog (draft — finalize after E2E recovery data)

1. ~~SSE degraded-window scenarios~~ **DONE this round** (web-retry-window +
   rescore-window recorded, 2f7331e) — the four-fixture system is back.
   Next scenario trigger: any seam touching a degraded path.
2. **repair-polish-stage old split classes** — the [1 3] re-land observed 3
   reference-scan loops inside the migrated repair/polish adoption blocks
   still using the old split class (finalBodyCit / pcr scans). RT10
   deliberately did NOT touch them (route code then); decide now that they
   are module-owned: either expand (consistency with the cited-set family)
   or pin the LOCAL-only rationale in a test.
3. **Recorder death discipline** — the §4 anomaly: a killed pipeline must
   leave the TaskRun in an honest terminal state (aborted-by-unknown), not
   a bare `running` row relying on the 20-min UI sweep (and never
   `completed` at 0 words).
4. **Verdict ledger re-land** (RT13 asset, E2E acceptance automation) —
   feeds from the first clean-window E2E.
5. **Adversarial band accumulation** (passive, E2E-fed).
6. **Production build leg** — environment NO-GO rolls (round 9).
7. **Push at end of round** (permanent discipline; token in remote URL).

---

## 7. Round artifacts

- Commits: 3c654d3 (SSE framework) → 806e38f (seam 4a) → f497e8f (seam 5) →
  447a1ce (seam 4b) → 06ad9cd (seam 6) → 7bbf3f8 (seam 8) → 1534c27 (RT10
  concomitants) → docs commit (this file).
- `tests/fixtures/sse/`: tiny.stubs.json / tiny.manifest.json (hash
  `0fbdf5900bb1…`, 57 tokens) / tiny.ndjson (wire archive).
- Six orchestrator modules: gather-stage (RT9/RT16) + sources-stage +
  planning-stage + generate-loop + compose-stage + repair-polish-stage.
