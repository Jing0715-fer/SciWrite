/**
 * Search Enhancement — query variant expansion + LLM relevance filtering
 *
 * round-50 defect: searching RCSB with "TMC1" hits only 3 entries, while many
 * relevant structures/papers are only retrievable with "TMC-1" — RCSB's
 * Lucene full-text tokenizer treats "TMC1", "TMC-1" and "TMC 1" as three
 * DIFFERENT tokens, so a single spelling silently loses most of the pool.
 * Full-text retrieval also pulls in entries whose primary subject is a
 * DIFFERENT protein that merely mentions the target.
 *
 * Three layers (each degrades safely on its own):
 *   1. mechanicalQueryVariants — deterministic, zero-cost: rewrites the
 *      letters/digits boundary of the protein-name token into all three
 *      separator forms (TMC1 / TMC-1 / TMC 1), in place inside long queries.
 *   2. expandQueryWithLlm — LLM-generated aliases (official full name,
 *      legacy symbols), cached via llm-cache, silently skipped on failure.
 *   3. filterItemsByRelevance — LLM judges for each result whether its
 *      PRIMARY research subject is the target molecule; conservative policy
 *      (uncertain → keep, failure → keep all) because later citation-
 *      planner scoring still refines the pool.
 *
 * Wired into searchRcsb / searchPubMed (databases.ts). Title-exact-match
 * verification paths (knowledge-verify) opt out via SearchEnhanceOpts.
 */

import { chat } from "@/lib/ai";
import { llmCacheKey, getCachedLLMResult, setCachedLLMResult } from "@/lib/llm-cache";
import type { DatabaseResultItem } from "@/lib/types";

/* ---------------- shared options ---------------- */

export interface SearchEnhanceOpts {
  /** Query variant expansion (default: on). Turn off for title-exact-match
   *  verification lookups where extra recall creates false positives. */
  expandVariants?: boolean;
  /** LLM relevance filtering of results (default: on). */
  filterByLlm?: boolean;
  /** Research topic context (e.g. project.topic) — helps the LLM resolve
   *  organism / paralogue context (human TMC1 vs C. elegans tmc-1). */
  context?: string;
}

/** One entry removed by the LLM relevance filter, with its reason. */
export interface FilteredOutItem {
  externalId?: string;
  title: string;
  reason: string;
}

/* ---------------- 1. mechanical variants ---------------- */

/**
 * Deterministic separator-form variants for the protein-name token.
 *
 *   "TMC1"              → ["TMC1", "TMC-1", "TMC 1"]
 *   "TMC-1"             → ["TMC-1", "TMC1", "TMC 1"]
 *   "TMC 1"             → ["TMC 1", "TMC1", "TMC-1"]   (short queries only)
 *   "TMC1 hearing loss" → ["TMC1 hearing loss", "TMC-1 hearing loss", "TMC 1 hearing loss"]
 *
 * The spaced form only applies when the whole query is ≤3 words — inside a
 * long query a bare "WORD 1" match is usually coincidence ("channel 1"),
 * whereas glued/hyphenated tokens are protein symbols by construction.
 * Tokens need ≥2 leading letters, so p53-style names are left untouched
 * (their hyphenated form is vanishingly rare and would only add noise).
 */
export function mechanicalQueryVariants(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  const out = new Set<string>([q]);

  const glued = q.match(/\b([A-Za-z]{2,})(\d+)\b/); // TMC1
  const hyphen = glued ? null : q.match(/\b([A-Za-z]{2,})-(\d+)\b/); // TMC-1
  const spaced =
    glued || hyphen
      ? null
      : q.split(/\s+/).length <= 3
        ? q.match(/\b([A-Za-z]{2,}) (\d+)\b/) // TMC 1 — short query only
        : null;

  const m = glued || hyphen || spaced;
  if (!m) return [q];
  const alpha = m[1];
  const num = m[2];
  const matched = m[0]; // contains only letters/digits/hyphen/space — plain-substring replace is exact

  for (const form of [`${alpha}${num}`, `${alpha}-${num}`, `${alpha} ${num}`]) {
    if (form === matched) continue;
    const variant = q.replace(matched, form);
    if (variant && variant !== q) out.add(variant);
  }
  return [...out];
}

/* ---------------- 2. LLM alias expansion ---------------- */

const MAX_LLM_ALIASES = 3;
const MAX_VARIANTS_TOTAL = 6;

/** Parse a JSON array of strings out of an LLM response. */
function parseStringArray(raw: string): string[] {
  const text = String(raw || "").trim();
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const parsed = JSON.parse(arrMatch[0]);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {}
  }
  // Fallback shapes: {"variants": [...]}, {"terms": [...]}, {"aliases": [...]}
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]);
      const arr = obj?.variants || obj?.terms || obj?.aliases || obj?.synonyms;
      if (Array.isArray(arr)) return arr.map(String);
    } catch {}
  }
  return [];
}

/**
 * LLM-generated alias search terms (official full name, legacy symbols).
 * Returns [] on any failure — the mechanical variants remain as the floor.
 */
export async function expandQueryWithLlm(query: string, context?: string): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];

  const system =
    "You are a search-term expansion assistant for biomedical databases (RCSB PDB, PubMed, UniProt). " +
    "Respond ONLY with a JSON array of strings.";
  const prompt = [
    `Query term: ${q}`,
    context ? `Research context: ${String(context).slice(0, 300)}` : "",
    "",
    "Generate alternative search terms a researcher should ALSO search for this term " +
    "(official full names, common aliases, legacy names, symbol variants).",
    "Rules:",
    "- Every term must point to the SAME protein/gene/molecule as the query term — never " +
    "broaden to families, functions, or diseases.",
    "- Terms must work as concise database full-text queries (no boolean operators).",
    "- At most 4 terms, most valuable first. If no precise alias exists, return [].",
    '- Output ONLY the JSON array, e.g. ["transmembrane channel-like protein 1"].',
  ]
    .filter(Boolean)
    .join("\n");

  const key = llmCacheKey(prompt, { taskType: "query-expand" });
  const cached = getCachedLLMResult(key);
  if (Array.isArray(cached)) return cached as string[];

  let terms: string[] = [];
  try {
    const raw = await chat(prompt, { system, temperature: 0.2, maxTokens: 512 });
    terms = parseStringArray(raw);
  } catch (err: any) {
    console.warn("[search-enhance] LLM query expansion failed:", err?.message?.slice(0, 120));
    return [];
  }

  // Dedup against the original term + mechanical forms; cap the count.
  const seen = new Set([q.toLowerCase(), ...mechanicalQueryVariants(q).map((v) => v.toLowerCase())]);
  const cleaned: string[] = [];
  for (const t of terms) {
    const s = String(t ?? "").trim();
    if (!s || s.length > 80) continue;
    const low = s.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    cleaned.push(s);
    if (cleaned.length >= MAX_LLM_ALIASES) break;
  }
  setCachedLLMResult(key, cleaned);
  return cleaned;
}

export interface QueryExpansion {
  /** All query spellings to run, original first. Empty only for empty input. */
  variants: string[];
  usedLlm: boolean;
}

/** Combined entry point: mechanical forms ∪ LLM aliases (original first). */
export async function expandQueryVariants(
  query: string,
  context?: string,
  opts?: { useLlm?: boolean }
): Promise<QueryExpansion> {
  const q = query.trim();
  if (!q) return { variants: [], usedLlm: false };
  const mech = mechanicalQueryVariants(q);
  if (opts?.useLlm === false) {
    return { variants: mech.slice(0, MAX_VARIANTS_TOTAL), usedLlm: false };
  }
  let llmTerms: string[] = [];
  let usedLlm = false;
  try {
    llmTerms = await expandQueryWithLlm(q, context);
    usedLlm = llmTerms.length > 0;
  } catch {
    // expandQueryWithLlm already degrades internally; belt & suspenders.
  }
  const variants = [...mech, ...llmTerms].slice(0, MAX_VARIANTS_TOTAL);
  return { variants, usedLlm };
}

/* ---------------- 3. LLM relevance filter ---------------- */

const FILTER_BATCH = 25;

/** Parse the filter decision JSON. null = unparseable (caller keeps all). */
function parseFilterJson(raw: string): { keep?: unknown[]; drop?: { i?: unknown; reason?: unknown }[] } | null {
  const text = String(raw || "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const tryParse = (src: string) => {
    try {
      const obj = JSON.parse(src);
      if (obj && typeof obj === "object" && (Array.isArray(obj.keep) || Array.isArray(obj.drop))) {
        return obj;
      }
      return null;
    } catch {
      return undefined; // parse error — try repair below
    }
  };
  const direct = tryParse(m[0]);
  if (direct) return direct;
  if (direct === null) return null; // valid JSON, wrong shape
  try {
    const fixed = m[0]
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
      .replace(/'/g, '"');
    const repaired = tryParse(fixed);
    return repaired ?? null;
  } catch {
    return null;
  }
}

export interface RelevanceFilterResult {
  kept: DatabaseResultItem[];
  dropped: FilteredOutItem[];
  usedLlm: boolean;
}

function itemLine(item: DatabaseResultItem, idx: number): string {
  const abs = String(item.abstract || "").replace(/\s+/g, " ").slice(0, 240);
  const extra = (item.extra || {}) as Record<string, unknown>;
  const meta = [
    item.journal ? `Journal: ${item.journal}` : "",
    extra.organism ? `Organism: ${String(extra.organism).slice(0, 80)}` : "",
    extra.method ? `Method: ${String(extra.method).slice(0, 60)}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  return (
    `#${idx} | Title: ${String(item.title || "(untitled)").slice(0, 200)} | ` +
    `${abs ? `Abstract: ${abs}` : "Abstract: (none)"}` +
    (meta ? ` | ${meta}` : "")
  );
}

/**
 * LLM relevance filter: drop entries whose PRIMARY research subject is a
 * different protein than the query target. Conservative — uncertain or
 * failed calls keep everything (the citation planner re-scores later).
 */
export async function filterItemsByRelevance(
  items: DatabaseResultItem[],
  query: string,
  context?: string
): Promise<RelevanceFilterResult> {
  if (items.length <= 1) return { kept: items, dropped: [], usedLlm: false };
  const q = query.trim();
  if (!q) return { kept: items, dropped: [], usedLlm: false };

  /* round-51 blind-spot guard: entries with no usable metadata (title
   * missing, or just the external ID) cannot be judged — the "when
   * uncertain, KEEP" policy would silently admit them. That was the exact
   * hole that let bare title=ID RCSB cards survive as pinned sources when
   * data.rcsb.org blipped. Drop them deterministically instead. */
  const judgeable: DatabaseResultItem[] = [];
  const dropped: FilteredOutItem[] = [];
  for (const it of items) {
    const title = String(it.title || "").trim();
    if (!title || title === String(it.externalId || "")) {
      dropped.push({
        externalId: it.externalId,
        title: title || String(it.externalId),
        reason: "no title/metadata available — cannot verify relevance",
      });
    } else {
      judgeable.push(it);
    }
  }
  if (judgeable.length <= 1) {
    return { kept: judgeable, dropped, usedLlm: false };
  }

  const system =
    "You are a rigorous screening assistant for biomedical search results. Respond ONLY with JSON.";
  const contextLine = context ? `\nResearch context: ${String(context).slice(0, 300)}` : "";
  const keepIdx = new Set<number>();
  let usedLlm = false;

  for (let off = 0; off < judgeable.length; off += FILTER_BATCH) {
    const batch = judgeable.slice(off, off + FILTER_BATCH);
    const listing = batch.map((it, i) => itemLine(it, off + i)).join("\n");
    const prompt =
      `Research target (the molecule/protein the user studies): ${q}${contextLine}\n\n` +
      `The following ${batch.length} search results were retrieved using this query and its ` +
      `spelling variants:\n${listing}\n\n` +
      `Decide for EACH result whether its PRIMARY RESEARCH SUBJECT is the target molecule:\n` +
      `- KEEP: the entry studies the target itself (structure, mutants, complexes, mechanism, ` +
      `function, expression, clinical role).\n` +
      `- DROP: the entry's primary subject is a DIFFERENT protein/molecule — including entries ` +
      `that merely MENTION the target (background, control, tool, or a list mention), or where ` +
      `the abbreviation coincidentally denotes something unrelated.\n` +
      `- When uncertain, KEEP — later curation stages re-score precisely.\n` +
      `- Do not drop entries for studying the target in a different organism.\n\n` +
      `Respond ONLY with JSON: {"keep": [numbers], "drop": [{"i": number, "reason": "short reason"}]}`;

    const key = llmCacheKey(prompt, { taskType: "result-filter" });
    let parsed = getCachedLLMResult(key);
    let fromCache = parsed != null;
    if (!parsed) {
      let raw: string;
      try {
        raw = await chat(prompt, { system, temperature: 0.1, maxTokens: 1536 });
      } catch (err: any) {
        console.warn(
          "[search-enhance] LLM relevance filter failed (keeping all):",
          err?.message?.slice(0, 120)
        );
        raw = "";
      }
      parsed = raw ? parseFilterJson(raw) : null;
      if (parsed) setCachedLLMResult(key, parsed);
    }
    if (!parsed) {
      // No decision for this batch → keep everything in it.
      for (let i = off; i < off + batch.length; i++) keepIdx.add(i);
      continue;
    }
    if (!fromCache) usedLlm = true;

    const droppedIdx = new Set<number>();
    const dropArr = Array.isArray(parsed.drop) ? parsed.drop : [];
    for (const d of dropArr) {
      const i = Number((d as any)?.i);
      if (Number.isInteger(i) && i >= 0 && i < judgeable.length && !droppedIdx.has(i)) {
        droppedIdx.add(i);
        dropped.push({
          externalId: judgeable[i]?.externalId,
          title: String(judgeable[i]?.title || "(untitled)").slice(0, 200),
          reason: String((d as any)?.reason || "primary subject is a different protein").slice(0, 200),
        });
      }
    }
    const keepArr = Array.isArray(parsed.keep) ? parsed.keep : [];
    for (const k of keepArr) {
      const i = Number(k);
      if (Number.isInteger(i) && i >= 0 && i < judgeable.length && !droppedIdx.has(i)) {
        keepIdx.add(i);
      }
    }
    // Conservative backfill: anything not explicitly dropped stays.
    for (let i = off; i < off + batch.length; i++) {
      if (!droppedIdx.has(i)) keepIdx.add(i);
    }
  }

  const kept = judgeable.filter((_, i) => keepIdx.has(i));
  return { kept, dropped, usedLlm };
}

/* ---------------- concurrency helper ---------------- */

/**
 * Run an async mapper with a fixed worker pool, preserving input order in
 * the output array. Used to parallelize RCSB per-ID metadata enrichment
 * (previously strictly serial — 20 IDs ≈ 40 sequential HTTP round-trips).
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) break;
        out[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return out;
}
