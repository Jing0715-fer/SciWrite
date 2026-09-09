import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { safeErrorMessage } from "@/lib/api-helpers";
// round-57 (P0-2): external fact-check layer — every high-risk claim in the
// article is web-searched and adjudicated against independent evidence
// before the reviewing LLM scores it. Best-effort: on tool failure the
// review proceeds exactly as before (factBlock stays empty).
// round-59: the review/revise CORE now lives in @/lib/review-engine (shared
// with the generate-full-v2 in-pipeline auto-repair loop) — this route is the
// HTTP + persistence wrapper. Prompts and merge logic are identical, so
// persisted reviews are indistinguishable no matter which path produced them.
import {
  reviewArticleCore,
  reviseArticleCore,
  type RevisionFeedback,
} from "@/lib/review-engine";
import { splitBodyAndReferences } from "@/lib/citation-audit";
import { parseReferenceBlock } from "@/lib/fact-check";

/**
 * round-61 (P0-A): abstracts of the article's own references, keyed by the
 * article's citation numbers. The article's "## References" lines carry
 * title/authors/year but NOT abstracts — join them against the project's
 * Reference rows by normalized title so the fact-check layer can corroborate
 * cited claims against the cited source's own abstract before (or instead
 * of) a web search. Best-effort: an empty map just means web-only checking.
 */
async function loadArticleRefAbstracts(
  projectId: string,
  content: string
): Promise<Map<number, { title: string; abstract: string }>> {
  const map = new Map<number, { title: string; abstract: string }>();
  try {
    const { referencesText } = splitBodyAndReferences(content);
    if (!referencesText || !referencesText.trim()) return map;
    const refsByNumber = parseReferenceBlock(referencesText);
    if (refsByNumber.size === 0) return map;
    const dbRefs = await db.reference.findMany({
      where: { projectId },
      select: { title: true, abstract: true },
    });
    const normKey = (s: string) =>
      (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const byTitle = new Map<string, string>();
    for (const r of dbRefs) {
      if (r.abstract && r.abstract.length > 80 && r.title) {
        byTitle.set(normKey(r.title), r.abstract);
      }
    }
    for (const [n, meta] of refsByNumber) {
      const abs = byTitle.get(normKey(meta.title));
      if (abs) map.set(n, { title: meta.title, abstract: abs });
    }
  } catch {}
  return map;
}

export const runtime = "nodejs";
// round-57: was 180s — the fact-check layer adds up to ~12 searches + ~12
// arbitration LLM calls ahead of the main review call. 600s keeps the
// non-streaming POST comfortably ahead of worst-case wall time.
export const maxDuration = 600;

// AI review of an article — inspired by nature-review-studio (structured
// multi-dimensional scoring) + ChatReviewer (iterative AI critique).
// Modes: "review" (generate a review), "revise" (act on a review to revise
// the article), "auto-iterate" (run N rounds of review+revise automatically).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const mode = body.mode as "review" | "revise" | "auto-iterate";
    const articleId = body.articleId as string;

    if (!articleId) {
      return NextResponse.json({ error: "Missing 'articleId'." }, { status: 400 });
    }

    const article = await db.article.findUnique({
      where: { id: articleId },
      include: { reviews: { orderBy: { round: "desc" } } },
    });
    if (!article) {
      return NextResponse.json({ error: "Article not found." }, { status: 404 });
    }

    if (mode === "review") {
      return NextResponse.json(await runReview(article));
    }
    if (mode === "revise") {
      const reviewId = body.reviewId as string;
      // r37 fix: ownership check — a reviewId from ANOTHER article could
      // drive a revision of this article (review.revisedContent built from
      // the foreign article would overwrite this one).
      if (reviewId) {
        const review = await db.review.findUnique({ where: { id: reviewId } });
        if (!review || review.articleId !== articleId) {
          return NextResponse.json(
            { error: "Review not found for this article." },
            { status: 404 }
          );
        }
      }
      const reviseResult = await runRevise(article, reviewId);
      // r37 fix: runRevise returned { error } with HTTP 200 — jfetch only
      // throws on !res.ok, so the client showed the success toast with
      // nothing revised. Surface it as a real error status.
      if ((reviseResult as any)?.error) {
        return NextResponse.json(reviseResult, { status: 404 });
      }
      return NextResponse.json(reviseResult);
    }
    if (mode === "auto-iterate") {
      const rounds = Math.min(Math.max(body.rounds || 2, 1), 5);
      return NextResponse.json(await runAutoIterate(article, rounds));
    }
    return NextResponse.json({ error: "Unknown mode." }, { status: 400 });
  } catch (err: any) {
    console.error("[/api/ai/review] error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Review failed.") },
      { status: 500 }
    );
  }
}

async function runReview(article: any) {
  // round-59: pure core (fact-check + review LLM) lives in review-engine.
  let topic = "";
  try {
    const project = await db.project.findUnique({
      where: { id: article.projectId },
      select: { topic: true },
    });
    topic = project?.topic || "";
  } catch {}

  // round-61 (P0-A): the abstracts of the article's own references —
  // cited claims are first checked against the cited source's abstract.
  const refAbstracts = await loadArticleRefAbstracts(article.projectId, article.content);

  const core = await reviewArticleCore(
    article.projectId,
    { title: article.title, abstract: article.abstract, content: article.content },
    { topic, maxClaims: 8, refAbstracts },
  );

  if (core.factReport?.ran && core.factReport.findings.length > 0) {
    console.log(
      `[fact-check] article=${article.id} claims=${core.factReport.claims.length} ` +
        `verified=${core.factReport.summary.verified} contradicted=${core.factReport.summary.contradicted} ` +
        `unverifiable=${core.factReport.summary.unverifiable} errors=${core.factReport.summary.errors}`,
    );
  }

  const parsed = core.parsed;
  const round = (article.reviews?.[0]?.round || 0) + 1;
  const review = await db.review.create({
    data: {
      articleId: article.id,
      round,
      scoreNovelty: parsed.scores?.novelty ?? null,
      scoreSignificance: parsed.scores?.significance ?? null,
      scoreClarity: parsed.scores?.clarity ?? null,
      scoreMethodology: parsed.scores?.methodology ?? null,
      scoreCitations: parsed.scores?.citations ?? null,
      scoreOverall: parsed.scores?.overall ?? null,
      verdict: parsed.verdict || "major-revision",
      summary: parsed.summary || "",
      strengths: JSON.stringify(parsed.strengths || []),
      weaknesses: JSON.stringify(core.mergedWeaknesses),
      suggestions: JSON.stringify(parsed.suggestions || []),
    },
  });

  return {
    review,
    scores: parsed.scores,
    verdict: parsed.verdict,
    ...(core.factReport?.ran && core.factReport.findings.length > 0
      ? { factCheck: core.factReport.summary }
      : {}),
  };
}

async function runRevise(article: any, reviewId: string) {
  const review = await db.review.findUnique({ where: { id: reviewId } });
  if (!article || !review) {
    return { error: "Article or review not found." };
  }

  const feedback: RevisionFeedback = {
    round: review.round,
    verdict: review.verdict,
    summary: review.summary,
    scores: {
      novelty: review.scoreNovelty,
      significance: review.scoreSignificance,
      clarity: review.scoreClarity,
      methodology: review.scoreMethodology,
      citations: review.scoreCitations,
      overall: review.scoreOverall,
    },
    strengths: safeParseJSON(review.strengths, []),
    weaknesses: safeParseJSON(review.weaknesses, []),
    suggestions: safeParseJSON(review.suggestions, []),
  };

  // round-59: "full" mode keeps the legacy manual-revise behavior (address
  // ALL weaknesses and suggestions) byte-for-byte — only the LLM call moved
  // into review-engine.
  const revised = await reviseArticleCore(
    article.projectId,
    { title: article.title, content: article.content },
    feedback,
    "full",
  );

  // Save revised content on the review record + update the article.
  // round-57 (P2-3): the revision changes the English content, but the
  // Chinese half (contentZh) still reflects the PRE-revision text — the
  // bilingual halves silently diverge. Null it out: the viewer shows the
  // English half (accurate) until the user batch-retranslates, instead of a
  // stale translation that contradicts the revised English. The flag lets
  // the client surface "中文已与英文分叉，请重新翻译".
  const hadZh = Boolean(article.contentZh);
  await db.review.update({
    where: { id: reviewId },
    data: { revisedContent: revised },
  });
  const updated = await db.article.update({
    where: { id: article.id },
    data: { content: revised, ...(hadZh ? { contentZh: null } : {}) },
  });

  return { article: updated, revised, reviewId, ...(hadZh ? { zhCleared: true } : {}) };
}

async function runAutoIterate(article: any, rounds: number) {
  const results: any[] = [];
  for (let i = 0; i < rounds; i++) {
    // r37 fix (stale-loop): reload the article (with reviews) EVERY round —
    // previously `article` was loaded once in POST, so round 2 reviewed the
    // PRE-revision content, round 2's revise rewrote from the ORIGINAL
    // content (round 1's revision silently discarded), and every review row
    // was created with round=1 (stale reviews[0].round).
    const fresh = await db.article.findUnique({
      where: { id: article.id },
      include: { reviews: { orderBy: { round: "desc" } } },
    });
    if (!fresh) break;
    article.content = fresh.content;
    article.reviews = fresh.reviews;

    // 1. Review
    const reviewResult = await runReview(article);
    results.push({ round: i + 1, phase: "review", ...reviewResult });

    // 2. If not accepted, revise
    if (reviewResult.verdict !== "accept") {
      // Refresh content AFTER the revision too, so the next round's prompt
      // sees it (runRevise already persisted it).
      const revisedArticle = await db.article.findUnique({
        where: { id: article.id },
      });
      if (revisedArticle) article.content = revisedArticle.content;
      const reviseResult = await runRevise(article, reviewResult.review.id);
      results.push({ round: i + 1, phase: "revise", ...reviseResult });
    } else {
      break; // accepted, stop iterating
    }
  }
  const finalArticle = await db.article.findUnique({ where: { id: article.id } });
  return { rounds: results.length, results, finalArticle };
}

function safeParseJSON(raw: string, fallback: any): any {
  if (typeof raw !== "string") return fallback;
  const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]);
  } catch {
    return fallback;
  }
}
