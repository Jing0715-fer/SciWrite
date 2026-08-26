# SciWrite v2 Pipeline — Citation Accuracy Improvement Plan (v2)

**Focus**: 文献引用一定不能出错 — additional safeguards beyond the
already-shipped `[n,n]` deduplication fix.

Generated as a follow-up to IMPROVEMENT_PLAN.md, after the 2026-08-26 E2E
test exposed two UNSUPPORTED citations, both tied to the same broken
sentence:

> "7 Å across different Cas9 orthologs provide fundamental insights
>  into the molecular basis of RNA-guided DNA recognition and cleavage
>  [5,5]."

Both UNSUPPORTEDs came from one underlying problem class: **the model
wrote a specific factual number ("7 Å") that the cited reference does
not contain**. The verify stage caught the citation mismatch but only
AFTER generation — by then the body is already written around the wrong
number, so fixing it surgically is hard.

The improvements below attack the same failure mode from five different
angles. Each is rated by **impact on citation accuracy** (not overall
article quality) and **implementation effort**.

---

## Tier 1 — Highest impact, lowest effort (do first)

### C1. Numeric-fact cross-check (HIGH impact, LOW effort)

**What it does**

Before the expensive LLM verify pass, scan every cited sentence for
specific numeric facts and check whether the cited reference's
title + abstract contains the same (or a close) number. Flag mismatches
as "suspect" so the LLM verify pass focuses on them, and as a final
safety net, surgically strip the unsupported number from the sentence.

**Pattern**

```
sentence: "Crystallographic studies at 7 Å [5] reveal ..."
                  number: "7 Å"  ← extract
                  ref [5] title+abstract: "Structural basis for
                  mismatch surveillance by CRISPR-Cas9"
                  → does NOT contain "7 Å" → flag as suspect
```

**Number patterns to extract**

- Resolutions: `\d+(\.\d+)?\s*Å`
- Years: `\b(19|20)\d{2}\b`
- Sizes / masses: `\d+(\.\d+)?\s*(kDa|bp|nt|Mb|Gb)`
- Percentages: `\d+(\.\d+)?\s*%`
- Specific quantities: `\d+\s*(amino acids|residues|genes|mutations)`
- PDB IDs: `\b[A-Z0-9]{4}\b` (cross-check vs the reference's PDB ID
  if it's an RCSB entry)

**Tolerance**

- For resolutions: ±0.1 Å (so "2.5 Å" matches "2.5 Å" but not "7 Å")
- For years: exact match
- For counts: exact match

**What to do on mismatch**

1. Flag the citation as `numeric-mismatch` (a new `flagged` reason)
2. If the LLM verify pass ALSO judges it UNSUPPORTED with confidence
   ≥80, remove the citation AND rewrite the sentence to drop the
   unsupported number (e.g. "Crystallographic studies [5] reveal ..."
   instead of "Crystallographic studies at 7 Å [5] reveal ...").
3. If the LLM verify pass judges it SUPPORTED despite the number
   mismatch (rare — means the rest of the sentence IS supported),
   downgrade to PARTIAL so a human can review.

**Why this is high impact**

It would have caught BOTH of the 2 UNSUPPORTED citations in the 2026-08-26
test, BEFORE the expensive LLM verify pass — saving LLM calls AND
giving the model a chance to regenerate the sentence without the bad
number. The fix is purely deterministic (regex + string search), no
new external dependencies.

**Implementation**

- `src/lib/citation-audit.ts`: add `extractNumericFacts(sentence)` and
  `numericFactSupportedByRef(fact, ref)`.
- `src/app/api/ai/generate-full-v2/route.ts`: in the verify stage,
  run the cheap numeric check FIRST, only send `numeric-mismatch`
  citations to the LLM. Other citations skip the LLM call entirely.
- Estimated: ~150 LOC, ~30 min.

### C2. Reference abstract availability gate (HIGH impact, LOW effort)

**What it does**

Before the allocate stage, drop any curated reference whose abstract
is shorter than 200 characters OR whose abstract text matches the
"RCSB-method-leakage" pattern (organism names, "Method: X-ray",
"Resolution: Y Å" — symptoms of the previously-fixed RCSB pubmed
field bug).

**Why this is high impact**

If a reference has no real abstract, the LLM verify pass has nothing
to check topicality against — it can only look at the title. Titles
are short and ambiguous, so the verdict is essentially a coin flip.
Dropping these references before allocation forces the curate stage
to pick alternatives with real abstracts, eliminating the entire
class of "verify couldn't tell, so it let a bad citation through"
failures.

**Implementation**

- `src/lib/generate-full-helpers.ts`: in `curateReferences`, after
  selecting the top-N, filter out any whose `abstract` fails the
  availability check. Replenish from the candidate pool if available.
- `src/lib/databases.ts`: in the RCSB and PubMed paths, log (don't
  silently swallow) cases where the abstract is missing — surface as
  a `gatherWarnings` field in the pipeline telemetry.
- Estimated: ~80 LOC, ~15 min.

### C3. Bibliography completeness as a blocking save gate (HIGH impact, LOW effort)

**What it does**

The compose stage already calls `buildAuditReport` which detects
orphan references (in `## References` but not cited in body) and
out-of-range citations (in body but not in `## References`). Currently
these are reported as findings but DO NOT block the save. Make them
blocking: if any blocking finding exists, do NOT save the article;
instead, regenerate the affected section.

**Why this is high impact**

This is the "circuit breaker" — if the structural binding somehow
fails (e.g. an LLM error produces a citation [99] for a 17-ref
article), the bad article never reaches the user. Currently a bad
article can be saved with `0 blocking` because the LLM verify may
have skipped the bad citation; this gate would catch it
deterministically.

**Implementation**

- `src/app/api/ai/generate-full-v2/route.ts`: in the compose stage,
  check `auditReport.blocking > 0` and if so, fall back to
  per-section regeneration (already implemented as the gate retry
  loop — just extend it to cover the post-compose audit too).
- Estimated: ~40 LOC, ~10 min.

---

## Tier 2 — High impact, medium effort (do next sprint)

### C4. Two-pass adversarial verification (cheap deterministic + expensive LLM)

**What it does**

Today the verify stage sends EVERY citation to the LLM in batches
of 10. With 50 citations × 7 sections, that's 5+ LLM calls per
section just for verify. Replace with:

1. **Pass 1 (cheap, deterministic, no LLM)**: For each (sentence,
   reference) pair, compute `topicalityScore` (already in
   `citation-audit.ts` with CJK support). Score < 0.02 → mark
   `suspect-weak`. Numeric mismatch (C1) → mark `suspect-numeric`.
2. **Pass 2 (expensive, LLM)**: Only send `suspect-*` citations to
   the LLM for adjudication. Citations that pass Pass 1 with a high
   topicality score AND no numeric mismatch are auto-supported.

**Why this is high impact**

Two effects:
- Cuts LLM verify calls from ~50 per article to ~10 (only the
  suspects), making the pipeline ~3 minutes faster (Tier-2 item A3
  from the original plan, now achieved differently).
- The LLM verify focuses on actually-suspicious cases, so its
  limited attention is spent where it matters. This should reduce
  false SUPPORTED verdicts (the LLM rubber-stamping citations that
  topicality already flagged as borderline).

**Implementation**

- `src/app/api/ai/generate-full-v2/route.ts`: replace the existing
  verify loop with the two-pass version.
- New helper in `citation-audit.ts`: `preVerifyCitations(body, refs)`
  returns `{ autoSupported: number[], suspects: {n, sentence, ref,
  reason}[] }`.
- Estimated: ~200 LOC, ~45 min.

### C5. Compose-time reference identity re-verification (HIGH impact, MEDIUM effort)

**What it does**

After the compose stage renumbers references globally, the citation
`[5]` in the final body may point at a DIFFERENT paper than the
`{{R5}}` the model originally bound it to (because renumbering is
based on first-appearance order, and the model may have intended a
different ordering). Today there is no post-compose check that the
new (citation, reference) pairs are still semantically aligned.

**Fix**

After compose, re-run the cheap topicality pre-verify (C4 Pass 1) on
the FINAL article body. Any pair with topicality < 0.02 is flagged
for the user, and any with topicality < 0.001 is auto-removed (with
a console warning so it's visible in dev.log).

**Why this is high impact**

The v2 architecture's structural binding prevents the original
[number drift] failure, but it doesn't prevent the LLM from
COPYING THE WRONG KEY (e.g. writing `{{R5}}` when the sentence is
about something R5 doesn't cover). The compose-time re-verification
catches that.

**Implementation**

- `src/app/api/ai/generate-full-v2/route.ts`: after compose, call
  `preVerifyCitations(articleBody, finalRefs)` and apply the
  conservative auto-removal.
- Estimated: ~120 LOC, ~30 min.

### C6. Per-claim citation sufficiency check (MEDIUM impact, MEDIUM effort)

**What it does**

Today the verify stage treats each (sentence, citation) pair
atomically. But a sentence can have multiple atomic claims ("Cas9
has a bilobed architecture with HNH and RuvC nuclease domains and
recognizes a 5'-NGG PAM via the PAM-interacting region [5]") — if
[5] supports only 2 of 4 claims, the citation is partially
unsupported, and the LLM may judge it SUPPORTED (because the
sentence "as a whole" mentions things the reference covers).

**Fix**

In the verify stage prompt, ask the LLM to first split the sentence
into atomic claims, then for each claim decide SUPPORTED/PARTIAL/
UNSUPPORTED against the cited reference. Take the WORST verdict as
the sentence's overall verdict.

**Why this is medium impact**

Most sentences have 1-2 atomic claims; only the "kitchen sink"
sentences the model sometimes writes have 4+. But those are also
the sentences most likely to have a citation mismatch, so this
helps where it matters most.

**Implementation**

- Modify the verify LLM prompt in
  `src/app/api/ai/generate-full-v2/route.ts` to ask for per-claim
  verdicts. The output schema changes from `N|VERDICT|CONFIDENCE|reason`
  to `N|CLAIM|VERDICT|CONFIDENCE|reason` with one row per claim.
- Aggregate: VERDICT = worst-of-claims, CONFIDENCE = min.
- Estimated: ~150 LOC (mostly parsing), ~45 min.

---

## Tier 3 — Architectural (do long-term)

### C7. Two-model verification (second opinion)

Use a DIFFERENT LLM for the verify stage than for generation.
Reduces shared blind spots — if the generation model has a bias
(e.g. over-citing Bravo 2022 for any structural question), a
different verify model is more likely to catch it.

**Implementation**: extend `src/lib/llm.ts` `decideProviderOrder` to
accept a `preferDifferentFrom` hint; the verify stage passes the
generation model's name and gets a different one.

### C8. Web-search fact-checking for canonical claims

For sentences containing specific named entities (PDB IDs, gene
symbols, canonical numerical values), run a focused web search and
check that the cited reference + search results agree. Catches
the "7 Å" class of factual errors that the cited reference can't
catch on its own (because the cited reference doesn't mention 7 Å
OR 2.5 Å — it just doesn't discuss resolution at all).

**Implementation**: add a new helper that, given a (sentence, ref)
pair with a numeric fact, runs `webSearch(ref.title + " " + fact)`
and checks whether the top result snippet contains the fact.

### C9. Citation graph integrity check

Build a bipartite graph: claims ↔ references. Detect:
- **Star pattern**: one reference cited by 5+ sentences (over-reliance)
- **Isolated reference**: in ## References but cited <2 times
  (under-utilization — why is it there?)
- **Cycle**: rare, but if claim A → ref X → claim B → ref Y →
  claim A, indicates a logical loop.

**Implementation**: post-compose graph analysis in
`src/lib/citation-audit.ts`, surface as `structuralFindings` in the
audit report.

### C10. User-facing citation review UI

Surface every citation with its verdict (auto-supported,
LLM-supported, partial, unsupported, flagged, removed) and let the
user override. The verify stage ALREADY produces this data; the UI
just needs to render it. This is Tier-2 item A5 from the original
IMPROVEMENT_PLAN.md, but worth restating because it's the user's
last line of defense.

**Implementation**: extend `citation-audit-banner.tsx` with a
per-citation table; ~80 LOC of UI plumbing.

---

## Priority matrix

| ID  | Issue                                       | Tier | Impact | Effort | Status   |
| --- | ------------------------------------------- | ---- | ------ | ------ | -------- |
| C1  | Numeric-fact cross-check                    | 1    | HIGH   | LOW    | **Planned** |
| C2  | Reference abstract availability gate       | 1    | HIGH   | LOW    | **Planned** |
| C3  | Bibliography completeness as blocking gate  | 1    | HIGH   | LOW    | **Planned** |
| C4  | Two-pass verification (cheap + LLM)         | 2    | HIGH   | MED    | Planned  |
| C5  | Compose-time reference identity re-verify  | 2    | HIGH   | MED    | Planned  |
| C6  | Per-claim citation sufficiency check        | 2    | MED    | MED    | Planned  |
| C7  | Two-model verification (second opinion)     | 3    | MED    | HIGH   | Future   |
| C8  | Web-search fact-checking                    | 3    | HIGH   | HIGH   | Future   |
| C9  | Citation graph integrity check              | 3    | MED    | MED    | Future   |
| C10 | User-facing citation review UI              | 2    | MED    | LOW    | Planned  |

---

## What would have caught the 2026-08-26 test failures

| Failure mode                                  | Catches it                |
| --------------------------------------------- | ------------------------- |
| `[5,5]` duplicate citation                    | (already shipped: A1)     |
| "7 Å" not in ref [5]'s abstract               | **C1 (numeric)** + C8     |
| Ref [5] has weak abstract → verify rubber-stamps | **C2 (abstract gate)** |
| Compose renumbering drifts citation → ref map | **C5 (re-verify)**         |
| LLM over-cites one reference across sentences | C9 (graph) + C7 (2-model) |

The Tier-1 items (C1, C2, C3) together would have caught both of the
2 UNSUPPORTED citations in the 2026-08-26 test BEFORE the LLM verify
pass even ran — making the pipeline both faster AND more accurate.
