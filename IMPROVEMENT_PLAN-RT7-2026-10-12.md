# SciWrite RT7 — Skill Migration Completion + Step-Namespace Hardening (2026-10-12)

RT7 executes the RT6 backlog (IMPROVEMENT_PLAN-RT6 §6, items 1 + 3 + 5):
the B-family stragglers (coherence, gap agents, knowledge-verify), the
SSE-step literal → constant migration, and per-skill degradation surfacing.
The skill catalog grows from 9 to 15; the two remaining out-of-namespace
session-step emitters ("coherence", "knowledge-verify") are unified; every
`step:` literal in both pipelines now fails the compiler on a typo.

## 1. What RT7 migrated

| Skill | File | Legacy site | Fallback contract |
| ----- | ---- | ----------- | ----------------- |
| `coherence-review` | skills-coherence.ts | coherence-polish.ts reviewArticleCoherence (LLM block) | empty findings ⇒ caller wraps as ran:false + error (legacy catch) |
| `coherence-edit` | skills-coherence.ts | coherence-polish.ts polishArticleCoherence (per-section, prose) | degenerate (≤80 chars) or provider failure ⇒ the ORIGINAL section text (per-section catch: section kept as-is) |
| `gap-design` | skills-gap.ts | research-gap.ts identifyEvidenceGaps (LLM pass) | empty gaps ⇒ mechanical gaps still run at the call-site |
| `gap-research` | skills-gap.ts | research-gap.ts runGapResearch (relevance gate) | provider failure ⇒ PubMed candidates' C-ids (legacy catch); parse failure distinguished from genuine keep-0 via `parseOk` (round-RT2 semantics preserved) |
| `knowledge` | skills-knowledge.ts | knowledge-verify.ts verifySourcesWithKnowledge (per-batch fill) | NO fallback — provider failures rethrow so the caller's catch keeps the storm/timeout semantics (stormHit skip, ChatTimeoutError ×2 stall detection) verbatim |
| `knowledge-summary` | skills-knowledge.ts | knowledge-verify.ts round-RT2 gap digest | empty missing (additive stage, never load-bearing) |

### Framework slots the migrations exercised

- **Prose slot (2nd user)**: coherence-edit confirms the RT6 pattern —
  identity `parse`, wrapper-stripping + degenerate-length guard in
  postProcess/validate, fallback = the input's original text.
- **parseOk flag**: gap-research's `parse` uses parseLlmJson (not
  safeParseJSON) and threads the ok-flag through the output so the caller
  can distinguish "the gate never spoke" from "the gate kept nothing".
- **Hard-fail skills (2nd/3rd users)**: knowledge fill joins review/revision
  — no fallback by design; storm semantics belong to the pool owner.
- **Cross-batch state stays at the call-site**: gatheredTitleKeys dedupe,
  the need-based batch pool, the ≤5-section polish loop, dedupe identity
  sets, keep-0 keyword ranking — all pool orchestration, not skill logic.

### Step unification (RT6 §1 continued, final two emitters)

| skill id | taskType | sseStep (metadata.step) | was |
| -------- | -------- | ----------------------- | --- |
| coherence-review | review | **polish** | step "coherence" (out of namespace) |
| coherence-edit | revise | **polish** | step "coherence" (out of namespace) |
| gap-design | gather | gapAgent ✓ | step "gapAgent" (already in namespace) |
| gap-research | gather | gapAgent ✓ | step "gapAgent" (already in namespace) |
| knowledge | gather | **knowledge** | step "knowledge-verify" (out of namespace) |
| knowledge-summary | gather | **knowledge** | step "knowledge-verify" (out of namespace) |

Verified in the DB by the live smoke (session rows carry
`step=knowledge skill=knowledge-summary sub=gapDigest`,
`step=polish skill=coherence-review sub=review`, …).

## 2. Step-namespace hardening (backlog item 3)

- `steps.ts` gains `STEP: { [K in PipelineStep]: K }` — property access
  with literal-preserving types.
- v2 route: **145** inline `step: "…"` literals → `STEP.…` (19 distinct
  values, all pre-verified inside PIPELINE_STEPS); v1 route: **100** →
  `STEP.…` (13 distinct). Pre-migration audit found ZERO out-of-namespace
  literals — the wire was already clean; now the compiler enforces it.
- Client copies unified onto the same namespace:
  - unified-writing-dialog STEPS: 22 ids → `STEP.…`
  - run-timeline-dialog STEP_LABEL_KEYS: `Record<PipelineStep, TranslationKey>`
    — exhaustive with explicit label slots for the 7 namespace-only steps
    (title/wordcount-retry/density-retry/glossary/adversarial-verify/
    paragraph/done fold onto their parent stages' labels).
- The dual i18n label sets (STEP_TITLES vs oneClick.stepXxx) remain —
  unified label sourcing deferred to RT8 (client i18n key derivation).

## 3. Degradation surfacing (backlog item 5)

`telemetry-collector.ts` — module-level, observer-only aggregate
(calls / degraded / cacheHits / totalMs per skill):

- executor `finish()` reports every invocation (all outcomes);
- v2 route resets at pipeline start and reads at the complete event:
  stats now carry `skillDegraded: {skill: n}` (only degraded skills — the
  compact "what went soft" view) and `skillCalls: {skill: n}`.

A run that quietly degraded three skills no longer looks identical to a
clean one in the final stats block.

## 4. QA results

| Suite | Result |
| ----- | ------ |
| Unit | **312/320** — 291 baseline + 30 new (6-skill contracts, cleanFill/validFill kernel relocation lock, CR-B#1 range check, MISSING-only policy, sentinel echoes, parseOk distinction, degenerate guard, collector). The 8 failures are the pre-existing llm-cache suite-order interference (env-dependent; passes 18/18 in isolation; pristine df904c7 shows the same 8). |
| Integration (live :3001) | **26 / 26** (after sandbox-restore DB init) |
| ESLint | 0 errors (193 warnings — below the RT6 baseline count) |
| tsc --noEmit | 4 pre-existing baseline errors, 0 new |
| Live smoke (skill-smoke-rt7.ts) | **RT7_SMOKE_PASS** — 4 real LLM calls: knowledge-summary named 8 real missing works (Jinek 2012 et al.), gap-design 3 gaps with valid queries, coherence-review caught all 5 injected cross-section defects (repetition/contradiction/terminology/transition/cross-ref), coherence-edit re-edited to 394 chars; session metadata unification verified IN THE DATABASE |
| E2E full generation (1500 words) | **PASS — 34.3 min, zero 429 storm, zero degraded skills** (details in §5) |

## 5. STATUS (final)

- [x] B-family stragglers complete — skill catalog 9 → 15
- [x] Step namespace: no out-of-namespace emitters remain; 245 route
      literals + 2 client copies constant-backed (compiler-enforced);
      title-generation events now carry `step: STEP.title` (both routes —
      previously the only step events WITHOUT a step field, rendering as
      "unknown" in progress logs)
- [x] Per-skill degradation counts in the complete-event stats block
- [x] Live smoke RT7_SMOKE_PASS with unified session metadata
- [x] **E2E full generation, 1500 words — 34.3 min, ZERO storm** (the
      first clean-window validation; RT4's "E2E in a clean window" goal
      finally realized — RT6's run rode a 429 storm + 10min cooldown):
      - 196 sources gathered → 154 saved → 26 curated → **20 final
        references**; 12/12 topic facets covered (100% gather coverage).
      - 7 sections, 7 paragraphs, **1695 EN words (113% of target)**;
        complete payload 2429 words.
      - **37 citations adversarially verified, 1 removed**; independent
        post-hoc adversarial re-review ([4/4]): 33 checked, 27 SUPPORTED,
        1 PARTIAL, 5 UNSUPPORTED, 0 removed.
      - Repair loop: round 1 major-revision 5/10 → 1 scoped revision →
        round 2 minor-revision 6/10 (converged); fact-check v4 c0 u0 e0.
      - Coherence polish: 2 passes (pass 1 polished §5/6/7 — 5 findings;
        pass 2 re-review found 7 newly-exposed findings, polished §2/5/6/7).
      - Mechanical audit: 0 blocking errors, 0 orphans, 18 topicality
        warnings; 39 markers / 20 unique / 20 listed refs.
      - **skillDegraded: {} — zero degraded skills across the whole run**;
        skillCalls: 41 invocations / 12 of 15 skills (knowledge×4,
        knowledge-summary×1, score×8, curate-smart×1, gap-design×1,
        gap-research×1, evidence-extract×3, fact-check×8, review×2,
        revision×3, coherence-review×2, coherence-edit×7).
      - Browser: home + article + run-timeline render with zero console/
        page errors (timeline step labels all resolve — the constant-backed
        Record<PipelineStep,…> map verified live); mobile 390px no
        horizontal overflow (shots/rt7-article.png, shots/rt7-home-mobile.png).
      - Incident (environment, non-functional): the dev server (next dev,
        unoptimized runtime + on-demand compilation) hit **2.3GB RSS during
        the post-pipeline adversarial re-review and was OOM-killed** by the
        3.9GB container — the CR-B-“RSS→2GB” class. All E2E artifacts had
        already hit disk (DB + report JSON); the server restarted clean and
        all browser verification passed post-restart. Logged as an RT8
        candidate (adversarial-review prompt budget / dev-mode memory cap).

## 6. RT8 backlog (ranked)

1. **plan / generate / verify v1+v2 merge** (RT6 backlog #2, deferred):
   each stage exists twice; one skill per stage with v2 as the only
   orchestrator. The biggest structural win left.
2. **generate/translate as skills** (RT6 backlog #4): the generator prose
   skills carry retry gates + word-count loops — needs an executor
   extension for "streaming + adopt/reject loops", or stays hand-rolled
   by design. Decide with data (skillCalls now measures what's left
   un-skill-ified per stage).
3. **Dev-mode memory ceiling** (E2E incident): the unoptimized dev runtime
   hit 2.3GB RSS during adversarial re-review and was OOM-killed on the
   3.9GB box. Candidates: cap adversarial-review batch prompt size,
   streaming JSON parse (no full-body buffer), or a production-build
   smoke path for the E2E harness.
4. **i18n label unification**: derive oneClick.stepXxx / timeline.stepXxx
   keys from the namespace (kills the dual label sets).
5. **Degraded-count UI surfacing**: the stats block now carries
   skillDegraded — surface it in run-timeline-dialog's summary as a
   badge row ("N skills degraded: ...").
6. **knowledge-summary → gap-design hand-off**: the digest's missing-works
   output and the gap-design identify pass overlap conceptually (both
   detect coverage gaps); a merged "coverage-audit" skill would halve the
   calls. Data first (skillCalls timing).

### Migration rules (unchanged from RT5/RT6, enforced by review)

- A skill is the ONLY place its prompt text lives.
- Every skill MUST declare fallback semantics (mechanical, or explicit
  hard-fail = no fallback) — degraded results are flagged, never silent.
- Telemetry rides the SkillTelemetry envelope; no new console.log at
  call-sites.
- Article-text outputs go through applyFormatContract OR the documented
  chunked combinator — adding a gate means editing FORMAT_GATES, never a
  per-exit sequence.
