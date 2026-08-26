import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const maxDuration = 45;

/**
 * POST /api/articles/[id]/optimize-structure
 *
 * AI-powered article structure analysis. The LLM examines:
 *  1. Section ordering (does the logical flow make sense?)
 *  2. Section balance (are some sections disproportionately long/short?)
 *  3. Missing sections (e.g. no "Limitations", no "Future Work")
 *  4. Transition quality (do sections connect coherently?)
 *  5. Redundancy (repeated content across sections)
 *
 * Returns:
 *   {
 *     score: number (0-100 overall structural quality),
 *     strengths: string[],
 *     weaknesses: string[],
 *     suggestions: [{ type, section, priority, suggestion }],
 *     recommendedOrder: string[] (section titles in suggested order),
 *     missingSections: string[]
 *   }
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
        include: { paragraph: true },
        orderBy: { order: "asc" },
      },
    },
  });

  if (!article) {
    return NextResponse.json({ error: "Article not found." }, { status: 404 });
  }

  // Build a section-by-section summary of the article.
  // Each section: title + word count + first 200 chars (for theme detection).
  const sections: { title: string; words: number; preview: string; format: string }[] = [];

  for (const ap of article.articleParagraph) {
    const p = ap.paragraph;
    const words = p.content.split(/\s+/).filter(Boolean).length;
    sections.push({
      title: p.title,
      words,
      preview: p.content.slice(0, 200).replace(/\n/g, " "),
      format: p.format,
    });
  }

  // Also include the article's own content structure (headings) as fallback
  const articleHeadings = (article.content.match(/^#{1,3}\s+.+$/gm) || [])
    .slice(0, 30)
    .map((h) => h.replace(/^#+\s+/, ""));

  if (sections.length === 0 && articleHeadings.length === 0) {
    return NextResponse.json({
      error: "No sections found to analyze.",
    }, { status: 400 });
  }

  const sectionSummary = sections.length > 0
    ? sections.map((s, i) =>
        `[${i + 1}] "${s.title}" (format: ${s.format}, ${s.words} words)\n  Preview: ${s.preview}...`
      ).join("\n\n")
    : articleHeadings.map((h, i) => `[${i + 1}] "${h}"`).join("\n");

  const totalWords = sections.reduce((sum, s) => sum + s.words, 0) ||
    article.content.split(/\s+/).filter(Boolean).length;

  const prompt = `You are an expert scientific editor specializing in research article structure. Analyze the following article's structure and provide actionable optimization suggestions.

ARTICLE TITLE: ${article.title}
TOTAL WORDS: ${totalWords}
TOPIC: ${(article as { topic?: string | null }).topic || "(not specified)"}

CURRENT SECTION ORDER:
${sectionSummary}

Analyze the structure across these dimensions:
1. LOGICAL FLOW: Does the section order follow standard scientific article conventions (Background → Methods → Results → Discussion → Conclusion)?
2. BALANCE: Are sections proportionally balanced? Flag any section that is < 50 words (too thin) or > 40% of total (too dominant).
3. COMPLETENESS: Are essential sections present? Common missing ones: Abstract, Limitations, Future Work, Conclusion.
4. TRANSITIONS: Do sections connect coherently?
5. REDUNDANCY: Is content repeated across sections?

Respond as STRICT JSON:
{
  "score": 78,
  "strengths": ["Clear methodological section", "Good citation density"],
  "weaknesses": ["Discussion is too short", "Missing limitations section"],
  "suggestions": [
    {
      "type": "reorder",
      "section": "Results",
      "priority": "high",
      "suggestion": "Move Results before Discussion to follow IMRaD convention"
    },
    {
      "type": "expand",
      "section": "Discussion",
      "priority": "medium",
      "suggestion": "Expand to at least 400 words — currently only 120"
    },
    {
      "type": "add",
      "section": "Limitations",
      "priority": "high",
      "suggestion": "Add a Limitations subsection in the Discussion"
    }
  ],
  "recommendedOrder": ["Background", "Methods", "Results", "Discussion", "Conclusion"],
  "missingSections": ["Limitations", "Future Work"]
}

Be specific and actionable. Prioritize suggestions by impact (high/medium/low).`;

  try {
    const raw = await chat(prompt, {
      system: "You are an expert scientific editor. Output strict JSON only, no prose.",
      temperature: 0.4,
      maxTokens: 4096,
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json(
        { error: "Failed to parse LLM response." },
        { status: 500 }
      );
    }
    const parsed = JSON.parse(jsonMatch[0]);

    return NextResponse.json({
      ...parsed,
      analyzedSections: sections.length,
      totalWords,
    });
  } catch (err: any) {
    console.error("[optimize-structure] error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Structure analysis failed.") },
      { status: 500 }
    );
  }
}
