import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/projects/[id]/enrich-references
 *
 * Batch-enrich references that have incomplete metadata by querying the
 * CrossRef API. Two strategies:
 *
 *  1. DOI-based (preferred): references that already have a `doi` but are
 *     missing authors/year/journal/abstract → fetch full metadata from
 *     CrossRef `works/{doi}` endpoint.
 *
 *  2. Title-based (fallback): references with NO doi but a non-empty title →
 *     search CrossRef `works?query.bibliographic={title}` and take the top
 *     match if its title similarity is high (Jaccard ≥ 0.5 on token sets).
 *
 * The endpoint processes up to 50 references per call to stay within the
 * 60s timeout. References that already have complete metadata are skipped.
 *
 * Returns:
 *   {
 *     enriched: number,
 *     skipped: number,
 *     failed: number,
 *     details: [{ id, title, strategy, fields: string[], status }]
 *   }
 */

const UA =
  "SciWriteAssistant/1.0 (mailto:support@sciwrite.app; +https://sciwrite.app)";
const CROSSREF_BASE = "https://api.crossref.org/works";

interface CrossRefMessage {
  DOI?: string;
  title?: string[];
  author?: { family?: string; given?: string; ORCID?: string }[];
  "container-title"?: string[];
  "short-container-title"?: string[];
  published?: { "date-parts"?: number[][] };
  abstract?: string;
  URL?: string;
  type?: string;
  publisher?: string;
  ISSN?: string[];
}

/** Fetch with timeout + retry. */
async function fetchJson(url: string, timeoutMs = 12000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Be polite to CrossRef — add mailto for the "polite pool" (higher rate limits)
    const politeUrl = url.includes("?")
      ? `${url}&mailto=support@sciwrite.app`
      : `${url}?mailto=support@sciwrite.app`;
    const res = await fetch(politeUrl, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Normalize CrossRef message → our reference shape. */
function normalizeCrossRef(msg: CrossRefMessage, fallbackTitle: string) {
  const authors = (msg.author || [])
    .map((a) => `${a.family || ""} ${a.given || ""}`.trim())
    .filter(Boolean)
    .join(", ");
  const title = msg.title?.[0]?.replace(/\.$/, "") || fallbackTitle;
  const journal =
    msg["container-title"]?.[0] ||
    msg["short-container-title"]?.[0] ||
    undefined;
  const year = msg.published?.["date-parts"]?.[0]?.[0]?.toString();
  const abstract = msg.abstract
    ? msg.abstract.replace(/<[^>]+>/g, "").slice(0, 1000)
    : undefined;
  return {
    doi: msg.DOI || undefined,
    title,
    authors: authors || undefined,
    journal,
    year,
    url: msg.URL || (msg.DOI ? `https://doi.org/${msg.DOI}` : undefined),
    abstract,
  };
}

/** Token-set Jaccard similarity for title matching (0-1). */
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

/** Sleep helper for rate-limit politeness. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const project = await db.project.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  // Fetch all references for this project (project-level + paragraph-level)
  const references = await db.reference.findMany({
    where: { OR: [{ projectId: id }, { paragraph: { projectId: id } }] },
    take: 200, // safety cap
  });

  // A reference "needs enrichment" if it has a DOI but is missing authors/year/journal,
  // OR if it has no DOI but has a title (try title search).
  const needsEnrichment = references.filter((r) => {
    const hasCompleteMeta = r.authors && r.year && r.journal;
    if (hasCompleteMeta) return false;
    if (r.doi) return true; // DOI-based enrichment
    if (r.title && r.title.length > 10) return true; // title-based search
    return false;
  });

  if (needsEnrichment.length === 0) {
    return NextResponse.json({
      enriched: 0,
      skipped: references.length,
      failed: 0,
      details: [],
      message: "All references already have complete metadata.",
    });
  }

  // Process up to 50 to stay within timeout
  const toProcess = needsEnrichment.slice(0, 50);
  const details: any[] = [];
  let enriched = 0;
  let failed = 0;

  for (const ref of toProcess) {
    try {
      let crossRefData: ReturnType<typeof normalizeCrossRef> | null = null;
      let strategy = "";

      // ── Strategy 1: DOI lookup ──────────────────────────────────────────
      if (ref.doi) {
        strategy = "doi";
        try {
          const data = await fetchJson(
            `${CROSSREF_BASE}/${encodeURIComponent(ref.doi)}`,
          );
          if (data?.message) {
            crossRefData = normalizeCrossRef(data.message, ref.title);
          }
        } catch (err: any) {
          // DOI lookup failed — fall through to title search if we have a title
          if (!ref.title || ref.title.length < 10) throw err;
          strategy = "doi→title";
        }
      }

      // ── Strategy 2: Title search ────────────────────────────────────────
      if (!crossRefData && ref.title && ref.title.length > 10) {
        if (strategy !== "doi→title") strategy = "title";
        const searchUrl = `${CROSSREF_BASE}?query.bibliographic=${encodeURIComponent(
          ref.title,
        )}&rows=3`;
        const data = await fetchJson(searchUrl);
        const items: CrossRefMessage[] = data?.message?.items || [];
        // Find the best-matching title
        let bestMatch: { msg: CrossRefMessage; score: number } | null = null;
        for (const item of items) {
          const itemTitle = item.title?.[0] || "";
          const score = titleSimilarity(ref.title, itemTitle);
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { msg: item, score };
          }
        }
        // Only accept if similarity ≥ 0.5 (avoids wrong matches)
        if (bestMatch && bestMatch.score >= 0.5) {
          crossRefData = normalizeCrossRef(bestMatch.msg, ref.title);
        } else {
          throw new Error(
            `No confident title match (best score: ${bestMatch?.score.toFixed(2) || 0})`,
          );
        }
      }

      if (!crossRefData) {
        throw new Error("No enrichment data available.");
      }

      // ── Update only the missing fields (don't overwrite existing data) ──
      const updateData: Record<string, string> = {};
      if (!ref.authors && crossRefData.authors)
        updateData.authors = crossRefData.authors;
      if (!ref.year && crossRefData.year) updateData.year = crossRefData.year;
      if (!ref.journal && crossRefData.journal)
        updateData.journal = crossRefData.journal;
      if (!ref.doi && crossRefData.doi) updateData.doi = crossRefData.doi;
      if (!ref.url && crossRefData.url) updateData.url = crossRefData.url;
      if (!ref.abstract && crossRefData.abstract)
        updateData.abstract = crossRefData.abstract;
      // Always update title if the CrossRef one is more complete (longer)
      if (
        crossRefData.title &&
        crossRefData.title.length > ref.title.length
      ) {
        updateData.title = crossRefData.title;
      }

      const updatedFields = Object.keys(updateData);
      if (updatedFields.length > 0) {
        await db.reference.update({
          where: { id: ref.id },
          data: updateData,
        });
        enriched++;
        details.push({
          id: ref.id,
          title: ref.title.slice(0, 60),
          strategy,
          fields: updatedFields,
          status: "enriched",
        });
      } else {
        details.push({
          id: ref.id,
          title: ref.title.slice(0, 60),
          strategy,
          fields: [],
          status: "no-update",
        });
      }

      // Be polite to CrossRef — 200ms between requests
      await sleep(200);
    } catch (err: any) {
      failed++;
      details.push({
        id: ref.id,
        title: ref.title.slice(0, 60),
        strategy: ref.doi ? "doi" : "title",
        fields: [],
        status: "failed",
        error: err?.message?.slice(0, 100) || "Unknown error",
      });
    }
  }

  return NextResponse.json({
    enriched,
    skipped: references.length - toProcess.length,
    failed,
    total: references.length,
    processed: toProcess.length,
    details,
  });
}
