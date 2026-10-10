# SciWrite v2 Pipeline — Improvement Plan (RT4, 2026-10-10)

Built from: (a) the RT3 E2E run of 2026-10-10 (see IMPROVEMENT_PLAN-RT3
E2E-RESULTS section), (b) a file-level implementation-scout of every item
below (exact file:line targets already verified), and (c) the carried-over
N1-N6 suggestions from RT3.

## 0. E2E evidence driving this plan (2026-10-10 run, GLM-4.6, 1500 words)

- 36.32 min end-to-end, all-green mechanical audit, 21/21 citations supported,
  BUT the run absorbed two live 429 storms: score → 100 % mechanical
  fallback, repair re-review → abort-ended (not convergence-ended),
  polish/relationships/peer-review → skipped, final word count 1252/1500
  (83.5 %).
- R2 pipelining verified live; R6 numeric sweep fired; gap-agent coverage
  early-stop fired; R1/R4 gates never reached their decision points.
- `stats.gatherCoverage` / web-search-cache counters never reach the
  complete-event payload — invisible to the report.

## 1. RT4 work items (ranked, with verified implementation targets)

### P0-1. Storm-aware abort state, persisted (N1)

The abort flag is a module-level variable (`rate-limiter.ts:237-240`) — a dev
restart forgets an active storm and immediately re-probes. Two storms hit
this exact run.

1. **Persist**: new `src/lib/rate-abort-store.ts` (JSON file, modeled on
   iteration-state): `setAbort()` (`rate-limiter.ts:257`) writes;
   `isAborted()` (`:242`) lazily reads + TTL-checks. Restart keeps the
   storm memory.
2. **Parse provider reset hints**: `QuotaState.updateFromHeaders`
   (`rate-limiter.ts:169-182`) currently ignores Retry-After /
   X-RateLimit-Reset (interface field `retryAfter` at `:39` is never
   assigned). Parse both; abort TTL becomes max(current TTL, retryAfter).
3. **In-stream backoff ladder**: generalize the fixed-4-min `stormRetry`
   (`generate-full-v2/route.ts:1665`, plan-only today) into a reusable
   wrapper over `ABORT_TTL_STEPS_MS`, emitting `send("step")` events with a
   `retryInMs` field so the client shows one honest countdown instead of
   requiring a manual re-click per attempt.
4. **Consistency fix**: `quota-status/route.ts:28-29` still hardcodes 15
   while the sliding window moved to 20 (`rate-limiter.ts:217`).

Unit-test targets: store round-trip + TTL expiry, header parsing (incl.
absent/HTTP-date forms), ladder escalation order.

### P0-2. Observability: complete-event stats gaps (N6, 15-minute change)

`route.ts:4991-5053` (stats block `:5003-5017`): add `webSearchCache:
{...webSearchCacheStats}` (from `web-search-cache.ts:38-43`) AND the
missing `gatherCoverage` / `gatherTopUpNewItems` (RT2 fields that never made
it into this payload). Optional run-scoped deltas: snapshot counters at
`:426` next to `t0`. The test report then shows cache savings + coverage on
every future run.

### P1-1. Clean-run validation of R1/R4 (N2) — a test, not a feature

The convergence gate and fixable/advisory split are prompt-driven and were
never exercised (storm aborted the loop first). One scheduled storm-free E2E
re-run (words 1500) whose acceptance criteria:

- repair loop ends by **convergence or verdict change**, not abort;
- rounds ≤ 2; advisory-only rounds are disclosed, not chased;
- numeric-sweep advisories ≤ 5 and visible in the Review tab;
- word count ≥ 90 % of target with the polish stage actually running.

### P1-2. Degraded-tail word-count floor (new finding this run)

polish/relationships/peer-review skipped → 1252/1500 words with no signal
beyond `achievementRate`. Add a mechanical guard in compose: when target
shortfall > 10 % AND polish was skipped, either (a) one bounded LLM top-up
call on the shortest section, or (b) mark the article `degraded` in the
complete payload so the UI/review tab says so. Cheapest honest option: (b)
first, (a) behind a flag.

### P2-1. Pipeline-overlap timing instrumentation (N3)

Current timings conflate the writer with the pending verify wait
(`sectionStart` at `route.ts:2534` is polluted by the `await
finalizePendingVerify` at `:3021`; verify `res.ms` lands only in a message
at `:2456`, never in stats). Add:

- `genStart` at `:3023` (after pendingVerify = null) — pure generation time;
- `finalizeStart` + post-await `waitMs` at `finalizePendingVerify` top
  (`:2421`) — writer-side wait = non-overlap;
- `stats.pipelineTimings[]` (declare at `:435`, push in finalize), export
  via the complete payload next to `repairTelemetry.numericSweep`
  (`:3508` → `:5040-5048` pattern).

Overlap quality then reads directly from the report instead of inference.

### P2-2. Bilingual canary (N4, carried) and numeric-sweep escalation (N5)

Unchanged from RT3: one `--language both` canary before any translation
work; sweep escalation decided from the false-positive rate once N2's clean
run measures it.

## 2. Suggested execution order

P0-1 → P0-2 (same commit, zero risk) → clean-run E2E validates P0-1/P0-2 +
R1/R4 (P1-1) → P1-2 → P2-1 → P2-2. Estimated: P0 half-day, P1-1 one
quota-quiet window, P1-2 + P2-1 half-day.

## 3. QA / E2E protocol for RT4 (what "done" means)

- Unit: new store/header/ladder tests + existing 185 stay green.
- Integration: 26/26 stay green (live server).
- E2E: full-generation-test --words 1500 completes with a **storm-free**
  report (or a storm that P0-1 visibly rides out via persisted state +
  backoff ladder in the log); mechanical audit all-green; stats payload now
  shows webSearchCache + gatherCoverage + pipelineTimings.
- Report deltas recorded against the RT2 baseline (41.3 min) and the
  storm-degraded RT4-1 run (36.32 min) with degradation honestly labeled.
