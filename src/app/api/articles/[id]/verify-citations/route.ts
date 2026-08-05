import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/articles/[id]/verify-citations
 *
 * Verifies that each inline [n] citation in the article is supported by
 * the corresponding reference's content. Uses a keyword-overlap heuristic
 * (not a full semantic similarity model) to estimate how well the
 * reference's title + abstract supports the claim made in the sentence
 * containing the citation.
 *
 * For each citation marker [n] found in the article body:
 * 1. Extract the sentence containing the citation.
 * 2. Extract keywords from that sentence (remove stopwords, keep terms ≥4 chars).
 * 3. Extract keywords from the reference's title + abstract.
 * 4. Compute the Jaccard-like overlap: |intersection| / |union|.
 * 5. Classify: ≥0.15 = "supported", 0.05–0.15 = "weak", <0.05 = "unsupported".
 *
 * Returns an array of verification results:
 *   { citation, refTitle, refIndex, sentence, score, status, message }
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const article = await db.article.findUnique({
    where: { id },
    include: {
      articleParagraph: {
        orderBy: { order: "asc" },
        include: {
          paragraph: {
            include: {
              references: { orderBy: { citationOrder: "asc" } },
            },
          },
        },
      },
    },
  });

  if (!article) {
    return NextResponse.json({ error: "Article not found." }, { status: 404 });
  }

  // Collect all references across paragraphs (deduplicated by externalId)
  const refMap = new Map<string, any>();
  for (const ap of article.articleParagraph) {
    for (const ref of ap.paragraph.references) {
      const key = `${ref.type}:${ref.externalId || ref.title}`;
      if (!refMap.has(key)) refMap.set(key, ref);
    }
  }
  const allRefs = [...refMap.values()];

  if (allRefs.length === 0) {
    return NextResponse.json({
      results: [],
      summary: { total: 0, supported: 0, weak: 0, unsupported: 0, missing: 0 },
    });
  }

  // Build a global ref index map (1-based, matching the article's [n] numbering)
  // We need to match [n] in the article content to the global reference list.
  // The article content was globally renumbered during compose, so [n] maps
  // directly to the n-th entry in the deduplicated reference list.
  const STOPWORDS = new Set([
    "the","a","an","and","or","but","of","to","in","on","at","by","for","with",
    "from","into","this","that","these","those","is","are","was","were","be",
    "been","being","have","has","had","do","does","did","will","would","could",
    "should","may","might","can","shall","must","not","no","nor","so","if","then",
    "than","too","very","just","also","only","about","above","after","again","all",
    "any","because","before","below","between","both","during","each","few","more",
    "most","other","over","same","some","such","through","under","until","up","down",
    "out","off","further","once","here","there","when","where","why","how","what",
    "which","who","whom","whose","section","part","study","studies","result","results",
    "shown","showed","found","reported","demonstrated","using","used","use","via",
    "within","without","upon","their","they","them","it","its","as","we","our","us",
    "you","your","he","she","his","her",
  ]);

  const extractKeywords = (text: string): Set<string> => {
    const lower = text.toLowerCase();
    const tokens = lower.match(/[a-z][a-z0-9-]{3,}/g) || [];
    return new Set(tokens.filter((t) => !STOPWORDS.has(t)));
  };

  const computeOverlap = (setA: Set<string>, setB: Set<string>): number => {
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    for (const kw of setA) {
      if (setB.has(kw)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
  };

  // Extract sentences containing [n] citations from the article content
  const content = article.content;
  // Remove reference section
  const refSectionIdx = content.indexOf("## References");
  const body = refSectionIdx >= 0 ? content.slice(0, refSectionIdx) : content;

  // Find all [n] or [n,m] citations and the sentence they appear in
  const citeRe = /\[(\d{1,3}(?:[,,\-]\s?\d{1,3})*)\]/g;
  const results: any[] = [];
  const seen = new Set<string>(); // deduplicate by (citation + sentence)

  // Split into sentences (rough: split on . followed by space + capital)
  const sentences = body.split(/(?<=\.)\s+(?=[A-Z])/);

  for (const sentence of sentences) {
    citeRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = citeRe.exec(sentence))) {
      const citeStr = m[1]; // e.g. "1" or "2,3"
      const nums = citeStr.split(/[,;]\s*/).flatMap((s) => {
        const rm = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
        if (rm) {
          const arr: number[] = [];
          for (let n = parseInt(rm[1]); n <= parseInt(rm[2]); n++) arr.push(n);
          return arr;
        }
        const n = parseInt(s);
        return isNaN(n) ? [] : [n];
      });

      for (const n of nums) {
        const ref = allRefs[n - 1];
        const dedupKey = `${n}:${sentence.slice(0, 80)}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        if (!ref) {
          results.push({
            citation: n,
            refTitle: null,
            refIndex: n,
            sentence: sentence.trim().slice(0, 200),
            score: 0,
            status: "missing",
            message: `Reference [${n}] not found in the reference list (max: ${allRefs.length})`,
          });
          continue;
        }

        const sentenceKw = extractKeywords(sentence);
        const refText = `${ref.title || ""} ${ref.abstract || ""}`;
        const refKw = extractKeywords(refText);
        const score = computeOverlap(sentenceKw, refKw);

        let status: string;
        let message: string;
        if (score >= 0.15) {
          status = "supported";
          message = `Strong overlap (${Math.round(score * 100)}%) — the reference's title/abstract shares key terms with the citing sentence.`;
        } else if (score >= 0.05) {
          status = "weak";
          message = `Weak overlap (${Math.round(score * 100)}%) — the reference may not directly support this specific claim. Consider verifying manually.`;
        } else {
          status = "unsupported";
          message = `Very low overlap (${Math.round(score * 100)}%) — the reference's title/abstract does not share key terms with the citing sentence. This citation may be incorrect or the reference may lack an abstract.`;
        }

        results.push({
          citation: n,
          refTitle: ref.title?.slice(0, 80) || "Untitled",
          refIndex: n,
          sentence: sentence.trim().slice(0, 200),
          score: Math.round(score * 100) / 100,
          status,
          message,
        });
      }
    }
  }

  // Build summary
  const summary = {
    total: results.length,
    supported: results.filter((r) => r.status === "supported").length,
    weak: results.filter((r) => r.status === "weak").length,
    unsupported: results.filter((r) => r.status === "unsupported").length,
    missing: results.filter((r) => r.status === "missing").length,
  };

  return NextResponse.json({ results, summary });
}
