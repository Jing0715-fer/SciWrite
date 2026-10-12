/**
 * Compose-stage pure text transforms (RT9 route decomposition, seam 2).
 *
 * Extracted verbatim from api/ai/generate-full-v2/route.ts STEP 8 (compose)
 * and the translate stage's citation-drift check. Every function here is
 * PURE: string/array in → string/array out, no SSE, no DB, no stats object
 * — counters are RETURNED so the caller keeps owning observability. The
 * regexes are preserved exactly per call-site (note: the renumber pass and
 * the translate-drift check use a marker regex WITHOUT \s in the separator
 * class, while the OOR strip / orphan remap / cited scan use one WITH \s —
 * both behaviors are load-bearing; see the per-function notes).
 *
 * Having these in lib means the compose pipeline's mechanical core is now
 * unit-testable directly (tests/unit/compose-transforms.test.ts) — the
 * 5.4K-line route previously had ZERO direct test coverage.
 */

/* ------------------------------------------------------------------ *
 * Shared citation-marker parsing
 * ------------------------------------------------------------------ */

/**
 * Expand the inner text of a citation marker ("1,3-5" / "1; 4" / "2–4") into
 * the flat list of numbers it denotes. Shared by every marker pass: the
 * renumber map, the OOR strip, the orphan remap, and the translate drift
 * check. Ranges are inclusive; non-numbers yield nothing.
 */
export function expandCitationNumbers(inner: string): number[] {
  return inner
    .split(/[,;]\s*/)
    .flatMap((s: string) => {
      const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rm) {
        const arr: number[] = [];
        for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) arr.push(n);
        return arr;
      }
      const n = parseInt(s);
      return isNaN(n) ? [] : [n];
    });
}

/** Marker regex WITHOUT \s separators — local (per-section) markers. */
const LOCAL_CITE_RE = /\[(\d+(?:[,\-–]\s*\d+)*)\]/g;
/** Marker regex WITH \s separators — post-compose global markers. */
const GLOBAL_CITE_RE = /\[(\d+(?:[,\-–\s]\d+)*)\]/g;

/* ------------------------------------------------------------------ *
 * STEP 8 — global renumbering
 * ------------------------------------------------------------------ */

/**
 * Renumber one section's LOCAL citation markers ([n] indexing that
 * section's own reference rows) into GLOBAL numbers, assigning each
 * distinct reference identity (type:externalId|title) a new global slot
 * on first sight. `globalRefMap` and `globalRefs` are caller-owned
 * accumulators mutated across sections — the route initializes both once
 * and maps all sections through this function.
 *
 * Also merges adjacent bracket pairs ("[3][14]" → "[3,14]", chained) AFTER
 * renumbering so merged numbers are final (round-15) and returns the merge
 * count so the caller can bump `stats.adjacentCitationsMerged`. A marker
 * whose local numbers all resolve to nothing is dropped from the text
 * ("return \"\"" inside the replace — preserved behavior).
 */
export function renumberSectionContent(
  content: string,
  refs: any[],
  globalRefMap: Map<string, number>,
  globalRefs: any[]
): { content: string; adjacentMerges: number } {
  let result = content;
  const citeRe = LOCAL_CITE_RE;
  result = result.replace(citeRe, (_match, inner: string) => {
    const nums = expandCitationNumbers(inner);
    const globalNums = nums
      .map((localNum: number) => {
        if (localNum < 1 || localNum > refs.length) return null;
        const ref = refs[localNum - 1];
        if (!ref) return null;
        const key = `${(ref.type || "").toLowerCase()}:${(ref.externalId || ref.title || "").toLowerCase()}`;
        if (!globalRefMap.has(key)) {
          const globalNum = globalRefs.length + 1;
          globalRefMap.set(key, globalNum);
          globalRefs.push(ref);
        }
        return globalRefMap.get(key)!;
      })
      .filter(Boolean) as number[];
    if (globalNums.length === 0) return "";
    globalNums.sort((a, b) => a - b);
    return `[${globalNums.join(",")}]`;
  });
  // ★ round-15: normalize adjacent bracket pairs. The LLM sometimes emits
  // two separate citation markers back-to-back ("[3][14]" — user-reported
  // format inconsistency). Merge them into the canonical comma form,
  // chained ([1][2][3] → [1,2,3]), AFTER global renumbering so the merged
  // numbers are final.
  let adjacentMerges = 0;
  let prevMerged = "";
  while (prevMerged !== result) {
    prevMerged = result;
    result = result.replace(/\[(\d+(?:,\d+)*)\]\s*\[(\d+(?:,\d+)*)\]/g, (_m, a: string, b: string) => `[${a},${b}]`);
    if (result !== prevMerged) adjacentMerges++;
  }
  return { content: result, adjacentMerges };
}

/* ------------------------------------------------------------------ *
 * STEP 8 — out-of-range strip (round-57 P2-1)
 * ------------------------------------------------------------------ */

/**
 * Mechanically drop any citation number outside 1..maxGlobal from its
 * marker (valid numbers in the same marker are kept; a fully-invalid
 * marker disappears). Runs unconditionally BEFORE the orphan-ref filter
 * so a stray LLM marker like [21] with only 20 refs can't survive into
 * the final article pointing at nothing.
 */
export function stripOutOfRangeCitations(body: string, maxGlobal: number): { body: string; stripped: number } {
  let stripped = 0;
  const oorRe = GLOBAL_CITE_RE;
  const out = body.replace(oorRe, (match, inner: string) => {
    const nums = expandCitationNumbers(inner);
    const valid = nums.filter((n: number) => n >= 1 && n <= maxGlobal);
    if (valid.length === nums.length) return match;
    stripped += nums.length - valid.length;
    if (valid.length === 0) return "";
    return `[${valid.sort((a, b) => a - b).join(",")}]`;
  });
  return { body: out, stripped };
}

/* ------------------------------------------------------------------ *
 * STEP 8 — orphan-reference filter + remap
 * ------------------------------------------------------------------ */

/** Scan a body for every citation number it uses (global marker form). */
export function scanCitedNumbers(body: string): Set<number> {
  const set = new Set<number>();
  const re = GLOBAL_CITE_RE;
  let m;
  while ((m = re.exec(body)) !== null) {
    for (const n of expandCitationNumbers(m[1])) set.add(n);
  }
  return set;
}

/**
 * Keep only references actually cited in the body and renumber the
 * survivors 1..N (compacting gaps left by dropped orphans). Returns the
 * compacted reference array and the old→new number map; when nothing is
 * orphaned the body is returned UNTOUCHED (the replace pass is skipped —
 * preserved from the route's `filteredRefs.length < globalRefs.length`
 * guard) and keptRefs === a same-length copy.
 */
export function filterOrphanedReferences(
  body: string,
  globalRefs: any[]
): { body: string; keptRefs: any[]; refNumberMap: Map<number, number> } {
  const citedInBody = scanCitedNumbers(body);
  const filteredRefs = globalRefs.filter((_, i) => citedInBody.has(i + 1));
  const refNumberMap = new Map<number, number>();
  if (filteredRefs.length >= globalRefs.length) {
    return { body, keptRefs: globalRefs.slice(), refNumberMap };
  }
  // Build the object-identity → index map once (indexOf inside the loop
  // below was O(n²) with object identity).
  const globalIndex = new Map(globalRefs.map((r, i) => [r, i] as const));
  filteredRefs.forEach((r, i) => {
    const gi = globalIndex.get(r);
    if (gi !== undefined) refNumberMap.set(gi + 1, i + 1);
  });
  const citeScanRe = GLOBAL_CITE_RE;
  const remapped = body.replace(citeScanRe, (_match, inner: string) => {
    const nums = expandCitationNumbers(inner);
    const newNums = nums.map((n: number) => refNumberMap.get(n)).filter(Boolean) as number[];
    if (newNums.length === 0) return "";
    newNums.sort((a, b) => a - b);
    return `[${newNums.join(",")}]`;
  });
  return { body: remapped, keptRefs: filteredRefs, refNumberMap };
}

/* ------------------------------------------------------------------ *
 * Reference list formatting (EN + ZH — identical shape, one impl)
 * ------------------------------------------------------------------ */

/**
 * Format the final reference list. The EN (STEP 8) and ZH (translate
 * stage) builders were character-identical modulo the header the caller
 * prepends — one implementation now. Blank line between entries
 * (round-cs-6: single "\n" joins render as ONE merged paragraph in most
 * markdown viewers — user-reported "没有被正确markdown渲染"). A URL-only
 * or missing author is rendered as "Anonymous" (avoiding "www.ncbi.nlm…
 * (2023)" style garbage in the citation line).
 */
export function buildReferenceList(refs: any[]): string {
  return refs
    .map((r, i) => {
      let auth = (r.authors || "").trim();
      if (!auth || /^(https?:\/\/)?(www\.)?[a-z0-9.-]+\.(gov|org|com|edu|net)$/i.test(auth)) {
        auth = "Anonymous";
      }
      const yr = r.year ? ` (${r.year})` : "";
      const jour = r.journal ? `, ${r.journal}` : "";
      const url = r.url ? ` — ${r.url}` : "";
      return `[${i + 1}] ${auth}${yr}${jour}. ${r.title || "Untitled"}.${url}`;
    })
    .join("\n\n");
}

/* ------------------------------------------------------------------ *
 * Translate stage — bilingual citation-drift check
 * ------------------------------------------------------------------ */

/**
 * Extract the set of citation numbers a text uses, in the LOCAL marker
 * form (no \s separator — the same regex the translate stage used). The
 * Chinese section must cite exactly the same global numbers as the
 * English one; a drift is logged by the caller but kept non-fatal.
 */
export function citationNumbersOf(s: string): Set<number> {
  const set = new Set<number>();
  const re = LOCAL_CITE_RE;
  let m;
  while ((m = re.exec(s)) !== null) {
    for (const n of expandCitationNumbers(m[1])) set.add(n);
  }
  return set;
}
