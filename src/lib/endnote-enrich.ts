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
