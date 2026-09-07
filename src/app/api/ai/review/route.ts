import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatWithSession } from "@/lib/llm-session";
import { safeErrorMessage } from "@/lib/api-helpers";
// round-57 (P0-2): external fact-check layer — every high-risk claim in the
// article is web-searched and adjudicated against independent evidence
// before the reviewing LLM scores it. Best-effort: on tool failure the
// review proceeds exactly as before (factBlock stays empty).
import {
  factCheckArticle,
  factFindingsPromptBlock,
  factFindingToWeakness,
} from "@/lib/fact-check";

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
  const system =
    "You are a rigorous scientific peer reviewer in the style of a top-tier journal " +
    "(Nature/Science/Cell). You evaluate manuscripts on multiple dimensions and " +
    "provide structured, actionable feedback. Be specific, critical, and constructive.";

  // ---- round-57 (P0-2): external fact-check BEFORE the review LLM runs ----
  // High-risk claims (quantitative / negation-existence / first / attribution)
  // are extracted, web-searched, and adjudicated against independent
  // evidence. Findings ride into the review prompt AND are force-merged into
  // the persisted weaknesses so they are visible in the Review tab even if
  // the reviewing LLM undersells them. Total failure ⇒ empty block, the
  // review degrades to its pre-round-57 behavior (never breaks).
  let factBlock = "";
  let factWeaknesses: string[] = [];
  let factSummary: any = null;
  try {
    let topic = "";
    try {
      const project = await db.project.findUnique({
        where: { id: article.projectId },
        select: { topic: true },
      });
      topic = project?.topic || "";
    } catch {}
    const report = await factCheckArticle(article.projectId, article.content, {
      maxClaims: 8,
      topic,
    });
    if (report.ran && report.findings.length > 0) {
      factBlock = factFindingsPromptBlock(report.findings);
      factWeaknesses = report.findings
        .filter((f) => f.verdict === "CONTRADICTED" || f.verdict === "UNVERIFIABLE")
        .map(factFindingToWeakness);
      factSummary = report.summary;
      console.log(
        `[fact-check] article=${article.id} claims=${report.claims.length} ` +
          `verified=${report.summary.verified} contradicted=${report.summary.contradicted} ` +
          `unverifiable=${report.summary.unverifiable} errors=${report.summary.errors}`,
      );
    }
  } catch (fcErr: any) {
    // Best-effort by contract — a fact-check failure must never fail review.
    console.warn(
      `[fact-check] degraded to baseline review: ${fcErr?.message?.slice(0, 120) || fcErr}`,
    );
  }

  const prompt = `ARTICLE TITLE: ${article.title}
${article.abstract ? `ABSTRACT: ${article.abstract}\n` : ""}
ARTICLE CONTENT:
${article.content}
${factBlock}
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

  const raw = await chatWithSession(article.projectId, prompt, {
    system,
    temperature: 0.4,
    taskType: "review",
    metadata: { mode: "review", articleId: article.id, title: article.title },
  });
  const parsed = safeParseJSON(raw, {
    scores: { overall: 5 },
    verdict: "major-revision",
    summary: "Review parsing failed.",
    strengths: [],
    weaknesses: [],
    suggestions: [],
  });

  // round-57: force-merge the external fact-check findings into the persisted
  // weaknesses (deduped against the LLM's own) — the review LLM is *told* to
  // keep them, but a lazy/generous model must not be able to bury a
  // CONTRADICTED finding. Cap the merged list at 10 (LLM weaknesses + facts).
  const llmWeaknesses: string[] = Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [];
  const mergedWeaknesses = [...llmWeaknesses];
  for (const w of factWeaknesses) {
    if (mergedWeaknesses.length >= 10) break;
    const already = mergedWeaknesses.some(
      (x) =>
        typeof x === "string" &&
        x.replace(/\s+/g, "").slice(0, 80) === w.replace(/\s+/g, "").slice(0, 80),
    );
    if (!already) mergedWeaknesses.push(w);
  }

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
      weaknesses: JSON.stringify(mergedWeaknesses),
      suggestions: JSON.stringify(parsed.suggestions || []),
    },
  });

  return {
    review,
    scores: parsed.scores,
    verdict: parsed.verdict,
    ...(factSummary ? { factCheck: factSummary } : {}),
  };
}

async function runRevise(article: any, reviewId: string) {
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

  const revised = await chatWithSession(article.projectId, prompt, {
    system,
    temperature: 0.5,
    taskType: "revise",
    metadata: { mode: "revise", articleId: article.id, round: review.round },
  });

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
