/**
 * evidence-pipeline.ts — Multi-stage evidence-grounded generation
 * (deepseek-harness-inspired: analyze → allocate → write).
 *
 * WHY (vs. one-shot LLM generation):
 *   When the LLM writes a section in a single pass it must simultaneously
 *   plan structure, remember facts, and bind citations — citation binding
 *   is the lowest-priority task and drifts. The v98/v99 audits showed the
 *   result: topicality warnings where the citing sentence shared 0 keywords
 *   with the cited reference.
 *
 *   This module decomposes the task, following the staged-agent pattern of
 *   deepseek-harness (each step validated before the next consumes it):
 *
 *     Stage 1  extractEvidenceBank     — analyze every gathered source and
 *               extract its key claims (the "先对收集到的信息进行分析" step).
 *               Output: a structured evidence bank where every claim is
 *               pre-bound to the reference it came from.
 *     Stage 2  allocateEvidenceToSections — for each planned section, decide
 *               which references (and which of their claims) it should draw
 *               on (the "根据分析结果形成文字大纲" step).
 *     Stage 3  (in generate-full-v2)  — each section is written with ONLY
 *               its allocated evidence, cited via structural {{Rn}} keys.
 *
 *   Accuracy properties:
 *     - the writer model never chooses WHICH source supports a claim —
 *       that decision was made in the analysis stage, where the model sees
 *       the source and the claim side by side with no prose to write
 *     - claims are extracted FROM sources (top-down), so fabricated
 *       "citation-shaped" facts have no place to hide
 *     - allocation gives every section a small, focused reference set,
 *       which measurably reduces cross-topic miscitation
 */

import { extractSectionKeywords, scoreRelevance } from "@/lib/generate-full-helpers";
// RT6 (B-family migration): both LLM stages run through the shared skill
// executor (skills-evidence.ts evidenceExtractSkill / evidenceAllocateSkill).
import { runSkill } from "@/lib/skill/executor";
import { evidenceAllocateSkill, evidenceExtractSkill } from "@/lib/skill/skills-evidence";

export interface EvidenceItem {
  /** 1-based index into the curated reference array. */
  refIndex: number;
  /** A specific, checkable claim drawn from that reference. */
  claim: string;
  /** What kind of evidence this is. */
  kind: "finding" | "method" | "statistic" | "contradiction" | "context";
}

export interface SectionAllocation {
  /** 0-based section index matching the plan's sections array. */
  sectionIndex: number;
  /** 1-based reference indices allocated to this section. */
  refIndices: number[];
  /** Subset of the evidence bank assigned to this section. */
  evidence: EvidenceItem[];
  /** One-line rationale (for the audit trail). */
  rationale?: string;
}

export interface EvidenceRefInput {
  id?: string;
  title: string;
  authors?: string | null;
  journal?: string | null;
  year?: string | null;
  abstract?: string | null;
  externalId?: string | null;
  type?: string | null;
  url?: string | null;
}

// formatRefForAnalysis moved into the skill (skills-evidence.ts) with the
// rest of the extract prompt assembly in RT6.

/**
 * Stage 1 — Analyze gathered sources and extract a structured evidence bank.
 *
 * The LLM sees references (title + abstract) in batches and must output, per
 * reference, 1-4 key claims. Claims must be facts actually stated by that
 * reference — not inferences about the topic in general. References are
 * processed in batches of ~14 to keep outputs well under token limits and
 * parsing reliable.
 *
 * round-42: `opts.fullTexts` (refId → full-text block) deepens the analysis —
 * refs whose full text was fetched get a ~900-char excerpt appended, so the
 * extracted claims come from the COMPLETE article rather than just the
 * abstract (能获取到全文的一定要看全文). The batch size shrinks to 10 when
 * full texts are present so each prompt stays comfortably under
 * llm-session's 28000-char compression cap.
 */
export async function extractEvidenceBank(
  projectId: string,
  refs: EvidenceRefInput[],
  topic: string,
  field: string,
  opts: { maxRefs?: number; batchSize?: number; maxTokens?: number; fullTexts?: Map<string, string> } = {}
): Promise<EvidenceItem[]> {
  const maxRefs = opts.maxRefs ?? 40;
  // round-42: shrink batches when full-text excerpts inflate each ref block.
  const batchSize = opts.fullTexts && opts.fullTexts.size > 0
    ? Math.min(opts.batchSize ?? 14, 10)
    : (opts.batchSize ?? 14);
  const limited = refs.slice(0, maxRefs);

  const allEvidence: EvidenceItem[] = [];

  // round-RT2 (evidence acceleration): serial batch loop → bounded pool of 3.
  // Per-batch failures degrade that batch only (the skill's fallback returns
  // empty evidence — same semantics as the legacy per-batch catch).
  const { runWithConcurrency } = await import("@/lib/search-enhance");
  const batchStarts: number[] = [];
  for (let b = 0; b < limited.length; b += batchSize) batchStarts.push(b);
  await runWithConcurrency(batchStarts, 3, async (b: number) => {
    const batch = limited.slice(b, b + batchSize);
    const totalBatches = Math.ceil(limited.length / batchSize);
    // RT6 (B-family migration): prompt/formatRefForAnalysis/parsing/range
    // filtering live in the skill (skills-evidence.ts evidenceExtractSkill).
    const result = await runSkill(
      evidenceExtractSkill,
      {
        topic,
        field,
        batch,
        batchNo: Math.floor(b / batchSize) + 1,
        totalBatches,
        batchStartIndex: b,
        totalRefs: limited.length,
        fullTexts: opts.fullTexts,
      },
      {
        projectId,
        fallbackValue: { evidence: [] },
        noCache: true, // legacy: no LLM cache on the evidence path
        chatOverrides: opts.maxTokens ? { maxTokens: opts.maxTokens } : undefined,
      },
    );
    allEvidence.push(...result.output.evidence);
  });

  return allEvidence;
}

/**
 * Stage 2 — Allocate references + evidence to planned sections.
 *
 * Given the section plan (titles + focus) and the evidence bank, decide
 * which references each section should draw on. A reference may be
 * allocated to multiple sections; every section must receive at least
 * `minRefsPerSection` references so the writer always has material.
 *
 * round-42: `opts.preallocatedRefs` (per-section 1-based ref-index arrays)
 * short-circuits the LLM call — the PLAN stage already co-designed the
 * outline and its citation map (先根据主题、长度确定大纲和引用哪些参考文献),
 * so this stage only validates the plan, tops thin sections up to the
 * minimum in pool-priority order, and filters the evidence bank. The LLM
 * allocator runs ONLY when no pre-allocation was provided (legacy paths).
 *
 * Falls back to keyword-overlap allocation if the LLM response is unusable
 * (never blocks the pipeline).
 */
export async function allocateEvidenceToSections(
  projectId: string,
  sections: { title: string; focus?: string }[],
  refs: EvidenceRefInput[],
  evidence: EvidenceItem[],
  topic: string,
  opts: {
    minRefsPerSection?: number;
    maxRefsPerSection?: number;
    maxTokens?: number;
    preallocatedRefs?: number[][];
  } = {}
): Promise<SectionAllocation[]> {
  const minRefs = opts.minRefsPerSection ?? 6;
  const maxRefs = opts.maxRefsPerSection ?? 14;

  // --- Fallback allocator (keyword overlap), always computed first so we
  // can top up LLM allocations that come back too thin.
  const fallbackAlloc = allocateByKeywords(sections, refs, evidence, { minRefs, maxRefs });

  if (!evidence.length || !refs.length) {
    return fallbackAlloc;
  }

  // --- round-42: plan-driven allocation (no LLM call — the plan stage
  // already decided which refs each section cites; validate + top up).
  if (opts.preallocatedRefs && opts.preallocatedRefs.length > 0) {
    const cited = new Set<number>();
    const merged: SectionAllocation[] = sections.map((s, i) => {
      const planned = (opts.preallocatedRefs![i] || [])
        .map((n) => parseInt(String(n), 10))
        .filter((n) => n >= 1 && n <= refs.length);
      const uniq = [...new Set(planned)].slice(0, maxRefs);
      for (const n of uniq) cited.add(n);
      return {
        sectionIndex: i,
        refIndices: uniq,
        evidence: evidence.filter((e) => uniq.includes(e.refIndex)),
        rationale: "plan-preallocated",
      };
    });
    // Top thin sections up to minRefs in pool order (the pool arrives
    // priority-ordered from smart curation). Never exceeds available refs —
    // a thin pool simply yields sections with fewer refs (不强行凑数).
    for (const alloc of merged) {
      if (alloc.refIndices.length >= minRefs) continue;
      for (let n = 1; n <= refs.length && alloc.refIndices.length < minRefs; n++) {
        if (!alloc.refIndices.includes(n) && !cited.has(n)) {
          alloc.refIndices.push(n);
          cited.add(n);
          alloc.rationale = "plan-preallocated+priority-topup";
        }
      }
      alloc.evidence = evidence.filter((e) => alloc.refIndices.includes(e.refIndex));
    }
    return merged;
  }

  // RT6 (B-family migration): the LLM allocator lives in the skill
  // (skills-evidence.ts evidenceAllocateSkill). degraded ⇒ the caller
  // returns the precomputed keyword allocation (the legacy catch path,
  // byte-identical). noCache keeps the legacy behavior.
  const allocateResult = await runSkill(
    evidenceAllocateSkill,
    { topic, sections, refs, evidence, minRefs, maxRefs },
    {
      projectId,
      fallbackValue: { allocations: [] },
      noCache: true, // legacy: no LLM cache on the allocate path
      chatOverrides: opts.maxTokens ? { maxTokens: opts.maxTokens } : undefined,
    },
  );
  if (allocateResult.degraded) {
    return fallbackAlloc;
  }
  const bySection = new Map<number, number[]>();
  for (const a of allocateResult.output.allocations) {
    bySection.set(a.section, a.refs);
  }

    // Merge: LLM allocation where usable, topped up by keyword fallback
    const merged: SectionAllocation[] = sections.map((_s, i) => {
      const llmRefs = (bySection.get(i + 1) || []).slice(0, maxRefs);
      const fb = fallbackAlloc[i];
      let finalRefs = llmRefs;
      if (finalRefs.length < minRefs) {
        const have = new Set(finalRefs);
        for (const n of fb.refIndices) {
          if (finalRefs.length >= minRefs) break;
          if (!have.has(n)) {
            finalRefs.push(n);
            have.add(n);
          }
        }
      }
      return {
        sectionIndex: i,
        refIndices: finalRefs,
        evidence: evidence.filter((e) => finalRefs.includes(e.refIndex)),
        rationale: `llm=${llmRefs.length}${finalRefs.length > llmRefs.length ? `+topup=${finalRefs.length - llmRefs.length}` : ""}`,
      };
    });
    return merged;
}

/** Deterministic keyword-overlap allocator (fallback + top-up source). */
function allocateByKeywords(
  sections: { title: string; focus?: string }[],
  refs: EvidenceRefInput[],
  evidence: EvidenceItem[],
  opts: { minRefs: number; maxRefs: number }
): SectionAllocation[] {
  return sections.map((s, i) => {
    const keywords = extractSectionKeywords(`${s.title} ${s.focus || ""}`);
    // Score refs two ways: metadata overlap + evidence-claim overlap
    const scored = refs.map((r, idx) => {
      const metaScore = scoreRelevance(keywords, `${r.title || ""} ${r.abstract || ""} ${r.journal || ""}`);
      const claims = evidence.filter((e) => e.refIndex === idx + 1).map((e) => e.claim).join(" ");
      const claimScore = scoreRelevance(keywords, claims);
      return { refIndex: idx + 1, score: metaScore + claimScore * 1.5 };
    });
    scored.sort((a, b) => b.score - a.score || a.refIndex - b.refIndex);
    const relevant = scored.filter((s2) => s2.score > 0).slice(0, opts.maxRefs).map((s2) => s2.refIndex);
    let refIndices = relevant;
    if (refIndices.length < opts.minRefs) {
      const have = new Set(refIndices);
      for (const s2 of scored) {
        if (refIndices.length >= opts.minRefs) break;
        if (!have.has(s2.refIndex)) {
          refIndices.push(s2.refIndex);
          have.add(s2.refIndex);
        }
      }
    }
    return {
      sectionIndex: i,
      refIndices,
      evidence: evidence.filter((e) => refIndices.includes(e.refIndex)),
      rationale: "keyword-fallback",
    };
  });
}

/**
 * Build the EVIDENCE CONTEXT block for one section's writing prompt.
 * Every claim is shown WITH its citation key, so the writer model can only
 * cite sources through claims that have already been extracted from them.
 *
 * round-42: `fullTexts` (refId → block) attaches a compact full-text excerpt
 * to refs that have one, flagged so the writer knows the claims for that
 * source come from the complete article.
 */
export function buildEvidenceContext(
  allocation: SectionAllocation,
  refs: EvidenceRefInput[],
  fullTexts?: Map<string, string>
): string {
  const refSubset = allocation.refIndices
    .map((n) => refs[n - 1])
    .filter(Boolean);
  if (!refSubset.length) return "";

  const keyedList = refSubset
    .map((r, i) => {
      const auth = (r.authors || "Anonymous").trim();
      const yr = r.year ? ` (${r.year})` : "";
      const jour = r.journal ? `, ${r.journal}` : "";
      const abs = r.abstract ? `\n    Abstract: ${r.abstract.slice(0, 300)}` : "";
      const ft = fullTexts?.get(r.id || "");
      const ftBlock = ft
        ? `\n    [FULL TEXT AVAILABLE — the verified claims below for this source were extracted from the COMPLETE article]\n    Full-text excerpt: ${ft.replace(/\s+/g, " ").slice(0, 700)}`
        : "";
      return `{{R${i + 1}}} ${auth}${yr}${jour}. ${r.title || "Untitled"}.${abs}${ftBlock}`;
    })
    .join("\n");

  const claims = allocation.evidence
    .slice(0, 40)
    .map((e) => {
      const localIdx = allocation.refIndices.indexOf(e.refIndex) + 1;
      if (localIdx <= 0) return null;
      return `{{R${localIdx}}} — ${e.claim}`;
    })
    .filter(Boolean)
    .join("\n");

  return `REFERENCE LIST (each entry is prefixed with its UNIQUE citation key — cite by copying that key exactly):
${keyedList}

VERIFIED EVIDENCE (claims extracted from the sources above — write FROM these; each claim shows the key of the source it came from):
${claims || "(no extracted claims — rely on the reference titles/abstracts only)"}`;
}

/**
 * Map per-section local ref indices back to global curated-ref indices.
 * (allocation.refIndices are 1-based indices into the curated array.)
 */
export function localKeyToGlobalRef(
  allocation: SectionAllocation,
  localIndex: number
): number | null {
  return allocation.refIndices[localIndex - 1] ?? null;
}
