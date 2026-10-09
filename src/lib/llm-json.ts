/**
 * Shared robust LLM-JSON extraction (round-RT2).
 *
 * WHY THIS MODULE EXISTS
 * ───────────────────────
 * The pipeline asks LLMs to answer in STRICT JSON at ~15 call sites, but a
 * model change is the classic way to break that contract: weaker models wrap
 * the JSON in markdown fences, prepend prose ("Here is the JSON you asked
 * for:"), append commentary, use trailing commas / single quotes / unquoted
 * keys, or answer with a top-level ARRAY instead of an object. Historically
 * SciWrite had ONE robust extractor (`safeParseJSON` in
 * generate-full-helpers.ts) used by the v2 pipeline stages, plus FOUR weak
 * local copies (greedy-brace + bare JSON.parse) in review-engine.ts,
 * fact-check.ts, gather/route.ts, outline/route.ts and
 * source-relationships/route.ts — exactly the stages that run on the
 * "review" model when a generation/review split is configured. A weak model
 * on either role broke precisely the stages that exist to catch the other
 * stages' mistakes (phantom "major-revision" repair rounds, fact-check ERROR
 * verdicts, no-op gather/outline stages).
 *
 * This module is the single canonical extractor. It:
 *   1. fences ```json … ``` (with and without the closing fence)
 *   2. top-level ARRAY `[...]` (review-engine's verdict array shape)
 *   3. greedy `{…}` / `[…]` block
 *   4. JSON5 tolerant parse (trailing commas, unquoted keys, single quotes)
 *   5. last-ditch regex repair of the classic issues
 *   6. optionally strips a "reasoning" preamble that some models prepend
 *      before the JSON payload
 *
 * Purity note: no DB, no LLM — safe to import anywhere (client-safe too,
 * though currently only used server-side).
 */

import JSON5 from "json5";

export interface LlmJsonParseResult<T> {
  /** Parsed value — the supplied fallback when extraction failed. */
  value: T;
  /** True when a real JSON payload was extracted and parsed. */
  ok: boolean;
  /** True when the LLM answer contained no recognizable JSON at all. */
  noJsonFound: boolean;
  /** The raw slice that was parsed (for diagnostics). */
  extracted: string;
}

/** Strip common "reasoning" wrappers some models add around JSON. */
function stripReasoningPreamble(raw: string): string {
  // 1. <think>…</think> blocks (R1-style / thinking models)
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // 2. A leading prose line before the first { or [ (keep the JSON itself)
  const firstBrace = s.search(/[{[]/);
  if (firstBrace > 0) {
    const head = s.slice(0, firstBrace);
    // Only strip when the head is short-ish prose without sentence structure
    // that could BE the answer (defensive: never strip more than 400 chars).
    if (head.length <= 400 && !/```/.test(head)) {
      s = s.slice(firstBrace);
    }
  }
  return s.trim();
}

/**
 * Parse an LLM answer that should contain JSON (object or top-level array).
 * Returns the fallback when nothing parseable is found — plus explicit
 * `ok` / `noJsonFound` flags so callers can distinguish "model answered
 * with an empty list" from "model answer was unparseable" (the gap-agent
 * relevance gate treats those two very differently).
 */
export function parseLlmJson<T = any>(raw: string, fallback: T): LlmJsonParseResult<T> {
  const cleaned = stripReasoningPreamble(String(raw ?? ""));
  if (!cleaned) {
    return { value: fallback, ok: false, noJsonFound: true, extracted: "" };
  }

  const tryParse = (candidate: string): T | undefined => {
    if (!candidate) return undefined;
    try {
      return JSON.parse(candidate) as T;
    } catch {}
    // JSON5 tolerant pass (trailing commas, unquoted keys, single quotes)
    try {
      return JSON5.parse(candidate) as T;
    } catch {}
    // Last-ditch mechanical repair
    try {
      const fixed = candidate
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]")
        .replace(/([{,]\s*)([A-Za-z_]\w*)(\s*:)/g, '$1"$2"$3')
        .replace(/'/g, '"');
      return JSON.parse(fixed) as T;
    } catch {}
    return undefined;
  };

  // Strategy 1: fenced ```json … ``` (greedy, full block)
  const fenced = cleaned.match(/```(?:json|JSON)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    const v = tryParse(fenced[1]);
    if (v !== undefined) return { value: v, ok: true, noJsonFound: false, extracted: fenced[1] };
  }

  // Strategy 1b: fence without the closing ``` (model forgot it)
  const openFence = cleaned.match(/```(?:json|JSON)?\s*([\s\S]*)$/);
  if (openFence) {
    const body = openFence[1].replace(/```\s*$/, "").trim();
    const v = tryParse(body);
    if (v !== undefined) return { value: v, ok: true, noJsonFound: false, extracted: body };
  }

  // Strategy 2: top-level array (single line OR multiline)
  if (/^\[\s*[\s\S]*\]\s*$/.test(cleaned)) {
    const v = tryParse(cleaned);
    if (v !== undefined) return { value: v, ok: true, noJsonFound: false, extracted: cleaned };
  }

  // Strategy 3: greedy object block { … }
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const v = tryParse(objMatch[0]);
    if (v !== undefined) return { value: v, ok: true, noJsonFound: false, extracted: objMatch[0] };
  }

  // Strategy 4: greedy array block [ … ]
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    const v = tryParse(arrMatch[0]);
    if (v !== undefined) return { value: v, ok: true, noJsonFound: false, extracted: arrMatch[0] };
  }

  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `[parseLlmJson] no parseable JSON found (length=${cleaned.length}); first 300 chars: ${cleaned.slice(0, 300)}`,
    );
  }
  return { value: fallback, ok: false, noJsonFound: true, extracted: "" };
}

/**
 * Drop-in replacement for the historical `safeParseJSON(raw, fallback)` —
 * same call signature, same semantics (returns the value; parse diagnostics
 * available via `parseLlmJson` when a caller needs to distinguish an empty
 * answer from a broken one).
 *
 * NOTE: deliberately NOT generic — the historical signature returned `any`,
 * and callers pass literal fallbacks like `{ queries: [] }` from which a
 * generic would infer `never[]` (empty-array literal) and poison every
 * downstream `.push`/property access with `never` errors.
 */
export function safeParseJSON(raw: string, fallback: any): any {
  return parseLlmJson<any>(raw, fallback).value;
}
