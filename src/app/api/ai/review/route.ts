import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";

export const runtime = "nodejs";
export const maxDuration = 180;

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
      return NextResponse.json(await runRevise(articleId, reviewId));
    }
    if (mode === "auto-iterate") {
      const rounds = Math.min(Math.max(body.rounds || 2, 1), 5);
      return NextResponse.json(await runAutoIterate(articleId, rounds));
    }
    return NextResponse.json({ error: "Unknown mode." }, { status: 400 });
  } catch (err: any) {
    console.error("[/api/ai/review] error:", err);
    return NextResponse.json(
      { error: err?.message || "Review failed." },
      { status: 500 }
    );
  }
}

async function runReview(article: any) {
  const system =
    "You are a rigorous scientific peer reviewer in the style of a top-tier journal " +
    "(Nature/Science/Cell). You evaluate manuscripts on multiple dimensions and " +
    "provide structured, actionable feedback. Be specific, critical, and constructive.";

  const prompt = `ARTICLE TITLE: ${article.title}
${article.abstract ? `ABSTRACT: ${article.abstract}\n` : ""}
ARTICLE CONTENT:
${article.content}

Provide a comprehensive peer review. Score each dimension 0-10 (10 = excellent).
Respond as STRICT JSON:
{
  "scores": {
    "novelty": 0,
    "significance": 0,
    "clarity": 0,
    "methodology": 0,
    "citations": 0,
    "overall": 0
  },
  "verdict": "accept|minor-revision|major-revision|reject",
  "summary": "2-3 sentence overall assessment",
  "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
  "weaknesses": ["specific weakness 1", "specific weakness 2", "specific weakness 3"],
  "suggestions": [
    {"section": "Introduction", "issue": "what's wrong", "fix": "how to fix it"},
    {"section": "Results", "issue": "...", "fix": "..."}
  ]
}
Be demanding but fair. Focus on scientific rigor, citation completeness, and clarity.
Output JSON only.`;

  const raw = await chat(prompt, { system, temperature: 0.4 });
  const parsed = safeParseJSON(raw, {
    scores: { overall: 5 },
    verdict: "major-revision",
    summary: "Review parsing failed.",
    strengths: [],
    weaknesses: [],
    suggestions: [],
  });

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
      weaknesses: JSON.stringify(parsed.weaknesses || []),
      suggestions: JSON.stringify(parsed.suggestions || []),
    },
  });

  return { review, scores: parsed.scores, verdict: parsed.verdict };
}

async function runRevise(articleId: string, reviewId: string) {
  const article = await db.article.findUnique({ where: { id: articleId } });
  const review = await db.review.findUnique({ where: { id: reviewId } });
  if (!article || !review) {
    return { error: "Article or review not found." };
  }

  const strengths = safeParseJSON(review.strengths, []);
  const weaknesses = safeParseJSON(review.weaknesses, []);
  const suggestions = safeParseJSON(review.suggestions, []);

  const system =
    "You are a scientific editor who revises articles to address peer-review feedback " +
    "while preserving scientific accuracy and all inline citations [n] / [SOURCE:ID].";

  const prompt = `ARTICLE TITLE: ${article.title}
CURRENT CONTENT:
${article.content}

REVIEWER FEEDBACK (Round ${review.round}):
Verdict: ${review.verdict}
Summary: ${review.summary}
Scores: novelty=${review.scoreNovelty}/10, significance=${review.scoreSignificance}/10, clarity=${review.scoreClarity}/10, methodology=${review.scoreMethodology}/10, citations=${review.scoreCitations}/10, overall=${review.scoreOverall}/10

STRENGTHS:
${strengths.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}

WEAKNESSES:
${weaknesses.map((w: string, i: number) => `${i + 1}. ${w}`).join("\n")}

REVISION SUGGESTIONS:
${suggestions.map((s: any, i: number) => `${i + 1}. [${s.section}] ${s.issue} → ${s.fix}`).join("\n")}

Revise the article to address ALL weaknesses and suggestions. Preserve:
- All inline citations [n] and [SOURCE:ID] markers exactly.
- The section structure (## headings).
- The ### Citations / ## References block at the end.

Output the revised article in Markdown. Do NOT add commentary — output only the revised article.`;

  const revised = await chat(prompt, { system, temperature: 0.5 });

  // Save revised content on the review record + update the article
  await db.review.update({
    where: { id: reviewId },
    data: { revisedContent: revised },
  });
  const updated = await db.article.update({
    where: { id: articleId },
    data: { content: revised },
  });

  return { article: updated, revised, reviewId };
}

async function runAutoIterate(articleId: string, rounds: number) {
  const results: any[] = [];
  for (let i = 0; i < rounds; i++) {
    // 1. Review
    const article = await db.article.findUnique({
      where: { id: articleId },
      include: { reviews: { orderBy: { round: "desc" } } },
    });
    if (!article) break;
    const reviewResult = await runReview(article);
    results.push({ round: i + 1, phase: "review", ...reviewResult });

    // 2. If not accepted, revise
    if (reviewResult.verdict !== "accept") {
      const reviseResult = await runRevise(articleId, reviewResult.review.id);
      results.push({ round: i + 1, phase: "revise", ...reviseResult });
    } else {
      break; // accepted, stop iterating
    }
  }
  const finalArticle = await db.article.findUnique({ where: { id: articleId } });
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
