import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { topicalityScore } from "@/lib/citation-audit";

export const runtime = "nodejs";

// Validate that every citation marker in a paragraph can be resolved to a
// reference. Returns a report of valid, missing, and orphaned citations.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const paragraph = await db.paragraph.findUnique({
    where: { id },
    // FIX: [n] → references[n-1] depends on citationOrder — without an
    // explicit orderBy, Prisma returns rows in an undefined order and the
    // validator resolves citations against the WRONG references.
    include: { references: { orderBy: { citationOrder: "asc" } } },
  });
  if (!paragraph) {
    return NextResponse.json({ error: "Paragraph not found." }, { status: 404 });
  }

  const content = paragraph.content;
  const references = paragraph.references;

  // Split content at ### Citations block
  const citeHeaderIdx = content.indexOf("### Citations");
  const body = citeHeaderIdx >= 0 ? content.slice(0, citeHeaderIdx) : content;
  const citationsBlock = citeHeaderIdx >= 0 ? content.slice(citeHeaderIdx) : "";

  // Extract all citation markers from the body
  // Matches [1], [2,3], [1, 5], [1-3], [1–3], [PMID:12345]
  const markerRe = /\[(\d{1,3}(?:[,\-–]\s*\d{1,3})*|[A-Z]{2,12}:\s?[^\]\n]{1,60})\]/g;
  const markers: { full: string; inner: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(body))) {
    markers.push({ full: m[0], inner: m[1].trim(), index: m.index });
  }

  // Parse the AI citations block into a numbered list (if present)
  const aiCitationLines = citationsBlock
    .split("\n")
    .filter((l) => /^\s*\[\d+\]/.test(l));
  const aiCitationMap: Record<number, string> = {};
  for (const line of aiCitationLines) {
    const lm = line.match(/^\s*\[(\d+)\]\s*(.+)$/);
    if (lm) {
      aiCitationMap[parseInt(lm[1], 10)] = lm[2].trim();
    }
  }

  // Normalize source type aliases
  const normalizeType = (t: string) => {
    const lt = t.toLowerCase();
    if (lt === "pmid") return "pubmed";
    if (lt === "pdb") return "rcsb";
    return lt;
  };

  // Validate each marker
  const results: {
    marker: string;
    inner: string;
    type: "numeric" | "source";
    status: "valid" | "missing" | "suspect";
    score?: number;
    resolvedTo?: string;
    suggestion?: string;
  }[] = [];

  // Bug #5 fix — extract the sentence containing each citation so we can run
  // a topicality check. A citation that is merely "in range" (n <= refs.length)
  // is NOT necessarily correct — the reference may be unrelated to the claim.
  // We compute a Jaccard keyword-overlap score between the citing sentence
  // and the reference's title+abstract, and mark low-overlap citations as
  // "suspect" so the user knows to verify them manually.
  const sentenceAt = (text: string, offset: number): string => {
    let start = offset;
    while (start > 0) {
      const ch = text[start - 1];
      if (ch === "." || ch === "!" || ch === "?" || ch === "\n") break;
      start--;
    }
    let end = offset;
    while (end < text.length) {
      const ch = text[end];
      if (ch === "." || ch === "!" || ch === "?" || ch === "\n") {
        end++;
        break;
      }
      end++;
    }
    return text.slice(start, end).trim();
  };

  for (const marker of markers) {
    const inner = marker.inner;
    // Check if it's a SOURCE:ID marker
    const srcMatch = inner.match(/^([A-Z]{2,12}):\s?(.+)$/);
    if (srcMatch) {
      const rawType = srcMatch[1].toLowerCase();
      const type = normalizeType(rawType);
      const idVal = srcMatch[2].trim();
      const found = references.find((r) => {
        const rType = normalizeType(r.type);
        return (
          rType === type &&
          (r.externalId?.toLowerCase() === idVal.toLowerCase() ||
            r.externalId?.toLowerCase().includes(idVal.toLowerCase()) ||
            idVal.toLowerCase().includes(r.externalId?.toLowerCase() || "___"))
        );
      });
      results.push({
        marker: marker.full,
        inner,
        type: "source",
        status: found ? "valid" : "missing",
        resolvedTo: found
          ? `${found.type}:${found.externalId} — ${found.title.slice(0, 60)}`
          : undefined,
        suggestion: !found
          ? `No saved reference matches ${rawType}:${idVal}. Save it as a reference or add it to the ### Citations block.`
          : undefined,
      });
    } else {
      // Numeric citation — check that the reference actually EXISTS (not just
      // that the index is in range) AND run a topicality check.
      const nums = expandRange(inner);
      const sentence = sentenceAt(body, marker.index);
      for (const n of nums) {
        const ref = references[n - 1];
        const hasRef = !!ref || !!aiCitationMap[n];
        // Bug #5 fix: compute topicality even for in-range citations.
        let score = 0;
        let status: "valid" | "missing" | "suspect" = "valid";
        let suggestion: string | undefined;
        if (!ref && !aiCitationMap[n]) {
          status = "missing";
          suggestion = `Reference [${n}] is cited but not found in saved references (${references.length} saved) or the AI citations block.`;
        } else if (ref) {
          const refText = `${ref.title || ""} ${ref.abstract || ""}`;
          score = topicalityScore(sentence, refText);
          if (score < 0.02) {
            status = "suspect";
            suggestion = `Very low topical overlap (${Math.round(
              score * 100
            )}%) between the citing sentence and the reference. The reference may not support this claim — verify manually.`;
          } else if (score < 0.05) {
            status = "suspect";
            suggestion = `Weak topical overlap (${Math.round(
              score * 100
            )}%) — the reference may not directly support this claim.`;
          }
        }
        const resolvedTo = ref
          ? `${ref.type}:${ref.externalId || "?"} — ${ref.title.slice(0, 60)}`
          : aiCitationMap[n]
          ? aiCitationMap[n]
          : undefined;
        results.push({
          marker: `[${n}]`,
          inner: String(n),
          type: "numeric",
          status,
          score: ref ? Math.round(score * 100) / 100 : undefined,
          resolvedTo,
          suggestion,
        });
      }
    }
  }

  // Find orphaned references (saved but never cited)
  const citedNumbers = new Set<number>();
  const citedSourceIds = new Set<string>();
  for (const r of results) {
    if (r.type === "numeric") citedNumbers.add(parseInt(r.inner, 10));
    else {
      const sm = r.inner.match(/^([A-Z]{2,12}):\s?(.+)$/);
      if (sm) citedSourceIds.add(`${normalizeType(sm[1])}:${sm[2].trim().toLowerCase()}`);
    }
  }
  const orphaned = references
    .map((ref, i) => {
      const refKey = `${normalizeType(ref.type)}:${(
        ref.externalId || ""
      ).toLowerCase()}`;
      const isCited =
        citedNumbers.has(i + 1) || citedSourceIds.has(refKey);
      return isCited
        ? null
        : {
            index: i + 1,
            type: ref.type,
            externalId: ref.externalId,
            title: ref.title.slice(0, 60),
          };
    })
    .filter(Boolean);

  const validCount = results.filter((r) => r.status === "valid").length;
  const missingCount = results.filter((r) => r.status === "missing").length;
  const suspectCount = results.filter((r) => r.status === "suspect").length;

  return NextResponse.json({
    paragraphId: id,
    totalMarkers: markers.length,
    validCount,
    missingCount,
    suspectCount,
    orphanedCount: orphaned.length,
    results,
    orphaned,
    hasCitationsBlock: citeHeaderIdx >= 0,
    aiCitationCount: Object.keys(aiCitationMap).length,
    savedReferenceCount: references.length,
  });
}

function expandRange(inner: string): number[] {
  const trimmed = inner.trim();
  const nums: number[] = [];
  const parts = trimmed.split(/[,;]\s*/);
  for (const p of parts) {
    const rangeMatch = p.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      for (let n = a; n <= b; n++) nums.push(n);
    } else {
      const n = parseInt(p, 10);
      if (!isNaN(n)) nums.push(n);
    }
  }
  return nums;
}
