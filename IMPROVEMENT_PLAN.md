# SciWrite v2 Pipeline — Next-Stage Improvement Plan

Generated 2026-09-29 from: (1) a four-layer comprehensive code review
(LLM / evidence-integrity / frontend-progress / infra-DB-export, 60+
findings, see worklog Task IDs CR-A/B/C/D); (2) **real production-run
forensics** — the round-5 canary's complete TaskRun timeline (2026-09-29
02:28–04:55 UTC, bilingual 3,000-word run, provider healthy→storm
mid-flight); (3) live incident reproduction (export-triggered OOM kill).

---

## 0. Real-run forensics (the data behind every item below)

Round-5 canary (Ferroptosis structural biology, 10 sections, 410 gathered
sources → 25 curated refs), stage wall-clock from the persisted timeline:

| Stage | Time | Notes |
|---|---|---|
| gather | **22.1 min** | 18 DB queries + web search theater + LLM query planning |
| knowledge | ~8 min | 40 batch events; healthy batches are 11–15s, gap-heavy 40–44s (the notorious "~4 min/batch" was pure 429-storm backoff math, not inherent) |
| score | 6.5 min | 266 sources, batched LLM |
| curate + plan | 1.3 min | 25/266 selected, 10 sections |
| gapAgent | 4.7 min | 3 gaps → 3 searches → 6 refs merged |
| analyze + allocate | 2.5 min | 76 evidence claims from 32 refs |
| generate + verify | **10.3 min** | 10 sections, 32–77s each — the CHEAPEST writing stage |
| repair | 18.6 min | 3 review rounds, 2 revisions |
| polish | 9.6 min | 20 findings, 2 passes |
| translate | **50.5 min → 10/10 FAILED** | 429 storm hit at 04:02; each section burned the full backoff chain (~4.5 min) before failing; wire already dead 45 min (canary 100-min cap) |
| relationships | 2 min | skipped (timeout) |

Total server-side ≈ 147 min; healthy-provider estimate ≈ 80–90 min.
Three structural conclusions: **(a)** per-section writing is fast and
cheap; **(b) the serial-LLM-call stages (gather planning, score, repair,
translate) dominate wall-clock; (c) storms turn any serial stage into a
fixed ~4.5 min/section money bonfire — now partially fixed (see P0).

---

## 1. P0 — already fixed this session (shipped, commit 3625582 + b39dc68)

1. **QuotaState never rolled over** (CR-A#1): one daily-quota exhaustion
   bricked every LLM call in the process forever (dev server lives for
   days). Fixed: exhausted readings >6h old auto-reset.
2. **Limiter didn't learn from failures** (CR-A#2): failed 429/5xx attempts
   now occupy sliding-window slots — the opening burst of a run can no
   longer self-trigger the provider's rolling limit.
3. **Flat 120s abort TTL** (CR-A#3): escalated 2min→10→30→60min on
   consecutive storms; the client no longer re-probes a throttled provider
   every ~2–4 min for hours (client-side storm persistence).
4. **chatStream ignored the stored model override** (CR-A#4): all streaming
   generation silently ran the default model.
5. **Knowledge-batch row-id cross-contamination** (CR-B#1): LLM
   locally-renumbered replies passed validation and wrote metadata fills
   onto *different* sources (citation-metadata corruption). Fixed: ids
   validated against the batch's own global range.
6. **Round-lock staleness < legitimate round length** (CR-D#2): a clean
   135-min round could get a second round started beside it → double
   pipeline → OOM. Fixed: a live PID is never reclaimed.
7. **SQLite busy_timeout = 0** (CR-D#3): recovery polling + compose
   transactions collided as `database is locked`. Fixed: 5s.
8. **Translate loop had no storm/disconnect short-circuit** (round-5
   post-mortem): 50 min / 100+ requests for zero output during a storm,
   45 min of it post-wire-death. Fixed: mirrors the generate loop's guard.
9. **Storm launches burned 3 minutes then fatal-rolled-back everything**
   (real-test finding RT-2, reproduced live): the gather query-planning LLM
   call has no try/catch — a launch during a 429 storm ran the full
   backoff chain, hit the fatal path, and the snapshot rollback erased even
   the freshly-gathered sources. Fixed: a one-call pre-flight on POST — 429
   storm → 503 in ~1s with an honest "nothing was consumed" message
   (verified: 0.5s rejection during the live storm), plus setAbort so
   re-clicks within the abort TTL cost zero provider calls.

## 2. P1 — scientific-accuracy enforcement gaps (the user's #1 priority)

The review's clearest verdict: **structural citation integrity is strong**
({{Rn}} keys, deterministic renumbering, heading pinning, citation-set
guards), but the **claim-truth layer is detect-only in too many places**.

| # | Item | Evidence | Fix sketch |
|---|---|---|---|
| P1-1 | **Adversarial-verify PARTIAL findings never reach the repair loop** — including the flagship "numeric mismatch" verdicts (CS-MAIN-4) | route.ts STEP 7 → `stats.citationsFlagged` only; STEP 8.5 builds `feedback.weaknesses` from fact-check + review only | Pipe `verifyResult.flagged` (esp. numeric mismatch) into the repair loop's weaknesses as `[VERIFY PARTIAL]` lines; numeric mismatches with confidence ≥ threshold should be removal-grade |
| P1-2 | Post-coverage-backfill tier re-gate compacts the pool but never remaps `sections[].refIndices` → wrong-paper-to-wrong-section allocation | route.ts 1571–1585; staleIndices only handles replaced slots | Identity-map remap after the gate (same pattern as compose's `refNumberMap`), or mark-and-strip with null placeholders until after allocation |
| P1-3 | Repair-loop `globalRefs` re-sync matches reference lines by exact string; first mismatch `break`s; stale list adopted while content is new → bilingual halves / paragraph sync can diverge from the EN reference list | route.ts 3280–3312 | Match by PMID/DOI identity (reuse `parseReferenceList` logic); skip unmatched, never break; re-derive from final refs on fallback |
| P1-4 | Translation citation drift is detected but only logged ("keeping translation as-is"); ZH-hallucinated `[n]` additions unchecked | route.ts 4205–4230 (round-5 run exercised exactly this path) | One retry with "restore citation markers verbatim"; then mechanical splice of EN markers; check `zhNums ⊆ enNums` too |
| P1-5 | Fact-check samples ≤8 claims/article and its verdicts are framed to the repairer as infallible ground truth — a false CONTRADICTED deletes a true claim | fact-check.ts 445, 616–622 | Feed STEP-7-flagged sentences into the claim pool (guaranteed coverage of suspects); require `evidenceQuote` non-empty for actionable CONTRADICTED |
| P1-6 | Adversarial verify caps at 2 sentences/ref/section; "topical match = SUPPORTED" lets same-topic-wrong-number pass | route.ts 4704–4721 | Raise the cap for numeric-bearing sentences; numeric mismatch ≥ threshold → removal-grade |
| P1-7 | `titleSimilarity` is asymmetric containment (short LLM suggestion ⊂ long real title scores 1.0) → real citation, wrong work | knowledge-verify.ts 375–382 | Symmetric Jaccard + suggestion-token coverage |
| P1-8 | Coherence polish always "fixes" the LATER section, propagating an error forward if the earlier value was the wrong one | coherence-polish.ts 196–204 | Let the reviewer name the authoritative section per finding; fall back to later-only when unspecified |
| P1-9 | `revisionGuard` floors (0.6) let a repair/polish silently drop 40% of citations and 40% of body words | v2-config.ts 59–64 | Tighten distinct-citation floor to ~0.85–0.9; per-section citation-count check on the scoped path |
| P1-10 | Section self-reference ("As detailed in Section 3" *inside* §3) survives polish | observed live in the canary-5 export | Mechanical detector: a section body referencing its own ordinal → cheap gate at compose |

## 3. P2 — throughput & reliability (measured, not speculative)

| # | Item | Measured impact | Fix sketch |
|---|---|---|---|
| P2-1 | **Knowledge stage re-design** (CR-B): complete rows (all three fields filled) still ride a full LLM round-trip each | 8 min healthy; 15 batches × ~12 sources | One aggregate gap-detection call over the pool + batch only gap-carrying rows; bounded concurrency 2–3 (abort architecture is already storm-safe) ≈ 3–5× stage speedup |
| P2-2 | **Translate stage concurrency + glossary reuse** | 50 min serial (storm); ~10–15 min healthy serial | Sections are independent post-compose; translate 2–3 in parallel with shared glossary; ~2–3× stage speedup |
| P2-3 | Gather: 22 min — web-search 1s sleeps × N queries + LLM planning + sequential NCBI | 22.1 min | Parallelize web queries (provider allows it when healthy), overlap DB+web phases, cache query plans per topic |
| P2-4 | **The double-run corruption chain** (CR-C#1+#2+#3): resume banner shows while a run is live (checkpoint `resumable:true` whenever a pool exists) + zombie sweep kills live slow-verify runs (20-min step silence; verify has no per-batch heartbeat) + null-path `setCurrentStep(STEPS.length)` re-enables Generate mid-probe | One click during the probe window launches a second pipeline on the same project → `clearSession` wipes paragraphs the live run references → checkpoint `runId_stage` unique-constraint collisions | (a) checkpoint route consults run-watch/TaskRun liveness before advertising resumable; (b) v2 POST rejects a second concurrent run per project; (c) verify emits per-batch events (mirror knowledge); (d) hold currentStep during the null-probe |
| P2-4b | **Gather LLM-failure has no mechanical fallback** (real-test RT-2, sibling of the fixed pre-flight): a mid-run storm at gather (after a healthy pre-flight) still fatals + rolls back; only empty-PARSE falls back to topic-word queries | gather is the FIRST LLM call — most exposed stage | try/catch around query planning → existing mechanical fallback → run continues with DB-only gathering; sources persist even if plan later fails (today the fatal rollback erases them) |
| P2-5 | **Export-path OOM** (reproduced live this session: docx/pdf export on the 2 GB dev server → kernel OOM kill at 2.3 GB RSS): export pulls `rawJson` for every dataSource (10–50 MB for a 150-source project) and runs the full appendix + EndNote enrichment for formats that discard them; `injectEndnoteFields` is O(n²) string copying | dmesg `Killed process 1597 anon-rss:2302712kB` during this session's export test | `select` excluding rawJson; gate appendix/enrichment on format; segment-join instead of slice-concat; consider moving export to a worker |
| P2-6 | Client render storm: server emits ~10 events/s with messages; client appends all 500 log rows with **index keys** → all rows re-render 10×/s for 1–2 h; autoscroll forces on every event | CPU burn on weak machines for the whole run — the same class of condition as the original freeze report | rAF/250ms throttle for streaming events; stable keys; autoscroll only when near-bottom |
| P2-7 | No AbortController in the SSE consumer; no user-facing Cancel; closing the dialog leaves the fetch running for the remaining 1–2 h | invisible token burn; "run invisible after reopen" feeds the double-run chain | Ref-held AbortController aborted on unmount + Cancel button (server 4-min grace already handles the wind-down) |
| P2-8 | Freshness matcher `startedAt ≥ runStart−60s` compares server ts to client clock and picks newest match | >60s clock skew → permanent "no record found"; two concurrent runs → displays the wrong one | Echo recorder `runId` in an early SSE event; match on runId; single-running-row acceptance |
| P2-9 | Generate-stage streaming lacks `accumulatedTail` (translate has it) — the live-preview footer stays empty during the longest phase | UI built for it, never fed | One-line: include `accumulated.slice(-300)` in generate streaming events |
| P2-10 | Storm-mode pacing: `withAbortWaitout` deadline is hardcoded 150s while escalated abort TTLs now reach 10–60 min | retry-once semantics silently became "fail fast" for escalated storms (acceptable, but undocumented) | Make the waitout deadline TTL-aware; document the contract |
| P2-11 | withRateLimit gives each of 5 attempts a fresh 300s budget (worst case 25–50 min/call on a slow-but-alive provider) | theoretical ceiling, observed near-misses | Budget the timeout across the whole withRateLimit call |
| P2-12 | canary fetch hard-capped at 100 min while a healthy bilingual run measures 80–90 min + any storm overruns | round-5 killed at cap; server kept going (now guarded by the translate short-circuit) | Raise the canary cap to 135 min (lock math now tolerates it) or scale to a storm factor |

## 4. P3 — hygiene & hardening (do opportunistically)

- **P3-1** `removeReferenceBlocks` false-positive class (CR-D#5): ≥3 lines with list markers + "et al"/URL/(19xx) deletes legitimate methods lists — tighten to ≥2 strong markers per line or terminal-block-only. Same family: the postscript cut on any "Note:" after char 500 (P3-2).
- **P3-3** `db/custom.db` (40 MB, user content) is tracked in git and pushed to the remote — remove from tracking, keep a seed/demo path (P3-4 documents the migration).
- **P3-5** Unattended git surgery (CR-D#4): `correctByRevert` runs `git revert` + `git reset --hard` on a shared tree; round pushes never pull/rebase (non-FF silently dropped). Abort correction on a dirty tree (except iteration-state); `git pull --rebase` before push.
- **P3-6** Mini-services lack single-instance guards (CR-D#1): this session found 2× scheduler consoles + 2× watchdogs + 4 zombie dev parents live simultaneously; the watchdog pair could double-fire pipelines on provider recovery. Port-bind/PID-file guard; retire mini-services/watchdog (its target projectId is dead).
- **P3-7** `scripts/` + `mini-services/` are excluded from tsc and have `noImplicitAny:false` — the riskiest code (git surgery, lock math — both already FATAL'd once) is un-typechecked. Add tsconfig.scripts.json.
- **P3-8** llm.ts residual (CR-A): `callZai` new-client-per-call without timeout; `api:*` paid providers inside the auto-fallback walk (silent credit burn); `eval("import")` hacks; cache key omits model; unbounded 30-min cache map; `compressPrompt` applied to SDK calls (24k cap on a 128k-context model); system prompt duplicated in llm-session.
- **P3-9** i18n gaps in recovery toasts/badges/step labels (CR-C#8); task-runs payload (full stepsJson × 50 runs per poll) needs a sinceTs cursor (CR-C#9); pipeline/language selectors stay enabled mid-run — switching disarms the stall watchdog (CR-C#11); accessibility (aria-live, role=log) for the 1–2 h progress UI (CR-C#14).
- **P3-10** `db:push --accept-data-loss` as the routine script name; export `bodyRefPmids` still has the substring-match bug class cs-7 fixed elsewhere (route line 278); llm-probe endpoint has no timeout (a hung provider hangs the probe).
- **P3-11** Keepalive relaunch uses non-detached spawn (CR-D#11) — contradicts the project's own setsid lesson; a relaunched dev server can be reaped with the console.

## 5. P4 — architecture: the multi-round agent the user asked for

The user's standing direction: "文章生成不再是一次生成…需要重复利用 agent
能力，长时间自主收集信息，和不断根据上下文打磨内容，尤其避免科学性错误
和文献引用错误." Current state vs. target:

- ✅ Gap agent: multi-round (merge → re-audit → pursue only new gaps), 6-ref budget, pool ceiling.
- ✅ Coherence polish: multi-pass (review → polish → re-review), mechanical gates per pass.
- ✅ Adversarial verify: numeric-first sentence selection.
- Next steps, in dependency order:
  1. **Close the enforcement gaps** (P1-1/5/6) — detection already exists; wiring it to repair is cheap and directly serves "避免科学性错误".
  2. **Evidence-driven revision rounds**: after repair, re-run verify on the
     CHANGED sentences only (scoped re-verification), until a clean pass or
     budget exhaustion — turns verify from a one-shot filter into a loop.
  3. **Deep-read on demand**: when verify flags a numeric mismatch, fetch the
     cited source's full text (PMC) and re-adjudicate with quote-level
     evidence before deleting the claim (pairs with P1-5's evidenceQuote
     requirement).
  4. **Writer-agent memory across sections**: today's continuity is a
     prompt digest; persist a structured claim-ledger (claim → source →
     section → status) that verify/repair/polish all read AND write —
     single source of truth for "what the article currently asserts".
  5. **User-visible provenance**: surface the claim-ledger in the UI (per-
     claim evidence links) — the ClawsGO-style traceability the auto-iterate
     timeline started.

## 6. Verification plan for each wave

- Wave 1 (P1-1..P1-6 + P2-4): synthetic seeded articles with known defects
  (existing test harness: test-format-cs7.ts pattern) + one real canary.
- Wave 2 (P2-1/2/2-5): timing A/B against the round-5 baseline table above
  (knowledge ≤3 min, translate ≤6 min healthy, export <10s/MB, RSS delta
  <300 MB).
- Every wave: tsc/lint gates + canary regression metrics (words/refs/parity/
  blocking) before/after, auto-revert on hard regression (iterate.ts).
