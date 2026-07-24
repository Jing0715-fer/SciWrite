import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatWithSession } from "@/lib/llm-session";
import { queryDatabase } from "@/lib/databases";

export const runtime = "nodejs";
export const maxDuration = 120;

// Auto-fix missing citations: for each unresolved marker, use AI to suggest
// a reference (and optionally query databases to find it), then save as a
// reference linked to the paragraph.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const paragraph = await db.paragraph.findUnique({
      where: { id },
      include: { references: true },
    });
    if (!paragraph) {
      return NextResponse.json({ error: "Paragraph not found." }, { status: 404 });
    }

    // 1. Identify missing citations (reuse validation logic)
    const content = paragraph.content;
    const references = paragraph.references;
    const citeHeaderIdx = content.indexOf("### Citations");
    const body = citeHeaderIdx >= 0 ? content.slice(0, citeHeaderIdx) : content;
    const citationsBlock = citeHeaderIdx >= 0 ? content.slice(citeHeaderIdx) : "";

    const markerRe = /\[(\d{1,3}(?:[,\-–]\s*\d{1,3})*|[A-Z]{2,12}:\s?[^\]\n]{1,60})\]/g;
    const markers: { full: string; inner: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(body))) {
      markers.push({ full: m[0], inner: m[1].trim() });
    }

    const aiCitationMap: Record<number, string> = {};
    for (const line of citationsBlock.split("\n")) {
      const lm = line.match(/^\s*\[(\d+)\]\s*(.+)$/);
      if (lm) aiCitationMap[parseInt(lm[1], 10)] = lm[2].trim();
    }

    const normalizeType = (t: string) => {
      const lt = t.toLowerCase();
      if (lt === "pmid") return "pubmed";
      if (lt === "pdb") return "rcsb";
      return lt;
    };

    const expandRange = (inner: string): number[] => {
      const nums: number[] = [];
      for (const p of inner.split(/[,;]\s*/)) {
        const rm = p.match(/^(\d+)\s*[-–]\s*(\d+)$/);
        if (rm) {
          for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) nums.push(n);
        } else {
          const n = parseInt(p, 10);
          if (!isNaN(n)) nums.push(n);
        }
      }
      return nums;
    };

    // Collect missing markers
    const missing: { marker: string; inner: string; type: "numeric" | "source" }[] = [];
    for (const marker of markers) {
      const inner = marker.inner;
      const srcMatch = inner.match(/^([A-Z]{2,12}):\s?(.+)$/);
      if (srcMatch) {
        const type = normalizeType(srcMatch[1].toLowerCase());
        const idVal = srcMatch[2].trim();
        const found = references.find((r) => {
          const rType = normalizeType(r.type);
          return (
            rType === type &&
            (r.externalId?.toLowerCase() === idVal.toLowerCase() ||
              r.externalId?.toLowerCase().includes(idVal.toLowerCase()))
          );
        });
        if (!found) {
          missing.push({ marker: marker.full, inner, type: "source" });
        }
      } else {
        const nums = expandRange(inner);
        for (const n of nums) {
          if (n > references.length && !aiCitationMap[n]) {
            missing.push({ marker: `[${n}]`, inner: String(n), type: "numeric" });
          }
        }
      }
    }

    if (missing.length === 0) {
      return NextResponse.json({
        message: "No missing citations to fix.",
        fixed: 0,
        references: [],
      });
    }

    // 2. AI suggests references for the missing markers based on paragraph context
    const missingList = missing
      .map((mm) => `${mm.marker} (${mm.type})`)
      .join(", ");
    const system =
      "You are a scientific reference resolver. Given a paragraph and a list of " +
      "missing citation markers, suggest concrete database queries (PubMed/RCSB/UniProt) " +
      "that would find the correct reference for each marker. Base your suggestions on " +
      "the paragraph's topic and the surrounding context.";

    const prompt = `PARAGRAPH (first 1500 chars):
${body.slice(0, 1500)}

MISSING CITATIONS: ${missingList}

For each missing citation, suggest a database query to find the correct reference.
Respond as STRICT JSON:
{
  "suggestions": [
    {
      "marker": "[1]",
      "database": "pubmed|rcsb|uniprot|ncbi",
      "query": "concrete search string",
      "reason": "why this query should find the right reference"
    }
  ]
}
Output JSON only.`;

    const raw = await chatWithSession(paragraph.projectId, prompt, {
      system,
      temperature: 0.4,
      taskType: "auto-fix",
      metadata: { paragraphId: id, missingCount: missing.length },
    });
    const parsed = safeParseJSON(raw, { suggestions: [] });
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter((s: any) => s.database && s.query)
      : [];

    // 3. Execute the suggested queries and save found references
    const savedRefs: any[] = [];
    for (const suggestion of suggestions.slice(0, 5)) {
      try {
        const dbResult = await queryDatabase(
          suggestion.database as any,
          String(suggestion.query)
        );
        if (dbResult.items.length > 0) {
          const item = dbResult.items[0];
          // Check if already saved
          const exists = references.find(
            (r) =>
              r.type === item.source &&
              r.externalId === item.externalId
          );
          if (!exists) {
            const ref = await db.reference.create({
              data: {
                type: item.source,
                externalId: item.externalId || null,
                title: item.title,
                authors: item.authors || null,
                journal: item.journal || null,
                year: item.year || null,
                url: item.url || null,
                doi: item.doi || null,
                abstract: item.abstract || null,
                paragraphId: id,
              },
            });
            savedRefs.push(ref);
          }
        }
      } catch (e) {
        // skip failed queries
      }
    }

    return NextResponse.json({
      message: `Resolved ${savedRefs.length} of ${missing.length} missing citations.`,
      fixed: savedRefs.length,
      totalMissing: missing.length,
      references: savedRefs,
      suggestions: suggestions.length,
    });
  } catch (err: any) {
    console.error("[/api/paragraphs/[id]/auto-fix-citations] error:", err);
    return NextResponse.json(
      { error: err?.message || "Auto-fix failed." },
      { status: 500 }
    );
  }
}

function safeParseJSON(raw: string, fallback: any): any {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]);
  } catch {
    return fallback;
  }
}
