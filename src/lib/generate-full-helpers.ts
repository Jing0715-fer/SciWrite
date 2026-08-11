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

export function ncbiItemsCount(items: any[]): number {
  return items.filter((i) => i.source === "pubmed" || i.source === "ncbi").length;
}

export function countBySource(items: any[], source: string): number {
  return items.filter((i) => i.source === source).length;
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

    // Strategy 3: Try to fix common JSON issues
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
 * Score how relevant a reference's text (title + abstract + journal) is to
 * a set of section keywords. Returns the count of distinct keyword matches.
 *
 * This is a simple keyword-overlap heuristic — not semantic similarity —
 * but it's fast (no LLM call) and catches the common case where a ref about
 * "TMC7 acrosome biogenesis" should NOT be cited in a section about
 * "TMC1 animal models and hearing".
 */
export function scoreRelevance(keywords: string[], refText: string): number {
  if (keywords.length === 0) return 0;
  const lower = refText.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) score++;
  }
  return score;
}
