import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/projects/[id]/fix-references
 *
 * Automatically fixes common formatting issues in the project's references:
 *  1. Normalize author names: "John Smith" → "Smith J", "Smith, John" → "Smith J"
 *  2. Normalize year: extract 4-digit year from strings like "2024 Jan" or "2024;34(1)"
 *  3. Trim whitespace from all fields
 *  4. Normalize journal names (trim, remove trailing periods)
 *  5. Fix DOI format (ensure https://doi.org/ prefix)
 *  6. Fix URL format (ensure https:// prefix)
 *
 * Returns { fixed: N, total: M, details: [{id, field, old, new}] }
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const references = await db.reference.findMany({
    where: { projectId: id },
    take: 200,
  });

  if (references.length === 0) {
    return NextResponse.json({ fixed: 0, total: 0, details: [] });
  }

  const details: { id: string; field: string; old: string; new: string }[] = [];
  let fixedCount = 0;

  // Helper: normalize author names
  const normalizeAuthors = (authors: string): string => {
    if (!authors) return authors;
    return authors
      .split(/[,;]/)
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .map((name) => {
        // If "First Last" format → "Last F"
        const parts = name.split(/\s+/);
        if (parts.length >= 2) {
          const last = parts[parts.length - 1];
          const initials = parts.slice(0, -1).map((p) => p[0]?.toUpperCase() + ".").join(" ");
          return `${last} ${initials}`;
        }
        return name;
      })
      .join(", ");
  };

  // Helper: extract 4-digit year
  const extractYear = (s: string): string => {
    if (!s) return s;
    const match = s.match(/(19|20)\d{2}/);
    return match ? match[0] : s.trim();
  };

  // Helper: fix DOI
  const fixDoi = (doi: string): string => {
    if (!doi) return doi;
    const trimmed = doi.trim();
    if (trimmed.startsWith("https://doi.org/")) return trimmed;
    if (trimmed.startsWith("doi.org/")) return `https://${trimmed}`;
    if (trimmed.startsWith("doi:")) return `https://doi.org/${trimmed.slice(4)}`;
    if (/^10\.\d{4,}/.test(trimmed)) return `https://doi.org/${trimmed}`;
    return trimmed;
  };

  // Helper: fix URL
  const fixUrl = (url: string): string => {
    if (!url) return url;
    const trimmed = url.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
    if (trimmed.startsWith("www.")) return `https://${trimmed}`;
    return trimmed;
  };

  for (const ref of references) {
    const updates: Record<string, string> = {};
    let changed = false;

    // Authors
    if (ref.authors) {
      const normalized = normalizeAuthors(ref.authors);
      if (normalized !== ref.authors) {
        updates.authors = normalized;
        details.push({ id: ref.id, field: "authors", old: ref.authors.slice(0, 50), new: normalized.slice(0, 50) });
        changed = true;
      }
    }

    // Year
    if (ref.year) {
      const extracted = extractYear(ref.year);
      if (extracted !== ref.year) {
        updates.year = extracted;
        details.push({ id: ref.id, field: "year", old: ref.year, new: extracted });
        changed = true;
      }
    }

    // Journal — trim trailing period
    if (ref.journal) {
      const trimmed = ref.journal.trim().replace(/\.$/, "");
      if (trimmed !== ref.journal) {
        updates.journal = trimmed;
        details.push({ id: ref.id, field: "journal", old: ref.journal.slice(0, 50), new: trimmed.slice(0, 50) });
        changed = true;
      }
    }

    // Title — trim
    if (ref.title) {
      const trimmed = ref.title.trim();
      if (trimmed !== ref.title) {
        updates.title = trimmed;
        changed = true;
      }
    }

    // DOI
    if (ref.doi) {
      const fixed = fixDoi(ref.doi);
      if (fixed !== ref.doi) {
        updates.doi = fixed;
        details.push({ id: ref.id, field: "doi", old: ref.doi.slice(0, 50), new: fixed.slice(0, 50) });
        changed = true;
      }
    }

    // URL
    if (ref.url) {
      const fixed = fixUrl(ref.url);
      if (fixed !== ref.url) {
        updates.url = fixed;
        details.push({ id: ref.id, field: "url", old: ref.url.slice(0, 50), new: fixed.slice(0, 50) });
        changed = true;
      }
    }

    if (changed) {
      await db.reference.update({ where: { id: ref.id }, data: updates });
      fixedCount++;
    }
  }

  return NextResponse.json({
    fixed: fixedCount,
    total: references.length,
    details: details.slice(0, 50), // Cap details at 50 to keep response small
  });
}
