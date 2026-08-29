/**
 * EndNote record enrichment via NCBI E-utilities (round 22).
 *
 * The article body's "## References" lines carry authors/year/journal/title/
 * URL — but NOT DOI, volume, issue or pages (the compose format never
 * included them, so the DB Reference rows don't have them either). When those
 * records are imported into EndNote (traveling library or the .enw export),
 * the DOI/Vol/Issue/Pages fields render empty — part of the "some information
 * displays as invalid" feedback.
 *
 * This module batch-fetches the authoritative metadata from PubMed esummary
 * (one request for up to 200 PMIDs) and fills the gaps in-place:
 *
 *   - doi      ← elocationid ("doi: 10.7554/eLife.94303")
 *   - volume   ← volume
 *   - issue    ← issue
 *   - pages    ← pages (page ranges and e-locations)
 *   - authors/year/journal ← repaired only when MISSING in the parsed record
 *     (the body line stays the source of truth when it parsed cleanly — the
 *     article's visible bibliography and the EndNote record must agree).
 *
 * Failure policy: this is an enhancement — any error (network, timeout,
 * malformed response) leaves the records untouched. The caller never has to
 * handle a failure.
 */
import type { EndNoteRecord } from "./endnote-fields";
import type { Reference } from "./types";

const UA =
  "Mozilla/5.0 (compatible; SciWriteAssistant/1.0; +https://example.com/sciwrite)";

/** Max PMIDs per esummary request (NCBI accepts ~200; 50 keeps URLs tidy). */
const CHUNK_SIZE = 50;

interface EsummaryPayload {
  result?: {
    uids?: string[];
    [pmid: string]: unknown;
  };
}

interface EsummaryRecord {
  title?: string;
  fulljournalname?: string;
  source?: string;
  pubdate?: string;
  elocationid?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  authors?: { name?: string; authtype?: string }[];
  [k: string]: unknown;
}

async function fetchJson(url: string, timeoutMs: number): Promise<EsummaryPayload | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as EsummaryPayload;
  } catch {
    return null; // timeout / network — enrichment is best-effort only
  } finally {
    clearTimeout(t);
  }
}

/** Extract the DOI from esummary fields: elocationid or articleids. */
function doiFromSummary(r: EsummaryRecord): string | undefined {
  if (r.elocationid?.startsWith("doi:")) {
    return r.elocationid.replace(/^doi:\s*/, "").trim() || undefined;
  }
  const ids = r.articleids as { idtype?: string; value?: string }[] | undefined;
  const fromIds = ids?.find((a) => a?.idtype === "doi")?.value;
  return fromIds?.trim() || undefined;
}

/**
 * Enrich records in place from PubMed esummary. Only records that carry a
 * PMID are considered; within them only missing fields are filled.
 *
 * @returns the number of records that were modified (for logging).
 */
export async function enrichRecordsFromPubmed(
  records: Map<number, EndNoteRecord> | EndNoteRecord[],
  timeoutMs = 8000,
): Promise<number> {
  const list = Array.isArray(records) ? records : [...records.values()];
  const byPmid = new Map<string, EndNoteRecord>();
  for (const rec of list) {
    if (rec.pmid && !byPmid.has(rec.pmid)) byPmid.set(rec.pmid, rec);
  }
  if (byPmid.size === 0) return 0;

  const pmids = [...byPmid.keys()];
  let touched = 0;
  for (let i = 0; i < pmids.length; i += CHUNK_SIZE) {
    const chunk = pmids.slice(i, i + CHUNK_SIZE);
    const url =
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=" +
      chunk.join(",");
    const data = await fetchJson(url, timeoutMs);
    const result = data?.result;
    if (!result?.uids) continue;

    for (const pmid of result.uids) {
      const rec = byPmid.get(pmid);
      const sum = result[pmid] as EsummaryRecord | undefined;
      if (!rec || !sum || typeof sum !== "object") continue;
      const before = JSON.stringify(rec);
      if (!rec.doi) {
        const doi = doiFromSummary(sum);
        if (doi) rec.doi = doi;
      }
      if (!rec.volume && sum.volume) rec.volume = sum.volume;
      if (!rec.issue && sum.issue) rec.issue = sum.issue;
      if (!rec.pages && sum.pages) rec.pages = sum.pages;
      if (!rec.year) {
        const y = (sum.pubdate || "").slice(0, 4);
        if (/^\d{4}$/.test(y)) rec.year = y;
      }
      if (!rec.journal) {
        const j = sum.fulljournalname || sum.source;
        if (j) rec.journal = j;
      }
      if (rec.authors.length === 0) {
        const names = (sum.authors || [])
          .filter((a) => a?.name && a.authtype !== "CollectiveName")
          .map((a) => a.name as string);
        if (names.length > 0) rec.authors = names;
      }
      if (JSON.stringify(rec) !== before) touched++;
    }
  }
  return touched;
}

/**
 * Mark records that are plain web sources (no journal, no PMID, no DOI) as
 * "Web Page" (EndNote ref-type 12) — an EndNote "Journal Article" with an
 * empty journal renders as if broken in the library view.
 */
export function applyWebPageRefTypes(records: Map<number, EndNoteRecord> | EndNoteRecord[]): void {
  const list = Array.isArray(records) ? records : [...records.values()];
  for (const rec of list) {
    if (rec.refType) continue;
    if (!rec.journal && !rec.pmid && !rec.doi && rec.url) {
      rec.refType = "Web Page";
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-row repair for hollow/malformed records (round 23)
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize a title for matching: lowercase, alphanumerics + CJK only. */
function normTitle(t: string): string {
  return (t || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

/** Split a DB authors string the same way the route does ("et al." dropped).
 * Hostname-shaped values (the gather step stores "pmc.ncbi.nlm.nih.gov" in
 * the authors field of web sources) become "Anonymous" — the same rule the
 * compose pipelines apply when writing the bibliography line. */
function splitAuthors(authors: string): string[] {
  const raw = authors.trim();
  if (!raw || /^(https?:\/\/)?(www\.)?[a-z0-9.-]+\.(gov|org|com|edu|net)$/i.test(raw)) {
    return ["Anonymous"];
  }
  return raw
    .split(/\s*[,;]\s*/)
    .map((s) => s.trim())
    .filter((s) => s && !/^et\.?\s*al\.?$/i.test(s));
}

/**
 * Repair hollow/malformed EndNote records from the DB Reference rows
 * (round 23 — the "还是存在少量文献出现这种情况" root cause).
 *
 * A bibliography line composed from a year-less Reference row carries no
 * "(YYYY)" segment, so its parsed EndNote record has NO authors and NO year —
 * and <Cite><Author>/<Cite><Year> are the two keys EndNote uses to bind a
 * citation to its record. A Cite missing them is unmatchable →
 * "!!! INVALID CITATION !!!". PubMed enrichment (round 22) repairs only the
 * PMID-carrying subset — this pass borrows the authoritative fields from the
 * DB rows the compose line was built from, matched by PMID → DOI →
 * normalized-title containment. For records flagged `lineMalformed` the
 * journal/title split is also garbled (the author list gets read as the
 * journal), so those fields are taken from the DB row as well.
 *
 * @param records parsed body-line records, mutated in place
 * @param references the DB Reference rows for the export
 * @param dbByPmid  PMID → row index the caller already built (optional)
 * @returns number of records that were modified
 */
export function repairRecordsFromDbRows(
  records: Map<number, EndNoteRecord> | EndNoteRecord[],
  references: {
    type?: string | null;
    externalId?: string | null;
    doi?: string | null;
    title?: string | null;
    year?: string | null;
    authors?: string | null;
    journal?: string | null;
  }[],
  dbByPmid?: Map<string, Reference>,
): number {
  const list = Array.isArray(records) ? records : [...records.values()];
  const byPmid = dbByPmid ?? new Map<string, Reference>();
  if (!dbByPmid) {
    for (const r of references) {
      if (r.type === "pubmed" && r.externalId) byPmid.set(r.externalId, r as Reference);
    }
  }
  type Row = (typeof references)[number];
  const byDoi = new Map<string, Row>();
  const byTitle: Array<[string, Row]> = [];
  for (const r of references) {
    if (r.doi) byDoi.set(r.doi.toLowerCase(), r);
    if (r.title) byTitle.push([normTitle(r.title), r]);
  }

  let repaired = 0;
  for (const rec of list) {
    const needYear = !rec.year;
    const needAuthors = rec.authors.length === 0;
    const malformed = !!rec.lineMalformed;
    if (!needYear && !needAuthors && !malformed) continue;
    let row: Row | undefined = rec.pmid ? byPmid.get(rec.pmid) : undefined;
    if (!row && rec.doi) row = byDoi.get(rec.doi.toLowerCase());
    if (!row) {
      const nt = normTitle(rec.title);
      if (nt.length >= 12) {
        row = byTitle.find(
          ([k]) => k.length >= 12 && (k === nt || k.includes(nt) || nt.includes(k)),
        )?.[1];
      }
    }
    if (!row) continue;
    const before = JSON.stringify(rec);
    if (needYear && row.year && /^\d{4}/.test(row.year)) {
      rec.year = row.year.slice(0, 4);
    }
    if (needAuthors && row.authors) {
      rec.authors = splitAuthors(row.authors);
    }
    if (malformed) {
      // The line's journal/title split is unreliable (the author list gets
      // read as the journal) — take the DB row's values; clear the journal
      // when the row has none so applyWebPageRefTypes can still type the
      // record as "Web Page".
      rec.journal = row.journal || undefined;
      if (row.title) rec.title = row.title;
    }
    if (JSON.stringify(rec) !== before) repaired++;
  }
  return repaired;
}
