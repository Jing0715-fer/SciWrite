/**
 * Web-verified fact checking for the review pipeline (round-57).
 *
 * WHY THIS EXISTS (E2E audit, round-56): the adversarial citation verifier
 * checks "does reference [n] support this sentence" — it NEVER checks "is
 * this sentence TRUE". A fabricated claim ("the MT current becomes
 * phase-shifted by 180°") sitting next to a real citation sails through,
 * because the pairing looks plausible. The closed-box reviewer had the same
 * blind spot: zero external input, so it could not know the double-knockout
 * literature says the current is COMPLETELY ABSENT.
 *
 * This module adds the missing half:
 *   1. extractVerifiableClaims — MECHANICAL (regex, model-independent)
 *      extraction of the claim types most prone to fabrication:
 *        - quantitative claims  ("180°", "52 ± 4 pS", "4-8% of cases")
 *        - negative-existence   ("has not been reported", "remains elusive")
 *        - novelty/first        ("first to demonstrate", "first report")
 *        - attribution          ("Holt and colleagues demonstrated")
 *   2. webVerifyClaims — one live web search per claim (capped), then ONE
 *      LLM arbitration call that classifies each claim against the search
 *      evidence: VERIFIED / CONTRADICTED / UNVERIFIABLE.
 *
 * Everything is best-effort and bounded: a search failure skips the claim,
 * a total failure returns empty findings — the review still runs, it just
 * runs without the web layer (never worse than the pre-round-57 baseline).
 */

import { webSearch } from "@/lib/ai";
import { chatWithSession } from "@/lib/llm-session";
import { splitBodyAndReferences } from "@/lib/citation-audit";

/** Max claims extracted per article (keeps searches bounded). */
const MAX_CLAIMS = 6;
/** Max search results fetched per claim. */
const SEARCH_RESULTS_PER_CLAIM = 5;

/** Quantitative claim: numbers with scientific units, percents, degrees, fold.
 *  NOTE (round-57 E2E lesson): symbol units (° % ×) must NOT require a
 *  trailing word boundary — "180°," had none (° is a non-word char followed
 *  by punctuation), so the fabricated phase-shift claim escaped extraction
 *  in the first live test. Alpha units keep the boundary (5 sons ≠ 5 s). */
const QUANT_RE =
  /\b\d+(?:[.,]\d+)?\s*(?:(?:°|degrees?|%|percent|×)|(?:pS|nS|pA|nA|µm|um|nm|mm|cm|mM|µM|uM|nM|kDa|Da|Hz|kHz|ms|fold|copies|dimers?|subunits?|helices|residues?|mutations?|families?|species|genes?|members?|amino acids?|kb|bp|Mb)\b|\bs\b|\bx\b)/i;

/** Negative-existence claim — the single most fabrication-prone form
 *  ("mammalian TMC structures have not been reported" — while they have). */
const NEGATIVE_EXISTENCE_RE =
  /\b(?:not been (?:reported|observed|determined|characterized|demonstrated|described|elucidated|solved)|remain(?:s|ed|ing)? (?:elusive|unknown|unclear|unresolved|undetermined|unexplored|poorly understood|controversial)|has yet to be|no (?:atomic |high-resolution )?(?:structure|report|study|evidence|data) (?:has|have) been|lacks? (?:structural|experimental|in vivo) evidence|is currently lacking)\b/i;

/** Novelty/priority claim. */
const NOVELTY_RE =
  /\b(?:first (?:to|report|demonstration|description|evidence|identification| cloning)|for the first time|novel (?:mechanism|finding|class|family|approach|method)|unprecedented|newly (?:discovered|identified))\b/i;

/** Attribution claim ("Holt and colleagues demonstrated..."). */
const ATTRIBUTION_RE =
  /\b(?:[A-Z][a-z]+(?:\s+(?:and|&)\s+[A-Z][a-z]+)?(?:\s+et\s+al\.?|\s+and\s+colleagues)?\s+(?:demonstrated|showed|reported|established|discovered|identified|found|provided)|demonstrated by|reported by|shown by|according to)\b/;

/** Lower bound on sentence length — short connectors are not claims. */
const MIN_CLAIM_WORDS = 8;

export interface VerifiableClaim {
  id: number;
  sentence: string;
  kind: "quantitative" | "negative-existence" | "novelty" | "attribution";
  cited: boolean;
}

export interface FactCheckFinding {
  claim: string;
  kind: string;
  cited: boolean;
  verdict: "VERIFIED" | "CONTRADICTED" | "UNVERIFIABLE";
  evidence: string;
}

/**
 * Mechanically extract the most fabrication-prone claim sentences from an
 * article body (references section is split off first). Model-independent.
 */
export function extractVerifiableClaims(content: string): VerifiableClaim[] {
  const { body } = splitBodyAndReferences(content || "");
  // Sentence split: period/bang/question followed by whitespace+capital.
  // Markdown-aware enough for generated review articles.
  const rawSentences = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/#{1,6}\s+[^\n]*/g, " ") // headings are structure, not claims
    .split(/(?<=[.!?])\s+(?=[A-Z*])|\n\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const scored: { s: string; kind: VerifiableClaim["kind"]; pri: number; cited: boolean }[] = [];
  const seen = new Set<string>();
  for (const s of rawSentences) {
    const words = (s.match(/\S+/g) || []).length;
    if (words < MIN_CLAIM_WORDS || words > 80) continue;
    const lower = s.toLowerCase().slice(0, 160); // dedup key on a prefix
    if (seen.has(lower)) continue;
    seen.add(lower);

    let kind: VerifiableClaim["kind"] | null = null;
    let pri = 0;
    if (NEGATIVE_EXISTENCE_RE.test(s)) {
      // Highest priority: "X has not been reported" is a checkable global fact
      // and the round-56 fatal class.
      kind = "negative-existence";
      pri = 3;
    } else if (NOVELTY_RE.test(s)) {
      kind = "novelty";
      pri = 2;
    } else if (QUANT_RE.test(s)) {
      kind = "quantitative";
      pri = 1;
    } else if (ATTRIBUTION_RE.test(s)) {
      kind = "attribution";
      pri = 1;
    }
    if (!kind) continue;
    scored.push({ s, kind, pri, cited: /\[\d/.test(s) });
  }

  // Priority order: negative-existence > novelty > quantitative/attribution;
  // within the same priority keep document order (stable sort).
  scored.sort((a, b) => b.pri - a.pri);
  return scored.slice(0, MAX_CLAIMS).map((x, i) => ({
    id: i + 1,
    sentence: x.s,
    kind: x.kind,
    cited: x.cited,
  }));
}

/** Turn a claim sentence into a focused search query (claim as written). */
function claimToQuery(claim: VerifiableClaim, topicHint: string): string {
  // Strip markdown/citation noise, keep the meaningful core.
  const clean = claim.sentence
    .replace(/\[\d+(?:[,\-–\s]*\d+)*\]/g, " ")
    .replace(/[*_`#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = clean.split(" ");
  const core = words.length > 24 ? words.slice(0, 24).join(" ") : clean;
  return topicHint ? `${core} ${topicHint}`.slice(0, 300) : core.slice(0, 300);
}

/**
 * round-57 (E2E lesson 2): the claim-as-written query embeds the possibly-
 * fabricated wording itself ("phase-shifted by 180°") — literature describing
 * the REAL outcome ("currents completely absent") never matches those
 * words, so the contradiction stays invisible. The SUBJECT PROBE strips
 * numbers-with-units and assertion glue, keeping the subject terms the
 * literature would actually use ("both isoforms absent MT current" + topic
 * → surfaces the knockout papers that state the true outcome).
 */
function claimToSubjectQuery(claim: VerifiableClaim, topicHint: string): string {
  const stripped = claim.sentence
    .replace(/\[\d+(?:[,\-–\s]*\d+)*\]/g, " ")
    .replace(/\d+(?:[.,]\d+)?\s*(?:°|degrees?|%|percent|×|pS|nS|pA|nA|µm|um|nm|mm|cm|mM|µM|uM|nM|kDa|Da|Hz|kHz|ms|fold|copies|dimers?|subunits?|helices|residues?|kb|bp|Mb)\b/gi, " ")
    .replace(/[*_`#]/g, " ")
    .replace(/\b(?:however|notably|furthermore|moreover|therefore|thus|indicating|suggesting|demonstrating|confirming|revealing|whereas|while|although|because)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = stripped.split(" ").filter((w) => w.length > 2);
  const core = words.slice(0, 10).join(" ");
  return `${core} ${topicHint}`.trim().slice(0, 300);
}

/**
 * Verify claims against the live web. One search per claim + one LLM
 * arbitration call. Best-effort: failures degrade to empty findings.
 */
export async function webVerifyClaims(
  projectId: string,
  claims: VerifiableClaim[],
  topicHint = ""
): Promise<FactCheckFinding[]> {
  if (claims.length === 0) return [];

  // 1) Search per claim (failures yield empty evidence — still arbitratable
  //    as UNVERIFIABLE, but skip claims whose search THREW to save budget).
  //    round-57 E2E lesson 2: quantitative claims get TWO queries — the claim
  //    as written AND a subject probe — because a fabricated number/mechanism
  //    term actively repels the literature that would refute it.
  const evidence = new Map<number, { name: string; snippet: string; url: string }[]>();
  await Promise.all(
    claims.map(async (c) => {
      const queries =
        c.kind === "quantitative"
          ? [claimToQuery(c, topicHint), claimToSubjectQuery(c, topicHint)]
          : [claimToQuery(c, topicHint)];
      const collected: { name: string; snippet: string; url: string }[] = [];
      for (const q of queries) {
        if (!q.trim()) continue;
        try {
          const results = await webSearch(q, SEARCH_RESULTS_PER_CLAIM);
          if (Array.isArray(results)) {
            for (const r of results.slice(0, SEARCH_RESULTS_PER_CLAIM)) {
              collected.push({
                name: String(r.name || "").slice(0, 140),
                snippet: String(r.snippet || "").slice(0, 400),
                url: String(r.url || "").slice(0, 200),
              });
            }
          }
        } catch {
          // query failed — try the next one
        }
      }
      // Dedup by URL, keep order (as-written results first).
      const seen = new Set<string>();
      const deduped = collected.filter((r) => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });
      if (deduped.length > 0) evidence.set(c.id, deduped.slice(0, SEARCH_RESULTS_PER_CLAIM * 2));
    })
  );

  const arbitratable = claims.filter((c) => evidence.has(c.id));
  if (arbitratable.length === 0) return [];

  // 2) ONE arbitration call over all claims with evidence.
  const system =
    "You are a meticulous fact-checker for a scientific manuscript. For each CLAIM you receive " +
    "live WEB SEARCH EVIDENCE (titles + snippets + URLs) retrieved just now. Judge whether the " +
    "web evidence CONFIRMS or CONTRADICTS the claim, or is insufficient.\n" +
    "Rules:\n" +
    "- VERIFIED: at least one result directly states/implies the same fact.\n" +
    "- CONTRADICTED: a credible source (journal, database, lab site) states a materially " +
    "different fact for the SAME subject. CRITICAL DISTINCTION: when the claim asserts a " +
    "specific OUTCOME or STATE (e.g. 'the current becomes phase-shifted by 180°', 'expression " +
    "was absent') and the evidence states a DIFFERENT outcome/state for that same subject " +
    "(e.g. 'currents were completely absent', 'expression was detected'), that is CONTRADICTED — " +
    "NOT UNVERIFIABLE. Quote the decisive snippet.\n" +
    "- Also CONTRADICTED: 'has not been reported' claims where the evidence shows it HAS been " +
    "reported (e.g. a structure/review of exactly that thing).\n" +
    "- UNVERIFIABLE: snippets genuinely don't address the claim's subject. Do NOT guess.\n" +
    "- Judge the CLAIM against the WEB, not the other way around.\n" +
    "Respond as STRICT JSON only:\n" +
    '{"findings":[{"id":1,"verdict":"VERIFIED|CONTRADICTED|UNVERIFIABLE","evidence":"one line, quote the decisive snippet if CONTRADICTED"}]}';

  const block = arbitratable
    .map((c) => {
      const ev = (evidence.get(c.id) || [])
        .map((r, i) => `  ${i + 1}. ${r.name} — ${r.snippet} (${r.url})`)
        .join("\n");
      const specific = c.kind === "quantitative" ? specificQuantitiesOf(c.sentence) : null;
      return `[CLAIM ${c.id}] (${c.kind}${c.cited ? ", cited in manuscript" : ", UNCITED"})\n  ${c.sentence.slice(0, 400)}\n${specific ? `  SPECIFIC QUANTITIES: ${specific.join(", ")} — their appearance in the evidence is NECESSARY but NOT SUFFICIENT for VERIFIED: the evidence must also describe the SAME outcome the claim asserts. If the evidence describes a DIFFERENT outcome for the same subject (e.g. the claim says the current 'becomes phase-shifted' but the evidence says currents 'were completely absent'), the verdict is CONTRADICTED.\n` : ""}  WEB EVIDENCE:\n${ev}`;
    })
    .join("\n\n");

  try {
    const raw = await chatWithSession(projectId, `CLAIMS TO FACT-CHECK:\n\n${block}`, {
      system,
      temperature: 0.1,
      taskType: "fact-check",
      metadata: { step: "fact-check", claims: arbitratable.length },
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    const byId = new Map(claims.map((c) => [c.id, c]));
    const findings: FactCheckFinding[] = [];
    for (const f of parsed.findings || []) {
      const id = parseInt(String(f.id), 10);
      const claim = byId.get(id);
      if (!claim) continue;
      let verdict = String(f.verdict || "").toUpperCase();
      if (!["VERIFIED", "CONTRADICTED", "UNVERIFIABLE"].includes(verdict)) continue;
      let evidenceText = String(f.evidence || "").slice(0, 300);
      // ★ round-57 MECHANICAL QUANTITY GUARD (model-independent): a
      // compound claim can pair a fabricated quantity with a true generic
      // statement ("the current becomes phase-shifted by 180°, indicating
      // that TMC proteins are necessary..." — second half true) and the
      // arbitrator confirms the sentence off the true half. VERIFIED for a
      // quantitative claim now REQUIRES the specific figure to literally
      // appear in the retrieved evidence; otherwise downgrade to
      // UNVERIFIABLE with the reason stated.
      if (verdict === "VERIFIED" && claim.kind === "quantitative") {
        const evList = evidence.get(id) || [];
        // ★ mechanical outcome-conflict guard (round-57, the round-56 fatal
        // class): a claim asserting a POSITIVE outcome for an absence
        // condition ("when both isoforms are absent, the current becomes
        // phase-shifted") is CONTRADICTED by evidence stating the outcome is
        // ABSENCE ("currents were completely absent") — regardless of whether
        // the claim's figure coincidentally appears elsewhere in the snippets
        // ("180" shows up in unrelated phase-mechanics text). Narrow scope:
        // absence-condition + positive-outcome-verb + absence-phrase in
        // evidence → hard CONTRADICTED with the quote.
        const conflict = mechanicalOutcomeConflict(claim.sentence, evList);
        const nums = specificQuantitiesOf(claim.sentence);
        const haystack = evList
          .map((r) => `${r.name} ${r.snippet}`)
          .join(" ")
          .toLowerCase();
        const has = nums.length > 0 && nums.some((n) => haystackHasQuantity(haystack, n));
        // round-57 debug: the guard's decision trail.
        console.log(
          `[fact-check] guard claim=${id} nums=[${nums.join(",")}] haystackHas=${has} conflict=${conflict ? "YES" : "no"} ` +
            `evidenceUrls=${evList.map((r) => r.url.slice(0, 60)).join(" | ").slice(0, 300)}`
        );
        if (conflict) {
          verdict = "CONTRADICTED";
          evidenceText = `Mechanical outcome-conflict guard: the claim asserts a positive outcome for an absence condition, but the retrieved evidence states the outcome IS absence — "${conflict.quote}". ${evidenceText.slice(0, 120)}`;
        } else if (!has) {
          verdict = "UNVERIFIABLE";
          evidenceText = `Mechanical guard: the specific figure(s) ${nums.join(", ")} do not appear anywhere in the retrieved web evidence — the claim is uncorroborated even if its subject matter is real. ${evidenceText.slice(0, 160)}`;
        }
      }
      findings.push({
        claim: claim.sentence.slice(0, 300),
        kind: claim.kind,
        cited: claim.cited,
        verdict: verdict as FactCheckFinding["verdict"],
        evidence: evidenceText,
      });
    }
    return findings;
  } catch {
    return [];
  }
}

/** The specific number+unit figures a quantitative claim asserts ("180°",
 *  "52 ± 4 pS" → ["180", "52", "4pS"]). Used for the mechanical
 *  VERIFIED-guard and to focus the arbitrator. Bare years/small ordinals
 *  are excluded (they are context, not checkable quantities). */
function specificQuantitiesOf(sentence: string): string[] {
  const out: string[] = [];
  // No trailing \b — symbol units (° % ×) are never followed by one (E2E
  // lesson 1 again); the leading \b plus the numeric body is selective
  // enough for claim sentences.
  const re = /\b(\d{1,4}(?:[.,]\d+)?)\s*(°|degrees?|%|percent|×|pS|nS|pA|nA|µm|um|nm|mm|cm|mM|µM|uM|nM|kDa|Da|Hz|kHz|ms|fold|copies|dimers?|subunits?|helices?|residues?|mutations?|families?|species|genes?|members?|kb|bp|Mb)?/gi;
  let m;
  while ((m = re.exec(sentence)) !== null) {
    const num = m[1];
    const unit = (m[2] || "").trim();
    const bare = parseInt(num.replace(".", ""), 10);
    // Skip years (1900-2099 with no unit) and tiny bare integers (1-3 =
    // grammatical counts).
    if (!unit && (bare >= 1900 && bare <= 2099)) continue;
    if (!unit && bare >= 1 && bare <= 3) continue;
    out.push(unit ? `${num}${unit}` : num);
  }
  return [...new Set(out)].slice(0, 6);
}

/** Word-boundary-safe containment: "180" must not match "1180" (bare numbers
 *  use regex word boundaries); unit-bearing forms match compactly ("4ps" in
 *  "4 pS") — the haystack is lowercased by the caller. */
function haystackHasQuantity(haystack: string, quantity: string): boolean {
  const q = quantity.toLowerCase();
  const hasUnit = /[^0-9.,]/.test(q);
  if (hasUnit) {
    const compact = haystack.replace(/\s+/g, "");
    if (compact.includes(q)) return true;
    // Spaced unit form ("4 ps") survives lowercasing; give it a chance too.
    const spaced = q.replace(/([0-9])([a-z°%×])/g, "$1 $2");
    if (spaced !== q && haystack.includes(spaced)) return true;
  }
  const numCore = q.replace(/[^0-9.,]/g, "");
  if (numCore.length >= 2) {
    try {
      if (new RegExp(`\\b${numCore.replace(/\./g, "\\.")}\\b`).test(haystack)) return true;
    } catch {
      // fallthrough
    }
  }
  return false;
}

/**
 * round-57 mechanical outcome-conflict detector: does the claim assert a
 * POSITIVE outcome for an ABSENCE condition while the evidence states the
 * outcome IS absence? ("when both isoforms are absent, the current becomes
 * phase-shifted by 180°" vs "mechanotransduction currents were completely
 * absent"). Returns the quoting evidence snippet when a conflict is found.
 */
function mechanicalOutcomeConflict(
  claimSentence: string,
  evidenceList: { name: string; snippet: string; url: string }[]
): { quote: string } | null {
  const claim = claimSentence.toLowerCase();
  const absenceCondition =
    /\b(?:both|double|either)\b[^.]{0,40}\b(?:absent|lacking|deleted|knockout|mutant|null)\b/.test(claim) ||
    /\b(?:lacking|absent|deleted)\b[^.]{0,40}\b(?:both|either|tmc\d|isoforms?)\b/.test(claim);
  const positiveOutcome =
    /\b(?:becomes?|produces?|exhibits?|displays?|generates?|results? in|shifts? to|is converted|undergoes?)\b/.test(claim);
  if (!absenceCondition || !positiveOutcome) return null;
  const absenceRe =
    /([^.]{0,120}(?:completely absent|were absent|is absent|abolished|eliminated|no residual|absence of mechanotransduction)[^.]{0,80})/i;
  // False-positive guard (E2E lesson 4): if the SAME evidence snippet that
  // contains the absence phrase ALSO states the claim's own outcome (e.g.
  // Kim-2013's abstract reports BOTH "in the absence of both isoforms ...
  // phase-shifted 180°" AND absence language elsewhere), the "conflict" is
  // really an intra-literature controversy that the claim faithfully cites
  // — NOT an evidence-against-claim contradiction. Only quote absence
  // language from snippets that do NOT themselves report the claimed
  // outcome (the claim's specific figures mark that).
  const claimQuantities = specificQuantitiesOf(claimSentence);
  for (const r of evidenceList) {
    const text = `${r.name} ${r.snippet}`;
    const m = text.match(absenceRe);
    if (!m) continue;
    if (
      claimQuantities.length > 0 &&
      claimQuantities.some((q) => haystackHasQuantity(text.toLowerCase(), q))
    ) {
      continue; // same snippet reports the claimed outcome — not a clean conflict
    }
    return { quote: m[1].trim().replace(/\s+/g, " ").slice(0, 200) };
  }
  return null;
}

/**
 * Full article fact-check: extract → verify. Convenience wrapper used by the
 * review route. Never throws.
 */
export async function factCheckArticle(
  projectId: string,
  articleTitle: string,
  articleContent: string
): Promise<{ claimsChecked: number; findings: FactCheckFinding[] }> {
  try {
    const topicHint = (articleTitle || "").split(/[:—–-]/)[0].trim().slice(0, 80);
    const claims = extractVerifiableClaims(articleContent);
    if (claims.length === 0) return { claimsChecked: 0, findings: [] };
    const findings = await webVerifyClaims(projectId, claims, topicHint);
    return { claimsChecked: claims.length, findings };
  } catch {
    return { claimsChecked: 0, findings: [] };
  }
}
