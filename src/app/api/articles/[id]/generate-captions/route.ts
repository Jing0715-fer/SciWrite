import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const maxDuration = 45;

/**
 * POST /api/articles/[id]/generate-captions
 *
 * AI-powered figure & table caption generator. Scans the article body for:
 *  - "Figure N" / "Fig. N" / "Fig N" references
 *  - "Table N" / "Tab. N" references
 *  - Markdown image syntax ![alt](src)
 *  - Markdown tables (|...|)
 *
 * For each detected figure/table that lacks a descriptive caption, the LLM
 * generates a publication-quality caption based on the surrounding context.
 *
 * Returns:
 *   {
 *     captions: [{
 *       type: "figure" | "table",
 *       number: number,
 *       reference: "Figure 1",
 *       context: string (surrounding text),
 *       caption: string (generated caption),
 *       existingCaption: string | null
 *     }],
 *     totalDetected: number
 *   }
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const article = await db.article.findUnique({
    where: { id },
  });

  if (!article) {
    return NextResponse.json({ error: "Article not found." }, { status: 404 });
  }

  const content = article.content;
  if (!content || content.trim().length < 50) {
    return NextResponse.json({
      captions: [],
      totalDetected: 0,
      message: "Article content is too short to detect figures/tables.",
    });
  }

  // ── Detect figure / table references and their surrounding context ───────
  // Match "Figure 1", "Fig. 1", "Fig 1", "Table 1", "Tab. 1" etc.
  const figureRe = /\b(?:Figure|Fig\.?)\s*(\d{1,2})\b/gi;
  const tableRe = /\b(?:Table|Tab\.?)\s*(\d{1,2})\b/gi;

  const detected: {
    type: "figure" | "table";
    number: number;
    reference: string;
    context: string;
  }[] = [];

  const seenFig = new Set<number>();
  const seenTab = new Set<number>();

  let m: RegExpExecArray | null;
  while ((m = figureRe.exec(content))) {
    const num = parseInt(m[1]);
    if (!seenFig.has(num) && num >= 1 && num <= 50) {
      seenFig.add(num);
      const start = Math.max(0, m.index - 300);
      const end = Math.min(content.length, m.index + 300);
      detected.push({
        type: "figure",
        number: num,
        reference: `Figure ${num}`,
        context: content.slice(start, end).replace(/\s+/g, " ").trim(),
      });
    }
  }
  while ((m = tableRe.exec(content))) {
    const num = parseInt(m[1]);
    if (!seenTab.has(num) && num >= 1 && num <= 50) {
      seenTab.add(num);
      const start = Math.max(0, m.index - 300);
      const end = Math.min(content.length, m.index + 300);
      detected.push({
        type: "table",
        number: num,
        reference: `Table ${num}`,
        context: content.slice(start, end).replace(/\s+/g, " ").trim(),
      });
    }
  }

  // Also detect markdown images ![alt](src) — assign them figure numbers
  const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let imgCount = 0;
  while ((m = imgRe.exec(content))) {
    imgCount++;
    const num = seenFig.size + imgCount;
    if (num <= 50) {
      detected.push({
        type: "figure",
        number: num,
        reference: `Figure ${num} (image: ${m[1] || "untitled"})`,
        context: m[0],
      });
    }
  }

  if (detected.length === 0) {
    return NextResponse.json({
      captions: [],
      totalDetected: 0,
      message: "No figure or table references found in the article.",
    });
  }

  // Cap at 15 to fit context window
  const toGenerate = detected.slice(0, 15);

  const itemsText = toGenerate
    .map(
      (d, i) =>
        `[${i + 1}] ${d.reference.toUpperCase()}
  Context: ${d.context.slice(0, 400)}`
    )
    .join("\n\n");

  const prompt = `You are a scientific figure/table caption writer. For each detected figure or table reference below, generate a publication-quality caption.

ARTICLE TITLE: ${article.title}
TOPIC: ${(article as { topic?: string | null }).topic || "(general research)"}

DETECTED FIGURES/TABLES (${toGenerate.length}):
${itemsText}

For each item, write a concise, informative caption that:
- Starts with the figure/table label (e.g. "Figure 1. " or "Table 1. ")
- Summarizes what the figure/table shows (1-2 sentences)
- Includes key findings or trends visible in the data
- Uses scientific register (third person, passive voice acceptable)

Respond as STRICT JSON:
{
  "captions": [
    {
      "index": 1,
      "caption": "Figure 1. Structural overview of the protein complex. The ribbon diagram highlights the alpha-helical domains (blue) and beta-sheet regions (orange), with ligand-binding sites indicated by arrows."
    },
    ...
  ]
}

Generate a caption for every detected item. Be specific to the article's topic.`;

  try {
    const raw = await chat(prompt, {
      system:
        "You are a scientific caption writer. Output strict JSON only, no prose.",
      temperature: 0.5,
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

    // Map generated captions back to detected items
    const captions = (parsed.captions || [])
      .filter((c: any) => c.index >= 1 && c.index <= toGenerate.length)
      .map((c: any) => {
        const d = toGenerate[c.index - 1];
        return {
          type: d.type,
          number: d.number,
          reference: d.reference,
          context: d.context.slice(0, 200),
          caption: c.caption || "",
        };
      });

    return NextResponse.json({
      captions,
      totalDetected: detected.length,
      generated: captions.length,
    });
  } catch (err: any) {
    console.error("[generate-captions] error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Caption generation failed.") },
      { status: 500 }
    );
  }
}
