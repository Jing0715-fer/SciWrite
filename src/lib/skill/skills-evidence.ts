/**
 * Skill definitions — evidence family (RT6).
 *
 * Migrated from the B-family STRICT-JSON sites (RT5 audit backlog #2):
 *   - fact-check      ← fact-check.ts arbitrate (per-claim adjudication)
 *   - evidence-extract  ← evidence-pipeline.ts extractEvidenceBank (per-batch)
 *   - evidence-allocate ← evidence-pipeline.ts allocateEvidenceToSections (LLM path)
 *
 * Degradation contract (kept identical to the legacy sites):
 *   - fact-check has NO skill fallback — the arbitration rethrows and the
 *     POOL layer keeps its two DIFFERENT catch semantics (pass-1: fall
 *     through to the web path; pass-2: ERROR finding). Those live at the
 *     call-site because they are pool orchestration, not skill semantics.
 *   - evidence-extract: skill fallback = empty evidence (the legacy per-batch
 *     catch contributed 0 claims for that batch).
 *   - evidence-allocate: skill fallback = empty allocations; the caller
 *     detects degraded and returns its precomputed keyword allocation
 *     (byte-identical to the legacy catch path).
 *
 * None of the legacy sites used the LLM cache — call-sites pass noCache:true
 * to keep that behavior (the executor's cache would otherwise be a new,
 * untested optimistic path for these stages).
 */

import { parseLlmJson } from "@/lib/llm-json";
import type {
  FactCheckClaim,
  FactCheckFinding,
  FactVerdict,
  RefAbstractEvidence,
  RefMeta,
} from "@/lib/fact-check";
import type { WebSearchItem } from "@/lib/ai";
import type { EvidenceItem, EvidenceRefInput } from "@/lib/evidence-pipeline";
import type { SkillDefinition } from "./types";

// ---------------------------------------------------------------------------
// fact-check — adjudicate ONE claim against cited abstracts + web evidence
// (legacy: fact-check.ts arbitrate)
// ---------------------------------------------------------------------------

export interface ArbitrateInput {
  claim: FactCheckClaim;
  /** Web-search results (pass 2) — [] for the cited-abstract-only pass 1. */
  evidence: WebSearchItem[];
  /** Metadata of the references the sentence itself cites. */
  citedRefs: RefMeta[];
  /** Abstracts of those references (round-61 P0-A pass 1). */
  abstracts: RefAbstractEvidence[];
}

export const ARBITER_SYSTEM = `You are a forensic fact-checker for scientific manuscripts. For each CHECK you receive ONE claim sentence and EVIDENCE in up to two forms:
- [A#] blocks — ABSTRACTS of the paper(s) the sentence itself cites. These are AUTHORITATIVE for whether the citation faithfully reports its source: a claim cited to [n] whose substance appears in [A#] (the abstract of [n]) is VERIFIED — the citation supports the claim. A claim cited to [n] that [A#] directly refutes is CONTRADICTED — the citation misreports its source.
- [E#] blocks — WEB SEARCH results (independent external evidence).
Adjudicate the claim strictly against this EVIDENCE.

VERDICT RULES (apply exactly):
- VERIFIED — evidence literally corroborates the claim. For QUANTITATIVE claims the specific number/value must appear in the evidence (literal match or trivial unit conversion). "completely absent" does NOT verify "shifted by 180°"; a different number does not verify this number. A cited-abstract [A#] match ("we performed more than 175 edits…" in the abstract of the paper cited for "over 175 edits") IS literal corroboration.
- CONTRADICTED — evidence directly refutes the claim. HARD RULE: when the claim asserts a positive finding, a specific value, or the existence of something, while the evidence explicitly reports its ABSENCE (phrases like "completely absent", "no … has been reported", "remains unresolved/unknown"), the verdict is CONTRADICTED even when other parts of the sentence match the evidence. This applies to [A#] too: the sentence says "X, [n]" while [A#] (the abstract of [n]) reports the opposite — that is a misreported citation, CONTRADICTED.
- UNVERIFIABLE — the evidence is topical but silent on the claim, or off-topic. Absence of corroboration is NOT contradiction. Do not guess.
- COMPOSITE SENTENCES: adjudicate the WHOLE sentence by its weakest factual component. One contradicted component ⇒ CONTRADICTED. A merely-unfound component ⇒ UNVERIFIABLE.
- ATTRIBUTION claims ("X et al. demonstrated …"): check whether the evidence attributes that work/finding to that group. Wrong group ⇒ CONTRADICTED with reason "attribution error".
- Use ONLY the EVIDENCE provided — never your own memory of the literature to confirm or refute. If the evidence is silent, say UNVERIFIABLE.

Respond as STRICT JSON only:
{"checks":[{"id":1,"verdict":"VERIFIED|CONTRADICTED|UNVERIFIABLE","confidence":0,"reason":"one sentence","evidence_quote":"the literal evidence fragment relied on, or empty"}]}
confidence is 0-100. Output JSON only.`;

export const factCheckArbitrateSkill: SkillDefinition<ArbitrateInput, FactCheckFinding> = {
  id: "fact-check",
  taskType: "review",
  sseStep: "review",
  title: "Fact-check claim arbitration",
  chat: { temperature: 0.1, maxTokens: 3000, thinking: false },

  buildPrompt(input) {
    const evidenceBlock =
      input.evidence.length > 0
        ? input.evidence
            .slice(0, 5)
            .map(
              (e, i) =>
                `[E${i + 1}] ${String(e.name || "").slice(0, 120)} — ${String(e.snippet || "").slice(0, 260)} (${e.host_name || e.url || ""})`,
            )
            .join("\n")
        : "(no web evidence provided)";

    const abstractBlock =
      input.abstracts.length > 0
        ? input.abstracts
            .map(
              (a, i) =>
                `[A${i + 1}] ABSTRACT OF CITED SOURCE [${a.num}] "${a.title.slice(0, 140)}" (the paper this sentence cites):\n${a.abstract.slice(0, 1800)}`,
            )
            .join("\n\n")
        : "";

    const citedBlock =
      input.citedRefs.length > 0
        ? input.citedRefs
            .map((r) => `- [${r.authors || "Anon"}${r.year ? ` (${r.year})` : ""}] ${r.title}`)
            .join("\n")
        : "(the sentence carries NO inline citation — this is an uncited assertion)";

    const prompt = `CHECK ${input.claim.id} (category: ${input.claim.category})
CLAIM SENTENCE: "${input.claim.sentence}"
${input.citedRefs.length > 0 ? `SENTENCE CITES: [${input.claim.citedNums.join(", ")}]` : "UNCITED ASSERTION"}

CITED SOURCES OF THIS SENTENCE (the article's own references):
${citedBlock}
${abstractBlock ? `\nCITED SOURCE ABSTRACTS (what the cited papers themselves report — authoritative for whether the citation supports the claim):
${abstractBlock}` : ""}

WEB SEARCH RESULTS (external evidence):
${evidenceBlock}

Adjudicate CHECK ${input.claim.id}. Respond as STRICT JSON:
{"checks":[{"id":${input.claim.id},"verdict":"...","confidence":0,"reason":"...","evidence_quote":"..."}]}`;

    return { system: ARBITER_SYSTEM, prompt };
  },

  metadata: (input) => ({
    claimCategory: input.claim.category,
    cited: input.claim.citedNums.length > 0,
  }),

  /**
   * round-RT2 semantics: parseLlmJson handles fences/preamble/JSON5 shapes;
   * `ok:false` is the explicit no-JSON error (the legacy throw).
   */
  parse(raw) {
    const parsed = parseLlmJson<any>(raw, { checks: [] });
    if (!parsed.ok) throw new Error("arbiter returned no JSON");
    return parsed.value;
  },

  /** Verdict whitelist + confidence clamp + length caps (legacy, verbatim). */
  postProcess(parsed, input) {
    const check = ((parsed as any).checks || [])[0] || {};
    let verdict = String(check.verdict || "").toUpperCase();
    if (!["VERIFIED", "CONTRADICTED", "UNVERIFIABLE"].includes(verdict)) {
      verdict = "UNVERIFIABLE";
    }
    return {
      claimId: input.claim.id,
      category: input.claim.category,
      sentence: input.claim.sentence,
      citedNums: input.claim.citedNums,
      verdict: verdict as FactVerdict,
      reason: String(check.reason || "").slice(0, 300),
      evidenceQuote: String(check.evidence_quote || "").slice(0, 300),
      evidenceUrls: input.evidence.slice(0, 3).map((e) => e.url).filter(Boolean),
      confidence: Math.max(0, Math.min(100, parseInt(String(check.confidence ?? 50), 10) || 50)),
    };
  },

  // No fallback: the pool layer owns two DIFFERENT catch semantics
  // (pass-1 fall-through vs pass-2 ERROR finding) — see skills-evidence.ts
  // header. A skill-level fallback would erase that distinction.
};

// ---------------------------------------------------------------------------
// evidence-extract — extract checkable claims from a batch of references
// (legacy: evidence-pipeline.ts extractEvidenceBank, per-batch LLM call)
// ---------------------------------------------------------------------------

export interface EvidenceExtractInput {
  topic: string;
  field: string;
  /** The refs in this batch (any-shape reference rows). */
  batch: EvidenceRefInput[];
  /** 1-based batch ordinal. */
  batchNo: number;
  totalBatches: number;
  /** Global 0-based start index of this batch (for [REF-n] numbering). */
  batchStartIndex: number;
  /** Total refs in the limited pool (range-filter bound). */
  totalRefs: number;
  /** refId → full-text block (round-42); present shrinks batches to 10. */
  fullTexts?: Map<string, string>;
}

export interface EvidenceExtractOutput {
  evidence: EvidenceItem[];
}

export const evidenceExtractSkill: SkillDefinition<EvidenceExtractInput, EvidenceExtractOutput> = {
  id: "evidence-extract",
  taskType: "analyze",
  sseStep: "analyze",
  title: "Extract the evidence bank (one batch)",
  chat: { temperature: 0.2 },

  buildPrompt(input) {
    const system = `You are a meticulous research analyst building an EVIDENCE BANK for a review article on: ${input.topic} (${input.field}).
Your ONLY job is to extract claims that each source ACTUALLY makes. You are the anti-hallucination stage:
- Every claim must be directly supported by the reference's title/abstract (and full-text excerpt, when shown) — never beyond what is shown.
- Do NOT infer, extrapolate, or add domain knowledge not present in the source.
- Do NOT write claims about the topic in general.
- Prefer quantitative specifics (numbers, methods, named proteins, trial names) over vague statements.`;

    const refList = input.batch
      .map((r, j) => {
        const auth = (r.authors || "Anon").trim();
        const yr = r.year ? ` (${r.year})` : "";
        const jour = r.journal ? `, ${r.journal}` : "";
        const abs = r.abstract
          ? `\n  Abstract: ${r.abstract.slice(0, 700)}`
          : "\n  (no abstract available — use the TITLE only)";
        const base = `[REF-${input.batchStartIndex + j + 1}] ${auth}${yr}${jour}. ${r.title}.${abs}`;
        const ft = input.fullTexts?.get(r.id || "");
        if (ft) {
          const excerpt = ft.replace(/\s+/g, " ").slice(0, 900);
          return `${base}\n  FULL-TEXT EXCERPT (from the complete article — extract claims from here too, deeper than the abstract): ${excerpt}`;
        }
        return base;
      })
      .join("\n\n");

    const prompt = `SOURCES (batch ${input.batchNo}):
${refList}

For EACH source above, extract 1-4 key claims it makes. A claim is a single checkable factual statement that this specific paper/database record supports.

Respond as STRICT JSON only:
{
  "evidence": [
    { "ref": 1, "claims": ["claim 1 ...", "claim 2 ..."] },
    { "ref": 2, "claims": ["..."] }
  ]
}
"ref" is the number in [REF-n]. Keep each claim under 40 words. Output JSON only.`;

    return { system, prompt };
  },

  metadata: (input) => ({
    batch: input.batchNo,
    refs: input.batch.length,
  }),

  /** Legacy per-item semantics: range-filter refs, drop short claims, cap 400. */
  postProcess(parsed, input) {
    const evidence: EvidenceItem[] = [];
    for (const e of (parsed as any).evidence || []) {
      const refIndex = parseInt(String(e.ref), 10);
      if (isNaN(refIndex) || refIndex < 1 || refIndex > input.totalRefs) continue;
      const claims = Array.isArray(e.claims) ? e.claims : [];
      for (const claim of claims) {
        if (typeof claim === "string" && claim.trim().length > 8) {
          evidence.push({
            refIndex,
            claim: claim.trim().slice(0, 400),
            kind: "finding",
          });
        }
      }
    }
    return { evidence };
  },

  /** Whole-batch failure ⇒ 0 claims from this batch (legacy per-batch catch). */
  fallback() {
    return { evidence: [] };
  },
};

// ---------------------------------------------------------------------------
// evidence-allocate — assign references/evidence to planned sections
// (legacy: evidence-pipeline.ts allocateEvidenceToSections, LLM path only —
// the plan-driven preallocatedRefs short-circuit stays at the call-site)
// ---------------------------------------------------------------------------

export interface EvidenceAllocateInput {
  topic: string;
  sections: { title: string; focus?: string }[];
  refs: EvidenceRefInput[];
  evidence: EvidenceItem[];
  minRefs: number;
  maxRefs: number;
}

export interface EvidenceAllocateOutput {
  /** section (1-based) → deduped, range-filtered ref indexes. */
  allocations: Array<{ section: number; refs: number[] }>;
}

export const evidenceAllocateSkill: SkillDefinition<EvidenceAllocateInput, EvidenceAllocateOutput> = {
  id: "evidence-allocate",
  taskType: "allocate",
  sseStep: "allocate",
  title: "Allocate evidence to sections",
  chat: { temperature: 0.2 },

  buildPrompt(input) {
    const system = `You are a review-article architect allocating an EVIDENCE BANK to article sections.
Given the section plan and the extracted evidence (each item pre-bound to a reference), decide which
references each section should draw on. Rules:
- Allocate a reference to a section ONLY if its evidence is topically relevant to that section.
- Aim for ${input.minRefs}-${input.maxRefs} references per section (more for longer sections).
- References may appear in multiple sections when genuinely relevant.
- Do NOT allocate a reference just to fill quota — relevance first.`;

    const sectionList = input.sections
      .map((s, i) => `SECTION ${i + 1}: ${s.title}\n  Focus: ${s.focus || "(none)"}`)
      .join("\n\n");

    const refList = input.refs
      .slice(0, 40)
      .map((r, i) => `[REF-${i + 1}] ${(r.authors || "Anon").trim()}${r.year ? ` (${r.year})` : ""}. ${r.title}`)
      .join("\n");

    const evidenceDigest = input.evidence
      .slice(0, 160)
      .map((e) => `[REF-${e.refIndex}] ${e.claim}`)
      .join("\n");

    const prompt = `ARTICLE TOPIC: ${input.topic}

SECTION PLAN:
${sectionList}

REFERENCE LIST:
${refList}

EVIDENCE BANK (claim → reference):
${evidenceDigest}

Allocate references to sections.

Respond as STRICT JSON only:
{
  "allocations": [
    { "section": 1, "refs": [1, 4, 7], "rationale": "..." },
    { "section": 2, "refs": [2, 5], "rationale": "..." }
  ]
}
"section" is 1-based. "refs" are the [REF-n] numbers. Output JSON only.`;

    return { system, prompt };
  },

  metadata: (input) => ({
    sections: input.sections.length,
    refs: input.refs.length,
  }),

  /** Legacy bySection map semantics: range-filter + dedupe (insertion order). */
  postProcess(parsed, input) {
    const bySection = new Map<number, number[]>();
    for (const a of (parsed as any).allocations || []) {
      const s = parseInt(String(a.section), 10);
      if (isNaN(s) || s < 1 || s > input.sections.length) continue;
      const arr = (Array.isArray(a.refs) ? a.refs : [])
        .map((n: any) => parseInt(String(n), 10))
        .filter((n: number) => n >= 1 && n <= input.refs.length) as number[];
      if (arr.length) bySection.set(s, [...new Set(arr)]);
    }
    return {
      allocations: [...bySection.entries()].map(([section, refs]) => ({ section, refs })),
    };
  },

  /**
   * Empty allocations — the caller detects degraded and returns its
   * precomputed keyword allocation (byte-identical to the legacy catch).
   */
  fallback() {
    return { allocations: [] };
  },
};
