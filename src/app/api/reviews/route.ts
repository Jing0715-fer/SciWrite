import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// GET: Load saved reviews for an article
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const articleId = searchParams.get("articleId");
  if (!articleId) {
    return NextResponse.json({ error: "Missing 'articleId'." }, { status: 400 });
  }
  const reviews = await db.review.findMany({
    where: { articleId },
    orderBy: { round: "desc" },
  });
  if (reviews.length === 0) {
    return NextResponse.json({ notFound: true });
  }
  const latest = reviews[0];
  return NextResponse.json({
    review: latest,
    scores: {
      novelty: latest.scoreNovelty,
      significance: latest.scoreSignificance,
      clarity: latest.scoreClarity,
      methodology: latest.scoreMethodology,
      citations: latest.scoreCitations,
      overall: latest.scoreOverall,
    },
    verdict: latest.verdict,
    allReviews: reviews.map(r => ({ id: r.id, round: r.round, verdict: r.verdict, createdAt: r.createdAt })),
  });
}
