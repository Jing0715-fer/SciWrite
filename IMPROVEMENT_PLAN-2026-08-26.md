# SciWrite v2 Pipeline — Improvement Plan

Generated from a fresh end-to-end generation test on 2026-08-26
(test artifact: `tool-results/full-gen-test-report.json`).

## Test snapshot

| Metric                          | Value                          |
| ------------------------------- | ------------------------------ |
| Topic                           | CRISPR-Cas9 genome editing     |
| Target words                    | 1500                           |
| Generated body words            | 2726 (body only)               |
| Sections generated              | 7                              |
| References cited (unique)       | 17                             |
| Citation markers in body        | 53                             |
| Pipeline wall-clock             | 12.4 minutes (744 s)           |
| In-pipeline removals (verify)   | 8 citations                    |
| In-pipeline flags (verify)      | 5 citations                    |
| Compose audit blocking          | 0                              |
| Compose audit topicality warns  | 19                             |
| Independent adversarial review  | 30 checked / 28 SUPPORTED / 2 UNSUPPORTED |
| Independent review support rate | **93.3 %**                     |
| Independent review unsupported  | **6.7 %**                      |

## Issues surfaced by this run

### A1. Duplicate `[n,n]` citation markers (HIGH — fixed in this session)

**Symptom**

The generated article body contained the marker `[5,5]`:

> "7 Å across different Cas9 orthologs provide fundamental insights into
>  the molecular basis of RNA-guided DNA recognition and cleavage [5,5]."

A single bracket citing the same paper twice is semantically meaningless
and trips duplicate-citation audit warnings. The same defect class was
reported by the user in a previous meta-review (`[2,2]`, `[9,9]`).

**Root cause**

`convertKeysToNumbers()` in `src/lib/citation-binding.ts` builds the
output marker by joining all `oldToNew[n]` values for the keys inside a
single `{{R…}}` group, without deduplicating. So `{{R5,R5}}` → `[5,5]`.

`removeCitationsAndRenumber()` has the same defect in its keep-rewrite
path, and `sanitizeOutOfRangeCitations()` in `citation-audit.ts` only
filtered out-of-range numbers — a duplicate pair where both numbers are
in range slipped through unchanged.

**Fix applied (this session)**

1. `convertKeysToNumbers` Pass 3: `Array.from(new Set(newNums))` before
   sort+join → `{{R5,R5}}` becomes `[5]`, not `[5,5]`.
2. `removeCitationsAndRenumber` Pass 2: same dedup pattern in the
   `@@KEEP…@@` rewrite step.
3. `sanitizeOutOfRangeCitations`: even when every number is in range,
   duplicates are collapsed and the marker is rewritten.

Verified by inline tests in `scripts/`:
`{{R5,R5}} → [5]`, `[5,5]+remove(1) → [1]`, `{{R3,R5}} → [1,2]` (real
multi-cite preserved).

### A2. Section redundancy between "Molecular Mechanisms" and "Structural Insights" (MEDIUM)

**Symptom**

The planner generated two overlapping sections — "Molecular Mechanisms of
Cas9" and "Structural Insights into Cas9 Function" — that both cover the
bilobed architecture, HNH/RuvC domains, and the 2.5 Å crystal structure.
This is the same redundancy the user flagged in the previous meta-review
on an earlier v2 article. The earlier fix was applied at the
**post-hoc article-edit** level (manually merging the two paragraphs),
so it does not survive a fresh regenerate.

**Root cause**

The `plan` stage (LLM-designed outline) has no structural-overlap
detector; if the LLM emits two topically adjacent sections, nothing
pushes back.

**Proposed fix (future)**

In `/api/ai/generate-full-v2`, after the LLM returns the section list,
compute pairwise topicality (reusing `topicalityScore` from
`citation-audit.ts` with the new CJK-aware keyword extractor) between
section **titles + one-sentence purpose** lines. If any pair exceeds a
similarity threshold (e.g. 0.6), send a follow-up LLM call asking it to
merge the two sections into one and re-emit the outline. Cap at 2 merge
iterations to avoid loops.

Estimated effort: ~30 LOC + 1 LLM call per planning run (when triggered).

### A3. Verify stage serial + small batches (MEDIUM)

**Symptom**

The v2 pipeline spent ~470 s (8 of 12.4 min) in the per-section verify
stage. Each section makes 1 LLM call per batch of ≤10 citations, and
sections are verified serially after each section's generation.

**Root cause**

`VERIFY_BATCH_SIZE = 10` (line 83 of `generate-full-v2/route.ts`) was
chosen for prompt-size safety, but the prompt comfortably fits ~20
(sentence, citation, reference title/abstract) tuples under the 4 k
token ceiling we use. Sections are also verified immediately after each
section is generated (sequential), not in parallel.

**Proposed fix (future)**

1. Bump `VERIFY_BATCH_SIZE` from 10 → 20 (halve the LLM call count).
2. Optionally: collect all sections, then verify them in parallel with
   `Promise.all` (rate-limiter already prevents flooding). This trades
   wall-clock for ~7× concurrent LLM load.

Estimated speedup: ~3 min off a 12-min pipeline (25 % faster), with no
loss of accuracy.

### A4. Factual error in the body — "7 Å" instead of "2.5 Å" (LOW)

**Symptom**

The model wrote "7 Å across different Cas9 orthologs" when the canonical
resolution associated with Cas9 structure papers is 2.5 Å (Nishimasu
2014). The verify stage correctly flagged this as UNSUPPORTED because
the cited reference (Bravo 2022) does not mention 7 Å.

**Root cause**

The LLM occasionally confabulates specific numeric facts. The verify
stage catches the **citation mismatch** but not the **factual error**
itself; the sentence still ships with "7 Å" in the body.

**Proposed fix (future, exploratory)**

Cross-check canonical numeric facts against an external knowledge graph
(Wikidata SPARQL for "Cas9 crystal structure resolution"). This is out
of scope for the current iteration but worth tracking.

A lighter interim option: when the verify stage removes a citation
because of a numeric mismatch, also flag the sentence for human review
(extend `removedCitations` with a `factualIssue` field). The UI
(`paragraph-card.tsx`) already shows citation-audit findings — adding
a "review this sentence" pill is cheap.

### A5. Topicality warnings not surfaced in UI (LOW)

**Symptom**

The compose audit reported `19 topicality warnings` — these are
citation-claim pairs where the topicality score fell below the
"supported" threshold but above the "unsupported" threshold. They are
written to the audit report but not surfaced anywhere user-visible.

**Proposed fix (future)**

`citation-audit-banner.tsx` already renders the audit report. Add a
collapsible "Review suggested (low topicality)" section that lists
these pairs and links to the paragraph + sentence for the user to
review. ~50 LOC, mostly UI plumbing.

## Priority summary

| ID  | Issue                                | Priority | Status        |
| --- | ------------------------------------ | -------- | ------------- |
| A1  | Duplicate `[n,n]` citation markers   | HIGH     | **Fixed**     |
| A2  | Section redundancy (Molecular / Structural) | MEDIUM | Planned        |
| A3  | Verify stage serial + small batches  | MEDIUM   | Planned        |
| A4  | Factual error "7 Å"                  | LOW      | Tracked        |
| A5  | Topicality warnings hidden in UI     | LOW      | Planned        |

## Reproducing the test

```bash
# Dev server must be running on http://localhost:3000
bun run scripts/full-generation-test.ts --words 1500
# → JSON report written to tool-results/full-gen-test-report.json
# → run log to stderr / tee to tool-results/full-gen-test-run.log
```

## Comparison to previous runs

| Source                       | Run date   | Words | Refs | Unsupported rate | Wall-clock |
| ---------------------------- | ---------- | ----- | ---- | ---------------- | ---------- |
| v1 baseline (worklog §10)    | 2026-08-25 | 1614  | 19   | 41 %             | 5.8 min    |
| v2 evidence-grounded (worklog §10) | 2026-08-25 | 1822 | 15 | 8 %         | 9.3 min    |
| **v2 fresh run (this test)** | 2026-08-26 | 2726  | 17   | 6.7 %            | 12.4 min   |

The fresh run is consistent with the previous v2 measurement: low
unsupported rate (~7–8 %), no orphan or out-of-range citations, but
noticeably longer wall-clock (because we generated ~50 % more content).
The `[5,5]` defect is new — it was not observed in the previous run but
matches a defect class the user had reported on a different v2 article.
