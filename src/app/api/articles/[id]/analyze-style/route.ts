import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";

export const runtime = "nodejs";
export const maxDuration = 45;

/**
 * POST /api/articles/[id]/analyze-style
 *
 * AI-powered writing style analysis. Combines local heuristic computation
 * with LLM-based academic register assessment.
 *
 * Local heuristics (computed without LLM, instant):
 *  - Flesch Reading Ease score (0-100, higher = easier)
 *  - Flesch-Kincaid Grade Level (years of education needed)
 *  - Average sentence length (words)
 *  - Average word length (syllables)
 *  - Passive voice sentence percentage
 *  - Citation density (citations per 100 words)
 *  - Lexical diversity (unique words / total words)
 *  - Long sentence count (> 30 words)
 *  - Paragraph count + average paragraph length
 *
 * LLM assessment (one call):
 *  - Academic register score (0-100)
 *  - Clarity score (0-100)
 *  - Conciseness score (0-100)
 *  - Top 5 style issues with specific examples from the text
 *  - Improvement suggestions (actionable, prioritized)
 *
 * Returns a unified style report.
 */

// ── Syllable counting heuristic (English-only, good enough for stats) ────────
function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  // Remove silent endings
  let cleaned = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  cleaned = cleaned.replace(/^y/, "");
  const groups = cleaned.match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
}

// ── Passive voice detection heuristic ────────────────────────────────────────
// Matches "is/are/was/were/been/be + past-participle (word ending in -ed or
// irregular past participle from a small list)". Not perfect but captures the
// common patterns.
const PASSIVE_RE =
  /\b(?:is|are|was|were|been|being|be|am)\s+(?:\w+ly\s+)?(\w+ed|known|done|made|seen|given|found|shown|taken|used|obtained|derived|observed|reported|considered|regarded|determined|identified|characterized|proposed|suggested|demonstrated|revealed|indicated|performed|carried|conducted|achieved|detected|measured|analyzed|examined|investigated|explored|compared|evaluated|assessed|calculated|estimated|predicted|modeled|simulated)\b/gi;

function isPassive(sentence: string): boolean {
  // Reset lastIndex for global regex
  PASSIVE_RE.lastIndex = 0;
  return PASSIVE_RE.test(sentence);
}

interface SectionStats {
  title: string;
  words: number;
  sentences: number;
  paragraphs: number;
  avgSentenceLen: number;
  fleschReadingEase: number;
  fleschKincaidGrade: number;
  passiveVoicePct: number;
  longSentences: number;
  citations: number;
  citationDensity: number; // citations per 100 words
  lexicalDiversity: number; // unique / total
}

function analyzeText(text: string): Omit<SectionStats, "title"> {
  // Clean: remove markdown formatting for analysis
  const clean = text
    .replace(/```[\s\S]*?```/g, " ") // code blocks
    .replace(/`[^`]+`/g, " ") // inline code
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → text
    .replace(/#{1,6}\s+/g, "") // headings
    .replace(/^\s*[-*+]\s+/gm, "") // list markers
    .replace(/^\s*\d+\.\s+/gm, "") // ordered list markers
    .replace(/^\s*>\s+/gm, "") // blockquotes
    .replace(/\|/g, " ") // table pipes
    .trim();

  // Split into sentences (handle abbreviations crudely)
  const sentenceSplit = clean
    .replace(/([.!?])\s+(?=[A-Z(])/g, "$1\n")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  const sentences = sentenceSplit.length;
  const paragraphs = clean
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20).length;

  // Words
  const words = clean.match(/\b[a-zA-Z][a-zA-Z'-]*\b/g) || [];
  const wordCount = words.length;
  const syllableCount = words.reduce((sum, w) => sum + countSyllables(w), 0);

  // Unique words (lowercased) for lexical diversity
  const uniqueWords = new Set(words.map((w) => w.toLowerCase()));
  const lexicalDiversity =
    wordCount > 0 ? Math.round((uniqueWords.size / wordCount) * 100) : 0;

  // Flesch Reading Ease = 206.835 - 1.015 * (words/sentences) - 84.6 * (syllables/words)
  const fleschReadingEase =
    sentences > 0 && wordCount > 0
      ? Math.round(
          (206.835 -
            1.015 * (wordCount / sentences) -
            84.6 * (syllableCount / wordCount)) *
            10,
        ) / 10
      : 0;

  // Flesch-Kincaid Grade Level = 0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59
  const fleschKincaidGrade =
    sentences > 0 && wordCount > 0
      ? Math.round(
          (0.39 * (wordCount / sentences) +
            11.8 * (syllableCount / wordCount) -
            15.59) *
            10,
        ) / 10
      : 0;

  // Average sentence length
  const avgSentenceLen =
    sentences > 0 ? Math.round((wordCount / sentences) * 10) / 10 : 0;

  // Passive voice
  const passiveCount = sentenceSplit.filter((s) => isPassive(s)).length;
  const passiveVoicePct =
    sentences > 0 ? Math.round((passiveCount / sentences) * 100) : 0;

  // Long sentences (> 30 words)
  const longSentences = sentenceSplit.filter(
    (s) => (s.match(/\b[a-zA-Z][a-zA-Z'-]*\b/g) || []).length > 30,
  ).length;

  // Citations [n] or [n,m] etc.
  const citeMatches = clean.match(/\[\d{1,3}(?:[,\-–\s]\d{1,3})*\]/g) || [];
  const citations = citeMatches.length;
  const citationDensity =
    wordCount > 0 ? Math.round((citations / wordCount) * 1000) / 10 : 0;

  return {
    words: wordCount,
    sentences,
    paragraphs,
    avgSentenceLen,
    fleschReadingEase,
    fleschKincaidGrade,
    passiveVoicePct,
    longSentences,
    citations,
    citationDensity,
    lexicalDiversity,
  };
}

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

  // ── Compute local heuristics per section ──────────────────────────────────
  const sectionStats: SectionStats[] = [];

  if (article.articleParagraph.length > 0) {
    for (const ap of article.articleParagraph) {
      const p = ap.paragraph;
      const stats = analyzeText(p.content);
      sectionStats.push({ title: p.title, ...stats });
    }
  } else {
    // Fallback: analyze the article content as a single section
    const stats = analyzeText(article.content);
    sectionStats.push({ title: article.title, ...stats });
  }

  // ── Aggregate totals ──────────────────────────────────────────────────────
  const totals = sectionStats.reduce(
    (acc, s) => ({
      words: acc.words + s.words,
      sentences: acc.sentences + s.sentences,
      paragraphs: acc.paragraphs + s.paragraphs,
      longSentences: acc.longSentences + s.longSentences,
      citations: acc.citations + s.citations,
      passiveCount: acc.passiveCount + Math.round((s.passiveVoicePct / 100) * s.sentences),
    }),
    { words: 0, sentences: 0, paragraphs: 0, longSentences: 0, citations: 0, passiveCount: 0 },
  );

  const overallReadability =
    totals.sentences > 0 && totals.words > 0
      ? Math.round(
          (206.835 -
            1.015 * (totals.words / totals.sentences) -
            84.6 *
              ((sectionStats.reduce((sum, s) => sum + s.words * (s.fleschKincaidGrade > 0 ? s.fleschKincaidGrade + 15.59 : 15.59), 0) /
                Math.max(totals.words, 1))) *
            0.1) *
            10,
        ) / 10
      : 0;

  const overallGrade =
    totals.sentences > 0 && totals.words > 0
      ? Math.round(
          (0.39 * (totals.words / totals.sentences) +
            11.8 * 1.5 - // assume avg 1.5 syllables/word as a rough estimate
            15.59) *
            10,
        ) / 10
      : 0;

  const overallPassivePct =
    totals.sentences > 0
      ? Math.round((totals.passiveCount / totals.sentences) * 100)
      : 0;

  const overallCitationDensity =
    totals.words > 0
      ? Math.round((totals.citations / totals.words) * 1000) / 10
      : 0;

  // ── LLM assessment of academic register + clarity + conciseness ───────────
  // Send a condensed version (first 4000 chars) to keep the call fast.
  const sampleText = article.content.slice(0, 4000);

  const llmPrompt = `You are an expert scientific writing editor. Analyze the academic writing style of this research article excerpt.

ARTICLE TITLE: ${article.title}

TEXT SAMPLE (first 4000 chars):
${sampleText}

Assess these dimensions and provide specific, actionable feedback:

1. ACADEMIC REGISTER (0-100): How formal and appropriate is the tone for a scientific publication? (0 = casual/blog-like, 100 = perfectly formal academic)

2. CLARITY (0-100): How clear and unambiguous is the writing? (0 = confusing, 100 = crystal clear)

3. CONCISENESS (0-100): How free is it from wordiness and redundancy? (0 = very verbose, 100 = perfectly concise)

4. TOP 5 STYLE ISSUES: Identify the 5 most impactful writing issues with a specific example sentence from the text.

5. IMPROVEMENT SUGGESTIONS: 3-5 actionable suggestions to improve the writing style.

Respond as STRICT JSON:
{
  "academicRegister": 82,
  "clarity": 75,
  "conciseness": 68,
  "issues": [
    { "issue": "Overuse of passive voice", "example": "The structure was determined by...", "severity": "medium" },
    ...
  ],
  "suggestions": [
    { "priority": "high", "suggestion": "Convert 30% of passive constructions to active voice for stronger claims" },
    ...
  ]
}`;

  let llmAssessment: any = null;
  try {
    const raw = await chat(llmPrompt, {
      system:
        "You are an expert scientific writing editor. Output strict JSON only, no prose.",
      temperature: 0.3,
      maxTokens: 3000,
    });
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      llmAssessment = JSON.parse(jsonMatch[0]);
    }
  } catch (err: any) {
    console.warn("[analyze-style] LLM assessment failed:", err?.message);
    // Continue without LLM assessment — local heuristics are still useful.
  }

  // ── Build unified report ──────────────────────────────────────────────────
  const report = {
    // Overall scores (0-100)
    readabilityScore: Math.max(0, Math.min(100, Math.round(overallReadability))),
    gradeLevel: overallGrade,
    academicRegister: llmAssessment?.academicRegister ?? null,
    clarity: llmAssessment?.clarity ?? null,
    conciseness: llmAssessment?.conciseness ?? null,

    // Quantitative metrics
    metrics: {
      totalWords: totals.words,
      totalSentences: totals.sentences,
      totalParagraphs: totals.paragraphs,
      avgSentenceLength:
        totals.sentences > 0
          ? Math.round((totals.words / totals.sentences) * 10) / 10
          : 0,
      passiveVoicePct: overallPassivePct,
      longSentences: totals.longSentences,
      citations: totals.citations,
      citationDensity: overallCitationDensity,
      lexicalDiversity:
        totals.words > 0
          ? Math.round(
              (new Set(
                (article.content.match(/\b[a-zA-Z][a-zA-Z'-]*\b/g) || []).map(
                  (w) => w.toLowerCase(),
                ),
              ).size /
                totals.words) *
                100,
            )
          : 0,
    },

    // Per-section breakdown
    sections: sectionStats,

    // LLM-provided issues + suggestions
    issues: llmAssessment?.issues || [],
    suggestions: llmAssessment?.suggestions || [],

    // Readability interpretation
    readabilityLabel:
      overallReadability >= 80
        ? "Very easy to read"
        : overallReadability >= 60
          ? "Plain English"
          : overallReadability >= 40
            ? "Fairly difficult"
            : overallReadability >= 20
              ? "Difficult"
              : "Very difficult",
  };

  return NextResponse.json(report);
}
