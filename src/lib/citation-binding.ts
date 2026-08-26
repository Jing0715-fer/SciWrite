/**
 * citation-binding.ts — Structural citation-key binding system (v2 accuracy core).
 *
 * PROBLEM (why this module exists):
 *   In the v1 pipeline the LLM is told to cite sources by NUMERIC index
 *   ("[n] refers to the n-th entry in the reference list"). LLMs are bad at
 *   maintaining that mapping while writing long prose: they transpose
 *   numbers, cite out-of-range indices, and drift after list re-orderings.
 *   Every downstream healing layer (renumbering, auto-fix, audit) then has
 *   to guess which paper a hallucinated [7] meant — and sometimes "fixes"
 *   correct citations into wrong ones.
 *
 * SOLUTION (structural, not prompt-based):
 *   The LLM NEVER writes numbers. Each reference is given a stable, unique
 *   key — {{R1}}, {{R2}}, … — printed right next to the entry in the
 *   reference list. The model cites by copying the key token that is
 *   physically bound to the source it wants. Numbers are then assigned
 *   MECHANICALLY by this module, in order of first appearance.
 *
 *   Misnumbering becomes structurally impossible:
 *     - a key either exists (→ exact known reference) or it doesn't (→ dropped)
 *     - number assignment is deterministic code, not model output
 *     - renumbering across compose/translation never drifts, because the
 *       key→reference mapping is recomputed from the reference list each time
 *
 * Key grammar:
 *   {{R1}}          single citation
 *   {{R1,R4}}       multi-citation (same bracket)
 *   {{R2}}{{R5}}    adjacent citations (allowed, treated as two markers)
 *
 * This module is PURE (no DB, no LLM) — same design constraint as
 * citation-audit.ts so it can run inline at every save boundary.
 */

/** Regular expression matching a raw citation-key marker. */
export const CITE_KEY_RE = /\{\{\s*R(\d{1,3})\s*(?:,\s*R(\d{1,3})\s*)*\}\}/g;

/**
 * Loose variant used to DETECT near-miss keys. Only matches inner text made
 * EXCLUSIVELY of R/r letters, digits, commas and whitespace — so ordinary
 * prose in double curly braces (e.g. "{{not a citation}}") is never touched.
 */
const CITE_KEY_LOOSE_RE = /\{\{[\s]*[rR]?[\s]*\d{1,3}[\s]*(?:,[\s]*[rR]?[\s]*\d{1,3}[\s]*)*\}\}/g;

export interface BindableRef {
  title: string;
  authors?: string | null;
  journal?: string | null;
  year?: string | null;
  url?: string | null;
  externalId?: string | null;
  type?: string | null;
  abstract?: string | null;
  doi?: string | null;
  id?: string;
}

/** Make the citation key for a 1-based reference index: {{R1}} … */
export function makeCitationKey(index1Based: number): string {
  return `{{R${index1Based}}}`;
}

/**
 * Build the keyed reference list block injected into generation prompts.
 * Each entry leads with its key so the LLM physically copies the token
 * attached to the source it is using.
 *
 * Example:
 *   {{R1}} Jinek M (2012), Science. A programmable dual-RNA-guided DNA endonuclease… — https://…
 *   {{R2}} …
 */
export function buildKeyedReferenceList(refs: BindableRef[]): string {
  return refs
    .map((r, i) => {
      const auth = (r.authors || "Anonymous").trim();
      const yr = r.year ? ` (${r.year})` : "";
      const jour = r.journal ? `, ${r.journal}` : "";
      const ext = r.externalId ? ` [${(r.type || "src").toUpperCase()}:${r.externalId}]` : "";
      const url = r.url ? ` — ${r.url}` : "";
      const abs = r.abstract ? `\n    Abstract: ${r.abstract.slice(0, 320)}` : "";
      return `{{R${i + 1}}} ${auth}${yr}${jour}. ${r.title || "Untitled"}.${ext}${url}${abs}`;
    })
    .join("\n");
}

export interface KeyedCitation {
  /** 1-based reference index the key points at. */
  refIndex: number;
  /** Original marker text, e.g. "{{R3}}" or "{{R1,R4}}". */
  marker: string;
  /** Character offset of the marker in the content. */
  index: number;
}

/** Extract all keyed citations in document order. */
export function extractKeyedCitations(content: string): KeyedCitation[] {
  const out: KeyedCitation[] = [];
  CITE_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_KEY_RE.exec(content))) {
    const nums = m[0].match(/R(\d{1,3})/g) || [];
    for (const tok of nums) {
      out.push({
        refIndex: parseInt(tok.slice(1), 10),
        marker: m[0],
        index: m.index,
      });
    }
  }
  return out;
}

export interface KeyConversionResult<T extends BindableRef> {
  /** Content with keys replaced by final numeric [n] markers. */
  content: string;
  /** References actually cited, reordered so position n-1 ↔ citation [n]. */
  citedRefs: T[];
  /** How many keyed citations were dropped (out-of-range / hallucinated). */
  droppedKeys: number;
  /** How many raw numeric [n] markers were stripped (format violations). */
  strippedNumeric: number;
}

/**
 * Convert keyed citations to numeric citations, numbered by order of first
 * appearance — the mechanical replacement for LLM-written numbers.
 *
 * Also:
 *   - strips raw numeric [n] markers the LLM wrote despite instructions
 *     (they are untrustable: we cannot know which reference was meant)
 *   - drops keyed citations pointing outside the reference list
 *   - repairs near-miss keys ({{ r1 }} → {{R1}}) before conversion
 *
 * @param content  Section/article body containing {{Rn}} markers
 * @param refs     The reference list the keys index into (1-based)
 */
export function convertKeysToNumbers<T extends BindableRef>(
  content: string,
  refs: T[]
): KeyConversionResult<T> {
  let working = content;

  // Pass 0: repair near-miss keys — {{ r2 }}, {{R 2}}, {{r7}} → {{R7}}
  working = working.replace(CITE_KEY_LOOSE_RE, (match) => {
    const nums = match.match(/(\d{1,3})/g);
    if (!nums || nums.length === 0) return match;
    const rs = nums.map((n) => `R${parseInt(n, 10)}`);
    return `{{${rs.join(",")}}}`;
  });

  // Pass 1: strip raw numeric [n] markers the LLM wrote against instructions
  // BEFORE key conversion — otherwise we would strip the numbers we are about
  // to create. We cannot map raw numbers to references reliably, so they are
  // removed rather than guessed at.
  let strippedNumeric = 0;
  working = working.replace(/\[(\d{1,3}(?:[,\-–]\s*\d{1,3})*)\]/g, () => {
    strippedNumeric++;
    return "";
  });

  // Pass 2: collect first-appearance order of VALID keys
  const appearanceOrder: number[] = [];
  const seen = new Set<number>();
  CITE_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_KEY_RE.exec(working))) {
    const nums = (m[0].match(/R(\d{1,3})/g) || []).map((t) => parseInt(t.slice(1), 10));
    for (const n of nums) {
      if (n >= 1 && n <= refs.length && !seen.has(n)) {
        seen.add(n);
        appearanceOrder.push(n);
      }
    }
  }

  // Map: old key index → new numeric citation (by first appearance)
  const oldToNew: Record<number, number> = {};
  appearanceOrder.forEach((oldNum, i) => {
    oldToNew[oldNum] = i + 1;
  });

  // Pass 3: replace every key marker with its numeric form
  let droppedKeys = 0;
  working = working.replace(CITE_KEY_RE, (match) => {
    const nums = (match.match(/R(\d{1,3})/g) || []).map((t) => parseInt(t.slice(1), 10));
    const newNums = nums
      .map((n) => oldToNew[n])
      .filter((n) => n !== undefined);
    if (newNums.length === 0) {
      droppedKeys++;
      return ""; // hallucinated key — remove entirely
    }
    // Dedupe within a single citation group: {{R5,R5}} → [5] not [5,5].
    // The LLM sometimes copies the same key twice in one bracket, which
    // would otherwise produce a meaningless [n,n] marker that looks like a
    // multi-citation but cites the same paper twice (and trips duplicate-
    // citation audit warnings downstream). Issue observed in E2E test
    // 2026-08-26: article cmt9f93jg00x4rewrmj0qpm75 contained [5,5].
    const unique = Array.from(new Set(newNums));
    unique.sort((a, b) => a - b); // ascending within a citation group
    return `[${unique.join(",")}]`;
  });

  // Pass 4: cleanup whitespace artifacts left by removals
  working = working
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();

  const citedRefs = appearanceOrder.map((oldNum) => refs[oldNum - 1]);
  return { content: working, citedRefs, droppedKeys, strippedNumeric };
}

/**
 * Adversarial-removal helper: given content that already contains NUMERIC
 * citations and the refs array they map to, remove the given citation
 * numbers everywhere and renumber the survivors by first appearance.
 *
 * Used by the adversarial verification pass: when a citation is judged
 * UNSUPPORTED with high confidence, we surgically remove it and renumber
 * so no gaps are left in the reference list.
 */
export function removeCitationsAndRenumber<T extends BindableRef>(
  content: string,
  refs: T[],
  removeNums: Set<number>
): { content: string; refs: T[] } {
  if (removeNums.size === 0) return { content, refs };

  const citeRe = /\[(\d{1,3}(?:[,\-–]\s*\d{1,3})*)\]/g;
  // Pass 1: strip removed numbers, collect surviving appearance order
  const appearanceOrder: number[] = [];
  const seen = new Set<number>();
  let stripped = content.replace(citeRe, (_match, inner: string) => {
    const nums = splitCitationInner(inner);
    const kept = nums.filter((n) => !removeNums.has(n));
    if (kept.length === 0) return "";
    for (const n of kept) {
      if (n >= 1 && n <= refs.length && !seen.has(n)) {
        seen.add(n);
        appearanceOrder.push(n);
      }
    }
    return `@@KEEP${kept.join(",")}@@`; // placeholder immune to re-matching
  });

  // Map old → new
  const oldToNew: Record<number, number> = {};
  appearanceOrder.forEach((oldNum, i) => {
    oldToNew[oldNum] = i + 1;
  });

  // Pass 2: rewrite placeholders with new numbers
  stripped = stripped.replace(/@@KEEP([\d,]+)@@/g, (_match, inner: string) => {
    const nums = inner.split(",").map((s) => parseInt(s, 10));
    const newNums = nums.map((n) => oldToNew[n]).filter((n) => n !== undefined);
    // Dedupe within citation group (defensive against [n,n] duplicates
    // that may already exist in the input being renumbered).
    const unique = Array.from(new Set(newNums));
    unique.sort((a, b) => a - b);
    return unique.length ? `[${unique.join(",")}]` : "";
  });

  // Pass 3: cleanup whitespace artifacts left by removals
  stripped = stripped
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n");

  const newRefs = appearanceOrder.map((oldNum) => refs[oldNum - 1]);
  return { content: stripped, refs: newRefs };
}

/** Split the inner text of a numeric citation into numbers ("1,3-4" → [1,3,4]). */
export function splitCitationInner(inner: string): number[] {
  const nums: number[] = [];
  for (const part of inner.split(/[,;]\s*/)) {
    const rm = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (rm) {
      const lo = Math.min(parseInt(rm[1], 10), parseInt(rm[2], 10));
      const hi = Math.max(parseInt(rm[1], 10), parseInt(rm[2], 10));
      const capped = Math.min(hi, lo + 49); // guard against [1-9999]
      for (let n = lo; n <= capped; n++) nums.push(n);
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n)) nums.push(n);
    }
  }
  return nums;
}

/**
 * Integrity gate (deepseek-harness-style validation between pipeline steps):
 * returns TRUE when the content is safe to save — every keyed citation is
 * in range, and no raw numeric citations leaked in.
 */
export function keyedCitationsAreValid(content: string, refCount: number): {
  ok: boolean;
  outOfRangeKeys: number;
  rawNumericMarkers: number;
  looseKeyTypos: number;
} {
  const valid = extractKeyedCitations(content);
  const outOfRangeKeys = valid.filter((c) => c.refIndex > refCount || c.refIndex < 1).length;
  const rawNumeric = (content.match(/\[\d{1,3}(?:[,\-–]\s*\d{1,3})*\]/g) || []).length;
  // loose keys that are NOT valid keys = typos like {{ r1 }} or {{R1,}}
  const looseCount = (content.match(CITE_KEY_LOOSE_RE) || []).length;
  CITE_KEY_RE.lastIndex = 0;
  const strictCount = (content.match(new RegExp(CITE_KEY_RE.source, "g")) || []).length;
  return {
    ok: outOfRangeKeys === 0 && rawNumeric === 0 && looseCount === strictCount,
    outOfRangeKeys,
    rawNumericMarkers: rawNumeric,
    looseKeyTypos: Math.max(0, looseCount - strictCount),
  };
}
