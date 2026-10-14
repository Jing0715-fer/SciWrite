/**
 * round-RT3 (R6): mechanical number+unit coverage sweep.
 *
 * WHY: numeric claims are only checked where a citation pair happens to be
 * verified (≤2 sentences/ref in the adversarial verify) or via the ≤8-
 * sentence fact-check sample — the RT2 run's correct "2.5 Å" was luck of
 * the sample, not coverage (the earlier A4-class error proved the escape
 * surface is real). This sweep closes the coverage gap at ZERO LLM cost:
 * every citation-bearing sentence with a number+unit token is checked
 * mechanically against the cited references' OWN abstracts.
 *
 * DESIGN:
 *  - Pure/deterministic — same input, same findings (unit-testable).
 *  - ADVISORY ONLY by design: a number absent from a short abstract is NOT
 *    proof of error (abstracts summarize; "2.5 Å" may live in the full
 *    text). Findings are injected as review weaknesses so the reviewer LLM
 *    weighs them and the Review tab discloses them, but they never hard-
 *    trigger a revision round on their own — that would churn the repair
 *    loop against false positives.
 *  - Hedged sentences skip: "approximately", "around", "reported" soften
 *    the precision contract, and the fact-check layer already owns them.
 *  - A number counts as covered when it appears in ANY of the sentence's
 *    cited abstracts (multi-ref sentences draw from any of them).
 */

export interface NumericSweepFinding {
  /** the matched numeric token, e.g. "2.5" or "76.3" */
  number: string;
  /** unit context following the number ("" for bare decimals) */
  unit: string;
  /** the citation numbers attached to the sentence */
  citedNums: number[];
  /** the sentence (trimmed, citation markers kept for traceability) */
  sentence: string;
  /** abstracts that were searched (numbers) — for the reason string */
  searchedRefs: number[];
}

export interface NumericSweepReport {
  findings: NumericSweepFinding[];
  /** numeric sentences examined (coverage telemetry) */
  sentencesExamined: number;
  /** numeric sentences whose numbers WERE found in a cited abstract */
  covered: number;
}

/** Number+unit token matcher — superset of fact-check's isQuantitative unit
 * table, tuned for the pattern "value + unit" rather than "any digits".
 * Bare decimals ("2.5 Å" splits as number=2.5 unit=Å; "1.8 million" →
 * number=1.8 unit=million) and percents are numeric claims; standalone
 * 4-digit years are NOT (already excluded upstream by the caller's regex). */
const NUM_UNIT_RE =
  /(\d{1,6}(?:[.,]\d+)?)\s*(Å|å|angstroms?|nm|µm|um|μm|mm|cm|m\b|nM|µM|uM|μM|mM|pM|M\b|kb|kbp|bp|kDa|Da|Md|g\b|mg|µg|ug|μg|ng|pg|mL|µL|uL|μL|ms|µs|us|ns|ps|s\b|min|h\b|hr|hours?|Hz|kHz|MHz|GHz|fold|×|%|percent|°C|°F|°|kcal|kJ|mol|mmol|µmol|μmol|residues?|amino[- ]acids?|aa\b|copies|cells?|patients?|mutants?|edits?|variants?|genes?|proteins?|types?|species|strains?|million|billion|billion)?/g;

/** Numbers too trivial to be worth an abstract cross-check. */
function isTrivialNumber(numStr: string): boolean {
  const n = parseFloat(numStr.replace(",", "."));
  if (Number.isNaN(n)) return true;
  // 0/1/2 and small integers without decimals are structural language
  // ("two main classes", "one study") — not factual numeric claims.
  if (Number.isInteger(n) && n >= 0 && n <= 3) return true;
  return false;
}

/** Normalize an abstract for numeric containment: digit tokens with commas
 * stripped ("1,000" ↔ "1000"), unicode minus → ASCII. */
function abstractNumbers(abstract: string): Set<string> {
  const out = new Set<string>();
  const re = /\d+(?:[.,]\d+)?/g;
  let m: RegExpExecArray | null;
  const norm = abstract.replace(/[−–—]/g, "-").replace(/(\d),(\d{3})\b/g, "$1$2");
  while ((m = re.exec(norm)) !== null) {
    out.add(m[0].replace(",", "."));
  }
  return out;
}

/** The same hedging contract the fact-check layer uses — a hedged numeric
 * claim is disclosed, not broken, and re-flagging it is churn. */
const NUMERIC_HEDGE_RE =
  /\b(?:approximately|approx\.?|around|about|roughly|~|at least|at most|more than|less than|over|under|up to|nearly|almost|reported|reportedly|estimated|on the order of|order of magnitude)\b/i;

const CITE_NUM_RE_SWEEP = /\[(\d+(?:[,\-–\s]\d+)*)\]/g;

function citedNumsOfSweep(sentence: string): number[] {
  const nums = new Set<number>();
  let m: RegExpExecArray | null;
  CITE_NUM_RE_SWEEP.lastIndex = 0;
  while ((m = CITE_NUM_RE_SWEEP.exec(sentence)) !== null) {
    // RT10: \s joins the split class — "[1 3]" contributes both numbers, so
    // coverage can draw on the SECOND number's abstract too (this was the
    // false-positive source: the second ref's abstract covered the value
    // but the marker only admitted the first number). No dash-space
    // collapse needed: CITE_NUM_RE_SWEEP's separator class has no trailing
    // \s*, so a dash can never be followed by a space in its inners.
    for (const part of m[1].split(/[,;\s]\s*/)) {
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

/**
 * Sweep an article BODY (references already stripped) for number+unit claims
 * whose numbers do not appear in any of the sentence's cited abstracts.
 *
 * @param body         article body markdown (## headings tolerated, skipped)
 * @param refAbstracts citation number → { title, abstract } (the article's
 *                     own pool, ≥80-char abstracts — same bar as fact-check)
 * @param opts.maxFindings cap (default 12 — enough to steer a review,
 *                     small enough to keep the weakness list sane)
 */
export function sweepNumericClaims(
  body: string,
  refAbstracts: Map<number, { title: string; abstract: string }>,
  opts: { maxFindings?: number } = {}
): NumericSweepReport {
  const maxFindings = opts.maxFindings ?? 12;
  const findings: NumericSweepFinding[] = [];
  if (!body) return { findings, sentencesExamined: 0, covered: 0 };

  // Pre-compute per-ref number sets once (abstracts are long, sentences many).
  const refNumbers = new Map<number, Set<string>>();
  for (const [n, meta] of refAbstracts) {
    if (meta?.abstract && meta.abstract.length > 80) {
      refNumbers.set(n, abstractNumbers(meta.abstract));
    }
  }

  const sentences = body
    .split(/\n/)
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .join(" ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  let examined = 0;
  let covered = 0;

  for (const sentence of sentences) {
    const cited = citedNumsOfSweep(sentence);
    if (cited.length === 0) continue; // uncited numeric claims belong to the fact-check layer
    // Do any cited refs have usable abstracts at all? If not, the sweep has
    // no evidence to cross-check against — skip silently (not a finding).
    const usableRefs = cited.filter((n) => refNumbers.has(n));
    if (usableRefs.length === 0) continue;

    // Extract number+unit pairs from a citation-stripped, year-stripped
    // view of the sentence — the "[1,2]" marker itself would otherwise
    // read as the number 1.2.
    const withoutCites = sentence.replace(/\[\d+(?:[,\-–\s]\d+)*\]/g, " ");
    const withoutYears = withoutCites.replace(/\b(19|20)\d{2}\b/g, " ");
    let m: RegExpExecArray | null;
    const pairs: { number: string; unit: string }[] = [];
    NUM_UNIT_RE.lastIndex = 0;
    while ((m = NUM_UNIT_RE.exec(withoutYears)) !== null) {
      const number = m[1];
      const unit = (m[2] || "").trim();
      if (isTrivialNumber(number)) continue;
      pairs.push({ number: number.replace(",", "."), unit });
    }
    if (pairs.length === 0) continue;
    examined++;

    // A pair is covered if its number appears in ANY cited usable abstract.
    // Uncovered pairs (deduped per sentence) become findings.
    const uncovered = pairs.filter(
      (p) => !usableRefs.some((n) => refNumbers.get(n)!.has(p.number)),
    );
    if (uncovered.length === 0) {
      covered++;
      continue;
    }
    if (NUMERIC_HEDGE_RE.test(sentence)) continue; // hedged → disclosed, skip
    if (findings.length >= maxFindings) continue;
    findings.push({
      number: uncovered[0].number,
      unit: uncovered[0].unit,
      citedNums: cited,
      sentence: sentence.slice(0, 300),
      searchedRefs: usableRefs,
    });
  }

  return { findings, sentencesExamined: examined, covered };
}

/** Format a sweep finding as a review weakness line (R6 injection). */
export function numericFindingToWeakness(f: NumericSweepFinding): string {
  const citeTag = f.citedNums.length > 0 ? `cites [${f.citedNums.join(",")}]` : "uncited";
  const value = f.unit ? `${f.number} ${f.unit}` : f.number;
  return `NUMERIC-COVERAGE GAP (advisory, ${citeTag}): value "${value}" not found in the cited reference's abstract — verify against the full text or hedge. Sentence: "${f.sentence.slice(0, 160)}"`;
}
