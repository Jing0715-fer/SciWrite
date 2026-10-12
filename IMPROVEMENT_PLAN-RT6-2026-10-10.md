# SciWrite RT6 — Skill Migration Wave 2 + Format Contract Completion (2026-10-10)

RT6 executes the RT5 migration backlog (IMPROVEMENT_PLAN-RT5 §3, items 1–3 +
5-partial): the A-family remainder, the B-family STRICT-JSON reviewers and
prose revision paths, and the C-family article-text exits — bringing the
skill catalog from 1 to 9 and the format gate registry from 4 to 7 gates.

## 1. What RT6 migrated

| Skill | File | Legacy site | Fallback contract |
| ----- | ---- | ----------- | ----------------- |
| `curate` | skills-curation.ts | generate-full-helpers.ts curateReferences (LLM block) | empty indices ⇒ caller slices mechanically (legacy catch) |
| `curate-smart` | skills-curation.ts | citation-planner.ts smartCurateReferences (LLM block) | empty indices ⇒ caller's core/important mechanical path; guardrails 1–4 STAY at the call-site (pool orchestration) |
| `review` | skills-review.ts | review-engine.ts reviewArticleCore | NO skill fallback — provider failures rethrow (review route → HTTP error; v2 loop → skip round); garbage JSON ⇒ parse fallbackValue (legacy safeParseJSON semantics) |
| `revision` | skills-review.ts | review-engine.ts reviseArticleCore (surgical\|full) | NO fallback — rethrows to the v2 per-attempt catch. **Prose skill**: `parse` = identity, wrapper-stripping in postProcess |
| `revision-scoped` | skills-review.ts | review-engine.ts reviseArticleScoped (per-section) | NO fallback — per-section catch stays at the call-site (failed section keeps its text) |
| `fact-check` | skills-evidence.ts | fact-check.ts arbitrate | NO fallback by design — the POOL keeps its two DIFFERENT catch semantics (pass-1 fall-through to web, pass-2 ERROR finding); `parseLlmJson` + verdict whitelist + confidence clamp in the skill |
| `evidence-extract` | skills-evidence.ts | evidence-pipeline.ts extractEvidenceBank (per-batch) | empty evidence (legacy per-batch catch ⇒ 0 claims); batch pool stays at call-site |
| `evidence-allocate` | skills-evidence.ts | evidence-pipeline.ts allocateEvidenceToSections (LLM path) | empty allocations ⇒ caller returns precomputed keyword allocation (byte-identical to legacy catch); preallocatedRefs short-circuit stays at call-site |

### Framework extensions the migrations required

- `SkillChatOptions.thinking` (fact-check's forensic mode) — forwarded by the
  executor to chatWithSession.
- `SKILL_IDS` + `evidence-allocate`.
- **Prose slot confirmed**: the executor's `parse` override IS the prose path
  (identity parse + postProcess stripping) — no executor changes needed.
- **Import-cycle discipline**: skills import business types with `import
  type` (compile-time only, no runtime cycle); business modules import skill
  definitions at runtime. `stripRevisionWrappers` moved review-engine →
  writing.ts (review-engine re-exports for compatibility).
- Caching: curation skills keep their legacy llm-cache behavior; every
  B-family call-site passes `noCache: true` (the legacy sites had no cache —
  keeping that exact behavior instead of silently gaining one).

### Naming unification (the three-vocabulary merge, RT5 §1 continued)

| skill id | taskType | sseStep (metadata.step) | was |
| -------- | -------- | ----------------------- | --- |
| curate | curate | curate | step "curate" ✓ |
| curate-smart | curate-smart | **curate** | step "curate-smart" (drift fixed) |
| review | review | review | no step field (drift fixed) |
| revision | revise | **repair** | no step field (drift fixed) |
| fact-check | review | **review** | step "fact-check" (drift fixed) |
| evidence-extract | analyze | **analyze** | step "evidence-extract" (drift fixed) |
| evidence-allocate | allocate | **allocate** | step "evidence-allocate" (drift fixed) |

## 2. Format contract: 4 → 7 registered gates

New structural prelude gates (the guts of the hand-assembled sequences):

| gate | function | englishOnly | notes |
| ---- | -------- | ----------- | ----- |
| remove-ref-blocks | removeReferenceBlocks | no | strips trailing per-section reference blocks |
| ascii-punctuation | normalizeAsciiPunctuation | **yes** | fullwidth → ASCII |
| section-markdown | normalizeSectionMarkdown | no | ### demotion, heading spacing |

Registry order: `remove-ref-blocks → ascii-punctuation → section-markdown →
sanitize → citation-keys → uniform-section → cjk-residual`. Subsetting is
order-preserving as before.

### **Chunked-combinator boundary (the important design decision)**

`normalizeArticleBodySections` is NOT the whole-text gate chain: with `##`
headings present it is the CHUNKED combinator (per-section cleaning, headings
pinned byte-preserved, preamble kept verbatim). The unit-test BEHAVIOR LOCK
caught this during migration — v2 repair-adoption, v2 polish-adoption and v1
compose therefore KEEP their `normalizeArticleBodySections` calls AS-IS.
On heading-free input (single sections / paragraphs) the combinator's
no-## branch IS the 4-gate chain, and those exits migrated:

- v2 generate pre-gate (:2823) → `[sanitize, citation-keys]`
- v2 generate retry (:2927) → same
- v2 generate enforce tail (:2973) → `[ascii-punctuation, section-markdown, uniform-section, cjk-residual]` (the two hand-run preludes folded in)
- v2 translate post (:4727) → unchanged (RT5)
- v2 compose per-section (:3184) → `[remove-ref-blocks, section-markdown, uniform-section]`
- v1 generate chunk + 3 retries → `[sanitize]`
- v1 translate → `[sanitize]` zh
- write route → `[ascii-punctuation, section-markdown, uniform-section, cjk-residual]` **+ language routing (bug fix: zh output was unconditionally CJK-stripped before RT6)**
- regenerate → `[sanitize, ascii-punctuation, section-markdown, uniform-section, cjk-residual]`
- revise → `[ascii-punctuation, section-markdown, uniform-section, cjk-residual]`
- retranslate → `[sanitize]` zh (paragraph-level: no uniform-section by granularity, not drift)
- compose route bilingual halves → `[remove-ref-blocks, section-markdown, uniform-section]` × (en, zh)

## 3. Step namespace completion

`PIPELINE_STEPS` gains the four values that were live emitters outside the
registry: `translate-glossary`, `adversarial-verify` (v2 metadata-only),
`generate-wordcount-retry`, `generate-density-retry` (v1 retry SSE events).
No live emitter is outside the namespace now; STEP_TITLES covers all 27.
(V2_MAIN_SEQUENCE unchanged — progress semantics identical.)

## 4. QA results

| Suite | Result |
| ----- | ------ |
| Unit | **291 / 291** (243 prior + 48 new: 8-skill contracts, structural gates, chunked-vs-wholetext behavior lock, wrapper-stripper relocation) |
| Integration (live :3001) | **26 / 26** |
| ESLint | 0 errors (195 warnings — +8 minor from the new skill files) |
| tsc --noEmit | 4 pre-existing baseline errors, 0 new |
| Live smoke (skill-smoke-rt6.ts) | curate-smart + review-core + fact-check against a real project (see STATUS below) |
| E2E full generation (1500 words) | see STATUS below |

Test-authored findings that changed the implementation (the lock working):
- BEHAVIOR LOCK failure → chunked-combinator boundary discovered → 3 exits
  reverted to `normalizeArticleBodySections` (correct legacy semantics).
- 3 test bugs fixed on my side (self-contradictory assertion, budget window
  rides the SYSTEM prompt, wrapper-stripper is single-pass).

## 5. STATUS (final)

- [x] A-family complete (score RT5 + curate/curate-smart RT6)
- [x] B-family core reviewers migrated (review/revision/revision-scoped/fact-check/evidence×2)
- [x] C-family exits migrated where semantics are whole-text; chunked exits
      documented and deliberately kept on the combinator
- [x] Step namespace complete for live emitters
- [x] **Live smoke — RT6_SMOKE_PASS** (scripts/skill-smoke-rt6.ts, real LLM
      calls against the E2E project): curate-smart picked 6/8 (dedup+range ok),
      review-core major-revision 4/10 with weakness classes normalized to
      `advisory,advisory,fixable`, fact-check UNVERIFIABLE on an uncited
      assertion. Session rows carry the unified metadata:
      `{step:"curate", skill:"curate-smart", pool}`, `{step:"review",
      skill:"review", mode:"review-core"}`, `{step:"review", skill:"fact-check",
      claimCategory}` — the three-vocabulary merge verified IN THE DATABASE.
- [x] **E2E full generation, 1500 words** (40.79min including a live 429
      storm + 10min cooldown in gather; storm #2 aborted and recovered
      exactly as the RT4 persisted-abort design intends):
      - 1845 words complete-payload / 1384 EN body (92% of target — RT4's
        degraded run shipped 83.5%; the polish stage ran to completion this
        time), 18 references, 28 citations adversarially verified, 0 removed.
      - **Repair loop converged properly (RT4's P1-1 convergence gate, first
        clean validation): 3 rounds — R1 scoped §1,5 → R2 scoped §1,3,5 →
        R3 converged (overall 5→5 <1 gain, 0 hard findings, remainder
        disclosed). Two `[skill] skill revision ok` telemetry rows are the
        scoped revisions doing real work.**
      - Coherence polish: 2 passes, 9 findings addressed (RT4's run skipped
        polish entirely).
      - Mechanical audit ALL GREEN: 5 `##` sections × exactly 2 paragraphs
        each, 0 list lines, 0 CJK, 0 fullwidth punctuation, `**` balanced,
        53 [n] markers.
      - fact-check summary v7 c0 u0 e0 in the final round — zero errors,
        zero contradictions after repair.
      - Browser: home + article view render all 5 sections, 0 console/page
        errors, mobile 390px no horizontal overflow (shots/rt6-home.png,
        shots/rt6-article.png).

## 6. RT7 backlog (ranked)

1. **B-family stragglers**: coherence review/edit (coherence-polish.ts :136/:236),
   research-gap agents (research-gap.ts :191/:361), knowledge-verify fill +
   gap digest (knowledge-verify.ts :287/:391) — six more STRICT-JSON sites,
   same pattern.
2. **plan / generate / verify v1+v2 merge** — the biggest win: each stage
   exists twice; one skill per stage with v2 as the only orchestrator.
3. **SSE literal → PIPELINE_STEPS constants**: v2 has ~136 inline `step:`
   literals in send() calls + v1 ~99; plus the two remaining client copies
   (unified-writing-dialog STEPS, run-timeline-dialog STEP_LABEL_KEYS) and
   the dual i18n label sets.
4. **generate/translate as skills** (the generator prose skills): they carry
   section-level state (retry gates, word-count loops) — needs an executor
   extension for "streaming + adopt/reject loops" or stays hand-rolled by
   design; decide with data.
5. Degradation-flag surfacing: the v2 complete-event stats block could carry
   per-skill degraded counts from the telemetry envelope (RT4-2 observability
   follow-through).

### Migration rules (unchanged from RT5, enforced by review)

- A skill is the ONLY place its prompt text lives.
- Every skill MUST declare fallback semantics (mechanical, or explicit
  hard-fail = no fallback) — degraded results are flagged, never silent.
- Telemetry rides the SkillTelemetry envelope; no new console.log at
  call-sites.
- Article-text outputs go through applyFormatContract OR the documented
  chunked combinator — adding a gate means editing FORMAT_GATES, never a
  per-exit sequence.
