import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chat } from "@/lib/ai";
import { buildComposePrompt, countWords } from "@/lib/writing";
import type { ComposeRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ComposeRequest;
    if (!body.projectId || !body.paragraphIds?.length) {
      return NextResponse.json(
        { error: "projectId and paragraphIds are required." },
        { status: 400 }
      );
    }

    const paragraphs = await db.paragraph.findMany({
      where: { id: { in: body.paragraphIds } },
      orderBy: { order: "asc" },
    });

    // honor the order supplied by the user
    const ordered = body.paragraphIds
      .map((pid) => paragraphs.find((p) => p.id === pid))
      .filter(Boolean) as typeof paragraphs;

    if (!ordered.length) {
      return NextResponse.json(
        { error: "No paragraphs found for the given ids." },
        { status: 404 }
      );
    }

    const system =
      "You are a senior scientific editor who composes coherent, deeply-synthesized research articles from multiple authored paragraphs while preserving every inline citation.";
    const prompt = buildComposePrompt({
      title: body.title,
      abstract: body.abstract,
      depth: body.depth || "standard",
      paragraphs: ordered.map((p) => ({
        title: p.title,
        format: p.format,
        content: p.content,
      })),
    });

    const content = await chat(prompt, { system, temperature: 0.55 });

    const article = await db.article.create({
      data: {
        projectId: body.projectId,
        title: body.title,
        abstract: body.abstract || null,
        content,
        articleParagraph: {
          create: ordered.map((p, i) => ({
            paragraphId: p.id,
            order: i,
            section: p.format,
          })),
        },
      },
      include: { articleParagraph: true },
    });

    return NextResponse.json({
      article,
      content,
      wordCount: countWords(content),
      sourceParagraphs: ordered.length,
    });
  } catch (err: any) {
    console.error("[/api/ai/compose] error:", err);
    return NextResponse.json(
      { error: err?.message || "Composition failed." },
      { status: 500 }
    );
  }
}
