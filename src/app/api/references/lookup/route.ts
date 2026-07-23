import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const UA =
  "Mozilla/5.0 (compatible; SciWriteAssistant/1.0; +https://example.com/sciwrite)";

async function fetchJson(url: string, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
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

/* Lookup by PMID via NCBI E-utilities */
async function lookupPmid(pmid: string) {
  const esummary = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(
    pmid
  )}&retmode=json`;
  const data = await fetchJson(esummary);
  const result = data?.result;
  if (!result || !result[pmid]) {
    throw new Error(`PMID ${pmid} not found.`);
  }
  const r = result[pmid];
  const authors = (r.authors || [])
    .map((a: any) => a.name)
    .filter(Boolean)
    .join(", ");
  const doi = r.elocationid?.startsWith("doi:")
    ? r.elocationid.replace("doi:", "").trim()
    : undefined;
  return {
    type: "pubmed",
    externalId: pmid,
    title: r.title?.replace(/\.$/, "") ?? "(untitled)",
    authors: authors || undefined,
    journal: r.fulljournalname || r.source || undefined,
    year: r.pubdate?.slice(0, 4),
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    doi,
    abstract: r.abstract || undefined,
  };
}

/* Lookup by DOI via CrossRef API */
async function lookupDoi(doi: string) {
  const crossref = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(crossref, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`DOI lookup failed (HTTP ${res.status}). DOI may be invalid.`);
    }
    const data = await res.json();
    const msg = data?.message;
    if (!msg) throw new Error("CrossRef returned no message.");
    const authors = (msg.author || [])
      .map((a: any) => `${a.family || ""} ${a.given || ""}`.trim())
      .filter(Boolean)
      .join(", ");
    const title = msg.title?.[0] || "(untitled)";
    const journal =
      msg["container-title"]?.[0] ||
      msg["short-container-title"]?.[0] ||
      undefined;
    const year = msg.published?.["date-parts"]?.[0]?.[0]?.toString();
    const abstract = msg.abstract
      ? msg.abstract.replace(/<[^>]+>/g, "").slice(0, 800)
      : undefined;
    return {
      type: "manual",
      externalId: doi,
      title,
      authors: authors || undefined,
      journal,
      year,
      url: msg.URL || `https://doi.org/${doi}`,
      doi,
      abstract,
    };
  } finally {
    clearTimeout(t);
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type");
    const id = searchParams.get("id")?.trim();
    if (!type || !id) {
      return NextResponse.json(
        { error: "Missing 'type' or 'id'." },
        { status: 400 }
      );
    }
    if (type === "pmid") {
      const result = await lookupPmid(id);
      return NextResponse.json(result);
    }
    if (type === "doi") {
      const result = await lookupDoi(id);
      return NextResponse.json(result);
    }
    return NextResponse.json(
      { error: "Unsupported lookup type. Use 'pmid' or 'doi'." },
      { status: 400 }
    );
  } catch (err: any) {
    console.error("[/api/references/lookup] error:", err);
    return NextResponse.json(
      { error: err?.message || "Lookup failed." },
      { status: 500 }
    );
  }
}
