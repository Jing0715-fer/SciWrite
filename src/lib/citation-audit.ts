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
 *   7. sparseSectionCheck (round-64) — a long body section citing <2 distinct
 *                          references (every claim must be attributed)
 *   8. redundantSectionCheck (round-64) — near-verbatim section overlap
 *   9. singleSourceDominance (round-64) — one reference supplying most of a
 *                          section's (or the whole article's) citations
 *  10. malformedRefCheck (round-64) — raw PDB-entry titles / bare rcsb.org
 *                          URLs instead of the primary publication
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
  | "mismatch"
  // round-64: article-level STRUCTURAL checks. Warning severity — they are
  // visible in the audit banner / topicality watch-list and injected into the
  // repair loop's review feedback, but never counted as blockingErrors.
  | "sparse-section"
  | "redundant-section"
  | "overcited-ref"
  | "malformed-ref";

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
    /** round-64 structural checks (warning severity). */
    sparseSection: number;
    redundantSection: number;
    overcitedRef: number;
    malformedRef: number;
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
  // Normalize trailing punctuation: entries parsed from a reference list
  // keep the sentence-final period of the line they came from, while DB
  // titles usually don't — without stripping, the same paper yields two
  // different identities ("title:foo." vs "title:foo") and every
  // identity-based comparison (dedup, numbering-integrity) misfires.
  return `title:${(r.title || "")
    .toLowerCase()
    .trim()
    .replace(/[.。,;:\s]+$/, "")
    .slice(0, 80)}`;
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

/* ------------------------------------------------------------------ *
 * round-64: article-level STRUCTURAL citation-hygiene checks.
 *
 * The ferroptosis production run (round-63) shipped four structural
 * defects that the per-citation checks above could never see:
 *   - a 500-word "Iron Storage and Trafficking" section with ZERO
 *     citations (textbook facts, none attributed)
 *   - a "Lipid Peroxide Repair Enzymes" section restating §2's GPX4
 *     content near-verbatim (redundant, wasted space in a review)
 *   - an Introduction citing [1] six times (single-source dominance)
 *   - a References entry that was a raw RCSB PDB record ("8WIK: ...",
 *     bare rcsb.org URL) instead of its primary publication
 * All functions are PURE and bilingual (Latin tokens + CJK chars).
 * ------------------------------------------------------------------ */

/** Verdicts produced by the structural checks below (not per-citation). */
const STRUCTURAL_VERDICTS = new Set<AuditVerdict>([
  "sparse-section",
  "redundant-section",
  "overcited-ref",
  "malformed-ref",
]);

/** Word-count that also works for CJK text (1 token ≈ 2 CJK chars). */
function countTokensMixed(text: string): number {
  const latin = (text || "").match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || [];
  const cjk = (text || "").match(/[\u4e00-\u9fff]/g) || [];
  return latin.length + Math.floor(cjk.length / 2);
}

/** 5-gram shingles over citation-stripped text (bilingual tokens). */
export function sectionShingles(text: string, n = 5): Set<string> {
  const words = (text || "")
    .toLowerCase()
    .replace(/\[\d+(?:[,\-–\s]\d+)*\]/g, " ")
    .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    out.add(words.slice(i, i + n).join(" "));
  }
  return out;
}

/** |A∩B| / |A| — how much of A is contained in B. */
function shingleContainment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const s of a) if (b.has(s)) hit++;
  return hit / a.size;
}

/** Split a body into `## Title` sections (falls back to one whole-body section). */
function splitSectionsLite(body: string): { title: string; body: string }[] {
  const secRe = /^##\s+(.+)$/gm;
  const marks: { title: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = secRe.exec(body))) {
    marks.push({ title: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }
  if (marks.length === 0) return [{ title: "(body)", body }];
  const out: { title: string; body: string }[] = [];
  for (let i = 0; i < marks.length; i++) {
    const contentEnd = i + 1 < marks.length ? marks[i + 1].start : body.length;
    const text = body.slice(marks[i].end, contentEnd);
    if (text.trim()) out.push({ title: marks[i].title, body: text });
  }
  return out;
}

const SPARSE_SECTION_MIN_TOKENS = 120;
const REDUNDANT_CONTAINMENT_THRESHOLD = 0.45;
const SECTION_DOMINANCE_THRESHOLD = 0.6;
const GLOBAL_DOMINANCE_THRESHOLD = 0.35;
/**
 * Perspective/outlook sections are exempt from the sparse-section check:
 * forward-looking prose states opinions and methodological projections,
 * not checkable factual claims — the community norm allows them to carry
 * few or no citations. (Learned from the ferroptosis article: §9 "Future
 * Directions and Perspectives" is legitimately citation-free.)
 */
const PERSPECTIVE_SECTION_RE =
  /\b(future|perspectives?|outlook|conclusions?|directions?)\b|未来|展望|结论|方向/i;

/**
 * The four round-64 structural checks. Exported for reuse by the repair
 * loop (route.ts) and by tests. Pure; never throws.
 */
export function structuralCitationFindings(
  body: string,
  parsedRefs: Map<number, AuditRef>
): CitationFinding[] {
  const findings: CitationFinding[] = [];
  const sections = splitSectionsLite(body);
  if (sections.length === 0) return findings;

  const globalMarkerCount = new Map<number, number>();
  let totalMarkers = 0;

  for (const sec of sections) {
    const secCites: number[] = [];
    const re = /\[(\d{1,3}(?:[,\-–]\s*\d{1,3})*)\]/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(sec.body))) {
      for (const n of expandCitationRange(mm[1])) {
        secCites.push(n);
        globalMarkerCount.set(n, (globalMarkerCount.get(n) || 0) + 1);
        totalMarkers++;
      }
    }
    const distinct = new Set(secCites);
    const tokens = countTokensMixed(sec.body);

    // 7. sparse-section: a long section grounded in <2 distinct references
    //    (perspective/outlook sections are exempt — see PERSPECTIVE_SECTION_RE)
    if (
      tokens >= SPARSE_SECTION_MIN_TOKENS &&
      distinct.size < 2 &&
      !PERSPECTIVE_SECTION_RE.test(sec.title)
    ) {
      findings.push({
        n: secCites[0] ?? 0,
        marker: distinct.size === 1 ? `§${sec.title}` : `§${sec.title}`,
        index: 0,
        sentence: sec.title,
        verdict: "sparse-section",
        reason:
          `Section "${sec.title}" (~${tokens} words) cites ${distinct.size === 0 ? "NO" : "only 1"} distinct reference(s). ` +
          "Every factual claim in a review section must be attributed to pool references — add citations or reframe unsupported claims as open questions.",
      });
    }

    // 9a. single-source dominance within one section
    const secCount = new Map<number, number>();
    for (const n of secCites) secCount.set(n, (secCount.get(n) || 0) + 1);
    if (secCites.length >= 5) {
      for (const [n, c] of secCount) {
        if (c / secCites.length > SECTION_DOMINANCE_THRESHOLD) {
          findings.push({
            n,
            marker: `[${n}]`,
            index: 0,
            sentence: sec.title,
            verdict: "overcited-ref",
            reason:
              `Reference [${n}] supplies ${Math.round((100 * c) / secCites.length)}% of section "${sec.title}"'s citations (${c}/${secCites.length}). ` +
              "A section resting on one source is over-reliant — distribute the claims across the primary literature in the pool.",
          });
          break; // one finding per section suffices
        }
      }
    }
  }

  // 9b. global single-source dominance
  if (totalMarkers >= 12) {
    for (const [n, c] of globalMarkerCount) {
      if (c / totalMarkers > GLOBAL_DOMINANCE_THRESHOLD) {
        findings.push({
          n,
          marker: `[${n}]`,
          index: 0,
          sentence: "(whole article)",
          verdict: "overcited-ref",
          reason:
            `Reference [${n}] accounts for ${Math.round((100 * c) / totalMarkers)}% of all ${totalMarkers} citation markers in the article — the review is effectively anchored to a single source. Diversify the citation base.`,
        });
      }
    }
  }

  // 8. redundant-section: later section near-contained in an earlier one
  const secShingles = sections.map((s) => sectionShingles(s.body));
  for (let j = 1; j < sections.length; j++) {
    let best = { i: -1, score: 0 };
    for (let i = 0; i < j; i++) {
      const score = shingleContainment(secShingles[j], secShingles[i]);
      if (score > best.score) best = { i, score };
    }
    if (best.score > REDUNDANT_CONTAINMENT_THRESHOLD) {
      findings.push({
        n: 0,
        marker: `§${sections[j].title}`,
        index: 0,
        sentence: sections[j].title,
        verdict: "redundant-section",
        score: best.score,
        reason:
          `Section "${sections[j].title}" overlaps "${sections[best.i].title}" by ${Math.round(best.score * 100)}% (5-gram containment) — it largely restates earlier content instead of adding new information. ` +
          "Replace it with content not covered elsewhere, or merge it into the earlier section.",
      });
    }
  }

  // 10. malformed reference entries: raw PDB records / bare database URLs
  for (const [num, ref] of parsedRefs) {
    const title = ref.title || "";
    const url = ref.url || "";
    const rawPdbTitle = /^[0-9A-Za-z]{4}:\s+\S/.test(title);
    const bareRcsb = /rcsb\.org/i.test(url) && !/pubmed|doi\.org|\/structure\//i.test(url);
    if (rawPdbTitle || bareRcsb) {
      findings.push({
        n: num,
        marker: `[${num}]`,
        index: 0,
        sentence: title.slice(0, 240),
        verdict: "malformed-ref",
        reason:
          `Reference [${num}] is a raw database record (${rawPdbTitle ? "PDB-entry title" : "bare rcsb.org URL"}) rather than a publication. ` +
          "Cite the associated primary paper instead (authors, journal, year, title, PubMed/DOI link), consistent with the rest of the list.",
        refIdentity: refIdentity(ref),
      });
    }
  }

  return findings;
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
    const yearMatch = body.match(/\((\d{4}[a-z]?)\)/);
    const year = yearMatch?.[1];
    const pmidMatch = body.match(/(?:pubmed|PMID)[:\s]+(\d+)/i);
    const pmid = pmidMatch?.[1];
    // URL-embedded identifiers: the v2 compose format appends
    // " — https://…" to every entry, so the external id lives ONLY inside
    // the URL. Without extracting it here the parsed ref falls back to a
    // title-based identity that can never equal the DB reference's
    // externalId-based identity — every citation in the composed article
    // then reports as a numbering mismatch (observed live: 74/74 false
    // blocking errors on a real 2500-word v2 run with perfect numbering).
    const pubmedUrl =
      body.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/) ||
      body.match(/ncbi\.nlm\.nih\.gov\/pubmed\/(\d+)/i);
    const pmcUrl = body.match(/pmc\.ncbi\.nlm\.nih\.gov\/articles\/(PMC\d+)/i);
    const rcsbUrl = body.match(/rcsb\.org\/(?:structure|3dview)\/([A-Za-z0-9]{4})/i);
    const uniprotUrl = body.match(/uniprot\.org\/uniprotkb\/([A-Za-z0-9_-]+)/i);
    const doiUrl = url
      ?.match(/doi\.org\/(10\.\S+)/i)?.[1]
      ?.replace(/[.,;)\]\/]+$/, "");
    const doiMatch = body.match(/doi:(10\.\S+)/i);
    const doi = doiMatch?.[1]?.replace(/[.,;]\s*$/, "") || doiUrl;
    const sourceMatch =
      body.match(/\[([A-Z]{2,12}):\s?([^\]]+)\]/) ||
      body.match(/\b([A-Z]{2,12}):\s?([A-Za-z0-9_\-\.]+)/);
    const rawType = sourceMatch?.[1]?.toLowerCase();
    // Prefer an explicit "TYPE: id" tag; fall back to the URL's database.
    const urlType = pubmedUrl
      ? "pubmed"
      : pmcUrl
        ? "pmc"
        : rcsbUrl
          ? "rcsb"
          : uniprotUrl
            ? "uniprot"
            : null;
    const type = normalizeType(rawType) || urlType;
    const externalId =
      sourceMatch?.[2]?.trim() ||
      pmid ||
      pubmedUrl?.[1] ||
      pmcUrl?.[1] ||
      (rcsbUrl ? rcsbUrl[1].toUpperCase() : undefined) ||
      uniprotUrl?.[1];
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
          // round-57: one-sided-identifier fallback. The text-parsed entry
          // can only carry identifiers extractable from its rendered URL /
          // DOI line; when the DB reference carries an externalId that never
          // made it into the rendered line (publisher URLs like
          // sciencedirect / cell.com / frontiersin carry no PMID), the
          // identity strings can never match even though the entry IS the
          // same paper — observed live as 26 spurious "mismatch" blocking
          // findings on a perfectly-numbered 17-ref E2E article. Only a
          // title mismatch (after the same normalization refIdentity uses)
          // proves real numbering drift.
          const normTitle = (t: string) =>
            (t || "").toLowerCase().trim().replace(/[.。,;:\s]+$/, "").slice(0, 80);
          const sameTitle = normTitle(ref.title) === normTitle(dbRef.title);
          if (!sameTitle) {
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

  // --- round-64: structural citation-hygiene checks (warning severity) ---
  const structural = structuralCitationFindings(body, parsedRefs);
  findings.push(...structural);

  // --- Summary ---
  const count = (v: AuditVerdict) =>
    findings.filter((f) => f.verdict === v).length;
  // ok counts only per-citation verdicts; structural findings are article-level
  // and must not be subtracted from the per-citation total.
  const citationLevelFindings = findings.filter(
    (f) => !STRUCTURAL_VERDICTS.has(f.verdict)
  );
  const summary = {
    ok: bodyCitations.length - citationLevelFindings.length,
    outOfRange: count("out-of-range"),
    missing: count("missing"),
    suspect: count("suspect"),
    unsupported: count("unsupported"),
    orphan: orphans.length,
    duplicate: duplicates.length,
    mismatch: count("mismatch"),
    blockingErrors: count("out-of-range") + count("missing") + count("mismatch"),
    sparseSection: count("sparse-section"),
    redundantSection: count("redundant-section"),
    overcitedRef: count("overcited-ref"),
    malformedRef: count("malformed-ref"),
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
