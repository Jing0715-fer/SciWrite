/**
 * Skill definitions — knowledge-verify family (RT7).
 *
 * Migrated from knowledge-verify.ts (RT6 backlog's B-family stragglers):
 *   - knowledge           ← verifySourcesWithKnowledge's per-batch fill call
 *   - knowledge-summary   ← the round-RT2 gap-detection digest call
 *
 * Degradation contract (kept identical to the legacy sites — non-fatal):
 *   - knowledge (fill batch): NO skill fallback — a provider failure
 *     RETHROWS to the caller, whose catch owns the storm semantics
 *     (RateLimitAbortedError / QuotaExhaustedError → stormHit → skip
 *     remaining batches; ChatTimeoutError ×2 → stall detection). A
 *     garbage-JSON reply degrades via the parse fallbackValue
 *     ({sources:[],missing:[]}) — a lost batch, not a lost run.
 *   - knowledge-summary (digest): an LLM/provider failure degrades via the
 *     skill fallback (empty missing) — the caller only logs (gap detection
 *     is additive, never load-bearing).
 *
 * Step unification: the legacy metadata.step was "knowledge-verify"
 * (outside PIPELINE_STEPS); both skills now ride the knowledge stage's
 * step ("knowledge"), with the legacy sub-rows ("gapDigest") and batch
 * counters preserved in metadata.
 *
 * Import-cycle discipline: the fill-batch pool (need-based batching, the
 * bounded worker pool, storm flag, onProgress heartbeats) and the
 * cross-batch missing-dedupe (gatheredTitleKeys) stay at the call-site —
 * they are shared STATE across invocations. Prompt text + per-item
 * validation (the CR-B#1 batch-range check, cleanFill/validFill, the
 * MISSING-only fill policy, kind whitelisting) live here.
 *
 * cleanFill/validFill/SENTINEL_VALUES moved here (they were private to
 * the two LLM blocks); knowledge-verify.ts re-exports them for the Stage-B
 * helpers that still use cleanFill-adjacent sanitization.
 */

import type { SkillDefinition } from "./types";

// ---------------------------------------------------------------------------
// Shared contracts (moved here from knowledge-verify.ts; re-exported there)
// ---------------------------------------------------------------------------

export interface KVCompletion {
  /** 1-based GLOBAL index into the full sources array. */
  index: number;
  /** Whether the LLM recognizes this specific work. */
  known: boolean;
  /** Fill values for fields that were MISSING in the input. */
  fill: {
    authors?: string;
    year?: string;
    journal?: string;
  };
  confidence: number;
}

export interface KVMissingSource {
  title: string;
  authors?: string;
  year?: string;
  journal?: string;
  doi?: string;
  pmid?: string;
  reason: string;
  kind: "landmark" | "review" | "method" | "database" | "contradicting";
}

export const FILLABLE_FIELDS = ["authors", "year", "journal"] as const;
type FillField = (typeof FILLABLE_FIELDS)[number];
// NOTE: "doi" is deliberately NOT fillable. E2E on the MscL/MscS project
// showed the LLM fills plausible-but-WRONG DOIs (a FEBS Lett 2002 paper got
// an Annual Reviews DOI; a Nature structure paper got a Science DOI).
// DOIs are machine-checkable identifiers — a wrong one is worse than none.
// (Real DOIs arrive via database gather or the reference-enrich flow.)

/**
 * Values that are placeholders, not data. Round-35 audit found the LLM
 * echoing the prompt's "[journal=MISSING]" sentinel straight back — that
 * landed as journal="MISSING" in the DB (cleanFill only rejected
 * unknown/n/a/none). Reject every sentinel-ish string, case-insensitive,
 * including punctuation-wrapped variants.
 */
export const SENTINEL_VALUES = new Set([
  "missing", "missng", "unknown", "n/a", "na", "none", "null", "nil",
  "not available", "not applicable", "not known", "unavailable", "no data",
  "no record", "tbd", "uncertain", "-", "—", "?", "??",
]);

/** Sanitize a single LLM-provided fill value. Returns null when unusable. */
export function cleanFill(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const CTRL = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]", "g");
  let v = value.replace(CTRL, "").trim();
  if (!v) return null;
  // The prompt marks gaps with [field=MISSING]; the LLM sometimes wraps
  // echoes in quotes or trailing periods before/after the sentinel.
  // r37 fix: it ALSO echoes the bracketed/prefixed sentinel itself —
  // "[journal=MISSING]" or "(journal=MISSING)". Strip wrapper brackets
  // and an optional "field=" prefix before the sentinel test, or the
  // literal sentinel string gets written to the DB (verified: the round-35
  // bare check passed "[journal=MISSING]" straight through).
  v = v.replace(/^["'`]([\s\S]*)["'`]$/, "$1").replace(/[.\s]+$/, "").trim();
  const bare = v
    .toLowerCase()
    .replace(/^[\[(]\s*/, "")
    .replace(/[\])]$/, "")
    .replace(/^[a-z]+\s*=\s*/, "")
    .replace(/[.:;]+$/, "")
    .trim();
  if (SENTINEL_VALUES.has(bare)) return null;
  if (!v) return null;
  return v.slice(0, maxLen);
}

export function validFill(field: FillField, value: string): boolean {
  switch (field) {
    case "year":
      return /^(19|20)\d{2}$/.test(value);
    case "authors":
      return value.length >= 3 && value.length <= 400;
    case "journal":
      return value.length >= 2 && value.length <= 200;
  }
}

const MISSING_KINDS = ["landmark", "review", "method", "database", "contradicting"] as const;

// ---------------------------------------------------------------------------
// knowledge — per-batch metadata completion + per-batch gap suggestions
// (legacy: knowledge-verify.ts verifySourcesWithKnowledge, runFillBatch)
// ---------------------------------------------------------------------------

export interface KnowledgeFillInput {
  topic: string;
  field: string;
  batchNo: number;
  totalBatches: number;
  /** Pre-rendered batch lines with GLOBAL row numbers (caller assembles). */
  list: string;
  /** First GLOBAL index of this batch (the CR-B#1 batch-range check base). */
  firstIndex: number;
  /** Batch size (the inclusive range is firstIndex..firstIndex+size−1). */
  batchSize: number;
  /** Raw source rows for the MISSING-only fill gate (field values by row). */
  rows: Array<{ authors?: string | null; year?: string | null; journal?: string | null }>;
}

export interface KnowledgeFillOutput {
  sources: KVCompletion[];
  missing: KVMissingSource[];
}

export const knowledgeFillSkill: SkillDefinition<KnowledgeFillInput, KnowledgeFillOutput> = {
  id: "knowledge",
  taskType: "gather", // legacy role routing
  sseStep: "knowledge", // RT6 unification: the fill stage rides STEP 2's step
  title: "Fill missing source metadata from LLM knowledge",
  chat: { temperature: 0.2 },

  buildPrompt(input) {
    const system = `You are a domain expert librarian cross-checking a gathered source list for a research article on: ${input.topic} (${input.field}).
You have TWO jobs:
1. METADATA COMPLETION — for each source, some fields are marked MISSING. Fill a MISSING field ONLY if you are confident you know the correct value for THIS SPECIFIC work from your training knowledge. Never invent plausible-looking guesses — if unsure, leave it empty. NEVER provide a value for a field that is not marked MISSING.
2. GAP DETECTION — using your knowledge of the field, name the most IMPORTANT works (landmark papers, key reviews, seminal methods, key database entries, or contradicting evidence) that are ABSENT from this list. Only suggest works you are confident actually exist.`;

    const prompt = `TOPIC: ${input.topic}

GATHERED SOURCES (batch ${input.batchNo} of ${input.totalBatches}):
${input.list}

Respond as STRICT JSON only:
{
  "sources": [
    { "n": 1, "known": true, "authors": "", "year": "", "journal": "", "confidence": 0.0 }
  ],
  "missing": [
    { "title": "...", "authors": "...", "year": "...", "journal": "...", "doi": "...", "pmid": "...", "reason": "why this work is essential for THIS topic", "kind": "landmark|review|method|database|contradicting" }
  ]
}
Rules:
- "n" is the (number) from the list above.
- Include ONLY fields you are filling (omit empty ones). Only fill fields marked MISSING (authors, year, journal).
- "known": whether you recognize this specific work (true/false).
- "confidence": your confidence in the fills (0.0-1.0).
- "missing": up to 4 most-important absent works for this batch's view of the topic. Only works that truly exist. Include doi/pmid there when you know them (they will be verified against PubMed before use).
Output JSON only.`;

    return { system, prompt };
  },

  metadata: (input) => ({
    batch: input.batchNo,
    sources: input.batchSize,
  }),

  /**
   * Per-item validation, verbatim from the legacy call-site:
   *   - "n" must lie in THIS batch's GLOBAL range (the CR-B#1 fix — models
   *     routinely renumber locally 1..12; a global-range check stops those
   *     fills landing on OTHER batches' rows),
   *   - a field is filled ONLY when the original was actually missing,
   *   - every fill passes cleanFill + validFill (per-field shape),
   *   - confidence is clamped to 0..1,
   *   - missing suggestions are cleaned + kind-whitelisted (title dedupe
   *     stays at the call-site — it is cross-batch state).
   */
  postProcess(parsed, input) {
    const completions: KVCompletion[] = [];
    // The parse fallback/LLM rows are RAW shapes (n/known/authors/...), not
    // KVCompletion — same trick as review-core's postProcess typing.
    for (const s of ((parsed as any).sources || []) as any[]) {
      const n = parseInt(String(s.n), 10);
      // CR-B#1 fix (preserved from the legacy site): the prompt numbers
      // rows GLOBALLY, but models routinely renumber locally (1..12). Only
      // ids within THIS batch's global range are valid.
      if (isNaN(n) || n < input.firstIndex || n > input.firstIndex + input.batchSize - 1) continue;
      const row = input.rows[n - input.firstIndex] ?? {};
      const fill: KVCompletion["fill"] = {};
      for (const f of FILLABLE_FIELDS) {
        // Fill ONLY if the original field was actually missing
        const orig = row[f];
        if (orig && String(orig).trim()) continue;
        const cleaned = cleanFill(s[f], f === "year" ? 4 : f === "authors" ? 400 : 200);
        if (cleaned && validFill(f, cleaned)) fill[f] = cleaned;
      }
      completions.push({
        index: n,
        known: Boolean(s.known),
        fill,
        confidence: Math.min(1, Math.max(0, Number(s.confidence) || 0)),
      });
    }

    const missing: KVMissingSource[] = [];
    for (const m of ((parsed as any).missing || []) as any[]) {
      const item = cleanMissingItem(m);
      if (item) missing.push(item);
    }
    return { sources: completions, missing };
  },

  // NO fallback: provider failures rethrow — the caller's catch owns the
  // storm/timeout semantics (stormHit skips the remaining batches; a lost
  // batch contributes nothing, which the pool tolerates by design).
};

// ---------------------------------------------------------------------------
// knowledge-summary — the whole-pool gap-detection digest
// (legacy: knowledge-verify.ts round-RT2 gap digest call)
// ---------------------------------------------------------------------------

export interface KnowledgeDigestInput {
  topic: string;
  field: string;
  /** Pre-rendered compact title lines (≤160 titles, caller assembles). */
  digestTitles: string;
}

export interface KnowledgeDigestOutput {
  missing: KVMissingSource[];
}

export const knowledgeDigestSkill: SkillDefinition<KnowledgeDigestInput, KnowledgeDigestOutput> = {
  id: "knowledge-summary",
  taskType: "gather", // legacy role routing
  sseStep: "knowledge",
  title: "Digest the source pool to detect coverage gaps",
  chat: { temperature: 0.2 },

  buildPrompt(input) {
    const system = `You are a domain expert librarian assessing literature coverage for a research article on: ${input.topic} (${input.field}).`;

    const prompt = `TOPIC: ${input.topic}

GATHERED SOURCE TITLES (complete pool, compact view):
${input.digestTitles}

Using your knowledge of the field, name the most IMPORTANT works (landmark papers, key reviews, seminal methods, key database entries, or contradicting evidence) that are ABSENT from this list. Only suggest works you are confident actually exist.

Respond as STRICT JSON only:
{ "missing": [ { "title": "...", "authors": "...", "year": "...", "journal": "...", "doi": "...", "pmid": "...", "reason": "why essential for THIS topic", "kind": "landmark|review|method|database|contradicting" } ] }
Up to 8 suggestions, most important first. Output JSON only.`;

    return { system, prompt };
  },

  metadata: () => ({ sub: "gapDigest" }),

  /**
   * Per-item normalization, verbatim: cleanFill on every field, kind
   * whitelist (default "landmark"), default reason. Title dedupe against
   * the gathered pool stays at the call-site (cross-batch state).
   */
  postProcess(parsed) {
    const missing: KVMissingSource[] = [];
    for (const m of ((parsed as any).missing || []) as any[]) {
      const item = cleanMissingItem(m);
      if (item) missing.push(item);
    }
    return { missing };
  },

  /** Digest failure → empty suggestions (additive stage, never load-bearing). */
  fallback: () => ({ missing: [] }),
};

// ---------------------------------------------------------------------------
// Shared missing-item normalizer (the two skills' identical legacy loop)
// ---------------------------------------------------------------------------

function cleanMissingItem(m: any): KVMissingSource | null {
  const title = cleanFill(m?.title, 300);
  if (!title) return null;
  return {
    title,
    authors: cleanFill(m.authors, 400) || undefined,
    year: cleanFill(m.year, 4) || undefined,
    journal: cleanFill(m.journal, 200) || undefined,
    doi: cleanFill(m.doi, 80) || undefined,
    pmid: cleanFill(m.pmid, 12) || undefined,
    reason: cleanFill(m.reason, 300) || "important for the topic",
    kind: (MISSING_KINDS.includes(m.kind) ? m.kind : "landmark") as KVMissingSource["kind"],
  };
}

