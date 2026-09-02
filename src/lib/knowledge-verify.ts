/**
 * knowledge-verify.ts — LLM-knowledge cross-check for gathered data sources.
 *
 * WHY (round-33, user feedback: "数据收集好像会存在遗漏，收集到的数据源还需要
 * 结合LLM本身的知识进行确认和评估，尽量补全缺失的信息"):
 *   The gather stage only knows what the databases/web returned. Two classes
 *   of gaps survive it:
 *     1. MISSING METADATA — a real paper saved with a title but no
 *        authors/year/journal (common for RCSB entries and thin web results),
 *        which weakens evidence analysis and citation binding.
 *     2. MISSING SOURCES — landmark/seminal papers the searches didn't
 *        surface (queries missed them), leaving coverage gaps in the article.
 *
 *   This module adds a post-gather stage that uses the LLM's OWN domain
 *   knowledge to close both:
 *     Stage A  verifySourcesWithKnowledge — show the LLM the gathered
 *              sources with explicit "MISSING" markers on empty fields; it
 *              fills ONLY the missing fields (never overwrites real
 *              database data) and reports which sources it actually
 *              recognizes.
 *     Stage B  verifyMissingViaPubMed — for each important source the LLM
 *              says is absent from the set, look it up in PubMed BY TITLE.
 *              Only matches with a real PubMed record become citable
 *              references (full real metadata + PMID); unmatched
 *              suggestions are saved as flagged data sources for the user
 *              to review but NEVER enter the citable reference pool —
 *              hallucinated citations are the one failure mode this app
 *              must structurally prevent (see the INVALID-CITATION history).
 *
 *   Integrity rules:
 *     - existing non-null fields are never touched (fill-gaps-only policy)
 *     - completions are capped in length and stripped of control chars
 *     - proposed sources need a PubMed title match (normalized similarity
 *       ≥ 0.72) before they can be cited
 */

import { chatWithSession } from "@/lib/llm-session";
import { queryDatabase, fetchPubMedSummaries, searchCrossref, lookupCrossrefDoi } from "@/lib/databases";
import { safeParseJSON } from "@/lib/generate-full-helpers";

export interface KVSourceInput {
  /** DB id of the saved data source (used to apply patches). */
  id: string;
  source: string;
  externalId?: string | null;
  title: string;
  authors?: string | null;
  year?: string | null;
  journal?: string | null;
  doi?: string | null;
  abstract?: string | null;
}

export interface KVCompletion {
  /** 1-based index into the input sources array. */
  index: number;
  /** Whether the LLM recognizes this specific work. */
  known: boolean;
  /** Fill values for fields that were MISSING in the input. */
  fill: {
    authors?: string;
    year?: string;
    journal?: string;
  };
  confidence: number;
}

export interface KVMissingSource {
  title: string;
  authors?: string;
  year?: string;
  journal?: string;
  doi?: string;
  pmid?: string;
  reason: string;
  kind: "landmark" | "review" | "method" | "database" | "contradicting";
}

export interface KnowledgeVerifyResult {
  completions: KVCompletion[];
  missing: KVMissingSource[];
}

const FILLABLE_FIELDS = ["authors", "year", "journal"] as const;
type FillField = (typeof FILLABLE_FIELDS)[number];
// NOTE: "doi" is deliberately NOT fillable. E2E on the MscL/MscS project
// showed the LLM fills plausible-but-WRONG DOIs (a FEBS Lett 2002 paper got
// an Annual Reviews DOI; a Nature structure paper got a Science DOI).
// DOIs are machine-checkable identifiers — a wrong one is worse than none.
// (Real DOIs arrive via database gather or the reference-enrich flow.)

/**
 * Values that are placeholders, not data. Round-35 audit found the LLM
 * echoing the prompt's "[journal=MISSING]" sentinel straight back — that
 * landed as journal="MISSING" in the DB (cleanFill only rejected
 * unknown/n/a/none). Reject every sentinel-ish string, case-insensitive,
 * including punctuation-wrapped variants.
 */
const SENTINEL_VALUES = new Set([
  "missing", "missng", "unknown", "n/a", "na", "none", "null", "nil",
  "not available", "not applicable", "not known", "unavailable", "no data",
  "no record", "tbd", "uncertain", "-", "—", "?", "??",
]);

/** Sanitize a single LLM-provided fill value. Returns null when unusable. */
function cleanFill(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  let v = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!v) return null;
  // The prompt marks gaps with [field=MISSING]; the LLM sometimes wraps
  // echoes in quotes or trailing periods before/after the sentinel.
  // r37 fix: it ALSO echoes the bracketed/prefixed sentinel itself —
  // "[journal=MISSING]" or "(journal=MISSING)". Strip wrapper brackets
  // and an optional "field=" prefix before the sentinel test, or the
  // literal sentinel string gets written to the DB (verified: the round-35
  // bare check passed "[journal=MISSING]" straight through).
  v = v.replace(/^["'`]([\s\S]*)["'`]$/, "$1").replace(/[.\s]+$/, "").trim();
  const bare = v
    .toLowerCase()
    .replace(/^[\[(]\s*/, "")
    .replace(/[\])]$/, "")
    .replace(/^[a-z]+\s*=\s*/, "")
    .replace(/[.:;]+$/, "")
    .trim();
  if (SENTINEL_VALUES.has(bare)) return null;
  if (!v) return null;
  return v.slice(0, maxLen);
}

function validFill(field: FillField, value: string): boolean {
  switch (field) {
    case "year":
      return /^(19|20)\d{2}$/.test(value);
    case "authors":
      return value.length >= 3 && value.length <= 400;
    case "journal":
      return value.length >= 2 && value.length <= 200;
  }
}

/**
 * Stage A — ask the LLM to (1) confirm/recognize each gathered source and
 * fill its missing metadata from its own knowledge, and (2) name the
 * important sources for this topic that are ABSENT from the gathered set.
 *
 * Sources are processed in batches of ~12 so outputs stay parseable. Every
 * batch is asked for missing-source suggestions; suggestions are deduped
 * across batches (by normalized title) and against already-gathered titles.
 */
export async function verifySourcesWithKnowledge(
  projectId: string,
  sources: KVSourceInput[],
  topic: string,
  field: string,
  opts: { batchSize?: number; maxMissing?: number; maxTokens?: number; onLog?: (msg: string) => void } = {}
): Promise<KnowledgeVerifyResult> {
  const batchSize = opts.batchSize ?? 12;
  const maxMissing = opts.maxMissing ?? 8;
  const log = opts.onLog || (() => {});

  const completions: KVCompletion[] = [];
  const missingRaw: KVMissingSource[] = [];
  const gatheredTitleKeys = new Set(
    sources.map((s) => normalizeTitle(s.title)).filter(Boolean)
  );

  const system = `You are a domain expert librarian cross-checking a gathered source list for a research article on: ${topic} (${field}).
You have TWO jobs:
1. METADATA COMPLETION — for each source, some fields are marked MISSING. Fill a MISSING field ONLY if you are confident you know the correct value for THIS SPECIFIC work from your training knowledge. Never invent plausible-looking guesses — if unsure, leave it empty. NEVER provide a value for a field that is not marked MISSING.
2. GAP DETECTION — using your knowledge of the field, name the most IMPORTANT works (landmark papers, key reviews, seminal methods, key database entries, or contradicting evidence) that are ABSENT from this list. Only suggest works you are confident actually exist.`;

  for (let b = 0; b < sources.length; b += batchSize) {
    const batch = sources.slice(b, b + batchSize);
    // round-35: rows whose three fillable fields are ALL complete get a
    // single compact line — the LLM has nothing to fill for them, they only
    // matter for gap detection. Rows with gaps keep the detailed
    // MISSING-marked form. This roughly halves prompt tokens on mature
    // projects and focuses the model on the rows that need work.
    const list = batch
      .map((s, j) => {
        const marks = (f: string, v?: string | null) =>
          v && String(v).trim() ? ` [${f}=${String(v).slice(0, 160)}]` : ` [${f}=MISSING]`;
        const complete =
          s.authors && String(s.authors).trim() &&
          s.year && String(s.year).trim() &&
          s.journal && String(s.journal).trim();
        if (complete) {
          return `(${b + j + 1}) (${s.source}${s.externalId ? ":" + s.externalId : ""}) TITLE: ${s.title.slice(0, 200)} [complete]`;
        }
        return (
          `(${b + j + 1}) (${s.source}${s.externalId ? ":" + s.externalId : ""}) ` +
          `TITLE: ${s.title.slice(0, 200)}` +
          marks("authors", s.authors) +
          marks("year", s.year) +
          marks("journal", s.journal)
        );
      })
      .join("\n");

    const prompt = `TOPIC: ${topic}

GATHERED SOURCES (batch ${Math.floor(b / batchSize) + 1} of ${Math.ceil(sources.length / batchSize)}):
${list}

Respond as STRICT JSON only:
{
  "sources": [
    { "n": 1, "known": true, "authors": "", "year": "", "journal": "", "confidence": 0.0 }
  ],
  "missing": [
    { "title": "...", "authors": "...", "year": "...", "journal": "...", "doi": "...", "pmid": "...", "reason": "why this work is essential for THIS topic", "kind": "landmark|review|method|database|contradicting" }
  ]
}
Rules:
- "n" is the (number) from the list above.
- Include ONLY fields you are filling (omit empty ones). Only fill fields marked MISSING (authors, year, journal).
- "known": whether you recognize this specific work (true/false).
- "confidence": your confidence in the fills (0.0-1.0).
- "missing": up to 4 most-important absent works for this batch's view of the topic. Only works that truly exist. Include doi/pmid there when you know them (they will be verified against PubMed before use).
Output JSON only.`;

    try {
      const raw = await chatWithSession(projectId, prompt, {
        system,
        temperature: 0.2,
        taskType: "gather",
        maxTokens: opts.maxTokens,
        metadata: { step: "knowledge-verify", batch: Math.floor(b / batchSize) + 1, sources: batch.length },
      });
      const parsed = safeParseJSON(raw, { sources: [], missing: [] });

      for (const s of parsed.sources || []) {
        const n = parseInt(String(s.n), 10);
        if (isNaN(n) || n < 1 || n > sources.length) continue;
        const fill: KVCompletion["fill"] = {};
        for (const f of FILLABLE_FIELDS) {
          // Fill ONLY if the original field was actually missing
          const orig = sources[n - 1][f];
          if (orig && String(orig).trim()) continue;
          const cleaned = cleanFill(s[f], f === "year" ? 4 : f === "authors" ? 400 : 200);
          if (cleaned && validFill(f, cleaned)) fill[f] = cleaned;
        }
        completions.push({
          index: n,
          known: Boolean(s.known),
          fill,
          confidence: Math.min(1, Math.max(0, Number(s.confidence) || 0)),
        });
      }

      for (const m of parsed.missing || []) {
        const title = cleanFill(m.title, 300);
        if (!title) continue;
        const key = normalizeTitle(title);
        if (!key || gatheredTitleKeys.has(key)) continue;
        gatheredTitleKeys.add(key);
        missingRaw.push({
          title,
          authors: cleanFill(m.authors, 400) || undefined,
          year: cleanFill(m.year, 4) || undefined,
          journal: cleanFill(m.journal, 200) || undefined,
          doi: cleanFill(m.doi, 80) || undefined,
          pmid: cleanFill(m.pmid, 12) || undefined,
          reason: cleanFill(m.reason, 300) || "important for the topic",
          kind: (["landmark", "review", "method", "database", "contradicting"].includes(m.kind)
            ? m.kind
            : "landmark") as KVMissingSource["kind"],
        });
      }
    } catch (err: any) {
      const errMsg = String(err?.message ?? err);
      log(`knowledge-verify: batch ${Math.floor(b / batchSize) + 1} failed: ${errMsg.slice(0, 120)}`);
      // Fail fast on process-wide aborts (429-quota / aborted-flag): trying
      // the remaining batches just produces a wall of identical errors.
      if (/previous call aborted|quota exhausted|daily quota/i.test(errMsg)) {
        const remaining = Math.ceil((sources.length - b) / batchSize) - 1;
        if (remaining > 0) {
          log(`knowledge-verify: LLM unavailable — skipping ${remaining} remaining batch(es); database backfill is already applied`);
        }
        break;
      }
    }
  }

  // Keep the most-varied top suggestions (interleave kinds when possible)
  const missing = pickDiverse(missingRaw, maxMissing);
  return { completions, missing };
}

/** Pick up to `max` suggestions with a spread across kinds (landmarks first). */
function pickDiverse(list: KVMissingSource[], max: number): KVMissingSource[] {
  if (list.length <= max) return list;
  const byKind = new Map<string, KVMissingSource[]>();
  for (const m of list) {
    const arr = byKind.get(m.kind) || [];
    arr.push(m);
    byKind.set(m.kind, arr);
  }
  const order = ["landmark", "review", "method", "contradicting", "database"];
  const out: KVMissingSource[] = [];
  let added = true;
  while (out.length < max && added) {
    added = false;
    for (const k of order) {
      if (out.length >= max) break;
      const arr = byKind.get(k);
      if (arr && arr.length) {
        out.push(arr.shift()!);
        added = true;
      }
    }
  }
  return out;
}

/** Lowercased, de-punctuated title key for fuzzy identity comparison. */
export function normalizeTitle(title: string): string {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token-Jaccard-ish similarity on normalized titles (0..1). */
function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeTitle(a).split(" ").filter((w) => w.length > 2));
  const tb = new Set(normalizeTitle(b).split(" ").filter((w) => w.length > 2));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

export interface VerifiedMissingItem {
  /** Full item shaped like a gather result — safe to save + cite. */
  item: {
    source: string;
    externalId: string;
    title: string;
    authors?: string;
    year?: string;
    journal?: string;
    doi?: string;
    url?: string;
    abstract?: string;
    extra: Record<string, any>;
    gatherMethod: string;
    reason: string;
    kind: string;
  };
  suggestion: KVMissingSource;
  similarity: number;
}

/**
 * Stage B — try to confirm each LLM-suggested missing source in PubMed.
 * A suggestion with a normalized-title match (similarity ≥ 0.72) against a
 * real PubMed record becomes a citable item carrying PubMed's metadata.
 * Everything else stays a flagged, non-citable suggestion.
 */
export async function verifyMissingViaPubMed(
  missing: KVMissingSource[],
  opts: { onLog?: (msg: string) => void; minSimilarity?: number } = {}
): Promise<{ verified: VerifiedMissingItem[]; unverified: KVMissingSource[] }> {
  // (round-35: see verifyMissingViaCrossref below for the second channel)
  const log = opts.onLog || (() => {});
  const minSim = opts.minSimilarity ?? 0.72;
  const verified: VerifiedMissingItem[] = [];
  const unverified: KVMissingSource[] = [];
  // Two different suggestion titles can fuzzy-match the SAME PubMed record
  // (E2E finding: "Bacterial Mechanosensitive Channels" suggested twice in
  // different batches, both resolving to PMID 29464558). Claim each PMID once.
  const claimedExtIds = new Set<string>();

  for (const suggestion of missing) {
    try {
      // round-50: title-exact-match verification — variant expansion would
      // manufacture false positives (a "TMC-1" paper matching a "TMC1"
      // suggestion title is NOT the same as a title match), and the LLM
      // relevance filter would fight the titleSimilarity gate below. Opt out.
      const res = await queryDatabase("pubmed", suggestion.title.slice(0, 180), {
        searchOpts: { expandVariants: false, filterByLlm: false },
      });
      const items: any[] = res.items || [];
      let best: { item: any; sim: number } | null = null;
      for (const item of items) {
        const sim = titleSimilarity(suggestion.title, item.title || "");
        if (!best || sim > best.sim) best = { item, sim };
      }
      if (best && best.sim >= minSim && best.item?.externalId) {
        const extId = String(best.item.externalId);
        if (claimedExtIds.has(extId)) {
          log(`knowledge-verify: "${suggestion.title.slice(0, 50)}" resolves to already-claimed PMID ${extId} — skipped`);
          continue;
        }
        claimedExtIds.add(extId);
        const it = best.item;
        verified.push({
          item: {
            source: "pubmed",
            externalId: extId,
            title: it.title || suggestion.title,
            authors: it.authors || suggestion.authors,
            year: it.year || suggestion.year,
            journal: it.journal || suggestion.journal,
            doi: it.doi || suggestion.doi,
            url: it.url,
            abstract: it.abstract,
            extra: {
              llmSuggested: true,
              llmKind: suggestion.kind,
              llmReason: suggestion.reason,
              matchSimilarity: Math.round(best.sim * 100) / 100,
            },
            gatherMethod: "llm-knowledge-verified",
            reason: suggestion.reason,
            kind: suggestion.kind,
          },
          suggestion,
          similarity: best.sim,
        });
        log(`knowledge-verify: "${suggestion.title.slice(0, 50)}" confirmed in PubMed (PMID ${it.externalId}, sim ${best.sim.toFixed(2)})`);
      } else {
        unverified.push(suggestion);
        log(
          `knowledge-verify: "${suggestion.title.slice(0, 50)}" NOT found in PubMed (best sim ${best ? best.sim.toFixed(2) : "0"}) — saved as unverified suggestion`
        );
      }
    } catch (err: any) {
      unverified.push(suggestion);
      log(`knowledge-verify: PubMed lookup failed for "${suggestion.title.slice(0, 50)}": ${String(err?.message ?? err).slice(0, 100)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return { verified, unverified };
}

/**
 * Apply Stage-A completions to the saved data-source rows AND their
 * reference twins. Fill-gaps-only: a field is written only when the current
 * DB value is empty. Returns per-field applied counts (for the SSE step
 * message) and patches the in-memory arrays so downstream stages (curate)
 * see the completed metadata.
 */
export async function applyKnowledgeCompletions(
  projectId: string,
  dataSources: { id: string; source: string; externalId?: string | null; title?: string | null; authors?: string | null; year?: string | null; journal?: string | null; doi?: string | null }[],
  references: { id: string; externalId?: string | null; title?: string | null; authors?: string | null; year?: string | null; journal?: string | null; doi?: string | null }[],
  completions: KVCompletion[],
  db: { dataSource: { update: (a: any) => Promise<any> }; reference: { update: (a: any) => Promise<any> } },
  opts: { minConfidence?: number; onLog?: (msg: string) => void } = {}
): Promise<{ fieldsCompleted: number; sourcesCompleted: number; byField: Record<string, number> }> {
  const log = opts.onLog || (() => {});
  const minConfidence = opts.minConfidence ?? 0.5;

  // Reference lookup by externalId, then by normalized title
  const refByExtId = new Map<string, any>();
  const refByTitle = new Map<string, any[]>();
  for (const r of references) {
    if (r.externalId) refByExtId.set(String(r.externalId), r);
    const key = normalizeTitle(r.title || "");
    if (key) {
      const arr = refByTitle.get(key) || [];
      arr.push(r);
      refByTitle.set(key, arr);
    }
  }

  let fieldsCompleted = 0;
  let sourcesCompleted = 0;
  const byField: Record<string, number> = {};

  for (const c of completions) {
    if (c.confidence < minConfidence) continue;
    const ds = dataSources[c.index - 1];
    if (!ds || !Object.keys(c.fill || {}).length) continue;

    const dsPatch: Record<string, string> = {};
    for (const f of FILLABLE_FIELDS) {
      const fillValue = c.fill[f];
      if (!fillValue) continue;
      const current = ds[f];
      if (current && String(current).trim()) continue; // fill-gaps-only
      dsPatch[f] = fillValue;
      byField[f] = (byField[f] || 0) + 1;
      fieldsCompleted++;
    }
    if (!Object.keys(dsPatch).length) continue;

    // Provenance: merge an llmFilled field-list into extra so every LLM-filled
    // value stays distinguishable from database-sourced data.
    const extraPatch = (() => {
      try {
        const cur = (ds as any).extra ? JSON.parse(String((ds as any).extra)) : {};
        const prevList: string[] = Array.isArray(cur.llmFilled) ? cur.llmFilled : [];
        cur.llmFilled = [...new Set([...prevList, ...Object.keys(dsPatch)])];
        return JSON.stringify(cur);
      } catch {
        return JSON.stringify({ llmFilled: Object.keys(dsPatch) });
      }
    })();

    try {
      await db.dataSource.update({
        where: { id: ds.id },
        data: { ...dsPatch, extra: extraPatch },
      });
      Object.assign(ds, dsPatch, { extra: extraPatch });
      // Mirror onto the matching reference record
      const ref =
        (ds.externalId && refByExtId.get(String(ds.externalId))) ||
        (refByTitle.get(normalizeTitle(ds.title || "")) || [])[0];
      if (ref) {
        const refPatch: Record<string, string> = {};
        for (const [k, v] of Object.entries(dsPatch)) {
          if (!ref[k] || !String(ref[k]).trim()) {
            refPatch[k] = v;
            ref[k] = v;
          }
        }
        if (Object.keys(refPatch).length) {
          await db.reference.update({ where: { id: ref.id }, data: refPatch });
        }
      }
      sourcesCompleted++;
      log(
        `knowledge-verify: completed [${Object.keys(dsPatch).join(", ")}] for "${String(ds.title).slice(0, 50)}"`
      );
    } catch (err: any) {
      log(`knowledge-verify: apply failed for "${String(ds.title).slice(0, 50)}": ${String(err?.message ?? err).slice(0, 100)}`);
    }
  }

  return { fieldsCompleted, sourcesCompleted, byField };
}

/* ==================== round-35 additions ==================== */

/**
 * Authoritative metadata backfill — runs BEFORE the LLM pass.
 *
 * A source saved from PubMed carries its PMID in externalId; when fields
 * went missing (thin esummary rows, older saving paths), PubMed's OWN
 * record for that PMID is ground truth — filling from it has zero
 * hallucination risk, unlike LLM fills. After this pass the LLM only sees
 * the gaps no database can close (web-scraped rows, registry misses).
 *
 * Also repairs the two systematic web-gather defects found in the round-35
 * audit of real project data:
 *   - authors holding the website DOMAIN ("www.nature.com") — not a person;
 *   - year holding a month fragment ("Jul ") from date.slice(0, 4).
 * Those strings are non-empty so fill-gaps-only passes skipped them forever;
 * here they are treated as garbage and reset so they can be refilled.
 */
const GARBAGE_AUTHORS =
  /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i; // bare domain-ish string
const GARBAGE_YEAR = /^(19|20)\d{2}$/;

export function looksLikeDomain(value?: string | null): boolean {
  if (!value) return false;
  const v = String(value).trim();
  if (/\s/.test(v)) return false; // domains never contain whitespace
  return GARBAGE_AUTHORS.test(v);
}

export function isValidYear(value?: string | null): boolean {
  const v = String(value || "").trim();
  return GARBAGE_YEAR.test(v);
}

export async function backfillFromExternalIds(
  projectId: string,
  dataSources: { id: string; source: string; externalId?: string | null; title?: string | null; authors?: string | null; year?: string | null; journal?: string | null; doi?: string | null; extra?: string | null }[],
  references: { id: string; externalId?: string | null; title?: string | null; authors?: string | null; year?: string | null; journal?: string | null; doi?: string | null }[],
  db: { dataSource: { update: (a: any) => Promise<any> }; reference: { update: (a: any) => Promise<any> } },
  opts: { onLog?: (msg: string) => void } = {}
): Promise<{ fieldsCompleted: number; sourcesCompleted: number; repairedGarbage: number; byField: Record<string, number> }> {
  const log = opts.onLog || (() => {});

  // Reset garbage values in-memory AND in the DB so fill-gaps-only passes
  // (this one and the LLM one after it) can repair them.
  let repairedGarbage = 0;
  for (const ds of dataSources) {
    const patch: Record<string, null> = {};
    if (looksLikeDomain(ds.authors)) patch.authors = null;
    if (ds.year && !isValidYear(ds.year)) patch.year = null;
    if (ds.journal && SENTINEL_VALUES.has(String(ds.journal).toLowerCase().replace(/[.:;]+$/, "").trim())) patch.journal = null;
    if (Object.keys(patch).length) {
      try {
        await db.dataSource.update({ where: { id: ds.id }, data: patch });
        Object.assign(ds, patch);
        repairedGarbage++;
        log(`backfill: reset garbage metadata (${Object.keys(patch).join(", ")}) on "${String(ds.title).slice(0, 50)}"`);
      } catch { /* non-fatal */ }
    }
  }

  // Collect PMID-backed rows with remaining gaps
  const needs = dataSources.filter(
    (ds) =>
      ds.source === "pubmed" &&
      ds.externalId &&
      /^\d{1,9}$/.test(String(ds.externalId)) &&
      (!ds.authors || !ds.year || !ds.journal || !ds.doi)
  );
  if (!needs.length) return { fieldsCompleted: 0, sourcesCompleted: 0, repairedGarbage, byField: {} };

  const summaries = await fetchPubMedSummaries(needs.map((ds) => String(ds.externalId)));
  log(`backfill: PubMed summaries fetched for ${summaries.size}/${needs.length} PMID-backed rows`);

  // Reference lookup mirrors applyKnowledgeCompletions
  const refByExtId = new Map<string, any>();
  const refByTitle = new Map<string, any[]>();
  for (const r of references) {
    if (r.externalId) refByExtId.set(String(r.externalId), r);
    const key = normalizeTitle(r.title || "");
    if (key) {
      const arr = refByTitle.get(key) || [];
      arr.push(r);
      refByTitle.set(key, arr);
    }
  }

  let fieldsCompleted = 0;
  let sourcesCompleted = 0;
  const byField: Record<string, number> = {};

  for (const ds of needs) {
    const sum = summaries.get(String(ds.externalId));
    if (!sum) continue;
    const patch: Record<string, string> = {};
    if (!ds.authors && sum.authors) { patch.authors = sum.authors.slice(0, 400); }
    if (!ds.year && sum.year) { patch.year = sum.year; }
    if (!ds.journal && sum.journal) { patch.journal = sum.journal.slice(0, 200); }
    if (!ds.doi && sum.doi) { patch.doi = sum.doi.slice(0, 120); }
    if (!Object.keys(patch).length) continue;

    const extraPatch = (() => {
      try {
        const cur = ds.extra ? JSON.parse(String(ds.extra)) : {};
        const prevList: string[] = Array.isArray(cur.dbFilled) ? cur.dbFilled : [];
        cur.dbFilled = [...new Set([...prevList, ...Object.keys(patch)])];
        return JSON.stringify(cur);
      } catch {
        return JSON.stringify({ dbFilled: Object.keys(patch) });
      }
    })();

    try {
      await db.dataSource.update({
        where: { id: ds.id },
        data: { ...patch, extra: extraPatch },
      });
      Object.assign(ds, patch, { extra: extraPatch });
      // Mirror to the reference twin (fill-gaps-only there too)
      const ref =
        (ds.externalId && refByExtId.get(String(ds.externalId))) ||
        (refByTitle.get(normalizeTitle(ds.title || "")) || [])[0];
      if (ref) {
        const refPatch: Record<string, string> = {};
        for (const [k, v] of Object.entries(patch)) {
          if (!ref[k] || !String(ref[k]).trim()) refPatch[k] = v;
        }
        if (Object.keys(refPatch).length) {
          await db.reference.update({ where: { id: ref.id }, data: refPatch });
        }
      }
      for (const k of Object.keys(patch)) byField[k] = (byField[k] || 0) + 1;
      fieldsCompleted += Object.keys(patch).length;
      sourcesCompleted++;
      log(`backfill: PMID ${ds.externalId} completed [${Object.keys(patch).join(", ")}] for "${String(ds.title).slice(0, 50)}"`);
    } catch (err: any) {
      log(`backfill: apply failed for "${String(ds.title).slice(0, 50)}": ${String(err?.message ?? err).slice(0, 100)}`);
    }
  }

  return { fieldsCompleted, sourcesCompleted, repairedGarbage, byField };
}

/**
 * Stage B' — Crossref, the SECOND verification channel (round-35).
 *
 * Suggestions that PubMed's title search could not confirm are not
 * necessarily hallucinations: PubMed indexes biomed journals only, so
 * preprints, non-indexed journals, and much older landmark work fall
 * through. Crossref registers DOIs for ~160M works across all disciplines,
 * so we re-try each unconfirmed suggestion there:
 *   1. If the suggestion carries a claimed DOI (extra llmDoi path), resolve
 *      it in the Crossref registry and title-match the result — a match
 *      means the LLM's DOI claim was actually right, and the registry's
 *      metadata is authoritative (real DOI, real journal, real year).
 *   2. Otherwise (or when the DOI resolves to a different work) do a
 *      bibliographic title search and pick the best normalized-title match.
 *
 * Only matches at the same ≥0.72 similarity bar as the PubMed channel
 * become citable; the rest stay unverified. DOI-level dedup guards two
 * suggestions resolving to the same registered work.
 */
export async function verifyMissingViaCrossref(
  missing: KVMissingSource[],
  opts: { onLog?: (msg: string) => void; minSimilarity?: number } = {}
): Promise<{ verified: VerifiedMissingItem[]; unverified: KVMissingSource[] }> {
  const log = opts.onLog || (() => {});
  const minSim = opts.minSimilarity ?? 0.72;
  const verified: VerifiedMissingItem[] = [];
  const unverified: KVMissingSource[] = [];
  const claimedDois = new Set<string>();

  for (const suggestion of missing) {
    let matched: { item: any; sim: number; via: "doi" | "title" } | null = null;
    // E2E finding: bibliographic search surfaces wwPDB structure entries
    // ("10.2210/pdb2oar/pdb", crossrefType "component") whose titles ARE
    // protein names like "Mechanosensitive Channel of Large Conductance
    // (MscL)" — they fuzzy-match literature suggestions and would verify
    // them against a STRUCTURE, not the suggested paper. Only literature
    // types are acceptable verification targets.
    const isLiterature = (item: any): boolean => {
      const t = String(item?.extra?.crossrefType || "");
      if (["component", "dataset", "peer-review"].includes(t)) return false;
      if (/^10\.2210\//i.test(String(item?.externalId || ""))) return false; // wwPDB entries
      return true;
    };
    try {
      // 1. LLM-claimed DOI (kept in suggestion.doi by the gather route)
      if (suggestion.doi) {
        try {
          const direct = await lookupCrossrefDoi(suggestion.doi);
          if (direct && isLiterature(direct)) {
            const sim = titleSimilarity(suggestion.title, direct.title || "");
            if (sim >= minSim) {
              matched = { item: direct, sim, via: "doi" };
            } else {
              log(`knowledge-verify: LLM DOI ${suggestion.doi} resolves to a DIFFERENT work (sim ${sim.toFixed(2)}) — claim discarded`);
            }
          }
        } catch (err: any) {
          log(`knowledge-verify: DOI lookup failed for ${suggestion.doi}: ${String(err?.message ?? err).slice(0, 80)}`);
        }
      }
      // 2. Bibliographic title search
      if (!matched) {
        const items = (await searchCrossref(suggestion.title, 5)).filter(isLiterature);
        let best: { item: any; sim: number } | null = null;
        for (const item of items) {
          const sim = titleSimilarity(suggestion.title, item.title || "");
          if (!best || sim > best.sim) best = { item, sim };
        }
        if (best && best.sim >= minSim && best.item?.externalId) {
          matched = { item: best.item, sim: best.sim, via: "title" };
        }
      }

      if (matched && matched.item?.externalId) {
        const doiKey = String(matched.item.externalId).toLowerCase();
        if (claimedDois.has(doiKey)) {
          log(`knowledge-verify: "${suggestion.title.slice(0, 50)}" resolves to already-claimed DOI ${doiKey} — skipped`);
          continue; // duplicate of an earlier suggestion — do not save twice
        }
        claimedDois.add(doiKey);
        const it = matched.item;
        verified.push({
          item: {
            source: "crossref",
            externalId: doiKey,
            title: it.title || suggestion.title,
            authors: it.authors || suggestion.authors,
            year: it.year || suggestion.year,
            journal: it.journal || suggestion.journal,
            doi: doiKey,
            url: it.url || `https://doi.org/${doiKey}`,
            abstract: it.abstract,
            extra: {
              llmSuggested: true,
              llmKind: suggestion.kind,
              llmReason: suggestion.reason,
              matchSimilarity: Math.round(matched.sim * 100) / 100,
              matchedVia: matched.via,
            },
            gatherMethod: matched.via === "doi"
              ? "llm-knowledge-verified-crossref-doi"
              : "llm-knowledge-verified-crossref",
            reason: suggestion.reason,
            kind: suggestion.kind,
          },
          suggestion,
          similarity: matched.sim,
        });
        log(`knowledge-verify: "${suggestion.title.slice(0, 50)}" confirmed in Crossref via ${matched.via} (DOI ${doiKey}, sim ${matched.sim.toFixed(2)})`);
      } else {
        unverified.push(suggestion);
        log(`knowledge-verify: "${suggestion.title.slice(0, 50)}" not confirmed in Crossref either — stays unverified`);
      }
    } catch (err: any) {
      unverified.push(suggestion);
      log(`knowledge-verify: Crossref lookup failed for "${suggestion.title.slice(0, 50)}": ${String(err?.message ?? err).slice(0, 100)}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  return { verified, unverified };
}

export interface PersistKnowledgeOutcome {
  addedSources: {
    title: string;
    journal?: string;
    year?: string;
    externalId: string;
    source: string;
    verified: true;
    reason: string;
  }[];
  promoted: number;
  unverifiedSaved: KVMissingSource[];
  skippedDuplicates: number;
}

/**
 * Shared persistence for knowledge-verified gap sources + remaining
 * unverified suggestions (round-35; previously duplicated ~90 lines across
 * the gather-verify route and the v2 pipeline, which had drifted).
 *
 * Verified items (PubMed or Crossref channel):
 *   - skipped when the project already holds the same externalId;
 *   - when a previously-saved UNVERIFIED suggestion row matches the
 *     verified work (claimed llmDoi, or title similarity ≥ 0.8), that row
 *     is PROMOTED IN PLACE — source/metadata upgraded, unverified flag
 *     dropped, reference created — instead of leaving a duplicate pair
 *     (one amber "unverified" card + one verified card for the same paper);
 *   - otherwise saved as a new citable dataSource + reference.
 *
 * Unverified suggestions: normalized-title dedup against ALL project rows
 * (round-34 rule) then saved flagged + non-citable.
 */
export async function persistKnowledgeSuggestions(
  projectId: string,
  verified: VerifiedMissingItem[],
  unverified: KVMissingSource[],
  db: any,
  opts: { onLog?: (msg: string) => void; onSaved?: (ds: any, ref: any) => void } = {}
): Promise<PersistKnowledgeOutcome> {
  const log = opts.onLog || (() => {});

  // Full current snapshot: extId dedup, title dedup, and promotion targets.
  const allRows: any[] = await db.dataSource.findMany({
    where: { projectId },
    select: { id: true, source: true, externalId: true, title: true, authors: true, journal: true, year: true, doi: true, url: true, abstract: true, extra: true, query: true, rawJson: true, pinned: true },
  });
  const existingExtIds = new Set(allRows.map((r) => r.externalId).filter(Boolean));
  const existingTitleKeys = new Set(
    allRows.map((r) => normalizeTitle(r.title || "")).filter(Boolean)
  );
  // round-35 E2E: verified items must also be checked against NON-llm rows by
  // TITLE — a Crossref bibliographic hit can be the same work already
  // gathered under a different identifier namespace (RCSB structure rows
  // hold PDB ids, not DOIs, so the extId check alone misses them).
  const nonLlmRows = allRows.filter((r) => r.source !== "llm");
  const isTitleDuplicate = (title: string): boolean => {
    const key = normalizeTitle(title);
    if (key && existingTitleKeys.has(key)) {
      // exact title dupes on llm rows are promotion candidates, handled
      // elsewhere — only non-llm rows make a real duplicate here
      return nonLlmRows.some((r) => normalizeTitle(r.title || "") === key);
    }
    return nonLlmRows.some((r) => titleSimilarity(String(r.title || ""), title) >= 0.8);
  };
  // Unverified-suggestion rows are promotion candidates
  const llmRows = allRows.filter((r) => {
    if (r.source !== "llm") return false;
    try {
      return Boolean(JSON.parse(String(r.extra || "{}")).unverified);
    } catch {
      return false;
    }
  });

  const findPromotable = (v: VerifiedMissingItem): any | null => {
    for (const row of llmRows) {
      let claimedDoi: string | null = null;
      try {
        const ex = JSON.parse(String(row.extra || "{}"));
        if (ex.llmDoi) claimedDoi = String(ex.llmDoi).toLowerCase();
      } catch { /* ignore */ }
      if (claimedDoi && v.item.doi && claimedDoi === String(v.item.doi).toLowerCase()) return row;
      if (titleSimilarity(String(row.title || ""), v.item.title) >= 0.8) return row;
    }
    return null;
  };

  const addedSources: PersistKnowledgeOutcome["addedSources"] = [];
  let promoted = 0;
  let skippedDuplicates = 0;

  const upsertReference = async (item: any) => {
    try {
      return await db.reference.create({
        data: {
          type: item.source === "crossref" ? "crossref" : "pubmed",
          externalId: item.externalId,
          title: item.title,
          authors: item.authors || null,
          journal: item.journal || null,
          year: item.year || null,
          url: item.url || null,
          doi: item.doi || null,
          abstract: item.abstract || null,
          projectId,
        },
      });
    } catch (err: any) {
      log(`reference create failed: ${String(err?.message ?? err).slice(0, 100)}`);
      return null;
    }
  };

  for (const v of verified) {
    if (existingExtIds.has(v.item.externalId)) {
      skippedDuplicates++;
      continue;
    }
    // Title-level guard: the same work may already be gathered under a
    // different identifier namespace (RCSB structure rows, web rows).
    if (isTitleDuplicate(String(v.item.title || ""))) {
      skippedDuplicates++;
      log(`knowledge-verify: verified "${String(v.item.title).slice(0, 50)}" duplicates an already-gathered source — skipped`);
      continue;
    }
    try {
      const promotable = findPromotable(v);
      if (promotable) {
        // Promote the unverified row in place — metadata from the registry,
        // provenance kept, amber flag removed.
        const extra = (() => {
          try {
            const cur = JSON.parse(String(promotable.extra || "{}"));
            delete cur.unverified;
            delete cur.note;
            cur.llmSuggested = true;
            cur.llmKind = v.item.extra?.llmKind;
            cur.llmReason = v.item.extra?.llmReason;
            cur.matchSimilarity = v.item.extra?.matchSimilarity;
            cur.matchedVia = v.item.extra?.matchedVia;
            cur.promotedFrom = "unverified";
            return JSON.stringify(cur);
          } catch {
            return JSON.stringify({ llmSuggested: true, promotedFrom: "unverified" });
          }
        })();
        const ds = await db.dataSource.update({
          where: { id: promotable.id },
          data: {
            source: v.item.source,
            externalId: v.item.externalId,
            title: v.item.title,
            url: v.item.url || null,
            authors: v.item.authors || promotable.authors || null,
            journal: v.item.journal || promotable.journal || null,
            year: v.item.year || promotable.year || null,
            doi: v.item.doi || null,
            abstract: v.item.abstract || null,
            extra,
            pinned: true,
          },
        });
        existingExtIds.add(v.item.externalId);
        promoted++;
        const ref = await upsertReference(v.item);
        opts.onSaved?.(ds, ref);
        addedSources.push({
          title: v.item.title,
          journal: v.item.journal,
          year: v.item.year,
          externalId: v.item.externalId,
          source: v.item.source,
          verified: true,
          reason: v.item.reason,
        });
        log(`knowledge-verify: promoted unverified row → ${v.item.source} ${v.item.externalId} ("${String(v.item.title).slice(0, 50)}")`);
        continue;
      }
      const ds = await db.dataSource.create({
        data: {
          projectId,
          source: v.item.source,
          query: "llm-knowledge cross-check",
          rawJson: JSON.stringify({ items: [v.item] }),
          title: v.item.title,
          externalId: v.item.externalId,
          url: v.item.url,
          authors: v.item.authors || null,
          journal: v.item.journal || null,
          year: v.item.year || null,
          doi: v.item.doi || null,
          abstract: v.item.abstract || null,
          extra: JSON.stringify(v.item.extra),
          pinned: true,
        },
      });
      existingExtIds.add(v.item.externalId);
      const ref = await upsertReference(v.item);
      opts.onSaved?.(ds, ref);
      addedSources.push({
        title: v.item.title,
        journal: v.item.journal,
        year: v.item.year,
        externalId: v.item.externalId,
        source: v.item.source,
        verified: true,
        reason: v.item.reason,
      });
    } catch (err: any) {
      log(`save verified source failed: ${String(err?.message ?? err).slice(0, 100)}`);
    }
  }

  // Unconfirmed suggestions — flagged, non-citable (round-34 rules:
  // normalizeTitle dedup over ALL project sources; LLM DOIs kept out of
  // structured fields, preserved in extra.llmDoi for human review).
  const unverifiedSaved: KVMissingSource[] = [];
  for (const s of unverified) {
    try {
      const key = normalizeTitle(s.title || "");
      if (key && existingTitleKeys.has(key)) {
        log(`unverified suggestion "${String(s.title).slice(0, 50)}" already saved — skipped`);
        continue;
      }
      if (key) existingTitleKeys.add(key);
      await db.dataSource.create({
        data: {
          projectId,
          source: "llm",
          query: "llm-knowledge cross-check (unverified)",
          rawJson: JSON.stringify({ items: [s] }),
          title: s.title,
          externalId: null,
          url: null,
          authors: s.authors || null,
          journal: s.journal || null,
          year: s.year || null,
          doi: null,
          abstract: null,
          extra: JSON.stringify({
            unverified: true,
            llmKind: s.kind,
            llmReason: s.reason,
            ...(s.doi ? { llmDoi: s.doi } : {}),
            note: "Proposed by LLM knowledge; not confirmed in PubMed or Crossref — review before citing.",
          }),
          pinned: false,
        },
      });
      unverifiedSaved.push(s);
    } catch (err: any) {
      log(`save unverified suggestion failed: ${String(err?.message ?? err).slice(0, 100)}`);
    }
  }

  return { addedSources, promoted, unverifiedSaved, skippedDuplicates };
}
