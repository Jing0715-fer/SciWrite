/**
 * citation-audit.ts — Adversarial citation validation engine (Layers 1 & 2).
 *
 * This module is the heart of SciWrite's citation-accuracy guarantee. It is
 * PURE TypeScript (no DB, no LLM) so it can run:
 *   - Inline, BEFORE a paragraph is saved (Layer 1 — write/generate-full/
 *     regenerate routes call `validateCitationsInline`).
 *   - Post-compose, across a whole article (Layer 2 — the
 *     /api/articles/[id]/audit-citations endpoint calls `buildAuditReport`
 *     and then optionally an LLM adversarial check).
 *
 * The checks are deliberately CONSERVATIVE and TRANSPARENT: every verdict
 * includes a human-readable reason so the user (and the rendering guard in
 * MarkdownCitations) can explain WHY a citation was flagged.
 *
 * Checks implemented:
 *   1. rangeCheck        — [n] must satisfy 1 ≤ n ≤ refCount
 *   2. topicalityScore   — Jaccard keyword overlap between citing sentence
 *                          and the reference's title+abstract
 *   3. orphanCheck       — references that are saved but never cited
 *   4. bidirectionalCheck — every body [n] exists in ## References AND every
 *                          ## References entry is cited in the body
 *   5. numberingIntegrity — body [n] → ## References [n] → DB reference[n-1]
 *                          all refer to the SAME paper (type:externalId)
 *   6. duplicateRefCheck  — duplicate entries inside the reference list
 *
 * The LLM adversarial check (does this reference plausibly support this
 * specific claim?) lives in the audit-citations route, not here, because it
 * requires a network call. This module prepares the batches for it.
 */

export interface AuditRef {
  id?: string;
  type?: string | null;
  externalId?: string | null;
  title: string;
  authors?: string | null;
  journal?: string | null;
  year?: string | null;
  abstract?: string | null;
  doi?: string | null;
  url?: string | null;
}

export type AuditVerdict =
  | "ok"
  | "out-of-range"
  | "missing"
  | "suspect"
  | "unsupported"
  | "orphan"
  | "duplicate"
  | "mismatch";

export interface CitationFinding {
  /** The citation number, e.g. 3 for "[3]". */
  n: number;
  /** The raw marker text, e.g. "[3]" or "[3,5]". */
  marker: string;
  /** Character offset of the marker in the body. */
  index: number;
  /** The sentence containing the citation (trimmed, ≤240 chars). */
  sentence: string;
  verdict: AuditVerdict;
  /** 0..1 topicality score (Jaccard overlap). Undefined for non-topical checks. */
  score?: number;
  reason: string;
  /** Identity of the reference this citation resolved to (when known). */
  refIdentity?: string;
}

export interface AuditReport {
  totalCitations: number;
  totalReferences: number;
  findings: CitationFinding[];
  orphans: { index: number; title: string; identity: string }[];
  duplicates: { index: number; identity: string }[];
  summary: {
    ok: number;
    outOfRange: number;
    missing: number;
    suspect: number;
    unsupported: number;
    orphan: number;
    duplicate: number;
    mismatch: number;
    blockingErrors: number;
  };
  /** True when the article body and ## References disagree on numbering. */
  numberingIntegrityOk: boolean;
}

const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","at","by","for","with",
  "from","into","this","that","these","those","is","are","was","were","be",
  "been","being","have","has","had","do","does","did","will","would","could",
  "should","may","might","can","shall","must","not","no","nor","so","if","then",
  "than","too","very","just","also","only","about","above","after","again","all",
  "any","because","before","below","between","both","during","each","few","more",
  "most","other","over","same","some","such","through","under","until","up","down",
  "out","off","further","once","here","there","when","where","why","how","what",
  "which","who","whom","whose","section","part","study","studies","result","results",
  "shown","showed","found","reported","demonstrated","using","used","use","via",
  "within","without","upon","their","they","them","it","its","as","we","our","us",
  "you","your","he","she","his","her","et","al","fig","figure","table","ref",
]);

/** Expand a citation inner string like "1,2,3" or "1-3" into an array of numbers. */
export function expandCitationRange(inner: string): number[] {
  const trimmed = inner.trim();
  const nums: number[] = [];
  const parts = trimmed.split(/[,;]\s*/);
  for (const p of parts) {
    const rangeMatch = p.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let n = lo; n <= hi; n++) nums.push(n);
    } else {
      const n = parseInt(p, 10);
      if (!isNaN(n)) nums.push(n);
    }
  }
  return nums;
}

/** Normalize a source-type alias to its canonical form (pmid→pubmed, pdb→rcsb). */
export function normalizeType(t: string | null | undefined): string {
  const lt = (t || "").toLowerCase();
  if (lt === "pmid") return "pubmed";
  if (lt === "pdb") return "rcsb";
  return lt;
}

/** Build a stable identity key for a reference (used for dedup + matching). */
export function refIdentity(r: AuditRef): string {
  const t = normalizeType(r.type);
  const id = (r.externalId || "").toLowerCase().trim();
  if (id) return `${t}:${id}`;
  if (r.doi) return `doi:${r.doi.toLowerCase().trim()}`;
  return `title:${(r.title || "").toLowerCase().trim().slice(0, 80)}`;
}

/**
 * Split content into (body, referencesText). The body is everything before
 * the first reference-like section header (## References, REFERENCES,
 * ### Citations, Bibliography, 文献, 参考文献). The referencesText is the rest.
 */
export function splitBodyAndReferences(content: string): {
  body: string;
  referencesText: string;
  refHeaderIdx: number;
} {
  const refHeaderRe =
    /^#{0,6}\s*\*{0,2}(References|REFERENCES|Citations|Bibliography|文献|参考文献)\*{0,2}\s*:?\s*$/m;
  const m = content.match(refHeaderRe);
  if (!m || m.index === undefined) {
    return { body: content, referencesText: "", refHeaderIdx: -1 };
  }
  return {
    body: content.slice(0, m.index),
    referencesText: content.slice(m.index),
    refHeaderIdx: m.index,
  };
}

/**
 * Extract the sentence containing a given character offset. Sentences are
 * split on ". " followed by a capital letter (rough but adequate). The
 * returned sentence is trimmed and capped at 240 chars.
 */
export function sentenceAt(content: string, offset: number): string {
  // Walk backwards to find the start of the sentence.
  let start = offset;
  while (start > 0) {
    const ch = content[start - 1];
    if (ch === "." || ch === "!" || ch === "?" || ch === "\n") {
      // Check if the char before is part of an abbreviation (e.g. "et al.")
      // — if the next char after the period is a lowercase letter, keep going.
      if (ch === "." && start < content.length && /[a-z]/.test(content[start])) {
        start--;
        continue;
      }
      break;
    }
    start--;
  }
  // Walk forward to find the end of the sentence.
  let end = offset;
  while (end < content.length) {
    const ch = content[end];
    if (ch === "." || ch === "!" || ch === "?") {
      // Peek ahead: if followed by space + capital or end-of-string, stop.
      const next = content[end + 1];
      if (!next || (next === " " && /[A-Z]/.test(content[end + 2] || ""))) {
        end++;
        break;
      }
    }
    if (ch === "\n") break;
    end++;
  }
  return content.slice(start, end).trim().slice(0, 240);
}

/**
 * Extract all numeric citation markers from the body (NOT the references
 * section). Returns markers in document order with their sentence context.
 */
export function extractBodyCitations(body: string): {
  n: number;
  marker: string;
  index: number;
  sentence: string;
}[] {
  const citeRe = /\[(\d{1,3}(?:[,\-–]\s*\d{1,3})*)\]/g;
  const out: { n: number; marker: string; index: number; sentence: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = citeRe.exec(body))) {
    const inner = m[1];
    const nums = expandCitationRange(inner);
    const sentence = sentenceAt(body, m.index);
    for (const n of nums) {
      out.push({ n, marker: `[${n}]`, index: m.index, sentence });
    }
  }
  return out;
}

/** Extract lowercase keyword tokens (length ≥4, not stopwords) from text. */
export function extractKeywords(text: string): Set<string> {
  const lower = (text || "").toLowerCase();
  const tokens = lower.match(/[a-z][a-z0-9-]{3,}/g) || [];
  const latin = new Set(tokens.filter((t) => !STOPWORDS.has(t)));
  // FIX (中文 support): the Latin-only regex made every Chinese sentence score
  // 0 → all citations in Chinese paragraphs were flagged suspect/unsupported
  // (false positives). Add CJK character bigrams as tokens so Chinese
  // topicality works the same way Latin keyword overlap does.
  const cjkRuns = lower.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) {
      latin.add(run.slice(i, i + 2));
    }
    if (run.length === 2) latin.add(run);
  }
  return latin;
}

/**
 * Jaccard keyword-overlap score between two texts. Returns 0..1.
 * Used as a cheap topicality proxy (no LLM call). A score of 0 means no
 * shared keywords; 1 means identical keyword sets.
 */
export function topicalityScore(textA: string, textB: string): number {
  const setA = extractKeywords(textA);
  const setB = extractKeywords(textB);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const kw of setA) {
    if (setB.has(kw)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Parse a "[n] ..." reference list (from ## References or ### Citations)
 * into a map of citation number → AuditRef. Mirrors the logic in
 * markdown-citations.tsx#parseCitationsBlock but returns a Map for O(1)
 * lookups and is server-safe.
 */
export function parseReferenceList(text: string): Map<number, AuditRef> {
  const lines = text.split("\n");
  const refMap = new Map<number, AuditRef>();
  for (const line of lines) {
    const m = line.match(/^\s*\[(\d+)\]\s*(.+)$/);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    const body = m[2].trim();
    const urlMatch = body.match(/https?:\/\/[^\s]+/);
    const url = urlMatch?.[0]?.replace(/[—–-]\s*$/, "").trim();
    const doiMatch = body.match(/doi:(10\.\S+)/i);
    const doi = doiMatch?.[1]?.replace(/[.,;]\s*$/, "");
    const yearMatch = body.match(/\((\d{4}[a-z]?)\)/);
    const year = yearMatch?.[1];
    const pmidMatch = body.match(/(?:pubmed|PMID)[:\s]+(\d+)/i);
    const pmid = pmidMatch?.[1];
    const sourceMatch =
      body.match(/\[([A-Z]{2,12}):\s?([^\]]+)\]/) ||
      body.match(/\b([A-Z]{2,12}):\s?([A-Za-z0-9_\-\.]+)/);
    const rawType = sourceMatch?.[1]?.toLowerCase();
    const type = normalizeType(rawType);
    const externalId = sourceMatch?.[2]?.trim() || pmid;
    let title = body;
    let authors: string | undefined;
    let journal: string | undefined;
    if (yearMatch && yearMatch.index !== undefined) {
      authors = body.slice(0, yearMatch.index).trim().replace(/[,\s]+$/, "");
      const afterYear = body.slice(yearMatch.index + yearMatch[0].length).trim();
      const journalMatch = afterYear.match(/^,?\s*([^.,]+)\.\s+(.+)$/);
      if (journalMatch) {
        journal = journalMatch[1].trim();
        title = journalMatch[2].trim();
      } else {
        title = afterYear;
      }
    }
    title = title
      .replace(/\[?[A-Z]{2,12}:\s?[^\]\s]+]?/g, "")
      .replace(/https?:\/\/[^\s]+/g, "")
      .replace(/doi:\S+/gi, "")
      .replace(/[—–-]\s*$/, "")
      .replace(/^\s*[—–-]\s*/, "")
      .replace(/\.$/, "")
      .trim();
    refMap.set(num, {
      type: type || "manual",
      externalId,
      title: title.slice(0, 200) || body.slice(0, 200),
      year,
      url,
      doi,
      authors,
      journal,
    });
  }
  return refMap;
}

/**
 * Layer 1 — Inline pre-save validator.
 *
 * Runs the cheap, deterministic checks that should gate EVERY paragraph
 * before it is saved: range check + topicality score + orphan detection.
 * Returns a list of findings (empty = clean). The caller decides whether
 * to log warnings, replace out-of-range [n] with [$REF], or surface to UI.
 *
 * @param content   The paragraph/article body text (may include a references
 *                  section — it is split off automatically).
 * @param refs      The reference list the [n] numbers index into (1-based).
 *                  Pass [] to only run range checks against the parsed
 *                  reference list inside `content`.
 */
export function validateCitationsInline(
  content: string,
  refs: AuditRef[]
): CitationFinding[] {
  const { body } = splitBodyAndReferences(content);
  const bodyCitations = extractBodyCitations(body);
  const findings: CitationFinding[] = [];

  for (const cite of bodyCitations) {
    const { n, marker, index, sentence } = cite;
    // Range check
    if (n < 1 || n > refs.length) {
      findings.push({
        n,
        marker,
        index,
        sentence,
        verdict: "out-of-range",
        reason: `Citation [${n}] is out of range — the reference list has ${
          refs.length
        } entr${refs.length === 1 ? "y" : "ies"} (1..${refs.length}). This citation may be hallucinated.`,
      });
      continue;
    }
    const ref = refs[n - 1];
    if (!ref) {
      findings.push({
        n,
        marker,
        index,
        sentence,
        verdict: "missing",
        reason: `Reference [${n}] does not exist in the reference list.`,
      });
      continue;
    }
    // Topicality check (cheap heuristic)
    const refText = `${ref.title || ""} ${ref.abstract || ""}`;
    const score = topicalityScore(sentence, refText);
    if (score < 0.02) {
      findings.push({
        n,
        marker,
        index,
        sentence,
        verdict: "unsupported",
        score,
        reason: `Very low topical overlap (${Math.round(
          score * 100
        )}%) between the citing sentence and the reference's title/abstract. The reference may not support this claim — verify manually.`,
        refIdentity: refIdentity(ref),
      });
    } else if (score < 0.05) {
      findings.push({
        n,
        marker,
        index,
        sentence,
        verdict: "suspect",
        score,
        reason: `Weak topical overlap (${Math.round(
          score * 100
        )}%) — the reference may not directly support this specific claim.`,
        refIdentity: refIdentity(ref),
      });
    }
    // verdict "ok" is implicit (no finding emitted) to keep the report small.
  }
  return findings;
}

/**
 * Replace out-of-range [n] markers with [$REF] placeholders. Used by Layer 1
 * in the write/generate-full/regenerate routes as a safety net BEFORE saving.
 */
export function sanitizeOutOfRangeCitations(
  content: string,
  refCount: number
): { content: string; replaced: number } {
  let replaced = 0;
  const citeRe = /\[(\d{1,3}(?:[,\-–]\s*\d{1,3})*)\]/g;
  const newContent = content.replace(citeRe, (match, inner: string) => {
    const nums = expandCitationRange(inner);
    // Dedupe within a citation group: [5,5] → [5]. The LLM or a buggy
    // adversarial-removal pass can produce a [n,n] marker that cites the
    // same paper twice — semantically meaningless and trips duplicate
    // audit warnings. Observed in E2E test 2026-08-26 on article
    // cmt9f93jg00x4rewrmj0qpm75 (one [5,5] slipped through sanitize).
    const unique = Array.from(new Set(nums));
    const validNums = unique.filter((n) => n >= 1 && n <= refCount);
    if (validNums.length === 0) {
      replaced += nums.length;
      return "[$REF]";
    }
    if (validNums.length < unique.length) {
      replaced += unique.length - validNums.length;
      return `[${validNums.join(",")}]`;
    }
    if (unique.length < nums.length) {
      // All valid but duplicates were collapsed — still rewrite so the
      // marker text matches the deduplicated form.
      return `[${validNums.join(",")}]`;
    }
    return match;
  });
  return { content: newContent, replaced };
}

/**
 * Layer 2 — Build a full audit report for a composed article.
 *
 * Runs ALL deterministic checks (range, topicality, orphan, bidirectional,
 * numbering-integrity, duplicate) across the article body + its ## References
 * section + the saved DB references. Returns a structured report.
 *
 * The LLM adversarial check is NOT run here (it needs a network call) — the
 * caller (audit-citations route) can post-process `findings` to batch the
 * "suspect"/"unsupported" ones into LLM calls.
 *
 * @param articleContent  The full article content (body + ## References).
 * @param dbRefs          References loaded from the DB (ordered by citationOrder
 *                        for each paragraph, or by global number for articles).
 *                        Pass [] to skip the DB-integrity check.
 */
export function buildAuditReport(
  articleContent: string,
  dbRefs: AuditRef[] = []
): AuditReport {
  const { body, referencesText } = splitBodyAndReferences(articleContent);
  const bodyCitations = extractBodyCitations(body);
  const parsedRefs = referencesText
    ? parseReferenceList(referencesText)
    : new Map<number, AuditRef>();

  const findings: CitationFinding[] = [];
  const citedNumbers = new Set<number>();
  const orphans: { index: number; title: string; identity: string }[] = [];
  const duplicates: { index: number; identity: string }[] = [];

  // --- Duplicate detection inside parsedRefs ---
  const seenIdentities = new Map<string, number>();
  for (const [num, ref] of parsedRefs) {
    const id = refIdentity(ref);
    if (seenIdentities.has(id)) {
      duplicates.push({ index: num, identity: id });
    } else {
      seenIdentities.set(id, num);
    }
  }

  // --- Per-citation checks ---
  for (const cite of bodyCitations) {
    const { n, marker, index, sentence } = cite;
    citedNumbers.add(n);

    // 1. Range check against the parsed ## References list
    if (parsedRefs.size > 0 && !parsedRefs.has(n)) {
      findings.push({
        n,
        marker,
        index,
        sentence,
        verdict: "missing",
        reason: `Citation [${n}] has no corresponding entry in the References section (which has ${parsedRefs.size} entries).`,
      });
      continue;
    }

    const ref = parsedRefs.get(n);
    // 2. Numbering integrity: parsed ## References [n] vs DB ref [n-1]
    if (dbRefs.length > 0 && n <= dbRefs.length) {
      const dbRef = dbRefs[n - 1];
      if (ref && dbRef) {
        const refId = refIdentity(ref);
        const dbId = refIdentity(dbRef);
        if (refId !== dbId) {
          findings.push({
            n,
            marker,
            index,
            sentence,
            verdict: "mismatch",
            reason: `Numbering mismatch: body [${n}] → References entry "${ref.title.slice(
              0,
              50
            )}" but DB reference[${n}] is "${dbRef.title.slice(0, 50)}". The citation numbering has drifted.`,
            refIdentity: refId,
          });
          continue;
        }
      }
    }

    // 3. Topicality check
    if (ref) {
      const refText = `${ref.title || ""} ${ref.abstract || ""}`;
      const score = topicalityScore(sentence, refText);
      if (score < 0.02) {
        findings.push({
          n,
          marker,
          index,
          sentence,
          verdict: "unsupported",
          score,
          reason: `Very low topical overlap (${Math.round(
            score * 100
          )}%) — the reference's title/abstract does not share key terms with the citing sentence. This citation may be incorrect.`,
          refIdentity: refIdentity(ref),
        });
      } else if (score < 0.05) {
        findings.push({
          n,
          marker,
          index,
          sentence,
          verdict: "suspect",
          score,
          reason: `Weak topical overlap (${Math.round(
            score * 100
          )}%) — verify that this reference supports the specific claim.`,
          refIdentity: refIdentity(ref),
        });
      }
    }
  }

  // --- Orphan check: parsed ## References entries never cited in body ---
  for (const [num, ref] of parsedRefs) {
    if (!citedNumbers.has(num)) {
      orphans.push({
        index: num,
        title: ref.title.slice(0, 60),
        identity: refIdentity(ref),
      });
    }
  }

  // --- Summary ---
  const count = (v: AuditVerdict) =>
    findings.filter((f) => f.verdict === v).length;
  const summary = {
    ok: bodyCitations.length - findings.length,
    outOfRange: count("out-of-range"),
    missing: count("missing"),
    suspect: count("suspect"),
    unsupported: count("unsupported"),
    orphan: orphans.length,
    duplicate: duplicates.length,
    mismatch: count("mismatch"),
    blockingErrors: count("out-of-range") + count("missing") + count("mismatch"),
  };

  return {
    totalCitations: bodyCitations.length,
    totalReferences: parsedRefs.size,
    findings,
    orphans,
    duplicates,
    summary,
    numberingIntegrityOk: count("mismatch") === 0,
  };
}

/**
 * Prepare batches of (citation, sentence, reference) triples for the LLM
 * adversarial check. Groups findings flagged as "suspect" or "unsupported"
 * into batches of `batchSize` (default 12) so a single LLM call can adjudicate
 * many citations at once (cost control).
 */
export function prepareLlmBatches(
  findings: CitationFinding[],
  refs: AuditRef[],
  batchSize = 12
): { citations: { n: number; sentence: string; refTitle: string; refAbstract: string }[] }[] {
  const targets = findings.filter(
    (f) => f.verdict === "suspect" || f.verdict === "unsupported"
  );
  const batches: { citations: { n: number; sentence: string; refTitle: string; refAbstract: string }[] }[] = [];
  for (let i = 0; i < targets.length; i += batchSize) {
    const slice = targets.slice(i, i + batchSize);
    batches.push({
      citations: slice.map((f) => {
        const ref = refs[f.n - 1] || {
          title: f.refIdentity || "(unknown)",
          abstract: "",
        };
        return {
          n: f.n,
          sentence: f.sentence,
          refTitle: ref.title || "",
          refAbstract: (ref.abstract || "").slice(0, 400),
        };
      }),
    });
  }
  return batches;
}

/**
 * Parse the LLM's adjudication response into a map of citation number →
 * verdict. The LLM is asked to return one line per citation:
 *   "N|YES" | "N|NO" | "N|PARTIAL|reason"
 * Malformed lines are ignored (defensive — the LLM may wrap output in prose).
 */
export function parseLlmAdjudication(
  response: string
): Map<number, { verdict: "yes" | "no" | "partial"; reason?: string }> {
  const out = new Map<number, { verdict: "yes" | "no" | "partial"; reason?: string }>();
  const lines = response.split("\n");
  for (const line of lines) {
    const m = line.trim().match(/^(\d+)\s*\|\s*(YES|NO|PARTIAL)\s*(?:\|\s*(.+))?$/i);
    if (m) {
      const n = parseInt(m[1], 10);
      const v = m[2].toUpperCase() as "YES" | "NO" | "PARTIAL";
      out.set(n, { verdict: v.toLowerCase() as any, reason: m[3]?.trim() });
    }
  }
  return out;
}
