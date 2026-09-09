/**
 * round-57 (P0-2): external fact-check layer for generated articles.
 *
 * Round-56 production audit found a FATAL fabrication that every existing
 * layer missed: "…MT current phase-shifted by 180°" — the cited source
 * (Kawashima 2011) actually reports the currents were *completely absent*,
 * and a neighboring source (Kim 2013) reports the opposite polarity. The
 * adversarial verify layer only asks "does citation [n] topically match
 * sentence S?" — it never asks "is sentence S TRUE in the real world?".
 * The auto-review had zero external input, so nothing ever surfaced the
 * contradiction.
 *
 * This module adds that missing layer, best-effort by design:
 *
 *   extract high-risk claims  →  web_search each  →  LLM arbitration
 *
 *   └─ mechanical regex        └─ z-ai webSearch   └─ three hard guardrails
 *
 * Claim categories (the four fabrication vectors seen in the audit):
 *   - quantitative         numbers with units/decimals (180°, 76.3%, 2:2:2)
 *   - negation-existence   "no structure has been reported" / "currents absent"
 *   - first-claim          "first identified", "novel", "pioneering"
 *   - attribution          "Zhang et al. demonstrated …"
 *
 * Arbitration guardrails (learned from the 180° failure):
 *   1. VERIFIED for a quantitative claim requires the literal value in the
 *      evidence — "completely absent" does NOT verify "shifted by 180°".
 *   2. HARD CONTRADICTED: claim asserts a positive finding/specific value/
 *      existing entity while evidence explicitly reports its absence.
 *   3. Composite sentences are adjudicated by their weakest factual part;
 *      uncorroborated-but-not-refuted is UNVERIFIABLE, never CONTRADICTED.
 *
 * Fail-safety: network/search/LLM failures degrade to `ran: false` (or per-
 * claim ERROR verdicts) — callers must fall back to the pre-round-57
 * behavior. This layer must never break a review that used to work.
 */

import { webSearch, type WebSearchItem } from "@/lib/ai";
import { chatWithSession } from "@/lib/llm-session";
import { splitBodyAndReferences } from "@/lib/citation-audit";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type FactClaimCategory =
  | "quantitative"
  | "negation-existence"
  | "first-claim"
  | "attribution";

export interface FactCheckClaim {
  id: number;
  category: FactClaimCategory;
  sentence: string;
  citedNums: number[];
  searchQuery: string;
}

export type FactVerdict =
  | "VERIFIED"
  | "CONTRADICTED"
  | "UNVERIFIABLE"
  | "ERROR";

export interface FactCheckFinding {
  claimId: number;
  category: FactClaimCategory;
  sentence: string;
  citedNums: number[];
  verdict: FactVerdict;
  reason: string;
  evidenceQuote: string;
  evidenceUrls: string[];
  confidence: number;
  /** round-61 (P0-A): which evidence chain produced the verdict.
   * "cited-abstract" = the abstract of a paper the sentence itself cites
   * (zero web-search cost, and the authoritative check for "does the
   * citation faithfully report its source"). "web" = open-web results.
   * "cited-abstract+web" = abstract was silent, web decided. */
  evidenceSource?: "cited-abstract" | "web" | "cited-abstract+web";
}

/** One cited source's abstract, keyed by its citation number. */
export interface RefAbstractEvidence {
  num: number;
  title: string;
  abstract: string;
}

export interface FactCheckReport {
  /** false ⇒ the tool layer failed wholesale — caller must fall back */
  ran: boolean;
  claims: FactCheckClaim[];
  findings: FactCheckFinding[];
  summary: {
    claimsChecked: number;
    verified: number;
    contradicted: number;
    unverifiable: number;
    errors: number;
  };
}

export interface RefMeta {
  title: string;
  authors: string;
  year: string;
  url: string;
}

/* ------------------------------------------------------------------ *
 * 1. Claim extraction (mechanical, deterministic)
 * ------------------------------------------------------------------ */

/** Sentences shorter than this are fragments/headings, not claims. */
const MIN_CLAIM_WORDS = 8;
/** A section may contribute at most this many claims (spread the budget). */
const MAX_PER_SECTION = 3;

const CITE_NUM_RE = /\[(\d+(?:[,\-–\s]\d+)*)\]/g;

function citedNumsOf(sentence: string): number[] {
  const nums = new Set<number>();
  let m: RegExpExecArray | null;
  CITE_NUM_RE.lastIndex = 0;
  while ((m = CITE_NUM_RE.exec(sentence)) !== null) {
    for (const part of m[1].split(/[,;]\s*/)) {
      const rm = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) {
        for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) nums.add(n);
      } else {
        const n = parseInt(part);
        if (!isNaN(n)) nums.add(n);
      }
    }
  }
  return [...nums];
}

/** Strip citation markers, markdown emphasis and footnote noise. */
function cleanForAnalysis(sentence: string): string {
  return sentence
    .replace(/\[\d+(?:[,\-–\s]\d+)*\]/g, " ")
    .replace(/\{\{R\d+\}\}/g, " ")
    .replace(/[*_`#>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Quantitative: a real number that is NOT just a standalone 4-digit year. */
function isQuantitative(clean: string): boolean {
  // remove years so "in 2011" alone doesn't qualify
  const withoutYears = clean.replace(/\b(19|20)\d{2}\b/g, " ");
  return (
    /\d+(?:\.\d+)?\s*(?:°|º|%|nM|µM|uM|mM|pM|kb|kDa|kbs|Da|bp|Å|å|ms|µs|us|ns|ps|Hz|kHz|MHz|fold|×|x\b|kcal|mol|bp|aa|amino[- ]acids?|residues?|subunits?|copies)/i.test(
      withoutYears,
    ) ||
    /\b\d+\s*:\s*\d+(?:\s*:\s*\d+)?\b/.test(withoutYears) || // stoichiometry 2:2:2
    /\b\d+\.\d+\b/.test(withoutYears) ||
    /\b\d{2,}\b/.test(withoutYears)
  );
}

const NEGATION_EXISTENCE_RE =
  /\b(?:no|none|nor|not|never|neither|absent|lacking|lacks?|without|yet to be|remains?|has yet)\b[^.;:]{0,120}\b(?:report(?:ed|s|ing)?|stud(?:y|ies|ied)|evidence|structure(?:s|d)?|data|publication(?:s)?|document(?:ed|ation)?|homolog(?:s|ues)?|ortholog(?:s|ues)?|paralog(?:s|ues)?|inhibitor|agonist|therap(?:y|ies)|treatment|cure|example|instance|case|determination|reconstruction|resolution)\b/i;

const FIRST_CLAIM_RE =
  /\b(?:first|initial|initially|novel|pioneering|unprecedented|inaugural|earliest|originally|previously undescribed)\b/i;
const SCIENCE_VERB_RE =
  /\b(?:identif(?:y|ied|ies)|report(?:ed|s)?|demonstrat(?:e|ed|ion)|describ(?:e|ed|ing)|discover(?:y|ed)|characteriz(?:e|ed|ation)|resolv(?:e|ed)|determin(?:e|ed|ation)|sh(?:own|ows?|owing)|reveal(?:ed|s)?|establish(?:ed)?|recogniz(?:e|ed)|clon(?:e|ed|ing)|mutat(?:e|ed|ion)|crystalliz(?:e|ed)|structur(?:e|ed|al))\b/i;

const ATTRIBUTION_RE =
  /\b([A-Z][A-Za-z'’-]{2,})\s+(?:et\s+al\.?|and\s+(?:colleagues|coworkers|co-?workers))\s+(?:first\s+)?\b(?:demonstrat|report|show|identifi|discover|propos|establish|characteriz|resolv|solv|describ|reveal|found|observ|not)/i;

function splitSentences(body: string): string[] {
  return body
    .split(/\n/)
    .filter((l) => !/^\s*#{1,6}\s/.test(l)) // headings out
    .join(" ")
    .split(/(?<=[.!?])\s+(?=[A-Z*“"(])|\n{2,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function categorize(clean: string): FactClaimCategory | null {
  if (NEGATION_EXISTENCE_RE.test(clean)) return "negation-existence";
  if (isQuantitative(clean)) return "quantitative";
  if (FIRST_CLAIM_RE.test(clean) && SCIENCE_VERB_RE.test(clean)) return "first-claim";
  if (ATTRIBUTION_RE.test(clean)) return "attribution";
  return null;
}

const CATEGORY_PRIORITY: Record<FactClaimCategory, number> = {
  quantitative: 0,
  "negation-existence": 1,
  "first-claim": 2,
  attribution: 3,
};

/** Build a compact search query from the (cleaned) claim sentence. */
function buildSearchQuery(clean: string, topic?: string): string {
  // Cut at a natural clause boundary; search engines dislike long queries.
  let core = clean.slice(0, 130);
  const lastComma = core.lastIndexOf(", ");
  const lastSemi = core.lastIndexOf("; ");
  const cut = Math.max(lastComma, lastSemi);
  if (cut > 60) core = core.slice(0, cut);
  const topicShort = (topic || "").slice(0, 60).trim();
  const q = topicShort && !core.toLowerCase().includes(topicShort.toLowerCase())
    ? `${topicShort} ${core}`
    : core;
  return q.slice(0, 160);
}

/**
 * Extract high-risk claims from an article body (references already
 * stripped). Deterministic; capped at `maxClaims`, priority-ranked, at most
 * MAX_PER_SECTION per "## " section, near-duplicate cores deduped.
 */
export function extractHighRiskClaims(
  body: string,
  maxClaims: number,
  topic?: string
): FactCheckClaim[] {
  const sections = body.split(/\n(?=##\s)/);
  const candidates: { sentence: string; clean: string; category: FactClaimCategory; citedNums: number[]; sectionIdx: number }[] = [];

  sections.forEach((sectionText, sectionIdx) => {
    let fromSection = 0;
    for (const sentence of splitSentences(sectionText)) {
      if ((sentence.match(/\S+/g) || []).length < MIN_CLAIM_WORDS) continue;
      const clean = cleanForAnalysis(sentence);
      const category = categorize(clean);
      if (!category) continue;
      if (fromSection >= MAX_PER_SECTION) continue;
      fromSection++;
      candidates.push({
        sentence,
        clean,
        category,
        citedNums: citedNumsOf(sentence),
        sectionIdx,
      });
    }
  });

  // Near-duplicate core dedupe (same leading 60 cleaned chars)
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = c.clean.slice(0, 60).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Priority: category rank, then CITED before UNCITED (a cited fabrication
  // is strictly worse — it wears the credibility of a real paper), then
  // earlier sections first.
  unique.sort((a, b) => {
    const cat = CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
    if (cat !== 0) return cat;
    const cite = (b.citedNums.length > 0 ? 1 : 0) - (a.citedNums.length > 0 ? 1 : 0);
    if (cite !== 0) return cite;
    return a.sectionIdx - b.sectionIdx;
  });

  return unique.slice(0, maxClaims).map((c, i) => ({
    id: i + 1,
    category: c.category,
    sentence: c.sentence.slice(0, 400),
    citedNums: c.citedNums,
    searchQuery: buildSearchQuery(c.clean, topic),
  }));
}

/* ------------------------------------------------------------------ *
 * 2. Web search per claim
 * ------------------------------------------------------------------ */

async function searchForClaim(claim: FactCheckClaim): Promise<WebSearchItem[]> {
  try {
    return await webSearch(claim.searchQuery, 6);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * 3. LLM arbitration
 * ------------------------------------------------------------------ */

const ARBITER_SYSTEM = `You are a forensic fact-checker for scientific manuscripts. For each CHECK you receive ONE claim sentence and EVIDENCE in up to two forms:
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

async function arbitrate(
  projectId: string,
  claim: FactCheckClaim,
  evidence: WebSearchItem[],
  citedRefs: RefMeta[],
  abstracts: RefAbstractEvidence[] = []
): Promise<FactCheckFinding> {
  const evidenceBlock =
    evidence.length > 0
      ? evidence
          .slice(0, 5)
          .map(
            (e, i) =>
              `[E${i + 1}] ${String(e.name || "").slice(0, 120)} — ${String(e.snippet || "").slice(0, 260)} (${e.host_name || e.url || ""})`,
          )
          .join("\n")
      : "(no web evidence provided)";

  const abstractBlock =
    abstracts.length > 0
      ? abstracts
          .map(
            (a, i) =>
              `[A${i + 1}] ABSTRACT OF CITED SOURCE [${a.num}] "${a.title.slice(0, 140)}" (the paper this sentence cites):\n${a.abstract.slice(0, 1800)}`,
          )
          .join("\n\n")
      : "";

  const citedBlock =
    citedRefs.length > 0
      ? citedRefs
          .map((r) => `- [${r.authors || "Anon"}${r.year ? ` (${r.year})` : ""}] ${r.title}`)
          .join("\n")
      : "(the sentence carries NO inline citation — this is an uncited assertion)";

  const prompt = `CHECK ${claim.id} (category: ${claim.category})
CLAIM SENTENCE: "${claim.sentence}"
${citedRefs.length > 0 ? `SENTENCE CITES: [${claim.citedNums.join(", ")}]` : "UNCITED ASSERTION"}

CITED SOURCES OF THIS SENTENCE (the article's own references):
${citedBlock}
${abstractBlock ? `\nCITED SOURCE ABSTRACTS (what the cited papers themselves report — authoritative for whether the citation supports the claim):
${abstractBlock}` : ""}

WEB SEARCH RESULTS (external evidence):
${evidenceBlock}

Adjudicate CHECK ${claim.id}. Respond as STRICT JSON:
{"checks":[{"id":${claim.id},"verdict":"...","confidence":0,"reason":"...","evidence_quote":"..."}]}`;

  const raw = await chatWithSession(projectId, prompt, {
    system: ARBITER_SYSTEM,
    temperature: 0.1,
    thinking: false,
    taskType: "review",
    maxTokens: 3000,
    metadata: {
      step: "fact-check",
      claimCategory: claim.category,
      cited: claim.citedNums.length > 0,
    },
  });

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("arbiter returned no JSON");
  const parsed = JSON.parse(match[0]);
  const check = (parsed.checks || [])[0] || {};
  let verdict = String(check.verdict || "").toUpperCase();
  if (!["VERIFIED", "CONTRADICTED", "UNVERIFIABLE"].includes(verdict)) {
    verdict = "UNVERIFIABLE";
  }
  return {
    claimId: claim.id,
    category: claim.category,
    sentence: claim.sentence,
    citedNums: claim.citedNums,
    verdict: verdict as FactVerdict,
    reason: String(check.reason || "").slice(0, 300),
    evidenceQuote: String(check.evidence_quote || "").slice(0, 300),
    evidenceUrls: evidence.slice(0, 3).map((e) => e.url).filter(Boolean),
    confidence: Math.max(0, Math.min(100, parseInt(String(check.confidence ?? 50), 10) || 50)),
  };
}

/** Abstracts available for a claim's cited numbers (round-61 P0-A). */
function abstractsForClaim(
  claim: FactCheckClaim,
  refAbstracts?: Map<number, { title: string; abstract: string }>
): RefAbstractEvidence[] {
  if (!refAbstracts || refAbstracts.size === 0) return [];
  const out: RefAbstractEvidence[] = [];
  for (const n of claim.citedNums) {
    const a = refAbstracts.get(n);
    if (a && a.abstract && a.abstract.length > 80) {
      out.push({ num: n, title: a.title, abstract: a.abstract });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4. Public entry point
 * ------------------------------------------------------------------ */

/**
 * Fact-check an article. Evidence chain per claim (round-61 P0-A):
 *   1. If the sentence cites [n] and the abstract of [n] is available
 *      (opts.refAbstracts), arbitrate against THE CITED SOURCE'S OWN
 *      ABSTRACT first — zero web-search cost, and the authoritative check
 *      for "does the citation faithfully report its source" (the 175-edits
 *      class: the claim is true and the abstract proves it). A decisive
 *      VERIFIED/CONTRADICTED ends the check.
 *   2. Otherwise (or when the abstract is silent), fall back to a web
 *      search and arbitrate against web results (+ any abstract evidence).
 * Best-effort — failures degrade to `ran: false` or per-claim ERROR
 * verdicts, never throw.
 *
 * @param projectId  for the LLM session (rate limiting + context)
 * @param content    the FULL article markdown (references section included;
 *                   it is stripped internally and parsed for cited-ref
 *                   metadata)
 * @param opts.maxClaims     budget cap (default 8, hard cap 12)
 * @param opts.topic         research topic, improves search recall
 * @param opts.refAbstracts  citation number → { title, abstract } for the
 *                   article's own references (DB pool or in-memory globalRefs)
 */
function summary0(findings: FactCheckFinding[], verdict: FactVerdict): number {
  return findings.filter((f) => f.verdict === verdict).length;
}

export async function factCheckArticle(
  projectId: string,
  content: string,
  opts: { maxClaims?: number; topic?: string; refAbstracts?: Map<number, { title: string; abstract: string }> } = {}
): Promise<FactCheckReport> {
  const maxClaims = Math.min(Math.max(opts.maxClaims ?? 8, 1), 12);
  const { body, referencesText } = splitBodyAndReferences(content);
  const refsByNumber = parseReferenceBlock(referencesText);

  const claims = extractHighRiskClaims(body, maxClaims, opts.topic);
  const empty: FactCheckReport = {
    ran: false,
    claims: [],
    findings: [],
    summary: { claimsChecked: 0, verified: 0, contradicted: 0, unverifiable: 0, errors: 0 },
  };
  if (claims.length === 0) {
    // Nothing high-risk found — the layer "ran" and found nothing to check.
    return { ...empty, ran: true, claims: [] };
  }

  const findings: FactCheckFinding[] = [];
  let searchSuccesses = 0; // telemetry: how many claims needed the web fallback

  for (const claim of claims) {
    const citedRefs = claim.citedNums
      .map((n) => refsByNumber.get(n))
      .filter(Boolean) as RefMeta[];
    const abstracts = abstractsForClaim(claim, opts.refAbstracts);

    // ---- Pass 1 (round-61 P0-A): cited-abstract arbitration, no web search.
    if (abstracts.length > 0) {
      try {
        const finding = await arbitrate(projectId, claim, [], citedRefs, abstracts);
        if (finding.verdict === "VERIFIED" || finding.verdict === "CONTRADICTED") {
          finding.evidenceSource = "cited-abstract";
          findings.push(finding);
          continue; // decisive — the web search quota stays untouched
        }
        // UNVERIFIABLE from the abstract alone → escalate to web evidence.
      } catch {
        // arbitration failure → fall through to the web path
      }
    }

    // ---- Pass 2: web search (sequential — external quota courtesy).
    const evidence = await searchForClaim(claim);
    if (evidence.length > 0) searchSuccesses++;
    if (evidence.length === 0 && abstracts.length === 0) {
      // No evidence of any kind to arbitrate against — could be tool failure
      // or a genuinely empty result set. Record ERROR and move on.
      findings.push({
        claimId: claim.id,
        category: claim.category,
        sentence: claim.sentence,
        citedNums: claim.citedNums,
        verdict: "ERROR",
        reason: "web search returned no usable evidence for this claim",
        evidenceQuote: "",
        evidenceUrls: [],
        confidence: 0,
      });
      continue;
    }
    try {
      const finding = await arbitrate(projectId, claim, evidence, citedRefs, abstracts);
      finding.evidenceSource =
        abstracts.length > 0 && evidence.length > 0
          ? "cited-abstract+web"
          : evidence.length > 0
            ? "web"
            : "cited-abstract";
      findings.push(finding);
    } catch {
      findings.push({
        claimId: claim.id,
        category: claim.category,
        sentence: claim.sentence,
        citedNums: claim.citedNums,
        verdict: "ERROR",
        reason: "arbitration call failed",
        evidenceQuote: "",
        evidenceUrls: evidence.slice(0, 2).map((e) => e.url).filter(Boolean),
        confidence: 0,
      });
    }
    // Small cool-down between searches (external search quota courtesy).
    await new Promise((r) => setTimeout(r, 250));
  }

  // Wholesale failure: nothing resolved at all (no abstract verdicts, no
  // successful searches, every finding ERROR) ⇒ the tool layer is down or
  // rate-limited to death — report ran:false so the caller falls back to
  // the pre-fact-check review behavior instead of presenting a wall of
  // ERRORs as if the article were uncheckable.
  const resolved = findings.filter((f) => f.verdict !== "ERROR").length;
  if (resolved === 0) {
    return { ...empty, claims };
  }
  // Telemetry: how many claims were settled by their own cited abstracts
  // (round-61 P0-A — these cost zero web-search quota).
  const abstractSettled = findings.filter((f) => f.evidenceSource === "cited-abstract").length;
  if (abstractSettled > 0 || searchSuccesses > 0) {
    console.log(
      `[fact-check] claims=${claims.length} abstractSettled=${abstractSettled} webSearched=${searchSuccesses} v=${summary0(findings, "VERIFIED")} c=${summary0(findings, "CONTRADICTED")} u=${summary0(findings, "UNVERIFIABLE")} e=${summary0(findings, "ERROR")}`,
    );
  }

  const summary = {
    claimsChecked: findings.filter((f) => f.verdict !== "ERROR").length,
    verified: findings.filter((f) => f.verdict === "VERIFIED").length,
    contradicted: findings.filter((f) => f.verdict === "CONTRADICTED").length,
    unverifiable: findings.filter((f) => f.verdict === "UNVERIFIABLE").length,
    errors: findings.filter((f) => f.verdict === "ERROR").length,
  };
  return { ran: true, claims, findings, summary };
}

/**
 * Parse the composed "## References" block back into per-number metadata.
 * Compose format (deterministic, written by both pipelines):
 *   [n] AUTHORS (YEAR), JOURNAL. TITLE. — URL
 * Tolerant: any field may be missing; title falls back to the whole tail.
 */
export function parseReferenceBlock(referencesText: string): Map<number, RefMeta> {
  const map = new Map<number, RefMeta>();
  if (!referencesText) return map;
  for (const line of referencesText.split("\n")) {
    const m = line.match(/^\s*\[(\d+)\]\s*(.+)$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    let rest = m[2].trim();
    let url = "";
    const dash = rest.indexOf(" — ");
    if (dash >= 0) {
      url = rest.slice(dash + 3).trim();
      rest = rest.slice(0, dash).trim();
    }
    const yearMatch = rest.match(/\((\d{4})\)/);
    const year = yearMatch ? yearMatch[1] : "";
    const firstDot = rest.indexOf(". ");
    const authors = firstDot >= 0 ? rest.slice(0, firstDot).trim() : rest;
    const title =
      firstDot >= 0
        ? rest
            .slice(firstDot + 2)
            .replace(/\.$/, "")
            .trim()
        : rest;
    map.set(n, { title, authors, year, url });
  }
  return map;
}

/* ------------------------------------------------------------------ *
 * 5. Formatting helpers (used by the review route to inject findings)
 * ------------------------------------------------------------------ */

/** One-line weakness string for a non-verified finding. */
export function factFindingToWeakness(f: FactCheckFinding): string {
  const citeTag = f.citedNums.length > 0 ? `CITED [${f.citedNums.join(",")}]` : "UNCITED";
  const sentence = f.sentence.length > 160 ? f.sentence.slice(0, 157) + "…" : f.sentence;
  const reason = f.reason || "no reason given";
  return `FACT-CHECK ${f.verdict} (${f.category}, ${citeTag}): "${sentence}" — ${reason}`;
}

/** Prompt block describing the findings for the reviewing LLM. */
export function factFindingsPromptBlock(findings: FactCheckFinding[]): string {
  const notable = findings.filter((f) => f.verdict !== "VERIFIED" && f.verdict !== "ERROR");
  if (notable.length === 0) return "";
  const lines = notable
    .map((f) => {
      const citeTag = f.citedNums.length > 0 ? `cites [${f.citedNums.join(",")}]` : "uncited";
      return `- [${f.verdict}] (${f.category}, ${citeTag}) "${f.sentence.slice(0, 220)}" — ${f.reason}${f.evidenceQuote ? ` | evidence: "${f.evidenceQuote.slice(0, 150)}"` : ""}`;
    })
    .join("\n");
  return `\nEXTERNAL FACT-CHECK FINDINGS (each claim was web-searched and adjudicated against independent evidence):
${lines}

HOW TO WEIGH THESE:
- CONTRADICTED: external evidence directly refutes the sentence (including the case where the sentence asserts a positive finding/specific value while the cited evidence reports its absence). Treat as a factual error that MUST be fixed or removed — mention it explicitly in weaknesses and demand correction in suggestions.
- UNVERIFIABLE: no independent corroboration could be found. Flag it as needing verification or a proper primary citation — it is not proof of error, but it is a verification gap.
- These findings are ground truth from external sources — do not soften them, and cite them in your weaknesses verbatim (keep the "FACT-CHECK" prefix so the author can trace each one).\n`;
}
