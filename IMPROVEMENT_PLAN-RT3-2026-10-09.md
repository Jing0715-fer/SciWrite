# SciWrite v2 Pipeline — Improvement Plan (RT3, 2026-10-09)

Next-phase implementation of the R1-R8 recommendations from
IMPROVEMENT_PLAN-RT2-2026-10-09.md, plus the QA/E2E validation round.

## 1. What was implemented in RT3

| RT2 rec | Change | Files |
| ------- | ------ | ----- |
| R1 (repair-loop latency, 14.6 min / 35 %) | **Convergence early-exit** — `shouldStopForConvergence`: a round with <1 overall-score gain, no hard-finding shrinkage and no NEW contradiction ends the loop (disclosed in the Review tab). First round never stops; a worse score without new contradictions counts as churn. **Fact-check pooling** — the per-claim serial loop (≤8 × [web search + LLM arbitration + 250ms]) now rides a 3-worker pool, findings re-sorted by claimId so output is byte-identical to the serial version. | `lib/review-engine.ts`, `lib/fact-check.ts`, `api/ai/generate-full-v2/route.ts` |
| R2 (generate/verify pipelining, ~3-4 min) | `verify(i)` no longer blocks `generate(i+1)`: the adversarial verify runs ONE SECTION BEHIND the writer. Digest entries are appended pre-verify (claims stand; removals only strip `[n]` markers) and refreshed when the verify lands. Save/checkpoint/digest bookkeeping moved into `finalizePendingVerify` — paragraph order, checkpoint order and event payloads unchanged. Skip paths land their pending predecessor (no lost sections); the last section finalizes before compose. | `api/ai/generate-full-v2/route.ts` |
| R4 (review over-criticality) | Review prompt now emits `weakness_classes` (fixable \| advisory, one per weakness). A `major-revision` verdict only triggers a revision when ≥1 weakness is FIXABLE (breadth/novelty/scope complaints are disclosed, not chased). `citations < 6` stays an unconditional trigger (mechanically repairable). Missing/garbled classes fall back to fixable — legacy behavior preserved for weaker models. | `lib/review-engine.ts` |
| R6 (numeric-fact coverage) | `lib/numeric-sweep.ts` — a zero-LLM regex sweep cross-checks EVERY citation-bearing number+unit sentence against the cited references' own abstracts. Gaps are injected as ADVISORY weaknesses (capped 5, surface in the Review tab via mergedWeaknesses) and telemetry — they never start a revision round (an absent-from-abstract number is a verification gap, not proof of error). Hedged sentences and short abstracts skip. | `lib/numeric-sweep.ts`, route |
| R7 (web-search cache) | `lib/web-search-cache.ts` — 10-min TTL replay of healthy search outcomes inside `webSearchDetailed`: every caller (fact-check, gather, gap agent, coverage top-up) benefits with zero code changes. Failures are never cached; hits are deep copies (callers mutate evidence); bounded at 200 entries with soonest-expiry eviction. | `lib/web-search-cache.ts`, `lib/ai.ts` |
| R8/O1 | `db/custom.db` untracked from git + ignored — a `git stash` during a live run can no longer swap the SQLite file under the dev server. | `.gitignore` |
| R8/O2 | `full-generation-test.ts` report path pinned relative to the script (`<repo>/tool-results/`), not the launch CWD. | `scripts/full-generation-test.ts` |
| R3 (adaptive rate window) | NOT implemented this round — deliberately deferred (see §4). | — |
| R5 (bilingual canary) | Not run this round (needs the same quota the E2E needs) — scheduled next. | — |

## 2. QA results (all green)

| Suite | Result |
| ----- | ------ |
| Unit tests (bun test tests/unit) | **185 / 185** (146 pre-existing + 39 new: numeric-sweep 15, web-search-cache 9, review-engine-rt3 15) |
| Integration tests (live dev server) | **26 / 26** |
| ESLint | 0 errors / 186 warnings (baseline parity) |
| tsc --noEmit | 4 pre-existing baseline errors, 0 new |
| Browser UI (agent-browser) | Home render ✓, project switch ✓, article view (RT2 PIEZO article) ✓, Export menu ✓, 0 console errors — screenshots `shots/rt3-home.png`, `shots/rt3-article-view.png` |

New unit coverage highlights:

- **R4**: all-advisory major-revision does NOT trigger revision (the RT2
  churn case); ≥1 fixable does; missing classes fall back fixable; reject
  and citations<6 stay unconditional; CONTRADICTED/unhedged-UNVERIFIABLE
  hard-trigger unchanged.
- **R1**: the convergence gate stops on the exact RT2 shape (6→6 score, flat
  hard count, no new contradictions), never stops round 1, keeps going on
  ≥1-point gains, hard-finding shrinkage, or new contradictions; a worse
  score without new contradictions is converged churn; null scores are
  null-safe.
- **R6**: covered/absent/multi-ref/hedged/short-abstract/year/trivial-int/
  comma-thousands/cap/heading behaviors all pinned (including the
  `[1,2]`-marker-read-as-1.2 regression caught during development).
- **R7**: TTL replay, deep-copy isolation, failure-never-cached, key
  semantics, bounded eviction, stats/clear.

## 3. E2E full-generation run

**Status: BLOCKED by an account-level z-ai quota storm — not by any code
defect.** Hard-blocked from ~05:45 (and still blocked at 14:12, >8.5 h):
single-attempt probes AND 5-step exponential retry ladders all return
`429 Too many requests` at the account level, while the process-level
limiter window shows 0 in-flight calls (the storm is provider-side quota
exhaustion, not self-inflicted rate). This after ~2.5 h of heavy same-day
usage (two full RT2 runs + a stray browser-triggered adversarial review).

What the incident DID validate:

- The **storm pre-flight** (RT2) worked exactly as designed: 429 → 503 in
  ~1s with an honest error, no sources cleared, nothing consumed, no
  3-minute backoff theater.
- The **graceful-degradation contract** held: the failed launch left an
  empty project and a clean JSON report; the server stayed healthy (200s
  throughout); no partial state.

An auto-launcher remains armed (probes every ~2 min): the moment quota
returns, `full-generation-test.ts --words 1500` runs unattended and its
report lands in `tool-results/full-gen-test-report.json` +
`tool-results/e2e-rt3.log`. Comparison target when it runs (RT2 baseline,
GLM-4.6, 1500 words): 41.3 min total / gather→analyze 17.1 min /
generate+verify 7.8 min / repair 14.6 min / 0 citations removed / clean
mechanical audit. Expected RT3 deltas: repair rounds 3→≤2 (convergence +
advisory split), generate slice −30-40 % (pipelined verify), review rounds
faster (pooled fact-check), web-search re-queries free (R7 cache).

<!-- E2E-RESULTS:APPENDED-BELOW-WHEN-AVAILABLE -->

### E2E RESULTS — 2026-10-10 run (RT4-1, GLM-4.6, 1500 words, fresh clone)

**Completed end-to-end in 36.32 min.** Report:
`tool-results/full-gen-test-report.json` (log: `tool-results/e2e-rt4.log` /
`e2e-rt4-err.log`). NOTE: this run absorbed **two live 429 quota storms**
(storm #1 TTL 2 min at knowledge-verify batch 4, storm #2 TTL 10 min during
score) — the deltas below mix real RT3 wins with graceful-degradation
shortcuts, and are labeled as such.

| Metric | RT2 baseline | RT3/RT4-1 run | Verdict |
| ------ | ------------ | ------------- | ------- |
| Total wall clock | 41.3 min | **36.32 min (−12 %)** | real-but-degraded (see above) |
| gather | 3.2 min | 3.19 min, 209 sources | parity (RT2 accel held) |
| knowledge (full) | ~5 min (RT2 refactor) | **4.3 min** (5 batches + cross-check) | held / slightly better |
| score | 4.5 min (LLM) | ~5 min, **100 % mechanical fallback** (storm #2) | degraded, not a timing claim |
| generate + verify | 7.8 min serial | **~6.1 min, pipelined** — per-section verify (33-35 s) overlapped the next section's writing ("verification running in parallel" in every section message) | **R2 verified live** |
| repair loop | 14.6 min / 3 rounds | 11.7 min, round-1 scoped revision (§1,4) applied; re-review hit abort → loop ended by **abort, not convergence** | R1/R4 gates NOT exercised — needs a clean re-run (RT4) |
| Adversarial verify | 0 removed | **1 removed mid-pipeline** (sec 2, pre-compose); final export re-check: 21/21 supported, 0 removed, 0 flagged | held under degradation |
| Final article | 1883 w / 19 refs | **1252 w / 13 refs** (83.5 % of target — polish+relationships+peer-review were storm-skipped) | format held; word count low (degraded tail) |
| Mechanical audit | all green | **all green**: 0 CJK, 0 lists, 0 tables, 0 residual keys, 0 fullwidth punct, `**` balanced, 5 uniform `##` section heads, 27 markers → 13 cited = 13 listed, `[6,8]`-style multi-cites resolved | six-layer defense held through 2 storms |
| New RT3 features live | — | numeric sweep fired (2 advisories, capped, Review-tab visible); gap agent early-stopped at 100 % coverage after round 1; web-search cache warmed (unmeasured — see N6 gap) | R6 + coverage-driven gathering verified live |

What the storms proved (again, this time on the primary path):
score → mechanical fallback, repair re-review → abort (article stands as
repaired), polish/relationships/peer-review → skipped with honest messages,
export → clean JSON report, server → 200s throughout. Zero partial state.

**Observability gap found in this run**: `stats.gatherCoverage` /
`gatherTopUpNewItems` (RT2) never reached the complete-event payload (stats
keys omit them) and the web-search-cache counters are console-only — both
folded into RT4 N6.

**R1 (convergence) / R4 (fixable-vs-advisory) remain unvalidated on a clean
run** — the highest-priority follow-up test for RT4 (see N2).

## 4. Next-phase development suggestions (RT4, ranked)

### N1. Adaptive rate-limiter window (carried over from R3 — now blocking)

The RT3 E2E could not even launch: an account-level quota storm blocked all
calls for 4+ hours while the process-level limiter saw a healthy window
(0 calls in flight). The limiter only models SELF-inflicted rate (sliding
window of its own calls), not PROVIDER-side account state. Options:

1. **Persist the abort state** (file-backed) so a dev-server restart doesn't
   forget the storm and immediately re-probe.
2. **Storm backoff scheduler**: on pre-flight 429, schedule an escalating
   retry ladder (1 min → 5 min → 15 min → 60 min) surfaced on the SSE wire,
   instead of requiring the user to click generate again per attempt.
3. **Header-driven quota tracking**: parse Retry-After / X-RateLimit-Reset
   from 429 responses when present (the SDK surfaces headers via the
   captureHeaders hook — currently unused for rate state).

### N2. Repair-loop latency — validate and tune the RT3 gates with real runs

The convergence gate and fixable/advisory split are prompt-driven; their
behavior under a real 3-round repair loop needs measurement (rounds saved,
final verdict drift). Tuning candidates: the <1 score-gain threshold, the
advisory classification prompt wording per model, and whether PARTIAL
verify verdicts should count as fixable.

### N3. Generate/verify pipelining — measure the actual overlap

The verify now overlaps the writer, but both contend for the same LLM
token-bucket (1 call / 2s). Measure per-section wall time vs the serial
baseline; if the overlap is bucket-bound, consider a dedicated small-batch
verify queue (verify batches are short calls; the bucket spacing is not the
bottleneck at ~2s, but the sliding-window cooldown >15 calls/10min is).

### N4. Bilingual (both-mode) canary (carried over from R5)

Still unexercised since the cs-6/7 gates landed. One scheduled both-mode
run should precede any further translation-stage work.

### N5. Numeric-sweep escalation path

The sweep is advisory-only by design. After N2 measures the false-positive
rate (how many "absent from abstract" numbers are actually in the full
text), decide whether a high-confidence subset (exact token + unit match
domain) should hard-trigger a one-shot revision.

### N6. Web-search cache observability

The cache counters (hits/misses/evictions) should ride the complete-event
stats so re-run savings are visible in the test report (currently
console-only telemetry).

## 5. Ops notes discovered this round

- **Background-process survival**: processes backgrounded from a tool
  command with `setsid/nohup/disown` are reaped when the command exits;
  the orphan-subshell pattern `(cmd &)` survives. Dev-server restarts must
  use the latter.
- **Memory**: an idle open browser (4 Chrome renderers) + route compilation
  pushed next-server RSS to 1.8GB and drew the kernel OOM killer. Keep
  browsers closed during generation runs; `NODE_OPTIONS=--max-old-space-
  size=1536` caps the heap.
- **Quota storms are account-level and can outlast any process-level
  window** — see N1.
