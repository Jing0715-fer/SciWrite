import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/references/search-by-title
 *
 * Search CrossRef by bibliographic query (title + optional author) and
 * return the top N matches with normalized metadata. Used by the
 * AddReferenceDialog's "search by title" mode to help users find the
 * correct DOI for a reference they only know by name.
 *
 * Body: { query: string, rows?: number (default 5) }
 *
 * Returns:
 *   {
 *     results: [{
 *       doi, title, authors, journal, year, url, abstract,
 *       similarity: number (0-1, title match score)
 *     }],
 *     total: number
 *   }
 */

const UA =
  "SciWriteAssistant/1.0 (mailto:support@sciwrite.app; +https://sciwrite.app)";

function titleSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection++;
  const union = sa.size + sb.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const query = String(body.query || "").trim();
    const rows = Math.min(Number(body.rows) || 5, 20);

    if (!query || query.length < 3) {
      return NextResponse.json(
        { error: "Query must be at least 3 characters." },
        { status: 400 },
      );
    }

    const crossrefUrl = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(
      query,
    )}&rows=${rows}&select=DOI,title,author,container-title,published,abstract,URL,type&mailto=support@sciwrite.app`;

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    let data: any;
    try {
      const res = await fetch(crossrefUrl, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        return NextResponse.json(
          { error: `CrossRef returned HTTP ${res.status}.` },
          { status: 502 },
        );
      }
      data = await res.json();
    } finally {
      clearTimeout(t);
    }

    const items: any[] = data?.message?.items || [];
    const results = items
      .map((item) => {
        const itemTitle = item.title?.[0]?.replace(/\.$/, "") || "";
        const similarity = titleSimilarity(query, itemTitle);
        const authors = (item.author || [])
          .map((a: any) => `${a.family || ""} ${a.given || ""}`.trim())
          .filter(Boolean)
          .join(", ");
        const year = item.published?.["date-parts"]?.[0]?.[0]?.toString();
        const journal =
          item["container-title"]?.[0] ||
          item["short-container-title"]?.[0] ||
          undefined;
        const abstract = item.abstract
          ? item.abstract.replace(/<[^>]+>/g, "").slice(0, 500)
          : undefined;
        return {
          doi: item.DOI || undefined,
          title: itemTitle,
          authors: authors || undefined,
          journal,
          year,
          url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : undefined),
          abstract,
          type: item.type || "journal-article",
          similarity: Math.round(similarity * 100) / 100,
        };
      })
      .sort((a, b) => b.similarity - a.similarity);

    return NextResponse.json({
      results,
      total: results.length,
    });
  } catch (err: any) {
    console.error("[/api/references/search-by-title] error:", err);
    return NextResponse.json(
      { error: err?.message || "Title search failed." },
      { status: 500 },
    );
  }
}
