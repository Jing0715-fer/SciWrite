import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/projects/[id]/import-references
 *
 * Bulk-import references from a .bib (BibTeX) or .ris file.
 *
 * Body: { content: string, format: "bib" | "ris", paragraphId?: string }
 *
 * The parser extracts structured fields (title, authors, journal, year, DOI,
 * etc.) from the file content and creates Reference records linked to the
 * project (and optionally a specific paragraph).
 *
 * Returns:
 *   {
 *     imported: number,
 *     skipped: number,
 *     total: number,
 *     details: [{ citationKey, title, status, fields: string[] }]
 *   }
 */

interface ParsedReference {
  citationKey?: string;
  title: string;
  authors?: string;
  journal?: string;
  year?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  type: string;
  externalId?: string;
}

// ── BibTeX parser ─────────────────────────────────────────────────────────────
// Handles entries like:
//   @article{smith2024,
//     title = {Deep learning for protein structure},
//     author = {Smith, John and Doe, Jane},
//     journal = {Nature},
//     year = {2024},
//     doi = {10.1038/...},
//     abstract = {...},
//   }
function parseBibTeX(content: string): ParsedReference[] {
  const refs: ParsedReference[] = [];
  // Match @type{key, ... } entries (non-greedy, handles nested braces)
  const entryRe = /@(\w+)\s*\{\s*([^,]+),\s*([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;

  while ((m = entryRe.exec(content))) {
    const entryType = m[1].toLowerCase();
    const citationKey = m[2].trim();
    const body = m[3];

    // Skip @comment, @string, @preamble
    if (["comment", "string", "preamble"].includes(entryType)) continue;

    // Extract fields: fieldname = {value} or fieldname = "value"
    const fields: Record<string, string> = {};
    const fieldRe = /(\w+)\s*=\s*[\{"]([\s\S]*?)[\}"]\s*,?(?=\s*\n|\s*$)/g;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(body))) {
      const fieldName = fm[1].toLowerCase();
      let value = fm[2];
      // Clean up: remove extra braces, normalize whitespace
      value = value.replace(/\{([^}]*)\}/g, "$1").replace(/\s+/g, " ").trim();
      fields[fieldName] = value;
    }

    // Map BibTeX fields to our schema
    const title = fields.title || fields.booktitle || "(untitled)";
    const rawAuthors = fields.author || "";
    const authors = rawAuthors
      .split(/\s+and\s+/)
      .map((a) => {
        // "Last, First" → "Last, First"; "First Last" → "Last, First"
        const parts = a.split(",").map((p) => p.trim());
        if (parts.length === 2) return `${parts[0]}, ${parts[1]}`;
        const nameParts = a.trim().split(/\s+/);
        if (nameParts.length >= 2) {
          const last = nameParts[nameParts.length - 1];
          const first = nameParts.slice(0, -1).join(" ");
          return `${last}, ${first}`;
        }
        return a.trim();
      })
      .filter(Boolean)
      .join(", ");

    // Map entry type to our type field
    const typeMap: Record<string, string> = {
      article: "journal",
      inproceedings: "proceedings",
      book: "book",
      incollection: "book",
      phdthesis: "thesis",
      mastersthesis: "thesis",
      techreport: "report",
      misc: "manual",
      unpublished: "manual",
    };
    const type = typeMap[entryType] || "manual";

    refs.push({
      citationKey,
      title: title.replace(/\.$/, ""),
      authors: authors || undefined,
      journal: fields.journal || fields.booktitle || undefined,
      year: fields.year || undefined,
      doi: fields.doi?.replace(/^doi:/, "") || undefined,
      url: fields.url || undefined,
      abstract: fields.abstract?.slice(0, 1000) || undefined,
      type,
      externalId: fields.doi?.replace(/^doi:/, "") || undefined,
    });
  }

  return refs;
}

// ── RIS parser ────────────────────────────────────────────────────────────────
// Handles entries like:
//   TY  - JOUR
//   AU  - Smith, John
//   TI  - Deep learning for protein structure
//   JO  - Nature
//   PY  - 2024
//   DO  - 10.1038/...
//   ER  -
function parseRIS(content: string): ParsedReference[] {
  const refs: ParsedReference[] = [];
  const entries = content.split(/\nER\s*-\s*\n?/);

  for (const entry of entries) {
    if (!entry.trim()) continue;

    const fields: Record<string, string[]> = {};
    const lines = entry.split("\n");
    let currentTag = "";
    let currentValue = "";

    for (const line of lines) {
      const match = line.match(/^(\w{2})\s*-\s*(.*)$/);
      if (match) {
        if (currentTag) {
          if (!fields[currentTag]) fields[currentTag] = [];
          fields[currentTag].push(currentValue.trim());
        }
        currentTag = match[1];
        currentValue = match[2];
      } else if (currentTag && line.trim()) {
        // Continuation of previous line
        currentValue += " " + line.trim();
      }
    }
    if (currentTag) {
      if (!fields[currentTag]) fields[currentTag] = [];
      fields[currentTag].push(currentValue.trim());
    }

    const title = fields.TI?.[0] || fields.T1?.[0] || fields.ST?.[0] || "(untitled)";
    const authors = (fields.AU || fields.A1 || fields.A2 || [])
      .map((a) => {
        const parts = a.split(",").map((p) => p.trim());
        if (parts.length === 2) return `${parts[0]}, ${parts[1]}`;
        return a;
      })
      .filter(Boolean)
      .join(", ");

    const typeMap: Record<string, string> = {
      JOUR: "journal",
      CONF: "proceedings",
      BOOK: "book",
      CHAP: "book",
      THES: "thesis",
      RPRT: "report",
      ELEC: "web",
      UNPB: "manual",
    };
    const risType = fields.TY?.[0] || "JOUR";
    const type = typeMap[risType] || "manual";

    refs.push({
      citationKey: fields.ID?.[0] || fields.C1?.[0],
      title: title.replace(/\.$/, ""),
      authors: authors || undefined,
      journal: fields.JO?.[0] || fields.JF?.[0] || fields.JA?.[0] || undefined,
      year: fields.PY?.[0] || fields.Y1?.[0] || undefined,
      doi: fields.DO?.[0]?.replace(/^doi:/, ""),
      url: fields.UR?.[0] || fields.LK?.[0] || undefined,
      abstract: fields.AB?.[0]?.slice(0, 1000) || undefined,
      type,
      externalId: fields.DO?.[0] || undefined,
    });
  }

  return refs;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const content = String(body.content || "");
    const format = String(body.format || "bib").toLowerCase();
    const paragraphId = body.paragraphId || null;

    if (!content.trim()) {
      return NextResponse.json(
        { error: "File content is empty." },
        { status: 400 },
      );
    }

    const project = await db.project.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    // Parse the content
    let parsed: ParsedReference[];
    try {
      parsed = format === "ris" ? parseRIS(content) : parseBibTeX(content);
    } catch (err: any) {
      return NextResponse.json(
        { error: `Failed to parse ${format.toUpperCase()} file: ${err?.message || "invalid format"}` },
        { status: 400 },
      );
    }

    if (parsed.length === 0) {
      return NextResponse.json({
        imported: 0,
        skipped: 0,
        total: 0,
        details: [],
        message: `No valid entries found in the ${format.toUpperCase()} file.`,
      });
    }

    // Deduplicate by DOI (if present) or title
    const seen = new Set<string>();
    const unique: ParsedReference[] = [];
    let skipped = 0;
    for (const ref of parsed) {
      const key = ref.doi
        ? `doi:${ref.doi}`
        : ref.title.toLowerCase().slice(0, 100);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      unique.push(ref);
    }

    // Also check against existing references in the project to avoid duplicates
    const existingRefs = await db.reference.findMany({
      where: {
        OR: [
          { projectId: id },
          { paragraph: { projectId: id } },
        ],
      },
      select: { doi: true, title: true },
    });
    const existingKeys = new Set(
      existingRefs
        .filter((r) => r.doi || r.title)
        .map((r) => (r.doi ? `doi:${r.doi}` : r.title.toLowerCase().slice(0, 100))),
    );

    const toCreate: ParsedReference[] = [];
    const details: any[] = [];
    for (const ref of unique) {
      const key = ref.doi
        ? `doi:${ref.doi}`
        : ref.title.toLowerCase().slice(0, 100);
      if (existingKeys.has(key)) {
        skipped++;
        details.push({
          citationKey: ref.citationKey || "",
          title: ref.title.slice(0, 60),
          status: "duplicate",
          fields: [],
        });
        continue;
      }
      toCreate.push(ref);
      details.push({
        citationKey: ref.citationKey || "",
        title: ref.title.slice(0, 60),
        status: "imported",
        fields: [
          ref.authors ? "authors" : null,
          ref.year ? "year" : null,
          ref.journal ? "journal" : null,
          ref.doi ? "doi" : null,
          ref.abstract ? "abstract" : null,
        ].filter(Boolean),
      });
    }

    // Batch create
    let imported = 0;
    if (toCreate.length > 0) {
      const result = await db.reference.createMany({
        data: toCreate.map((ref) => ({
          type: ref.type,
          externalId: ref.externalId || null,
          title: ref.title,
          authors: ref.authors || null,
          journal: ref.journal || null,
          year: ref.year || null,
          url: ref.url || null,
          doi: ref.doi || null,
          abstract: ref.abstract || null,
          citationKey: ref.citationKey || null,
          projectId: id,
          paragraphId: paragraphId || null,
        })),
      });
      imported = result.count;
    }

    return NextResponse.json({
      imported,
      skipped,
      total: parsed.length,
      details: details.slice(0, 100), // cap details at 100 for response size
    });
  } catch (err: any) {
    console.error("[/api/projects/[id]/import-references] error:", err);
    return NextResponse.json(
      { error: err?.message || "Import failed." },
      { status: 500 },
    );
  }
}
