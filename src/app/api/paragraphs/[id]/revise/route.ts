import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatWithSession } from "@/lib/llm-session";
import { buildRevisePrompt, countWords } from "@/lib/writing";
import type { Annotation } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json();
    const mode = (body.mode as "annotations" | "instructions" | "polish") || "annotations";
    const paragraph = await db.paragraph.findUnique({
      where: { id },
      include: { annotations: true },
    });
    if (!paragraph) {
      return NextResponse.json({ error: "Paragraph not found." }, { status: 404 });
    }

    const unresolved =
      mode === "annotations"
        ? paragraph.annotations.filter((a) => !a.resolved)
        : [];
    if (mode === "annotations" && unresolved.length === 0) {
      return NextResponse.json(
        { error: "No unresolved annotations to revise against." },
        { status: 400 }
      );
    }

    await db.paragraph.update({ where: { id }, data: { status: "revising" } });

    const prompt = buildRevisePrompt({
      content: paragraph.content,
      annotations: unresolved as Annotation[],
      instructions: body.instructions ? String(body.instructions) : undefined,
      mode,
    });

    const system =
      "You are an expert scientific editor. Revise the paragraph to address reviewer feedback while preserving scientific accuracy and inline citations. Keep the academic register.";
    const revised = await chatWithSession(paragraph.projectId, prompt, {
      system,
      temperature: 0.5,
      taskType: "revise",
      metadata: { mode, paragraphId: id, annotationCount: unresolved.length },
    });

    const updated = await db.paragraph.update({
      where: { id },
      data: {
        content: revised,
        wordCount: countWords(revised),
        status: "revised",
      },
    });

    // mark addressed annotations as resolved and store AI response summary
    if (mode === "annotations") {
      await db.annotation.updateMany({
        where: { paragraphId: id, resolved: false },
        data: { resolved: true, aiResponse: "Revised by AI in latest revision." },
      });
    }

    return NextResponse.json({
      paragraph: updated,
      revised,
      addressedCount: unresolved.length,
    });
  } catch (err: any) {
    console.error("[revise] error:", err);
    // revert status on failure
    await db.paragraph
      .update({ where: { id }, data: { status: "annotated" } })
      .catch(() => {});
    return NextResponse.json(
      { error: err?.message || "Revision failed." },
      { status: 500 }
    );
  }
}
