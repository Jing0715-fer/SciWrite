# SciWrite v2 Pipeline — Improvement Plan (RT2, 2026-10-09)

Generated from two fresh end-to-end generation tests on 2026-10-09:

- Baseline (old code, GLM-4.6, 1500 words): stage timings captured up to
  generate; the run died at compose from an infrastructure fault (dev-server
  SQLite handle went stale after a `git stash` cycled the git-tracked
  `db/custom.db` underneath the running process — see Ops note O1).
- RT2 run (new code, GLM-4.6, 1500 words): completed in **41.3 min**,
  1883 body words, 19 refs, 33 markers, **0 citations removed** by the
  adversarial review (100 % support on checked pairs; 1 PARTIAL flagged).
- RT2-flash run (new code, glm-4-flash weaker model): format-defense
  validation (see §3).

## 1. Measured effect of the RT2 changes (old → new code, same topic/model)

| Stage | Old code | New code | Δ |
| ----- | -------- | -------- | - |
| gather (272→205 sources) | 6.42 min | 3.28 min | **2.0×** |
| knowledge pass (23 serial batches) | 12.75 min | 5.25 min (5 fill batches in a pool of 3 + 1 gap digest) | **2.4×** |
| score (10 serial batches) | 4.5 min | 1.9 min (pooled 3) | **2.4×** |
| curate + full-text fetch | 2.5 min | 0.8 min | 3.1× |
| plan | 0.6 min | 0.6 min | — |
| gap agent | 3.9 min (fixed 2-round budget) | 4.5 min (1 round, then **coverage-driven early stop**) | quality ↑ |
| analyze | 1.9 min | 0.8 min | 2.4× |
| **gather → analyze total** | **32.0 min** | **17.1 min** | **1.9×** |

The user-facing "information gathering" slice (gather + knowledge + score)
went **23.7 min → 10.4 min (2.3×)**.

Format quality of the final article (mechanical audit of the composed body):
0 CJK characters, 0 list lines, 0 internal headings, 0 tables, 0 leftover
`{{Rn}}` / `[Rn]` junk markers, 0 fullwidth punctuation, balanced `**`,
19/19 references present and cited, clean `##` section structure, correct
2.5 Å figure (the previous A4-class numeric error did not reproduce).

New agent behaviors observed live:

- Coverage check announced "12/12 topic facets covered" → **no** top-up
  round spent (the correct decision — the old code had no such check).
- Gap agent merged 6 refs in round 1, then stopped with
  "coverage sufficient (100 %, no uncovered facets)" instead of re-auditing.

## 2. Remaining wall-clock structure (RT2 run, 41.3 min total)

| Slice | Time | Note |
| ----- | ---- | ---- |
| gather → analyze | 17.1 min | addressed by RT2 (1.9×) |
| generate + per-section verify | 7.8 min | serial by design (continuity digest) |
| **auto-review & repair (STEP 8.5)** | **14.6 min** | 3 review rounds + 2 revisions — now the single biggest slice |
| compose + title + relationships | ~2 min | |

## 3. Next-phase development suggestions (ranked)

### R1. Repair loop latency (HIGH — 14.6 min, 35 % of wall-clock)

The review→revise→re-review loop ran 3 rounds. Each round = full-article
review (1 call) + fact-check (≤8 web searches + adjudications) + scoped
revision (1 call). Opportunities:

1. **Early-exit on convergence**: stop when the overall score improves by
   < 1 between rounds AND no new CRITICAL finding appears (the run ended
   6/10 → "revision budget exhausted"; rounds 2-3 bought ~1 finding each).
2. **Parallelize the fact-check web searches** (currently ≤8 serial
   `webSearch` calls inside factCheckArticle — same `runWithConcurrency(3)`
   treatment the gather loop got).
3. **Overlap repair with translation**: sections already accepted by the
   reviewer can start translating while later sections are still being
   revised (currently translation waits for the whole EN half to settle).

### R2. Generate/verify pipelining (MEDIUM — ~3-4 min)

`verify(section i)` currently blocks `generate(section i+1)`. The
adversarial verify only reads the section + its refs — it can run one
section behind the writer. The continuity digest only needs the WRITTEN
sections, so a one-section lag is safe. Estimated 30-40 % off the 7.8-min
generate slice.

### R3. Rate-limiter window vs. batch concurrency (MEDIUM)

The knowledge/score pools are bounded by the sliding window (20 calls /
10 min) more than by the pool size: with 60 LLM calls before generate,
calls pace at ~30 s each during storm-free runs. Options:

1. Adaptive window: probe the provider's real limit (headers on 429s) and
   scale the window instead of assuming 30/10min.
2. Batch-size growth (12→16-20 for knowledge fills): fewer calls for the
   same rows when the provider is healthy (the JSON contract held fine at
   12; 16 is a measured step).

### R4. Review-model over-criticality (MEDIUM — quality)

The final verdict stayed "major-revision (6/10)" after 3 rounds with 0
unsupported citations and 1 PARTIAL. The rubric likely punishes review-style
articles for breadth ("not enough X") in ways a writer can never fix within
budget. Suggested: separate **fixable** (fact/citation/structure — drives
rounds) from **advisory** (breadth/novelty — surfaces in the Review tab
only) findings in the review prompt, and let only fixable findings extend
the loop.

### R5. Bilingual (both-mode) regression run (MEDIUM)

All RT2 runs were `language: en`. The translate stage (glossary + per-section
translation + ZH reference mirror) was not exercised. The cs-6/7 format
gates apply to the ZH half differently (no ASCII punctuation conversion, no
CJK strip). A both-mode canary should be the next scheduled run.

### R6. Numeric-fact checking remains sampled (LOW)

The 2.5 Å fact was correct this run, but numeric claims are still only
checked where a citation pair happens to be verified (≤2 sentences/ref) or
via the ≤8-sentence fact-check sample. The A4-class escape surface is
narrower but not closed. Candidate: a cheap regex sweep for
`number + unit` patterns (Å, nm, kDa, %, fold, bp) that cross-checks each
against the cited reference's abstract before the verify stage.

### R7. Web-search result cache (LOW)

2/6 web searches in the RT2 run were degraded by hosted-search rate
limits. Search results for a given query are stable for minutes — an
llm-cache-style TTL map (query → items, 10 min) would make re-runs and
canary retries free on that axis.

### R8. Ops items (HYGIENE)

- **O1**: `db/custom.db` is git-tracked (40 MB). `git stash` during a live
  run swapped the file under the dev server's SQLite handle →
  "readonly database" at compose. Suggested: stop tracking the DB (or move
  it out of the repo), and never stash while a pipeline run is live.
- **O2**: `scripts/full-generation-test.ts` writes its report to
  `tool-results/` of whatever CWD it runs from — running from the repo
  wrote into `/home/z/my-project/tool-results/` this session. Pin the
  output path relative to the script.

## 4. Multi-model format hardening — what changed (summary)

The "GLM-4.6 fine, other models messy" failure had six root causes; all
are now closed:

| # | Root cause | Fix |
| - | ---------- | --- |
| 1 | `maxTokens` silently dropped for every non-zai provider → sections cut at provider defaults (often 4k) mid-sentence | forwarded through `chat()` / `chatWithSessionId()` (`ai.ts`) |
| 2 | Weak local JSON parsers in review-engine / fact-check / gather / outline / source-relationships → phantom "major-revision" fallbacks, ERROR verdicts, no-op stages | single canonical `parseLlmJson` (`lib/llm-json.ts`): fences, top-level arrays, JSON5, mechanical repair, `<think>` strip |
| 3 | Near-miss citation keys (`[R5]`, `{{R1-3}}`, `{{R1;R2}}`, `｛｛R5｝｝`, `{{{R5}}}`) leaked as literal text and evaded the zero-cite gate | `normalizeCitationKeyVariants` (`citation-binding.ts`) runs before every gate and conversion |
| 4 | No truncation detection (finish_reason ignored) | `looksTruncated` gate dimension with a COMPLETION retry |
| 5 | CJK leak retry adopts only when strictly better → Han chars could ship | unconditional `stripResidualCJK` backstop after the format gate |
| 6 | llm-cache keys ignored provider/model → 30-min cross-model answer replay after a switch | selection-aware cache keys |

Plus: the format gauntlet (ASCII punctuation, markdown normalization,
uniform template, reference-block strip, role-label echo strip) now covers
**every** output path — v2 generate (already had it), v1 compose,
`/api/ai/write`, `paragraphs/[id]/regenerate`, and `paragraphs/[id]/revise`
(previously saved raw LLM output verbatim).

## 5. Agent-controlled gathering — what changed (summary)

- **Coverage-driven top-up (STEP 1.2)**: after the initial gather, a
  mechanical facet-coverage assessment (`lib/gather-coverage.ts`) measures
  how well the pool covers the topic's facets; uncovered/weak facets
  trigger ONE bounded, targeted query round (LLM-designed, mechanical
  fallback) instead of blind re-searching.
- **Need-based knowledge pass**: only incomplete rows ride the LLM fill
  batches (pooled, 3 concurrent); complete rows feed one title-only
  gap-digest call.
- **Gap agent early stop**: round 2 runs only when coverage actually
  improved and marginal yield ≥ 2 new refs — otherwise it stops with the
  reason surfaced on the wire.
- **Honest keep-0 fallback**: the relevance gate's empty verdict is now
  distinguished from an unparseable answer; a genuine rejection triggers
  mechanical topical ranking (≥ 2 gap-keyword overlap) instead of
  admitting every PubMed candidate.

## 6. Reproducing the tests

```bash
# Dev server must be running on http://localhost:3000 (DATABASE_URL
# pointing at the repo's db/custom.db — see .env note in worklog RT2-0).
bun run scripts/full-generation-test.ts --words 1500
# → JSON report + stage timeline (tool-results/full-gen-test-report.json)

# Switch model (then re-run):
curl -X POST localhost:3000/api/llm-config/select \
  -H 'Content-Type: application/json' \
  -d '{"provider":"zai-sdk","model":"glm-4-flash"}'
```
