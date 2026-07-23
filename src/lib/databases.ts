import type { DatabaseQueryResponse, DatabaseResultItem, DatabaseSource } from "./types";

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
export async function searchPubMed(query: string, retmax = 10): Promise<DatabaseQueryResponse> {
  const cleaned = query.trim();
  const esearch = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(
    cleaned
  )}&retmax=${retmax}&retmode=json&sort=relevance`;
  const esData = await fetchJson(esearch);
  const ids: string[] = esData?.esearchresult?.idlist ?? [];
  const total = parseInt(esData?.esearchresult?.count ?? "0", 10);

  if (ids.length === 0) {
    return { source: "pubmed", query: cleaned, total: 0, items: [] };
  }

  const esummary = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(
    ","
  )}&retmode=json`;
  const sumData = await fetchJson(esummary);
  const result = sumData?.result ?? {};

  const items: DatabaseResultItem[] = ids.map((id) => {
    const r = result[id];
    if (!r) return null;
    const authors = (r.authors || [])
      .map((a: any) => a.name)
      .filter(Boolean)
      .join(", ");
    return {
      source: "pubmed",
      externalId: id,
      title: r.title?.replace(/\.$/, "") ?? "(untitled)",
      authors: authors || undefined,
      journal: r.fulljournalname || r.source || undefined,
      year: r.pubdate?.slice(0, 4),
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      doi: r.elocationid?.startsWith("doi:")
        ? r.elocationid.replace("doi:", "").trim()
        : undefined,
      abstract: r.abstract || undefined,
      extra: {
        pubdate: r.pubdate,
        pubtype: Array.isArray(r.pubtype) ? r.pubtype.join(", ") : r.pubtype,
      },
    };
  }).filter(Boolean) as DatabaseResultItem[];

  return { source: "pubmed", query: cleaned, total, items };
}

/* ---------------- UniProt ---------------- */
export async function searchUniprot(
  query: string,
  size = 10
): Promise<DatabaseQueryResponse> {
  const cleaned = query.trim();
  const url = `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(
    cleaned
  )}&format=json&size=${size}`;
  const data = await fetchJson(url);
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
export async function searchRcsb(
  query: string,
  limit = 10
): Promise<DatabaseQueryResponse> {
  const cleaned = query.trim();
  const body = {
    query: {
      type: "group",
      logical_operator: "and",
      nodes: [
        {
          type: "terminal",
          service: "full_text",
          parameters: {
            value: cleaned,
          },
        },
      ],
    },
    return_type: "entry",
    request_options: {
      paginate: { start: 0, rows: limit },
      results_content_type: ["experimental"],
      sort: [{ sort_by: "score", direction: "desc" }],
    },
  };
  const url = "https://search.rcsb.org/rcsbsearch/v2/query?json=" + encodeURIComponent(JSON.stringify(body));
  const data = await fetchJson(url);
  const total = data?.total_count ?? 0;
  const resultSet = data?.result_set ?? [];
  const ids = resultSet.map((r: any) => r.identifier);

  const items: DatabaseResultItem[] = [];
  for (const id of ids) {
    try {
      const meta = await fetchJson(`https://data.rcsb.org/rest/v1/core/entry/${id}`);
      const title = meta?.struct?.title || id;
      const method = meta?.exptl?.[0]?.method;
      const res = meta?.rcsb_entry_info?.resolution_combined?.[0];
      const org = meta?.rcsb_entry_info?.organism_scientific_name?.join(", ");
      const date = meta?.rcsb_accession_info?.initial_release_date;

      // Fetch associated publication via RCSB API
      let pubTitle = title || id;
      let pubAuthors = org;
      let pubJournal = method ? `PDB · ${method}` : "RCSB PDB";
      let pubYear = date?.slice(0, 4);
      let pubDoi = meta?.rcsb_entry_container_identifiers?.doi;
      let pubAbstract = [
        method ? `Method: ${method}` : "",
        res ? `Resolution: ${res} Å` : "",
        org ? `Organism: ${org}` : "",
      ].filter(Boolean).join(" · ");

      try {
        const pubData = await fetchJson(`https://data.rcsb.org/rest/v1/core/pubmed/${id}`);
        if (pubData) {
          // Use the publication info as the primary reference
          pubTitle = pubData?.title || pubTitle;
          pubAuthors = pubData?.authors?.map((a: any) => a.name).join(", ") || pubAuthors;
          pubJournal = pubData?.journal_abbreviation || pubData?.journal || pubJournal;
          pubYear = pubData?.pub_date?.slice(0, 4) || pubYear;
          pubDoi = pubData?.doi || pubDoi;
          pubAbstract = pubData?.abstract || pubAbstract;
        }
      } catch {
        // No associated publication — use structure metadata only
      }

      items.push({
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
          hasPublication: pubTitle !== (title || id),
        },
      });
    } catch {
      items.push({
        source: "rcsb",
        externalId: id,
        title: id,
        url: `https://www.rcsb.org/structure/${id}`,
      });
    }
  }

  return { source: "rcsb", query: cleaned, total, items };
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

/* ---------------- Router ---------------- */
export async function queryDatabase(
  source: DatabaseSource,
  query: string,
  opts: { program?: "blastp" | "blastn"; database?: string } = {}
): Promise<DatabaseQueryResponse> {
  switch (source) {
    case "pubmed":
      return searchPubMed(query, 10);
    case "uniprot":
      return searchUniprot(query, 10);
    case "rcsb":
      return searchRcsb(query, 10);
    case "ncbi":
      return searchNcbiGene(query, 10);
    case "blast":
      return runBlast(query, opts);
    default:
      throw new Error(`Unsupported database source: ${source}`);
  }
}
