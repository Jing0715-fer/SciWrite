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
import { queryDatabase } from "@/lib/databases";
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

/** Sanitize a single LLM-provided fill value. Returns null when unusable. */
function cleanFill(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!v || v.toLowerCase() === "unknown" || v.toLowerCase() === "n/a" || v.toLowerCase() === "none") return null;
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
    const list = batch
      .map((s, j) => {
        const marks = (f: string, v?: string | null) =>
          v && String(v).trim() ? ` [${f}=${String(v).slice(0, 160)}]` : ` [${f}=MISSING]`;
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
      log(`knowledge-verify: batch ${Math.floor(b / batchSize) + 1} failed: ${String(err?.message ?? err).slice(0, 120)}`);
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
      const res = await queryDatabase("pubmed", suggestion.title.slice(0, 180));
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
