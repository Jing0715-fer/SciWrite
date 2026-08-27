/**
 * v57-1: Helper functions extracted from generate-full/route.ts to reduce
 * the route file size (was 2836 lines, caused Turbopack OOM during
 * compilation in 3.9Gi RAM environments).
 *
 * These functions are pure utilities — no side effects, no DB access.
 * Extracted: ncbiItemsCount, countBySource, generateWebSearchQueries,
 * curateReferences, inferFormat, safeParseJSON, extractKeywords,
 * scoreRelevance.
 */

import { chatWithSession } from "@/lib/llm-session";
import JSON5 from "json5";

export function ncbiItemsCount(items: any[]): number {
  return items.filter((i) => i.source === "pubmed" || i.source === "ncbi").length;
}

export function countBySource(items: any[], source: string): number {
  return items.filter((i) => i.source === source).length;
}

// ---------------------------------------------------------------------------
// Preprint/published dedupe (round-14 hardening)
//
// E2E finding (TMC1/TMC2 article): the SAME work entered the reference pool
// twice — once as its bioRxiv/Research Square preprint and once as the
// peer-reviewed version (Giese eLife 2025 + bioRxiv 2024; Wang Nat Commun
// 2024 + Research Square 2024). Both survived curation and were cited
// side-by-side, which a reviewer flagged as a citation-management defect.
//
// This mechanical pass runs BEFORE curation so the LLM never sees both
// versions of the same work.
// ---------------------------------------------------------------------------

const PREPRINT_RE =
  /(bio|med|chem)rxiv|research ?square|arxiv|preprint|ssrn|peerj preprints|authorea/i;

function isPreprintRef(r: any): boolean {
  const journal = String(r?.journal || "");
  const url = String(r?.url || "");
  const doi = String(r?.doi || "");
  return (
    PREPRINT_RE.test(journal) ||
    /biorxiv|medrxiv|researchsquare|arxiv/i.test(url) ||
    // 10.1101/* is the bioRxiv/medRxiv DOI prefix
    /^10\.1101\//.test(doi)
  );
}

function normalizeTitle(t: any): string {
  return String(t || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleTokens(t: any): Set<string> {
  return new Set(normalizeTitle(t).split(" ").filter((w) => w.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function firstAuthorSurname(r: any): string {
  const first = String(r?.authors || "").split(",")[0] || "";
  return first.trim().split(/\s+/)[0].toLowerCase();
}

function refYear(r: any): number {
  return parseInt(String(r?.year || ""), 10) || 0;
}

/**
 * True when two reference entries describe the SAME work (a preprint and its
 * published version, or a straight duplicate entry).
 *
 * Rule 1 — identical normalized titles (covers the Giese pair: preprint and
 * eLife version share the exact title).
 * Rule 2 — at least one entry is a preprint AND first-author surnames match
 * AND years differ by ≤1 AND title-token Jaccard ≥ 0.75 (covers the Wang
 * pair, whose preprint title was reworded for publication). When neither is a
 * preprint we deliberately do NOT fuzzy-merge: two distinct published papers
 * can legitimately share title tokens.
 */
function isSameWork(a: any, b: any): boolean {
  const na = normalizeTitle(a?.title);
  const nb = normalizeTitle(b?.title);
  if (na && na === nb) return true;
  const aPre = isPreprintRef(a);
  const bPre = isPreprintRef(b);
  if (!aPre && !bPre) return false;
  if (firstAuthorSurname(a) !== firstAuthorSurname(b)) return false;
  const ya = refYear(a);
  const yb = refYear(b);
  if (ya && yb && Math.abs(ya - yb) > 1) return false;
  return jaccard(titleTokens(a?.title), titleTokens(b?.title)) >= 0.75;
}

/** True → keep `a` over `b`: published beats preprint, then newer beats older. */
function preferredOver(a: any, b: any): boolean {
  const aPre = isPreprintRef(a);
  const bPre = isPreprintRef(b);
  if (aPre !== bPre) return !aPre;
  return refYear(a) >= refYear(b);
}

export interface PreprintDedupeResult {
  refs: any[];
  dropped: { keptTitle: string; droppedTitle: string; droppedJournal: string }[];
}

/**
 * Remove preprint duplicates from a reference list, keeping the published
 * version of each work. Pure function; O(n²) is fine for n ≤ a few hundred.
 */
export function dedupePreprintVersions(references: any[]): PreprintDedupeResult {
  const kept: any[] = [];
  const dropped: PreprintDedupeResult["dropped"] = [];
  outer: for (const r of references) {
    for (let i = 0; i < kept.length; i++) {
      if (isSameWork(r, kept[i])) {
        if (preferredOver(r, kept[i])) {
          dropped.push({
            keptTitle: String(r.title || ""),
            droppedTitle: String(kept[i].title || ""),
            droppedJournal: String(kept[i].journal || ""),
          });
          kept[i] = r;
        } else {
          dropped.push({
            keptTitle: String(kept[i].title || ""),
            droppedTitle: String(r.title || ""),
            droppedJournal: String(r.journal || ""),
          });
        }
        continue outer;
      }
    }
    kept.push(r);
  }
  return { refs: kept, dropped };
}

// ---------------------------------------------------------------------------
// round-15: primary-paper coverage assertion
// ---------------------------------------------------------------------------

/** Journal/title heuristics for "this is a review, not primary research". */
function looksLikeReview(r: any): boolean {
  const j = String(r?.journal || "").toLowerCase();
  const t = String(r?.title || "").toLowerCase();
  return /review|perspect|current opinion|opinion|primer|insight|outlook|survey/.test(j) || /^(\ba\b\s+)?(review|perspective|opinion|primer)\b/.test(t);
}

/** True if the reference is a primary structure-determination paper. */
function isPrimaryStructurePaper(r: any): boolean {
  const t = String(r?.title || "").toLowerCase();
  if (looksLikeReview(r)) return false;
  return /\bstructure of\b|\bstructures of\b|\bstructural basis\b|\bcryo-?em\b|\bcryo-?electron\b|\barchitecture of\b|\bx-ray structure\b|\bcrystal structure\b/.test(t);
}

/** True if the reference is a primary therapy/intervention paper. */
function isPrimaryTherapyPaper(r: any): boolean {
  const t = String(r?.title || "").toLowerCase();
  if (looksLikeReview(r)) return false;
  return /\bgene therapy\b|\btherapeutic\b|\brestores (auditory|hearing|function)\b|\btreatment of\b|\brna interference\b|\bgene editing\b|\bcrispr\b|\baav\b|\bantisense\b/.test(t);
}

export interface CoverageBackfillResult {
  refs: any[];
  backfilled: { signal: string; addedTitle: string; replacedTitle: string | null }[];
}

/**
 * round-15: mechanical coverage assertion AFTER curation + planning.
 *
 * E2E regression finding: an article titled "…cryo-EM structures of TMC1/TMC2"
 * shipped with ZERO primary structure papers (claims hung on reviews), and a
 * Therapeutic-Approaches section had no therapy papers in the curated pool
 * (Askew 2015 gene-therapy paper was in the gather pool but never curated).
 * The LLM curation prompt asks for primary papers (priority 5), but prompt
 * rules alone proved unreliable — this function enforces it mechanically.
 *
 * Signals are derived from the topic + planned section titles:
 *   - structure signal (structur/architect/cryo/morpholog/anatomy) → curated
 *     list must contain ≥ 2 primary structure papers
 *   - therapy signal (therapeut/treatment/gene therapy/clinic/restor) → ≥ 1
 *     primary therapy paper
 * Missing papers are pulled from the deduped candidate pool, replacing the
 * most expendable REVIEWS first (reviews are the safest swaps: their claims
 * are second-hand and other sections usually cite the primaries anyway). If
 * no review is expendable, the paper is appended (max +2 over the cap).
 */
export function ensurePrimaryPaperCoverage(
  topic: string,
  sectionTitles: string[],
  candidates: any[],
  curated: any[],
): CoverageBackfillResult {
  const corpus = `${topic}\n${sectionTitles.join("\n")}`.toLowerCase();
  const backfilled: CoverageBackfillResult["backfilled"] = [];
  const refs = [...curated];
  const refKey = (r: any) => `${String(r?.title || "").toLowerCase().replace(/\s+/g, " ").trim()}|${String(r?.doi || r?.url || r?.externalId || "").toLowerCase()}`;
  const inCurated = new Set(refs.map(refKey));

  const signals: { name: string; active: boolean; test: (r: any) => boolean; min: number }[] = [
    {
      name: "structure",
      active: /structur|architect|cryo|morpholog|anatom/.test(corpus),
      test: isPrimaryStructurePaper,
      min: 2,
    },
    {
      name: "therapy",
      active: /therapeut|treatment|gene therapy|clinic|restor|translational/.test(corpus),
      test: isPrimaryTherapyPaper,
      min: 1,
    },
  ];

  for (const sig of signals) {
    if (!sig.active) continue;
    let have = refs.filter(sig.test).length;
    if (have >= sig.min) continue;
    // Find candidates for this signal, best first (newest, and title keyword
    // density as a light relevance sort), skipping anything already curated.
    const pool = candidates
      .filter((c) => sig.test(c) && !inCurated.has(refKey(c)))
      .sort((a, b) => refYear(b) - refYear(a));
    for (const cand of pool) {
      if (have >= sig.min) break;
      // Prefer replacing a review; otherwise append (bounded at +2).
      const reviewIdx = refs.findIndex(looksLikeReview);
      if (reviewIdx >= 0) {
        const replaced = refs[reviewIdx];
        refs[reviewIdx] = cand;
        backfilled.push({ signal: sig.name, addedTitle: String(cand.title || ""), replacedTitle: String(replaced.title || "") });
      } else {
        if (refs.length >= curated.length + 2) break;
        refs.push(cand);
        backfilled.push({ signal: sig.name, addedTitle: String(cand.title || ""), replacedTitle: null });
      }
      inCurated.add(refKey(cand));
      have++;
    }
  }
  return { refs, backfilled };
}

/**
 * Generate web search queries to supplement database queries.
 * Capped at maxQueries to avoid JSON truncation by the LLM's output token limit.
 */
export async function generateWebSearchQueries(
  projectId: string,
  topic: string,
  field: string,
  targetWords: number,
  maxQueries: number = 8,
  maxTokens?: number,
): Promise<string[]> {
  // maxQueries >= 9999 means "no limit" (user set 0 in the UI).
  const isUnlimited = maxQueries >= 9999;
  try {
    const system = "You are a research strategist who designs web search queries to find supplementary sources.";
    const prompt = `RESEARCH TOPIC: ${topic}
FIELD: ${field}
TARGET: ${targetWords}-word comprehensive review article.

${isUnlimited
  ? `Design as many well-chosen web search queries as needed for MAXIMUM coverage (no upper limit — but keep the JSON concise).`
  : `Design ${Math.max(3, maxQueries - 3)}-${maxQueries} well-chosen web search queries (NOT more — too many causes JSON truncation).`
} Find recent reviews, preprints, news, and supplementary sources
NOT available in PubMed/RCSB/UniProt. Use distinct strategies:
- 1 broad review search (e.g. "TMC protein family review 2024")
- 1-2 specific mechanism searches (e.g. "TMC1 cryo-EM structure mechanism")
- 1 disease/clinical search (e.g. "TMC1 gene therapy hearing loss clinical trial")
- 1 recent news/breakthrough (e.g. "TMC channel discovery 2025")
- 1 preprint search (e.g. "site:biorxiv.org TMC mechanotransduction")
- 1 comparison/phylogeny search if relevant

Keep the JSON concise. Duplicates will be removed automatically.

Respond as STRICT JSON: { "queries": ["query 1", "query 2", ...] }`;

    const raw = await chatWithSession(projectId, prompt, {
      system,
      temperature: 0.4,
      taskType: "gather",
      metadata: { step: "web-search-queries" },
      maxTokens,
    });
    const parsed = safeParseJSON(raw, { queries: [] });
    // When unlimited, don't slice — keep everything the LLM returned.
    const queries = isUnlimited
      ? (parsed.queries || [])
      : (parsed.queries || []).slice(0, maxQueries);
    // Fallback: if LLM didn't return any queries, use basic topic-based queries
    if (queries.length === 0) {
      const topicWords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
      const topicPhrase = topicWords.join(" ");
      return [
        `${topicPhrase} review`,
        `${topicPhrase} mechanism`,
        `${topicPhrase} recent advances`,
        `${topicWords[0]} protein family`,
        `${topicWords[0]} structure function`,
      ];
    }
    return queries;
  } catch {
    return [`${topic} review`, `${topic} mechanism`, `${topic} recent advances`];
  }
}

/**
 * Have the LLM curate the most relevant references for the article.
 * This reduces the reference set to a manageable size and ensures focus.
 */
export async function curateReferences(
  projectId: string,
  references: any[],
  topic: string,
  field: string,
  maxCount: number,
  maxTokens?: number,
): Promise<any[]> {
  if (references.length <= maxCount) return references;

  try {
    const system = "You are a research curator who selects the most relevant references for a review article.";
    const refList = references.map((r, i) => {
      const auth = r.authors || "Anon";
      const yr = r.year ? ` (${r.year})` : "";
      return `[${i + 1}] ${auth}${yr} ${r.title?.slice(0, 80) || ""}`;
    }).join("\n");

    const prompt = `RESEARCH TOPIC: ${topic}
FIELD: ${field}
TARGET: Select the ${maxCount} MOST relevant references for a comprehensive review.

AVAILABLE REFERENCES (${references.length} total):
${refList}

Select the most relevant, recent, and authoritative references. Prioritize:
1. Recent publications (last 5 years)
2. Seminal/foundational papers
3. Review articles covering the topic
4. Primary research with key findings
5. The ORIGINAL papers behind key advances (e.g., the primary structure
   determination, functional demonstration, or therapy papers) — a review
   about a structure/mechanism/therapy topic MUST cite the primary papers,
   not only reviews describing them
6. When a preprint AND its peer-reviewed version are both listed, select the
   peer-reviewed version — never select both

Respond as STRICT JSON: { "indices": [1, 3, 5, 7, ...] }
Use 1-based indices. Select exactly ${maxCount} references.`;

    // Check LLM cache — if the user has regenerated with the same topic +
    // reference list, the curation result is reusable. This saves a 5-15s
    // LLM call on every regeneration.
    const { llmCacheKey, getCachedLLMResult, setCachedLLMResult } = await import("@/lib/llm-cache");
    const cacheKey = llmCacheKey(prompt, { system, temperature: 0.3, taskType: "curate", maxTokens });
    const cached = getCachedLLMResult(cacheKey);
    let raw: string;
    if (cached) {
      console.log("[curateReferences] cache hit — skipping LLM call");
      raw = cached;
    } else {
      console.log("[curateReferences] cache miss — calling LLM");
      raw = await chatWithSession(projectId, prompt, {
        system,
        temperature: 0.3,
        taskType: "curate",
        metadata: { step: "curate", total: references.length, maxCount },
        maxTokens,
      });
      setCachedLLMResult(cacheKey, raw);
    }
    const parsed = safeParseJSON(raw, { indices: [] });
    const indices = (parsed.indices || [])
      .filter((n: number) => n >= 1 && n <= references.length)
      .slice(0, maxCount);

    if (indices.length === 0) {
      return references.slice(0, maxCount);
    }

    return indices.map((n: number) => references[n - 1]);
  } catch {
    return references.slice(0, maxCount);
  }
}

/**
 * Infer paragraph format from section title and position.
 */
export function inferFormat(title: string, index: number, total: number): string {
  const lower = title.toLowerCase();
  if (index === 0) return "abstract";
  if (lower.includes("introduc")) return "intro";
  if (lower.includes("background")) return "background";
  if (lower.includes("method")) return "methods";
  if (lower.includes("result")) return "results";
  if (lower.includes("discussion")) return "discussion";
  if (lower.includes("conclusion") || lower.includes("future") || index === total - 1) return "conclusion";
  return "background";
}

export function safeParseJSON(raw: string, fallback: any): any {
  // Strategy 1: Try to find a JSON code block ```json ... ```
  // Use greedy match to capture the FULL JSON object inside code block
  const codeBlockMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch {}
  }

  // Strategy 1b: Try code block without closing ``` (LLM may have forgotten it)
  const codeBlockMatch2 = raw.match(/```(?:json)?\s*(\{[\s\S]*\})/);
  if (codeBlockMatch2) {
    try {
      return JSON.parse(codeBlockMatch2[1]);
    } catch {}
  }

  // Strategy 2: Greedy match — find the largest { ... } block
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.warn("[safeParseJSON] No JSON found in response (length=" + raw.length + ")");
    console.warn("[safeParseJSON] First 500 chars: " + raw.slice(0, 500));
    return fallback;
  }
  try {
    return JSON.parse(match[0]);
  } catch (e: any) {
    console.warn("[safeParseJSON] Failed to parse JSON (length=" + match[0].length + ")");
    console.warn("[safeParseJSON] Error: " + (e?.message || "unknown"));
    console.warn("[safeParseJSON] First 200 chars: " + match[0].slice(0, 200));
    console.warn("[safeParseJSON] Last 200 chars: " + match[0].slice(-200));

    // Strategy 3: Tolerant parse — JSON5 handles trailing commas, unquoted
    // keys, and single-quoted strings CORRECTLY (unlike the regex repair
    // below, which mangles numeric keys and apostrophes inside values).
    try {
      return JSON5.parse(match[0]);
    } catch {
      // fall through to the last-ditch regex repair
    }

    // Strategy 4 (last resort): regex repair of common JSON issues
    let fixed = match[0]
      .replace(/,\s*}/g, "}")  // trailing comma
      .replace(/,\s*]/g, "]")  // trailing comma in array
      .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3')  // unquoted keys
      .replace(/'/g, '"');  // single quotes
    try {
      return JSON.parse(fixed);
    } catch (e2: any) {
      console.warn("[safeParseJSON] Fix attempt also failed: " + (e2?.message || "unknown"));
      return fallback;
    }
  }
}

/**
 * Extract meaningful keywords from a section's title + focus text.
 * Used for per-section reference filtering — we score each ref by how many
 * of these keywords appear in its title/abstract, and keep only the top
 * scoring refs so the LLM isn't tempted to cite irrelevant sources.
 *
 * Strategy:
 * 1. Lowercase + tokenize on non-alphanumeric.
 * 2. Remove stopwords (the/a/an/of/and/...) and very short tokens (<3 chars).
 * 3. Remove the project topic words themselves (they'd match everything).
 * 4. Keep terms that are >= 4 chars OR look like gene/protein names (TMC1,
 *    TMC2, ...), species (mouse, zebrafish), or methods (cryo-EM, CRISPR).
 *
 * Returns a de-duplicated keyword array.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "by",
  "for", "with", "from", "into", "this", "that", "these", "those", "is",
  "are", "was", "were", "be", "been", "being", "have", "has", "had", "do",
  "does", "did", "will", "would", "could", "should", "may", "might", "can",
  "shall", "must", "not", "no", "nor", "so", "if", "then", "than", "too",
  "very", "just", "also", "only", "about", "above", "after", "again",
  "against", "all", "any", "because", "before", "below", "between", "both",
  "during", "each", "few", "more", "most", "other", "over", "same", "some",
  "such", "through", "under", "until", "up", "down", "out", "off", "over",
  "under", "again", "further", "once", "here", "there", "when", "where",
  "why", "how", "what", "which", "who", "whom", "whose", "section", "part",
  "focus", "describe", "discuss", "review", "summarize", "provide", "cover",
  "include", "using", "used", "use", "via", "within", "without", "upon",
  "their", "they", "them", "it", "its", "as", "we", "our", "us", "you",
  "your", "he", "she", "his", "her", "its", "our", "their",
]);

export function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  // Match word-like tokens including TMC1, CRISPR-Cas9, cryo-EM, etc.
  const tokens = lower.match(/[a-z][a-z0-9\-]{2,}/g) || [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    if (t.length < 4 && !/^[a-z]+\d+$/.test(t)) continue; // keep TMC1-style short names
    if (seen.has(t)) continue;
    seen.add(t);
    keywords.push(t);
  }
  return keywords;
}

/**
 * v99-3: Enhanced keyword extraction for section ref filtering.
 *
 * The v98 test showed 46 topicality warnings (0% overlap between citing
 * sentences and references). The root cause: `extractKeywords` returns ALL
 * tokens, including generic words ("detailed", "explanation", "work") that
 * dilute relevance scoring. This function:
 *
 * 1. Removes generic academic fillers ("overview", "discussion", "detailed",
 *    "explanation", "current", "including", "work", "highlighting", etc.)
 * 2. Ranks by frequency, keeps top 12 keywords (prevents over-matching)
 *
 * Used by generate-full's per-section ref filtering to score which refs
 * are most relevant to a section's title+focus.
 */
const GENERIC_FILLERS = new Set([
  "overview", "discussion", "detailed", "explanation", "current",
  "including", "work", "highlighting", "background", "introduction",
  "conclusion", "summary", "approach", "study", "studies", "research",
  "analysis", "review", "chapter", "section", "topic", "focus",
  "explore", "exploration", "examine", "examination", "investigate",
  "investigation", "understand", "understanding", "provide", "provides",
  "present", "presents", "show", "shows", "demonstrate", "demonstrates",
  "reveal", "reveals", "describe", "describes", "discuss", "discusses",
  "consider", "considers", "examine", "examines", "address", "addresses",
  "cover", "covers", "include", "includes", "involve", "involves",
  "related", "relevant", "important", "significant", "various", "several",
  "many", "much", "also", "well", "more", "most", "such", "other",
  "first", "second", "third", "new", "novel", "recent", "previous",
  "prior", "early", "late", "main", "major", "minor", "general",
  "specific", "particular", "certain", "given", "known", "unknown",
]);

export function extractSectionKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.match(/[a-z][a-z0-9\-]{2,}/g) || [];
  // Count frequency to rank keywords
  const freq = new Map<string, number>();
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    if (GENERIC_FILLERS.has(t)) continue; // v99-3: remove academic fillers
    if (t.length < 4 && !/^[a-z]+\d+$/.test(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  // Sort by frequency (desc), then alphabetically for stability
  const ranked = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12) // v99-3: top 12 keywords max
    .map(([kw]) => kw);
  return ranked;
}

/**
 * Score how relevant a reference's text (title + abstract + journal) is to
 * a set of section keywords. Returns the count of distinct keyword matches.
 *
 * This is a simple keyword-overlap heuristic — not semantic similarity —
 * but it's fast (no LLM call) and catches the common case where a ref about
 * "TMC7 acrosome biogenesis" should NOT be cited in a section about
 * "TMC1 animal models and hearing".
 *
 * v99-3: Added partial-match bonus — if a keyword like "crispr" partially
 * matches "crispr-cas9" in the ref text, count it (0.5). This reduces
 * false-zero scores that caused topicality warnings in v98.
 */
export function scoreRelevance(keywords: string[], refText: string): number {
  if (keywords.length === 0) return 0;
  const lower = refText.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) {
      score++;
    } else if (kw.length >= 5) {
      // v99-3: partial match — check if keyword's prefix (first 6 chars)
      // appears as a word boundary in the ref text (e.g., "crispr" in "crispr-cas9")
      const partialRe = new RegExp(`\\b${kw.slice(0, Math.min(kw.length, 6))}`, "i");
      if (partialRe.test(lower)) score += 0.5;
    }
  }
  return score;
}

// ---------------------------------------------------------------------------
// Cross-section near-duplicate claim removal (round-16 hardening, round-17 fixes)
//
// E2E regression finding (TMC1/TMC2, two consecutive fresh runs): despite the
// round-15 claim-level digest + NO-REPETITION prompt rule, the LLM still
// restated the same citation-bearing claim in 2+ sections nearly verbatim
// ("at least a dozen components [4]", "cysteine residues within the pore
// region [7]", "assemble as dimers … TMEM16 [7]", "lipid-mediated subunit
// contacts [9]", "phosphatidylserine externalization [11]"). Prompt-level
// defenses reduce but cannot eliminate this — so compose now applies a
// MECHANICAL pass: any claim sentence (contains a citation marker) in a LATER
// section that near-matches the claim pool of an EARLIER section is dropped
// (first occurrence wins).
//
// Match rule (calibrated on the two E2E corpuses, see
// scripts/test-dedupe-round16.ts):
//   duplicate ⟺ containment ≥ 0.66  OR  (longest common word run ≥ 5
//   AND containment ≥ 0.45), where containment = |words(s) ∩ pool_j| /
//   |words(s)| over content words (stopwords stripped). The 0.66 line sits
//   between the closest false positive measured on the calibration corpus
//   (a §4 Cib2-knockout phenotype sentence at 0.652 — specific evidence whose
//   overlap with §1 was inflated by generic words) and the closest true
//   duplicate caught by containment alone (0.667); true duplicates below
//   0.66 are still caught by the run branch (e.g. 0.650 + run 5).
// Guards: sentence must carry ≥ 8 content words; a section always keeps
// ≥ 1 citation; empty paragraphs are collapsed.
//
// round-17 fixes (verified on the third fresh E2E run):
//   A. TRUNCATION BUG: naive `split(/(?<=[.!?])\s+/)` broke sentences at
//      abbreviation periods — "The structural determination of the *C.
//      elegans* TMC-2 complex has provided insights … [5]" was split into
//      "…of the *C." + "elegans* TMC-2 complex …", the second fragment
//      matched as a duplicate and was removed, leaving a dangling fragment
//      "The structural determination of the *C." in the composed article.
//      Fix: splitIntoSentences() merges any fragment that starts with a
//      lowercase letter (or digit, after a known abbreviation) back into
//      its predecessor.
//   B. REMOVAL CAP: the fixed ≤3-removals-per-section cap was hit exactly
//      on §6 of the E2E run (3 true duplicates removed, a 4th left standing).
//      Replaced by: ≤5 removals per section AND ≤40% of a section's words.
//   C. UNCITED RESTATEMENTS: sentences WITHOUT a citation marker were never
//      compared, so the LLM's citation-less restatements of earlier claims
//      (e.g. a whole electrophysiology paragraph restated in §5 with the
//      citations dropped) survived. Now also checked, with a stricter
//      threshold (containment ≥ 0.80 AND run ≥ 6, ≥ 12 content words).
// ---------------------------------------------------------------------------

export type CrossSectionDedupRemoval = {
  section: number; // 1-based, the section that lost the sentence
  matchedSection: number; // 1-based, where the claim was first established
  snippet: string; // ≤ 90 chars of the removed sentence
  uncited?: boolean; // round-17: removed as an uncited restatement
};

const MAX_DEDUP_REMOVALS_PER_SECTION = 5;
const MAX_DEDUP_WORD_LOSS = 0.4; // never strip more than 40% of a section's words

// Known abbreviations whose trailing period is NOT a sentence boundary.
const ABBREV_TAIL_RE =
  /(?:\bet al\.|\be\.g\.|\bi\.e\.|\bvs\.|\bcf\.|\betc\.|\bca\.|\bapprox\.|\bFig\.|\bRef\.|\bRefs\.|\bNo\.|\bVol\.|\bProf\.|\bDr\.)$/i;
// A single capital letter ending a fragment (initials / "*C." of "*C. elegans*").
const SINGLE_CAP_TAIL_RE = /(?:^|[^A-Za-z])([A-Z])\.$/;

/**
 * Sentence splitter that tolerates abbreviation periods. A fragment is
 * merged back into its predecessor when it cannot grammatically start a
 * sentence: it begins with a lowercase letter ("elegans* TMC-2 complex …")
 * or with a digit directly after a known abbreviation/initial ("50 pS …"
 * after "approx.").
 */
export function splitIntoSentences(text: string): string[] {
  const raw = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const merged: string[] = [];
  for (const frag of raw) {
    const stripped = frag.replace(/^[*_`#>\s"“'\\(]+/, "");
    const startsLower = /^[a-z]/.test(stripped);
    const startsLowerOrDigit = /^[a-z0-9]/.test(stripped);
    const prev = merged.length ? merged[merged.length - 1] : null;
    const prevTrim = prev ? prev.trim() : "";
    const prevEndsAbbrev =
      ABBREV_TAIL_RE.test(prevTrim) || SINGLE_CAP_TAIL_RE.test(prevTrim);
    if (prev && (startsLower || (prevEndsAbbrev && startsLowerOrDigit))) {
      merged[merged.length - 1] = `${prev} ${frag}`;
    } else {
      merged.push(frag);
    }
  }
  return merged;
}

/**
 * Round-17 validation-gate probe: measure the trailing run of UNCITED
 * substantive claim words at the end of a section ({{Rn}} keys are the
 * citation form at gate time). Returns the word count of the trailing
 * uncited block when it is long enough AND claim-bearing (≥2 evidence
 * verbs); returns null when the tail is properly cited or clearly
 * transitional.
 *
 * E2E motivation: the outlook section of the third run opened with three
 * cited sentences and then made ~100 words of therapeutic claims
 * ("gene therapy approaches offer promising avenues", "functional redundancy
 * suggests …", "the discovery that …") with zero citations.
 */
const EVIDENCE_VERB_RE =
  /\b(?:demonstrat\w*|reveal\w*|show(?:n|s|ing)?|suggest\w*|indicat\w*|studies|findings|evidence|discover\w*|establish\w*|proves?|supports?|recent advances|has been shown|report\w*)\b/i;

export function trailingUncitedClaimWords(content: string): number | null {
  const sentences = splitIntoSentences(content);
  if (sentences.length === 0) return null;
  // Walk backwards while sentences carry no citation key.
  let words = 0;
  let evidenceHits = 0;
  for (let k = sentences.length - 1; k >= 0; k--) {
    const s = sentences[k];
    if (/\{\{R\d+\}\}/.test(s)) break;
    const w = (s.match(/\S+/g) || []).length;
    if (EVIDENCE_VERB_RE.test(s)) evidenceHits++;
    words += w;
  }
  if (words >= 60 && evidenceHits >= 2) return words;
  return null;
}

function dedupContentWords(sentence: string): string[] {
  return sentence
    .replace(/\[\d+(?:[,\-–;]\s*\d+)*\]/g, " ") // numeric citation markers
    .replace(/\{\{R\d+\}\}/g, " ") // keyed citations (pre-renumber safety)
    .replace(/[*_`#>]/g, " ") // markdown emphasis
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function longestCommonRun(a: string[], b: string[]): number {
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let run = 0;
      while (i + run < a.length && j + run < b.length && a[i + run] === b[j + run]) run++;
      if (run > best) best = run;
    }
  }
  return best;
}

export function removeCrossSectionDuplicates(contents: string[]): {
  contents: string[];
  removals: CrossSectionDedupRemoval[];
} {
  const removals: CrossSectionDedupRemoval[] = [];
  if (contents.length < 2) return { contents, removals };

  // Pre-parse: per section, paragraphs → sentences; claim sentences + word pool.
  const sectionClaims: string[][] = contents.map((c) =>
    splitIntoSentences(c).filter((s) => /\[\d/.test(s)),
  );
  const sectionPools: Set<string>[] = sectionClaims.map((sents) => {
    const pool = new Set<string>();
    for (const s of sents) for (const w of dedupContentWords(s)) pool.add(w);
    return pool;
  });
  // Word arrays per claim sentence, for run computation.
  const claimWordArrays: string[][][] = sectionClaims.map((sents) =>
    sents.map((s) => dedupContentWords(s)),
  );

  const result = contents.map((c) => c);
  const removedInSection = new Array(contents.length).fill(0);

  for (let i = 1; i < contents.length; i++) {
    if (removedInSection[i] >= MAX_DEDUP_REMOVALS_PER_SECTION) continue;
    // Guard basis: total citations in this section minus what removals have
    // already taken — a section must always keep ≥ 1 citation.
    const sectionCitations = (contents[i].match(/\[\d/g) || []).length;
    const sectionWordCount = (contents[i].match(/\S+/g) || []).length;
    let citationsRemoved = 0;
    let wordsRemoved = 0;
    const paragraphs = contents[i].split(/\n\n+/);
    const rebuiltParagraphs: string[] = [];

    for (const para of paragraphs) {
      const sentences = splitIntoSentences(para);
      const kept: string[] = [];

      for (const sentence of sentences) {
        const isClaim = /\[\d/.test(sentence);
        const words = dedupContentWords(sentence);
        let duplicateOf = -1;
        let uncitedRestatement = false;
        const sentenceWordCount = (sentence.match(/\S+/g) || []).length;

        if (
          removedInSection[i] < MAX_DEDUP_REMOVALS_PER_SECTION &&
          wordsRemoved + sentenceWordCount <= MAX_DEDUP_WORD_LOSS * sectionWordCount
        ) {
          if (isClaim && words.length >= 8) {
            const wordSet = new Set(words);
            for (let j = 0; j < i; j++) {
              // containment against section j's claim pool
              let inter = 0;
              for (const w of wordSet) if (sectionPools[j].has(w)) inter++;
              const containment = wordSet.size ? inter / wordSet.size : 0;
              // longest common run against section j's claim sentences
              let maxRun = 0;
              for (let k = 0; k < sectionClaims[j].length; k++) {
                const run = longestCommonRun(words, claimWordArrays[j][k]);
                if (run > maxRun) maxRun = run;
              }
              if (containment >= 0.66 || (maxRun >= 5 && containment >= 0.45)) {
                duplicateOf = j;
                break;
              }
            }
          } else if (!isClaim && words.length >= 12) {
            // round-17: uncited restatement of an earlier section's claim —
            // stricter thresholds to protect legitimate topic sentences.
            const wordSet = new Set(words);
            for (let j = 0; j < i; j++) {
              let inter = 0;
              for (const w of wordSet) if (sectionPools[j].has(w)) inter++;
              const containment = wordSet.size ? inter / wordSet.size : 0;
              if (containment < 0.8) continue;
              let maxRun = 0;
              for (let k = 0; k < sectionClaims[j].length; k++) {
                const run = longestCommonRun(words, claimWordArrays[j][k]);
                if (run > maxRun) maxRun = run;
              }
              if (maxRun >= 6) {
                duplicateOf = j;
                uncitedRestatement = true;
                break;
              }
            }
          }
        }

        if (duplicateOf >= 0) {
          const sentenceCitations = (sentence.match(/\[\d/g) || []).length;
          if (
            isClaim &&
            sectionCitations - citationsRemoved - sentenceCitations <= 0
          ) {
            kept.push(sentence); // never strip the LAST citation of a section
            continue;
          }
          removedInSection[i]++;
          citationsRemoved += sentenceCitations;
          wordsRemoved += sentenceWordCount;
          removals.push({
            section: i + 1,
            matchedSection: duplicateOf + 1,
            snippet: sentence.replace(/\s+/g, " ").trim().slice(0, 90),
            uncited: uncitedRestatement || undefined,
          });
          continue; // drop the sentence
        }
        kept.push(sentence);
      }
      const joined = kept.join(" ").replace(/\s+/g, " ").trim();
      if (joined) rebuiltParagraphs.push(joined);
    }
    result[i] = rebuiltParagraphs.join("\n\n");
  }

  return { contents: result, removals };
}
