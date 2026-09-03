import type { DatabaseQueryResponse, DatabaseResultItem, DatabaseSource } from "./types";
import {
  expandQueryVariants,
  filterItemsByRelevance,
  runWithConcurrency,
  type FilteredOutItem,
  type SearchEnhanceOpts,
} from "./search-enhance";

const UA =
  "Mozilla/5.0 (compatible; SciWriteAssistant/1.0; +https://example.com/sciwrite)";

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        ...(init?.headers || {}),
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Retry wrapper — retries a fetch operation up to `maxRetries` times with
 * exponential backoff. Used for database queries that may fail due to
 * rate limiting (429), temporary network issues, or malformed queries
 * that can be simplified on retry.
 *
 * @param fn     The async function to retry
 * @param maxRetries  Maximum number of retry attempts (default: 2)
 * @param baseDelay   Base delay in ms for exponential backoff (default: 1000)
 * @returns The result of fn(), or throws the last error after all retries fail
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  baseDelay = 1000
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      // Don't retry on the last attempt
      if (attempt >= maxRetries) break;
      // Don't retry on 400 Bad Request (query syntax error) — retrying won't help
      // unless we simplify the query, which we don't do here.
      const is400 = err?.message?.includes("HTTP 400");
      if (is400) break;
      // Exponential backoff: 1s, 2s, 4s, ...
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * Clean a UniProt query string to fix common LLM-generated syntax errors.
 *
 * The UniProt REST API has specific syntax requirements:
 *  - `organism:"Homo sapiens"` is valid but `organism:"Homo sapiens` (missing closing quote) is not
 *  - `family:"..."` is not a valid field — should be removed or converted to keyword search
 *  - Multiple field:value pairs must be joined with AND/OR
 *  - Unmatched quotes cause 400 errors
 *
 * This function:
 *  1. Fixes unmatched quotes
 *  2. Removes unsupported field prefixes (family, length, etc.)
 *  3. Simplifies the query to keyword + organism if the complex query fails
 */
function cleanUniprotQuery(query: string): string {
  let q = query.trim();

  // Fix unmatched quotes — count double quotes, add closing if odd
  const quoteCount = (q.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    q += '"';
  }

  // Remove unsupported field prefixes that cause 400 errors.
  // UniProt supports: accession, id, gene, organism, organism_id, protein_name,
  // keyword, etc. Unsupported fields like "family:" cause 400.
  // We strip known-unsupported fields and keep the rest as keywords.
  const unsupportedFields = [
    "family", "length", "mass", "domain", "site", "feature",
    "cc:", "ft:", "go:", "interpro", "pfam", "comment",
  ];
  for (const field of unsupportedFields) {
    // Remove "field:value" or "field:"value"" patterns
    q = q.replace(new RegExp(`\\b${field.replace(":", "\\:")}:("[^"]*"|\\S+)`, "gi"), "");
  }

  // Clean up: remove extra spaces, dangling AND/OR, etc.
  q = q.replace(/\s+/g, " ").trim();
  q = q.replace(/^(AND|OR)\s+/i, "").replace(/\s+(AND|OR)$/i, "").trim();

  // If the query is now empty or just has organism filter, add a fallback keyword
  if (!q || q.length < 3) {
    q = "protein";  // minimal fallback
  }

  return q;
}

async function fetchText(url: string, init?: RequestInit, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        "User-Agent": UA,
        ...(init?.headers || {}),
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- PubMed (NCBI E-utilities) ---------------- */

/**
 * FIX (citation-accuracy audit): PubMed esummary does NOT return abstracts.
 * Without abstracts, every topicality check in the citation audit judges
 * only on titles — systematically weak scores and false "unsupported"
 * flags. This helper fetches real abstracts via efetch (XML) for a batch of
 * PMIDs and returns them as a map.
 */
export async function fetchPubMedAbstracts(
  pmids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = pmids.filter(Boolean).slice(0, 200);
  if (!ids.length) return out;
  try {
    const url =
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(",")}` +
      `&rettype=abstract&retmode=xml`;
    const xml = await fetchText(url);
    // Each article: <MedlineCitation> ... <PMID>123</PMID> ... <Abstract>...
    // <AbstractText ...>text</AbstractText> ... </Abstract> ... </MedlineCitation>
    const articles = xml.split("<MedlineCitation").slice(1);
    for (const art of articles) {
      const pmidMatch = art.match(/<PMID[^>]*>(\d+)<\/PMID>/);
      if (!pmidMatch) continue;
      const pmid = pmidMatch[1];
      const abstractParts: string[] = [];
      const absRe = /<AbstractText[^>]*Label="([^"]*)"[^>]*>([\s\S]*?)<\/AbstractText>|<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
      let m: RegExpExecArray | null;
      while ((m = absRe.exec(art))) {
        const label = m[1];
        const text = (m[2] ?? m[3] ?? "")
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (text) abstractParts.push(label ? `${label}: ${text}` : text);
      }
      if (abstractParts.length) {
        out.set(pmid, abstractParts.join(" ").slice(0, 2500));
      }
    }
  } catch (err: any) {
    console.warn("[fetchPubMedAbstracts] failed:", err?.message?.slice(0, 100));
  }
  return out;
}

export async function searchPubMed(
  query: string,
  retmax = 10,
  enhance: SearchEnhanceOpts = {}
): Promise<DatabaseQueryResponse> {
  const cleaned = query.trim();
  const doExpand = enhance.expandVariants !== false;
  const doFilter = enhance.filterByLlm !== false;

  /* round-50: variant expansion — PubMed tokenizes "TMC1" / "TMC-1" /
   * "TMC 1" differently, so one spelling misses papers indexed under the
   * others. NCBI allows ~3 req/s without an API key: variant esearches run
   * serially with a 300ms gap (≤6 variants ≈ +1.5s). Original-spelling hits
   * keep priority in the merged order. */
  const { variants } = doExpand
    ? await expandQueryVariants(cleaned, enhance.context)
    : { variants: [cleaned] };
  const multiVariant = variants.length > 1;

  const seenIds = new Set<string>();
  const ids: string[] = [];
  let singleTotal = 0;
  for (let vi = 0; vi < variants.length; vi++) {
    const v = variants[vi];
    const esearch = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(
      v
    )}&retmax=${retmax}&retmode=json&sort=relevance`;
    const esData = await fetchJson(esearch);
    if (vi === 0) singleTotal = parseInt(esData?.esearchresult?.count ?? "0", 10);
    for (const id of esData?.esearchresult?.idlist ?? []) {
      if (!seenIds.has(id)) {
        seenIds.add(id);
        ids.push(id);
      }
    }
    if (vi < variants.length - 1) await new Promise((r) => setTimeout(r, 300));
  }
  // Metadata headroom: enrich a few more than retmax so the LLM filter can
  // remove irrelevant entries without shrinking the page below retmax.
  if (ids.length > retmax + 10) ids.length = retmax + 10;
  // Single-variant keeps the database-side count; a multi-spelling union has
  // no single count — report the deduped hits actually retrieved.
  const total = multiVariant ? ids.length : singleTotal;

  if (ids.length === 0) {
    return { source: "pubmed", query: cleaned, total: 0, items: [] };
  }

  const esummary = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(
    ","
  )}&retmode=json`;
  const sumData = await fetchJson(esummary);
  const result = sumData?.result ?? {};

  // FIX: esummary returns NO abstract — fetch real abstracts via efetch so
  // references carry the metadata the citation audit needs to judge topicality.
  const abstractMap = await fetchPubMedAbstracts(ids);

  const items: DatabaseResultItem[] = ids.map((id) => {
    const r = result[id];
    if (!r) return null;
    const authors = (r.authors || [])
      .map((a: any) => a.name)
      .filter(Boolean)
      .join(", ");
    // Extract PMC ID from articleids if available
    const articleIds: any[] = r.articleids || [];
    const pmcId = articleIds.find((a) => a.idtype === "pmc")?.value;
    return {
      source: "pubmed",
      externalId: id,
      title: r.title?.replace(/\.$/, "") ?? "(untitled)",
      authors: authors || undefined,
      journal: r.fulljournalname || r.source || undefined,
      // FIX: "Winter 2023"-style pubdates used to yield "Wint" — parse the
      // first 4-digit year anywhere in the string instead of slicing.
      year: (r.pubdate?.match(/\d{4}/) || [])[0],
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      doi: r.elocationid?.startsWith("doi:")
        ? r.elocationid.replace("doi:", "").trim()
        : undefined,
      abstract: abstractMap.get(id) || undefined,
      extra: {
        pubdate: r.pubdate,
        pubtype: Array.isArray(r.pubtype) ? r.pubtype.join(", ") : r.pubtype,
        pmcId: pmcId || undefined,
        hasFreeFullText: !!pmcId,
      },
    };
  }).filter(Boolean) as DatabaseResultItem[];

  /* round-50: LLM relevance filter — drop entries whose primary subject is a
   * different protein than the query target (conservative: uncertain or
   * failed calls keep everything; the citation planner re-scores later). */
  let finalItems = items;
  let filteredOut: FilteredOutItem[] | undefined;
  if (doFilter && items.length > 1) {
    const r = await filterItemsByRelevance(items, cleaned, enhance.context);
    if (r.dropped.length > 0) {
      finalItems = r.kept;
      filteredOut = r.dropped;
    }
  }
  if (finalItems.length > retmax) finalItems = finalItems.slice(0, retmax);

  return {
    source: "pubmed",
    query: cleaned,
    total,
    items: finalItems,
    variants: multiVariant ? variants : undefined,
    filteredOut,
  };
}

/**
 * Fetch full text from PubMed Central (PMC) for free-access articles.
 * Uses NCBI E-utilities efetch with rettype=full to get the complete article XML,
 * then extracts the text content (title, abstract, body sections, figures).
 *
 * @param pmcId - PMC ID (e.g. "PMC1234567" or just "1234567")
 * @returns Full text content (up to ~50,000 chars) or null if not available
 */
export async function fetchPmcFullText(pmcId: string): Promise<string | null> {
  const cleanId = pmcId.replace(/^PMC/i, "").trim();
  if (!cleanId) return null;

  // efetch from PMC database with rettype=full returns XML
  const efetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${cleanId}&rettype=full&retmode=xml`;

  try {
    const xmlText = await fetchText(efetchUrl, undefined, 30000);

    // Check if we got an error response
    if (xmlText.includes("<ERROR>") || xmlText.length < 100) return null;

    // Extract text content from XML
    // Remove XML tags but preserve structure for readability
    let text = xmlText;

    // Extract article title
    const titleMatch = text.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";

    // Extract abstract
    const abstractMatch = text.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/);
    const abstract = abstractMatch ? abstractMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";

    // Extract body sections
    const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/);
    let body = "";
    if (bodyMatch) {
      body = bodyMatch[1]
        // Replace section titles with markers
        .replace(/<title[^>]*>([\s\S]*?)<\/title>/g, "\n\n### $1\n")
        // Replace paragraph breaks
        .replace(/<\/p>/g, "\n\n")
        .replace(/<p[^>]*>/g, "")
        // Remove all remaining tags
        .replace(/<[^>]+>/g, "")
        // Clean up whitespace
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    // Combine
    const fullText = [
      title ? `# ${title}` : "",
      abstract ? `## Abstract\n${abstract}` : "",
      body ? `## Full Text\n${body}` : "",
    ].filter(Boolean).join("\n\n");

    // Limit to ~50,000 chars to avoid token overflow
    return fullText || null;
  } catch (err) {
    console.error("[fetchPmcFullText] error:", err);
    return null;
  }
}

/**
 * Fetch full text for a PubMed article if it has a PMC ID.
 * Returns the full text or null if not available (not PMC-indexed).
 *
 * @param pmid - PubMed ID
 * @param pmcId - Optional PMC ID (from esummary articleids)
 * @returns Full text or null
 */
export async function fetchFullTextForPubMed(pmid: string, pmcId?: string): Promise<string | null> {
  // If we have a PMC ID, fetch directly
  if (pmcId) {
    return fetchPmcFullText(pmcId);
  }

  // Otherwise, try to find the PMC ID via ID conversion
  try {
    const convertUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pmc&id=${pmid}&retmode=json`;
    const data = await fetchJson(convertUrl);
    const linkSets = data?.linksets || [];
    for (const ls of linkSets) {
      const linkSetDbs = ls?.linksetdbs || [];
      for (const lsd of linkSetDbs) {
        if (lsd?.dbto === "pmc") {
          const links = lsd?.links || [];
          if (links.length > 0) {
            return fetchPmcFullText(String(links[0]));
          }
        }
      }
    }
  } catch {
    // Not available
  }

  return null;
}

/* ---------------- UniProt ---------------- */
export async function searchUniprot(
  query: string,
  size = 10
): Promise<DatabaseQueryResponse> {
  // Clean the query to fix common LLM-generated syntax errors
  const cleaned = cleanUniprotQuery(query);

  // Try the full cleaned query first, then fall back to a simplified
  // keyword-only query (strip organism: filter) if it fails with 400.
  const tryQuery = async (q: string) => {
    const url = `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(
      q
    )}&format=json&size=${size}`;
    return await withRetry(() => fetchJson(url), 2, 1000);
  };

  let data: any;
  try {
    data = await tryQuery(cleaned);
  } catch (err: any) {
    // If the cleaned query failed (likely 400), try a simplified version:
    // strip organism: filter and just search by keywords
    const simplified = cleaned
      .replace(/organism(_id)?:("[^"]*"|\S+)/gi, "")
      .replace(/\s+(AND|OR)\s+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (simplified && simplified !== cleaned) {
      try {
        data = await tryQuery(simplified);
      } catch {
        // Both attempts failed — return empty results
        return { source: "uniprot", query: cleaned, total: 0, items: [] };
      }
    } else {
      return { source: "uniprot", query: cleaned, total: 0, items: [] };
    }
  }

  const results = data?.results ?? [];
  const total = data?.header?.results ?? results.length;

  const items: DatabaseResultItem[] = results.map((r: any) => {
    const acc = r.primaryAccession;
    const org = r.organism?.scientificName;
    const proteinName =
      r.proteinDescription?.recommendedName?.fullName?.value ||
      r.proteinDescription?.submissionNames?.[0]?.fullName?.value ||
      r.proteinDescription?.names?.[0]?.fullName?.value;
    const gene = r.genes?.[0]?.geneName?.value;
    const title = `${proteinName || gene || acc}${org ? " [" + org + "]" : ""}`;
    const comments = (r.comments || [])
      .map((c: any) => c.texts?.map((t: any) => t.value).join(" "))
      .filter(Boolean)
      .join(" ");
    return {
      source: "uniprot",
      externalId: acc,
      title,
      authors: org,
      journal: "UniProtKB",
      year: r.entryAudit?.lastAnnotationUpdateDate?.slice(0, 4),
      url: `https://www.uniprot.org/uniprotkb/${acc}`,
      doi: undefined,
      abstract:
        comments.slice(0, 600) ||
        r.proteinDescription?.recommendedName?.shortNames?.[0]?.value ||
        undefined,
      extra: {
        gene: gene || "",
        organism: org || "",
        length: r.sequence?.length ? String(r.sequence.length) : "",
        function: comments.slice(0, 300),
      },
    };
  });

  return { source: "uniprot", query: cleaned, total, items };
}

/* ---------------- RCSB PDB ---------------- */

/**
 * RCSB's search API returns HTTP 204 with an EMPTY body for zero hits — the
 * generic fetchJson would choke on res.json() of "" and surface that as a
 * spurious error. This dedicated fetcher normalizes 204/empty to null.
 */
async function rcsbSearchFetch(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (res.status === 204) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const text = await res.text();
    if (!text.trim()) return null;
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

/** One RCSB full-text search → ranked entry IDs (+ database-side total). */
async function rcsbSearchIds(
  query: string,
  rows: number
): Promise<{ ranked: { id: string; score: number }[]; total: number }> {
  const body = {
    query: {
      type: "group",
      logical_operator: "and",
      nodes: [
        {
          type: "terminal",
          service: "full_text",
          parameters: { value: query },
        },
      ],
    },
    return_type: "entry",
    request_options: {
      paginate: { start: 0, rows },
      results_content_type: ["experimental"],
      sort: [{ sort_by: "score", direction: "desc" }],
    },
  };
  const url =
    "https://search.rcsb.org/rcsbsearch/v2/query?json=" + encodeURIComponent(JSON.stringify(body));
  const data = await rcsbSearchFetch(url);
  const resultSet: any[] = data?.result_set ?? [];
  return {
    ranked: resultSet.map((r) => ({ id: String(r.identifier), score: Number(r.score ?? 0) })),
    total: data?.total_count ?? 0,
  };
}

/**
 * Build one RCSB result item: entry metadata + linked publication.
 * round-51: THROWS on entry-metadata failure so the caller can retry or
 * drop — the old silent fallback returned a bare title=ID card, which is
 * useless for citation planning AND blinds the round-50 LLM relevance
 * filter ("when uncertain, KEEP" admitted junk whenever data.rcsb.org
 * blipped — the exact bare 6VYM/2QTS/5W2O/5W2Q cards the user hit).
 * Each fetch gets 1 retry: transient 429/5xx/network blips recover; a 404
 * (withdrawn entry / no linked publication) costs one 600ms retry at most.
 */
async function buildRcsbItem(
  id: string,
  pmidByPdb: Map<string, string>
): Promise<DatabaseResultItem> {
  const meta = await withRetry(
    () => fetchJson(`https://data.rcsb.org/rest/v1/core/entry/${id}`),
    1,
    600
  );
  const method = meta?.exptl?.[0]?.method;
  const res = meta?.rcsb_entry_info?.resolution_combined?.[0];
  const org = meta?.rcsb_entry_info?.organism_scientific_name?.join(", ");
  const date = meta?.rcsb_accession_info?.initial_release_date;

  // Structure-metadata fallback reference
  let pubTitle: string | undefined = meta?.struct?.title || id;
  let pubAuthors: string | undefined = org;
  let pubJournal: string | undefined = method ? `PDB · ${method}` : "RCSB PDB";
  let pubYear: string | undefined = date?.slice(0, 4);
  let pubDoi: string | undefined = meta?.rcsb_entry_container_identifiers?.doi;
  let pubAbstract: string | undefined = [
    method ? `Method: ${method}` : "",
    res ? `Resolution: ${res} Å` : "",
    org ? `Organism: ${org}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  let hasPub = false;
  let pmcId: string | undefined;

  try {
    const pubData = await withRetry(
      () => fetchJson(`https://data.rcsb.org/rest/v1/core/pubmed/${id}`),
      1,
      600
    );
    if (pubData && pubData.rcsb_id) {
      const pmid = String(pubData.rcsb_id);
      pmidByPdb.set(id, pmid);
      hasPub = true;
      // Real abstract + DOI from RCSB (fields actually present)
      if (pubData.rcsb_pubmed_abstract_text) {
        pubAbstract = String(pubData.rcsb_pubmed_abstract_text).slice(0, 2500);
      }
      if (pubData.rcsb_pubmed_doi) pubDoi = String(pubData.rcsb_pubmed_doi);
      if (pubData.rcsb_pubmed_central_id) {
        pmcId = String(pubData.rcsb_pubmed_central_id);
      }
    }
  } catch {
    // No associated publication — structure metadata only
  }

  return {
    source: "rcsb",
    externalId: id,
    title: pubTitle || id,
    authors: pubAuthors,
    journal: pubJournal,
    year: pubYear,
    url: `https://www.rcsb.org/structure/${id}`,
    doi: pubDoi,
    abstract: pubAbstract,
    extra: {
      method: method || "",
      resolution: res ? String(res) : "",
      organism: org || "",
      pdbId: id,
      pmid: pmidByPdb.get(id) || "",
      pmcId: pmcId || "",
      hasPublication: hasPub,
    },
  };
}

export async function searchRcsb(
  query: string,
  limit = 10,
  enhance: SearchEnhanceOpts = {}
): Promise<DatabaseQueryResponse> {
  const cleaned = query.trim();
  const doExpand = enhance.expandVariants !== false;
  const doFilter = enhance.filterByLlm !== false;

  /* round-50: variant expansion + merged multi-search. RCSB's Lucene
   * full-text tokenizer treats TMC1 / TMC-1 / TMC 1 as DISTINCT tokens, so a
   * single spelling silently loses most of the pool (user-observed: "TMC1"
   * → 3 entries while "TMC-1" unlocks the rest). Original-spelling hits keep
   * priority in the merged ranking; each variant searches `limit` rows in
   * parallel (search.rcsb.org tolerates light concurrency). */
  const { variants } = doExpand
    ? await expandQueryVariants(cleaned, enhance.context)
    : { variants: [cleaned] };
  const multiVariant = variants.length > 1;

  let firstErr: unknown = null;
  const perVariant = await runWithConcurrency(variants, 4, async (v) => {
    try {
      return await rcsbSearchIds(v, limit);
    } catch (err) {
      if (firstErr === null) firstErr = err;
      return null;
    }
  });
  if (perVariant.every((r) => r === null)) {
    throw firstErr ?? new Error("RCSB search failed for all query variants");
  }

  const idRank = new Map<string, { order: number; score: number }>();
  perVariant.forEach((r, order) => {
    if (!r) return;
    for (const { id, score } of r.ranked) {
      if (!idRank.has(id)) idRank.set(id, { order, score });
    }
  });
  // Metadata headroom: enrich a few more than limit so the LLM filter can
  // remove irrelevant entries without shrinking the page below limit.
  const ids = [...idRank.keys()].slice(0, limit + 10);
  // Single-variant keeps the historical database-side total_count; the
  // deduped union count is the only honest number for multi-spelling.
  const total = multiVariant ? idRank.size : (perVariant[0]?.total ?? 0);

  // NOTE (round-50 refactor): the strictly serial per-ID loop became a
  // worker pool (concurrency 6) — 20+ IDs meant 40+ sequential HTTP
  // round-trips. The old entryMeta map was write-only dead state (never read
  // after the loop) and was dropped.
  // FIX (citation-accuracy audit): the RCSB /core/pubmed/{id} endpoint does
  // NOT return title/authors/journal fields — it returns rcsb_pubmed_*
  // fields (rcsb_id = PMID, rcsb_pubmed_abstract_text = real abstract,
  // rcsb_pubmed_doi, rcsb_pubmed_central_id). The previous code read
  // pubData.title / .authors / .journal_abbreviation / .pub_date / .doi /
  // .abstract — ALL undefined — so every RCSB reference was saved with
  // authors=<organism name>, journal="PDB · METHOD", year=PDB release year,
  // and a fake "Method · Resolution · Organism" pseudo-abstract. That
  // corrupted the final reference list AND every topicality audit.
  //
  // Correct strategy:
  //   1. read the real PMID (rcsb_id) + real abstract + DOI from RCSB
  //   2. batch-fetch PubMed esummary for those PMIDs → real title/authors/
  //      journal/year
  //   3. fall back to structure metadata when no publication is linked
  //
  // round-51 metadata resilience: first pass at concurrency 6 (each fetch
  // retries transient failures once in-flight inside buildRcsbItem); ids
  // whose metadata still fails get a SEQUENTIAL rescue pass with 350ms
  // cool-down gaps — data.rcsb.org blips are transient, and the old silent
  // fallback (a bare title=ID card) both blinded the round-50 relevance
  // filter ("when uncertain, KEEP") and flooded projects with unverifiable
  // pinned sources. Ids failing BOTH passes are dropped and surfaced in
  // filteredOut instead of being returned as junk.
  const pmidByPdb = new Map<string, string>();

  const slots = await runWithConcurrency(ids, 6, (id) =>
    buildRcsbItem(id, pmidByPdb).catch((err: any) => {
      console.warn(
        `[searchRcsb] metadata fetch failed for ${id}: ${err?.message?.slice(0, 100)}`
      );
      return null;
    })
  );

  // Rescue pass — sequential, gentle, original ranking order preserved.
  const items: DatabaseResultItem[] = [];
  const metaDropped: FilteredOutItem[] = [];
  for (let i = 0; i < ids.length; i++) {
    const item = slots[i];
    if (item) {
      items.push(item);
      continue;
    }
    const id = ids[i];
    await new Promise((r) => setTimeout(r, 350));
    try {
      items.push(await buildRcsbItem(id, pmidByPdb));
    } catch (err: any) {
      console.warn(
        `[searchRcsb] metadata rescue failed for ${id}: ${err?.message?.slice(0, 100)}`
      );
      metaDropped.push({
        externalId: id,
        title: id,
        reason: "RCSB metadata unavailable after retries — excluded (unverifiable source)",
      });
    }
  }

  // Enrich RCSB items that have a linked publication with REAL publication
  // metadata (title/authors/journal/year) from PubMed esummary.
  if (pmidByPdb.size > 0) {
    try {
      const pmids = [...new Set([...pmidByPdb.values()])];
      const esummaryUrl =
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmids.join(",")}&retmode=json`;
      // round-51: 1 retry — a single NCBI blip here used to strand every
      // RCSB-with-publication item at its structure-metadata fallback
      // (struct.title + rcsb.org URL instead of the real paper metadata).
      const sumData = await withRetry(() => fetchJson(esummaryUrl), 1, 800);
      const sumResult = sumData?.result ?? {};
      for (const item of items) {
        if (item.source !== "rcsb") continue;
        const pmid = pmidByPdb.get(String(item.externalId));
        if (!pmid) continue;
        const r = sumResult[pmid];
        if (!r) continue;
        const authors = (r.authors || [])
          .map((a: any) => a.name)
          .filter(Boolean)
          .join(", ");
        if (r.title) item.title = String(r.title).replace(/\.$/, "");
        if (authors) item.authors = authors;
        if (r.fulljournalname || r.source) {
          item.journal = r.fulljournalname || r.source;
        }
        const yr = (r.pubdate?.match(/\d{4}/) || [])[0];
        if (yr) item.year = yr;
        item.url = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
        if (item.extra) {
          (item.extra as any).pubmedId = pmid;
        }
      }
    } catch (err: any) {
      console.warn("[searchRcsb] pubmed enrichment failed:", err?.message?.slice(0, 100));
    }
  }

  /* round-50: LLM relevance filter — full-text retrieval routinely mixes in
   * entries whose primary subject is a DIFFERENT protein that merely mentions
   * the query term. Conservative: uncertain/failure keeps the entry; the
   * citation planner re-scores the pool later anyway.
   * round-51: entries dropped for unavailable metadata (rescue pass failed)
   * merge into the same transparency list. */
  let finalItems = items;
  let filteredOut: FilteredOutItem[] | undefined;
  const allDrops: FilteredOutItem[] = [...metaDropped];
  if (doFilter && items.length > 1) {
    const r = await filterItemsByRelevance(items, cleaned, enhance.context);
    finalItems = r.kept;
    allDrops.push(...r.dropped);
  }
  if (allDrops.length > 0) filteredOut = allDrops;
  if (finalItems.length > limit) finalItems = finalItems.slice(0, limit);

  return {
    source: "rcsb",
    query: cleaned,
    total,
    items: finalItems,
    variants: multiVariant ? variants : undefined,
    filteredOut,
  };
}

/* ---------------- NCBI Gene ---------------- */
export async function searchNcbiGene(
  query: string,
  retmax = 10
): Promise<DatabaseQueryResponse> {
  const cleaned = query.trim();
  const esearch = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=gene&term=${encodeURIComponent(
    cleaned
  )}&retmax=${retmax}&retmode=json`;
  const esData = await fetchJson(esearch);
  const ids: string[] = esData?.esearchresult?.idlist ?? [];
  const total = parseInt(esData?.esearchresult?.count ?? "0", 10);

  if (ids.length === 0) {
    return { source: "ncbi", query: cleaned, total: 0, items: [] };
  }

  const esummary = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gene&id=${ids.join(
    ","
  )}&retmode=json`;
  const sumData = await fetchJson(esummary);
  const result = sumData?.result ?? {};

  const items: DatabaseResultItem[] = ids.map((id) => {
    const r = result[id];
    if (!r) return null;
    return {
      source: "ncbi",
      externalId: id,
      title: r.name ? `${r.name} — ${r.description || ""}`.trim() : r.description || id,
      authors: r.organism?.scientificname || r.organism?.commonname,
      journal: "NCBI Gene",
      year: undefined,
      url: `https://www.ncbi.nlm.nih.gov/gene/${id}`,
      abstract: r.summary || undefined,
      extra: {
        symbol: r.name || "",
        chromosome: r.chromosome || "",
        maplocation: r.maplocation || "",
        organism: r.organism?.scientificname || "",
      },
    };
  }).filter(Boolean) as DatabaseResultItem[];

  return { source: "ncbi", query: cleaned, total, items };
}

/* ---------------- BLAST (RID polling) ---------------- */
export async function runBlast(
  sequence: string,
  opts: { program?: "blastp" | "blastn"; database?: string } = {}
): Promise<DatabaseQueryResponse> {
  const program = opts.program ?? "blastp";
  const database = opts.database ?? "nr";
  const cleaned = sequence.replace(/\s+/g, "").slice(0, 4000);
  if (!cleaned) {
    return { source: "blast", query: sequence.slice(0, 200), total: 0, items: [] };
  }

  // Submit BLAST job
  const putParams = new URLSearchParams({
    CMD: "Put",
    PROGRAM: program,
    DATABASE: database,
    QUERY: sequence,
    HITLIST_SIZE: "10",
    EXPECT: "10",
    FORMAT_TYPE: "JSON2",
  });
  const putRes = await fetchText(
    "https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: putParams.toString(),
    }
  );
  const ridMatch = putRes.match(/RID\s*=\s*(\S+)/);
  if (!ridMatch) {
    throw new Error("Failed to obtain BLAST RID");
  }
  const rid = ridMatch[1];

  // Poll for readiness (max ~60s)
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const checkParams = new URLSearchParams({
      CMD: "Get",
      RID: rid,
      FORMAT_OBJECT: "SearchInfo",
    });
    const info = await fetchText(
      "https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi?" + checkParams.toString()
    );
    const statusMatch = info.match(/Status=(\w+)/);
    const status = statusMatch?.[1];
    if (status === "READY") {
      ready = true;
      break;
    }
    if (status === "FAILED" || status === "UNKNOWN") {
      throw new Error(`BLAST job ${status.toLowerCase()} (RID=${rid})`);
    }
  }
  if (!ready) {
    return {
      source: "blast",
      query: `RID=${rid}`,
      total: 0,
      items: [],
      rawSnippet: `BLAST job ${rid} is still running. Try again later.`,
    };
  }

  // Fetch JSON2 results
  const getParams = new URLSearchParams({
    CMD: "Get",
    RID: rid,
    FORMAT_TYPE: "JSON2",
    ALIGNMENTS: "10",
    DESCRIPTIONS: "10",
  });
  const raw = await fetchText(
    "https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi?" + getParams.toString()
  );

  let hits: any[] = [];
  try {
    const parsed = JSON.parse(raw);
    hits = parsed?.BlastOutput2?.[0]?.report?.results?.search?.hits ?? [];
  } catch {
    // fallback: not JSON
  }

  const items: DatabaseResultItem[] = hits.slice(0, 10).map((h: any) => {
    const desc = h.description?.[0] || {};
    const hsps = h.hsps?.[0] || {};
    const acc = desc.accession || h.num;
    const title = desc.title || desc.accession || `Hit ${h.num}`;
    return {
      source: "blast",
      externalId: acc,
      title,
      authors: desc.taxid ? `taxid:${desc.taxid}` : desc.sciname,
      journal: `${program} vs ${database}`,
      year: undefined,
      url: `https://www.ncbi.nlm.nih.gov/protein/${acc}`,
      abstract: [
        hsps["bit-score"] ? `Bit-score: ${hsps["bit-score"]}` : "",
        hsps.evalue ? `E-value: ${hsps.evalue}` : "",
        hsps.identity ? `Identity: ${hsps.identity}/${hsps.align_len}` : "",
        hsps["positive"] ? `Positives: ${hsps["positive"]}/${hsps.align_len}` : "",
      ].filter(Boolean).join(" · "),
      extra: {
        score: hsps["bit-score"] ? String(hsps["bit-score"]) : "",
        evalue: hsps.evalue ? String(hsps.evalue) : "",
        identity: hsps.identity ? `${hsps.identity}/${hsps.align_len}` : "",
      },
    };
  });

  return {
    source: "blast",
    query: sequence.slice(0, 120),
    total: items.length,
    items,
    rawSnippet: `BLAST ${program} vs ${database} · RID=${rid}`,
  };
}

/* ---------------- PubMed summaries by PMID (round-35) ---------------- */

export interface PubMedSummary {
  title: string;
  authors?: string;
  journal?: string;
  year?: string;
  doi?: string;
}

/**
 * Batch-fetch authoritative esummary records for a list of PMIDs.
 *
 * round-35: sources saved with an externalId (PMID) but missing
 * authors/year/journal can be completed from PubMed's OWN record for that
 * PMID — zero hallucination risk, unlike LLM fills. Chunks of 200 PMIDs per
 * request (E-utilities recommended max).
 */
export async function fetchPubMedSummaries(
  pmids: string[]
): Promise<Map<string, PubMedSummary>> {
  const out = new Map<string, PubMedSummary>();
  const clean = [...new Set(pmids.map((p) => String(p).trim()).filter(Boolean))];
  for (let i = 0; i < clean.length; i += 200) {
    const chunk = clean.slice(i, i + 200);
    try {
      const url =
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${chunk.join(",")}&retmode=json`;
      const data = await withRetry(() => fetchJson(url), 2, 800);
      const result = data?.result ?? {};
      for (const id of chunk) {
        const r = result[id];
        if (!r || r.error) continue;
        const authors = (r.authors || [])
          .map((a: any) => a.name)
          .filter(Boolean)
          .join(", ");
        out.set(id, {
          title: String(r.title || "").replace(/\.$/, ""),
          authors: authors || undefined,
          journal: r.fulljournalname || r.source || undefined,
          year: (String(r.pubdate || "").match(/\d{4}/) || [])[0],
          doi: r.elocationid?.startsWith?.("doi:")
            ? String(r.elocationid).replace("doi:", "").trim()
            : (r.articleids || []).find((a: any) => a.idtype === "doi")?.value,
        });
      }
    } catch {
      // One failed chunk must not poison the whole backfill — the LLM
      // knowledge pass still runs afterwards on whatever stayed missing.
    }
  }
  return out;
}

/* ---------------- Crossref (round-35 verification channel) ---------------- */

function crossrefItemToResultItem(msg: any): DatabaseResultItem {
  const authors = (msg.author || [])
    .map((a: any) => `${a.family || ""} ${a.given || ""}`.trim())
    .filter(Boolean)
    .join(", ");
  // Crossref titles often carry inline markup ("Crystal Structure of
  // <i>Escherichia coli</i> MscS") and embedded newlines — strip both.
  const title = String(msg.title?.[0] || "(untitled)")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const year = String(
    msg.issued?.["date-parts"]?.[0]?.[0] ||
      msg.published?.["date-parts"]?.[0]?.[0] ||
      msg.created?.["date-parts"]?.[0]?.[0] ||
      ""
  ).slice(0, 4);
  const abstract = msg.abstract
    ? String(msg.abstract)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 800)
    : undefined;
  return {
    source: "crossref",
    externalId: String(msg.DOI || "").toLowerCase(),
    title,
    authors: authors || undefined,
    journal:
      msg["container-title"]?.[0] ||
      msg["short-container-title"]?.[0] ||
      undefined,
    year: /^\d{4}$/.test(year) ? year : undefined,
    url: msg.URL || (msg.DOI ? `https://doi.org/${msg.DOI}` : ""),
    doi: String(msg.DOI || "").toLowerCase() || undefined,
    abstract: abstract || undefined,
    extra: {
      crossrefType: msg.type,
      publisher: msg.publisher,
    },
  };
}

/**
 * Crossref bibliographic (title-ish) search — the second verification
 * channel for LLM-suggested gap sources (round-35). PubMed title search
 * misses preprints, non-indexed journals, and older landmark papers;
 * Crossref registers DOIs for ~160M works across all disciplines.
 * Relevance-ranked; callers must title-match the returned candidates.
 */
export async function searchCrossref(
  query: string,
  rows = 5
): Promise<DatabaseResultItem[]> {
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  const url =
    `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}` +
    `&rows=${rows}&select=DOI,title,author,issued,published,created,container-title,short-container-title,URL,abstract,type,publisher`;
  const data = await withRetry(
    () => fetchJson(url, undefined, 20000),
    2,
    1000
  );
  const items: any[] = data?.message?.items || [];
  return items
    .filter((m) => m?.DOI && m?.title?.[0])
    .map(crossrefItemToResultItem);
}

/**
 * Direct DOI lookup in the Crossref registry. Used to TEST an LLM-claimed
 * DOI (round-33 showed LLM DOIs are often plausible-but-wrong): if the DOI
 * resolves AND its registered title matches the suggestion, the claim was
 * right and we can trust the registry's full metadata.
 */
export async function lookupCrossrefDoi(doi: string): Promise<DatabaseResultItem | null> {
  const d = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "");
  if (!/^10\.\d{4,9}\/\S+$/i.test(d)) return null;
  const url = `https://api.crossref.org/works/${encodeURIComponent(d)}`;
  const data = await withRetry(
    () => fetchJson(url, undefined, 20000),
    1,
    1000
  );
  const msg = data?.message;
  if (!msg?.DOI) return null;
  return crossrefItemToResultItem(msg);
}

/* ---------------- Router ---------------- */
export interface QueryDatabaseOpts {
  program?: "blastp" | "blastn";
  database?: string;
  /** round-50: query variant expansion + LLM relevance filtering (applies
   * to pubmed + rcsb). Title-exact-match verification lookups must pass
   * { expandVariants: false, filterByLlm: false } — extra recall there
   * manufactures false positives. */
  searchOpts?: SearchEnhanceOpts;
}

export async function queryDatabase(
  source: DatabaseSource,
  query: string,
  opts: QueryDatabaseOpts = {}
): Promise<DatabaseQueryResponse> {
  switch (source) {
    case "pubmed":
      return searchPubMed(query, 20, opts.searchOpts);
    case "uniprot":
      return searchUniprot(query, 20);
    case "rcsb":
      return searchRcsb(query, 20, opts.searchOpts);
    case "ncbi":
      return searchNcbiGene(query, 20);
    case "blast":
      return runBlast(query, opts);
    default:
      throw new Error(`Unsupported database source: ${source}`);
  }
}
