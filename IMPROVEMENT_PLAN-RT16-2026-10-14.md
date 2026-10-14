# IMPROVEMENT_PLAN — RT16 (Recovery Round: Storm-Resilience Re-land + First Successful Push)

**Date:** 2026-10-14
**Round theme:** Second full sandbox reset recovery → re-land the highest-value lost
RT14/RT15 features WITH the RT16 backlog fixes designed in → QA → E2E → RT17 plan →
**push round 6 — GO** (user-supplied token; the previous 5 rounds failed on missing
credentials).

---

## 0. Round context: the disaster and the recovery decision

The 2026-10-14 sandbox reset destroyed `/home/z/SciWrite` — and with it the RT10→RT15
development work (seam extractions 4a/5/6/4b/8, SSE scenario framework, rescore,
web-search clean-window retry, recovery badges, verdict ledger, 110 unit tests). The
work was never pushed: push credentials did not survive resets (6 rounds of NO-GO),
so GitHub `main` ended at `37ee9e5` (RT9 completion, 169 commits).

What survived: the 80-KB iteration journal (RT2→RT15, every design decision and live
observation). That journal is now the SPECIFICATION for re-implementation.

**Recovery executed (RT16-0):**
- Re-clone from GitHub at `37ee9e5`; deps + prisma + fresh DB **inside** the repo dir
  (RT10 lesson: DB follows the code, explicit `DATABASE_URL` always).
- **New sandbox constraint discovered and solved:** this sandbox incarnation reaps
  orphaned processes at Bash-command boundaries (setsid/nohup/disown ALL die — verified
  empirically). The only survival path is a `detached: true` + `unref()`'d child spawned
  from a short-lived bun process (`scripts/dev-daemon.ts`). The dev server now runs
  reaper-proof on :3000 (SciWrite serves the preview panel, template server killed).
- Auto-iterate scheduler disabled (RT2 lesson, `nextRunAt` far-future).
- Baseline verified: **364/364 unit** — the exact RT9 recovery check.

**What to re-implement first (prioritization):**
1. **Storm resilience (RT14 rescore + RT15 web-retry)** — highest live-proven value:
   rate storms hit the E2E in nearly every session; the features were deep-live-tested
   (40-round waits, probe-refusals, honest give-ups). Re-landed this round **with the
   RT16 backlog fixes designed in** (TTL-aware budgets + same-storm dedup — see §1/§2).
2. **Seam extractions + SSE parity framework** — large mechanical refactors with a
   test-infra prerequisite. Deferred to RT17 (planned there in dependency order).
3. **Verdict ledger / translate disposal / adversarial ledger** — RT13 features riding
   on E2E cadence; rolled passively, re-land when their consumer stages come back.

---

## 1. RT16 backlog disposition (from RT15-Final)

| # | Item | Disposition |
|---|------|-------------|
| 1 | Storm-ladder TTL vs recovery-budget structural mismatch (TTL 30-min ladder step > 10/15-min flat budgets ⇒ every wait structurally doomed) | **DONE (re-landed with fix)** — `waitForCleanWindow` budgets from the abort TTL itself: `clamp(TTL-remaining + margin, pollMs, hardMax)`. Short storms wait only as long as the storm can last; the 30-min ladder step becomes waitable (31.5-min budget — RT8's live-proven "outlast the storm" recovery now reachable); anything past `hardMax` (35 min) short-circuits to an instant honest "structurally-doomed" disclosure — no wait theatre. See `src/lib/storm-recovery.ts`. |
| 2 | Same-storm duplicate wait dedup (RT15 E2E burned 25 min wall-clock on two stacked waits for ONE storm) | **DONE** — single-flight map keyed by abort epoch (`abort:${at}:${ttl}`): the first waiter performs THE wait; later waiters on the same storm join the in-flight promise and receive the same outcome. Each caller still probes per-capability afterwards. Unit-tested (join semantics + fresh-epoch-after-re-set). |
| 3 | Adversarial band passive accumulation | **PASSIVE** — the E2E's adversarial-review leg feeds the band; collected this round if the E2E lands in a clean window. |
| 4 | Production build leg (round 7) | **NO-GO (environment)** — sandbox forbids `next build`; unchanged. |
| 5 | Push (round 6) | **GO** — user supplied a token this session. This document rides the push. |

---

## 2. Design details

### 2.1 `src/lib/storm-recovery.ts` (new, 290 lines)

- **Budget computation (the #1 fix).** At entry, `getAbortInfo()` (new additive
  rate-limiter export mirroring `isAborted()`'s hydration+expiry semantics) supplies
  `{reason, at, ttl, consecutiveStorms}`:
  - `ttlRemaining + margin > hardMax(35 min)` → return `structurally-doomed` IMMEDIATELY
    (rounds=0, waitedMs=0) — the deep-storm give-up is a designed instant outcome, never
    a slow one. This is RT15-Final candidate (b) made honest, bounded by candidate (a)'s
    TTL-awareness.
  - else budget = `min(ttlRemaining + margin, hardMax)`, floored at one poll round.
  - No abort flag (window-drain-only wait) → flat `defaultBudgetMs` (10 min).
- **Clean predicate.** `!abortActive && windowCount <= quietThreshold(3)` — the sliding
  window's decay is the visible progress proxy (RT15's `windowCount 52→0` disclosure).
- **Single-flight.** `inFlightWaits: Map<epochKey, Promise<StormWaitResult>>`; joiners
  spread the base result with `joinedSharedWait: true`. New storm epoch (abort re-set at
  a different `at`/escalated `ttl`) → fresh key → fresh wait (ladder escalation observed
  correctly).
- **Caller-abort seam.** `shouldAbort` checked before every sleep — the gather hook
  passes the route's client-disconnect getter.
- **Round disclosure.** `onRound({round, waitedMs, windowCount, abortTtlRemainingMs})`
  after every poll — the timeline shows every 15-s round (RT15's 40/100-round
  disclosure pattern).
- **Test seams.** `setStormStateReaders({abortInfo, windowCount} | null)` +
  `_resetStormRecoveryForTests()` + per-call `_now`/`_sleep` — a 30-min storm resolves
  in microseconds on the fake clock.

### 2.2 Gather web-search clean-window retry (`orchestrator/gather-stage.ts`)

- The per-query body is extracted to `executeWebQuery(q, wi, total)` — BOTH the main
  loop and the retry round run byte-identical semantics (mapping, tally, events).
- Queries failing with `reason === "rate-limit"` are collected into `rateLimitedQueries`
  (parse errors / timeouts / provider-without-search are NOT retry candidates).
- After the degraded-tally disclosure: `waitForCleanWindow({label: "gather-web-retry",
  shouldAbort: isClientDisconnected, onRound: <step progress event>})`.
- Clean wait → **probe first** (RT12 lesson, twice-proven: in-process clean ≠ account
  recovered): one real `webSearchDetailed(rateLimitedQueries[0])`. The probe doubles as
  the first retry — its results are ingested. Probe refused → honest give-up
  ("N query(ies) not retried — provider still throttled after the recovery wait
  (probe refused); database-gathered sources are unaffected"). Probe healthy → retry
  the remaining queries once (pool 3); re-refused queries stay degraded (no second
  wait round by design).
- Every path records a `StormRecoveryEntry` on `ctx.stats.stormRecovery`.

### 2.3 Score-stage rescore (`citation-planner.ts scoreSources`)

- A degraded batch is a **rescore candidate only when the skill fallback rode a storm**
  (`issues` matching `/abort|429|rate.?limit|too many/i` — chat-level failure). A
  parse-garbage fallback replays from the llm-cache, so re-running it is pointless —
  this distinction is documented and unit-level enforced by the detection predicate.
- `runBatch(b, rescoreRound)` shared by both passes; the rescore round disables the
  storm-degradation collector (no third round by design; also avoids mutating the array
  under iteration — a live bug class from this round's first draft, caught in review).
- Batch accounting corrected across passes (first pass counts fallback; rescore success
  cancels the fallback count — `llmBatches` already incremented inside `runBatch`;
  re-failure cancels the duplicate).
- No separate probe: rescore batches re-enter `withRateLimit` + `withAbortWaitout`, so a
  still-hot provider refuses them instantly — **the first retry IS the probe**
  (RT12 lesson applied per-capability).
- Honest outcomes: "Rescored K/N storm-degraded batch(es) back to LLM scores…" /
  "N batch(es) keep mechanical scores — provider still throttled…" / budget/doomed
  phrasing via `describeWaitOutcome`.

### 2.4 Timeline recovery badge (`run-timeline-dialog.tsx` + i18n)

- `stats.stormRecovery` (complete-event payload, route 4508) renders a
  **HeartPulse-labeled chip row** between the skills-degraded badges and the provider
  snapshot: recovered waits → emerald (`stage: K/N recovered · duration`), gave-up /
  probe-refused / structurally-doomed → slate (`stage: outcome · duration`), tooltip
  carries the detail string. Non-empty sets only — a storm-free run adds zero noise.
- i18n keys added (en + zh): `timeline.stormRecovery/stormRecovered/stormGaveUp/
  stormProbeRefused/stormDoomed`.

### 2.5 Reaper-proof dev infrastructure (`scripts/dev-daemon.ts`, `e2e-daemon.ts`, `armed-e2e-runner.ts`)

- The sandbox now kills orphaned processes at command boundaries (empirically: setsid,
  nohup, disown, plain `&` all die; only bun-spawned `detached:true`+`unref()` children
  survive). All long-running processes (dev server, E2E, armed runner) launch through
  this pattern.
- `armed-e2e-runner.ts` — the RT15 armed-runner pattern re-landed: probe
  (`scripts/quota-probe.ts`, 8-token chat) every 180 s, 60 probes (~3 h); first clean
  probe fires the E2E immediately; exhaustion exits non-zero (honest give-up).

---

## 3. QA (unit + integration + static)

| Gate | Result | Baseline delta |
|------|--------|----------------|
| Unit (`bun test tests/unit`) | **378/378** | +14 (storm-recovery: no-storm fast path, doom short-circuit, TTL-extends-past-default, short-storm-TTL-crossing, budget-exhaustion, window-drain clean, caller-abort, onRound disclosure, single-flight join, fresh-epoch-after-re-set, outcome phrasing, live getAbortInfo round-trips ×3) |
| Integration (`bun test tests/integration`) | **26/26** | 0 |
| `tsc --noEmit` | 4 errors | 0 (exact RT9 baseline: page.tsx ×1, database-query-panel ×2, sidebar ×1) |
| `eslint .` | **0 errors / 187 warnings** | 0 (baseline level; all changed files clean) |
| Dev server | :3000 serving SciWrite, `/api/projects` 200 | — |

One defect caught and fixed during this round's own review (before any test run): the
first draft of the rescore double-counted `llmBatches` and could push into the array
being iterated — both corrected with explanatory comments.

---

## 4. E2E (full-generation live test)

**Launch attempt 1 (05:32Z)** — **blocked by the pre-flight guard**: the provider
account was throttled at launch time (8-token probe → 429 → abort → 503 "provider
throttled (429 storm) — the pipeline was NOT started (no sources were cleared,
nothing was consumed)"). The guard worked exactly as designed (RT12 `5e0dd09`
behavior live-reproduced — zero quota wasted on a doomed launch).

**Armed wait-storm runner round 1 (05:35Z → 08:32Z)**: 60 probes × 180 s (~3 h
coverage). The provider account stayed throttled for the entire window — a 429
storm of ≥3 h (second-deepest on record; RT15's deepest was 7.2 h). Every probe
correctly failed-fast; **zero quota was burned on the dead provider**. The runner
exhausted its budget and exited honestly:
`storm never cleared after 60 probes — honest give-up` (non-zero exit).

**Armed runner round 2 (08:32Z → 11:32Z)**: re-armed with a fresh 60-probe budget;
if the storm clears late in the session the E2E fires autonomously. Status at
document finalization: still throttled.

**E2E verdict: environment NO-GO (provider capacity)** — same class as RT15's
final verdict. The feature work is NOT judged by this (see §4.1).

### 4.1 Feature-verification legs (standing without the full E2E)

| Leg | Evidence |
|-----|----------|
| Core wait semantics | 14/14 unit tests on the fake clock: no-storm fast path, structural-doom short-circuit (zero wait theatre), TTL-extends-past-default (the RT15 structural mismatch FIXED), short-storm TTL-crossing, budget-exhaustion honesty, window-drain clean detection, caller-abort, per-round disclosure payload, single-flight join, fresh-epoch-after-re-set, outcome phrasing, live `getAbortInfo` round-trips (ladder, persistence, expiry) |
| Recovery-badge UI data path | LIVE: a synthetic completed run carrying `stats.stormRecovery` (one recovered + one probe-refused wait) rendered the badge correctly in the browser — emerald "gather-web: 3/3 recovered · 3m 0s" + slate "score: provider still throttled · 2m 0s" + the full waiting-event sequence in the step list (screenshot `shots/rt16-recovery-badge-expanded.png`); 0 console/page errors. This is the live verification RT15 could not achieve (its E2E was storm-dead too) — achieved here via direct TaskRun stats injection, the same data path the real pipeline writes. |
| Pre-flight guard | LIVE: refused the doomed launch instantly (503, zero consumption) — RT12 behavior reproduced on the real provider. |
| Armed-runner honesty | LIVE: 60/60 probes failed-fast without burning pipeline quota; exhaustion disclosed with a non-zero exit (round-1 log). |
| Browser app health | LIVE: homepage + failed-run partial state + timeline dialog + 390px responsive (scrollW=innerW) + sticky footer (bottom=viewportH); 0 console errors, 0 page errors; screenshots `shots/rt16-home.png`, `rt16-timeline-failed-run.png`, `rt16-mobile-390.png`. |

**Open (rolls into RT17 #4):** the wait/retry hooks themselves have no live
in-pipeline datapoint this round (the guard correctly prevented the pipeline from
starting against a dead provider — exactly the designed trade-off: no quota
waste, no live storm-recovery observation). RT17 schedules an armed storm-window
E2E to exercise them live; the single-flight dedux also has no live datapoint yet
(two stages waiting on one storm).

---

## 5. RT17 backlog (draft — finalize after E2E recovery data)

Priority order reflects the dependency chain of the lost RT10–RT12 work:

1. **SSE event-sequence regression framework (prerequisite).** Re-build the golden-hash
   scenario runner + the recorder-parity assertions FIRST — it was the acceptance gate
   that made the seam surgeries safe (RT10-12 discipline: "golden hash unchanged"
   after every extraction). Scenarios to re-land: baseline full-run, gap-merge, rescore,
   web-retry degraded (the four lost fixtures).
2. **Seam extractions re-run** (route is 4,680 lines again — the monolith RT10-12 cut
   to ~2,000, all lost): 4a sources-stage → 5 repair/polish loops (+article-state
   shared helper) → 4b planning-stage → 6 generate-loop → 8 compose-stage, in that
   order, each gated by the SSE framework from (1).
3. **RT10 concomitants:** `[1 3]` spaced citation-marker full expansion in all
   cited-set views; standalone adversarial-review route dedup onto
   `@/lib/adversarial-verify`; revise taskType statelessness.
4. **Storm-recovery live validation gap:** if this round's E2E lands clean (no storm),
   the wait/retry paths stay unit-level only — schedule an armed storm-window E2E
   (RT15-style saga) to exercise them live; the single-flight dedup in particular has
   no live datapoint yet.
5. **Adversarial band accumulation** (passive; feeds from E2E adversarial legs).
6. **Verdict ledger + translate disposal** (RT13 decisions riding the E2E cadence).
7. **Production build leg** — environment NO-GO rolls (round 8).
8. **Push discipline (NEW, permanent):** push at the END of every round, not "when
   credentials appear" — the token is now in the remote URL; a future reset loses it,
   so treat each session's push as mandatory-close. Journal (`worklog.md`) rides every
   push — it is the only artifact that survived this reset.

---

## 6. E2E final state

Round-2 armed runner remains armed past this document's finalization (autonomous
fire through ~11:32Z; any late firing is collected by a follow-up commit). The
round-1 honest give-up, the guard's zero-waste refusal, and the §4.1 legs are the
final E2E record for RT16.
