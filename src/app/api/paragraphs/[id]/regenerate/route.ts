import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatStream } from "@/lib/ai";
import { saveSessionMessage } from "@/lib/llm-session";
import { countWords, sanitizeSectionContent, renumberByAppearance } from "@/lib/writing";
import {
  sanitizeOutOfRangeCitations,
  validateCitationsInline,
} from "@/lib/citation-audit";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * POST /api/paragraphs/[id]/regenerate
 *
 * Regenerate a single paragraph's English content using the same prompt
 * that was used during the original generation. The prompt is reconstructed
 * from the project's curated references + the paragraph's section info.
 *
 * This is different from "revise" (which edits existing content) and
 * "retranslate" (which translates EN→ZH). Regenerate completely replaces
 * the English content with a fresh LLM call.
 *
 * The regenerated content is sanitized (preambles, postscripts, meta-
 * commentary removed) before being saved to the database.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const paragraph = await db.paragraph.findUnique({
      where: { id },
      include: { references: { orderBy: { citationOrder: "asc" } } },
    });
    if (!paragraph) {
      return NextResponse.json({ error: "Paragraph not found." }, { status: 404 });
    }

    const project = await db.project.findUnique({
      where: { id: paragraph.projectId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    // Fetch all project-level references for the prompt context
    const allRefs = await db.reference.findMany({
      where: { projectId: paragraph.projectId, paragraphId: null },
      orderBy: { createdAt: "asc" },
    });

    // Also include this paragraph's own references
    const paraRefs = paragraph.references || [];
    const curatedRefs = [...allRefs, ...paraRefs];

    // Build reference context (same format as generate-full)
    const refContext = curatedRefs
      .map((r: any, i: number) => {
        const auth = r.authors || "Anon";
        const yr = r.year ? ` (${r.year})` : "";
        const jour = r.journal ? `, ${r.journal}` : "";
        const url = r.url ? ` — ${r.url}` : "";
        const abs = r.abstract ? `\nAbstract: ${r.abstract.slice(0, 200)}` : "";
        return `[${i + 1}] ${auth}${yr}${jour}. ${r.title}.${url}${abs}`;
      })
      .join("\n");

    // Fetch data sources for context
    const dataSources = await db.dataSource.findMany({
      where: { projectId: paragraph.projectId },
      take: 30,
    });
    const dsContext = dataSources
      .map((d: any, i: number) => {
        const parts = [`[DS:${i + 1}] (${d.source}) ${d.title || d.query}`];
        if (d.authors) parts.push(`Authors: ${d.authors}`);
        if (d.journal) parts.push(`Journal: ${d.journal}`);
        if (d.year) parts.push(`Year: ${d.year}`);
        if (d.abstract) parts.push(`Abstract: ${d.abstract.slice(0, 200)}`);
        return parts.join("\n");
      })
      .join("\n\n");

    // Build the prompt (same format as generate-full)
    const REF_BUDGET = 6000;
    const DS_BUDGET = 6000;
    const trimmedRef = refContext.length > REF_BUDGET
      ? refContext.slice(0, REF_BUDGET) + "\n... (truncated for context window)"
      : refContext;
    const trimmedDs = dsContext.length > DS_BUDGET
      ? dsContext.slice(0, DS_BUDGET) + "\n... (truncated for context window)"
      : dsContext;

    const targetWords = Math.max(300, paragraph.wordCount || 600);

    const prompt = `RESEARCH TOPIC: ${project.topic}
SECTION: ${paragraph.title}
TARGET WORDS: ${targetWords}
LANGUAGE: English

REFERENCE LIST (cite as [n], 1-based index into this list of ${curatedRefs.length} refs):
${trimmedRef}

DATABASE RECORDS (structural/sequence data — cite the associated publication):
${trimmedDs}

Now compose this section. Write DEEPLY and THOROUGHLY.

CITATION FORMAT (MANDATORY):
- Use ONLY numeric [n] citations (e.g. [1], [2], [3]).
- Number citations starting from [1] for THIS section. Each [n] refers to the n-th entry
  in the REFERENCE LIST above (${curatedRefs.length} entries, [1] to [[${curatedRefs.length}]).
- Cite AT LEAST 3 different references per ~500 words.
- Do NOT output a "### Citations" block — just write the text with [n] markers.`;

    const system = `You are a senior scientific research writer and domain expert.
Write in English, using formal, precise academic prose (third person, past tense for results/methods).
Compose ONE cohesive section without markdown headers. Do NOT add any preamble, commentary, word count, or notes. Output ONLY the article text.`;

    let newContent = "";
    try {
      newContent = await chatStream(prompt, {
        system,
        temperature: 0.65,
        thinking: false,
      });
    } catch {
      const { chat } = await import("@/lib/ai");
      newContent = await chat(prompt, { system, temperature: 0.65 });
    }

    // Sanitize citations — replace out-of-range [n] with [$REF].
    // Bug #2 fix: the original regex `\d+(?:[,\-\u2013\s*\d+)*` had a
    // broken character class (\s* inside [] becomes a literal '*' and the
    // whitespace intent is lost). Use the canonical form from citation-audit.
    const maxRefNum = curatedRefs.length;
    const { content: sanitizedContent, replaced: replacedCount } =
      sanitizeOutOfRangeCitations(newContent, maxRefNum);
    newContent = sanitizedContent;
    if (replacedCount > 0) {
      console.warn(
        `[regenerate] replaced ${replacedCount} out-of-range citation(s) with [$REF]`
      );
    }

    // Sanitize content — remove preambles, postscripts, meta-commentary
    newContent = sanitizeSectionContent(newContent);

    if (!newContent || newContent.length < 50) {
      return NextResponse.json(
        { error: "Regeneration produced empty or too-short output." },
        { status: 500 }
      );
    }

    // Bug #2 fix: renumber citations by order of first appearance so that
    // [1] = first cited ref, [2] = second, etc. This keeps the paragraph's
    // body numbering consistent with its saved references. Without this, the
    // regenerated body could have arbitrary [n] order that doesn't match the
    // paragraph's reference citationOrder — breaking hover tooltips and
    // downstream compose.
    const { content: renumberedContent, references: citedRefs } =
      renumberByAppearance(newContent, curatedRefs);
    newContent = renumberedContent;

    // Layer 1 — adversarial pre-save audit.
    const inlineFindings = validateCitationsInline(newContent, citedRefs as any);
    if (inlineFindings.length > 0) {
      const blocking = inlineFindings.filter(
        (f) => f.verdict === "out-of-range" || f.verdict === "missing"
      ).length;
      const suspect = inlineFindings.filter(
        (f) => f.verdict === "suspect" || f.verdict === "unsupported"
      ).length;
      console.warn(
        `[regenerate] citation audit: ${blocking} blocking, ${suspect} topicality warning(s)`
      );
    }

    // Save session messages
    try {
      await saveSessionMessage(paragraph.projectId, "generate", "user", prompt, {
        step: "regenerate",
        paragraphId: id,
        sectionTitle: paragraph.title,
      });
      await saveSessionMessage(paragraph.projectId, "generate", "assistant", newContent, {
        step: "regenerate",
        paragraphId: id,
        sectionTitle: paragraph.title,
        chars: newContent.length,
      });
    } catch {}

    // Update the paragraph
    const updated = await db.paragraph.update({
      where: { id },
      data: {
        content: newContent,
        wordCount: countWords(newContent),
      },
    });

    // Bug #2 fix: rebuild the paragraph's references so citationOrder matches
    // the renumbered body. Delete refs that are no longer cited, and upsert
    // the cited ones with their new citationOrder. This keeps the paragraph's
    // reference list in lock-step with its body — essential for compose and
    // hover-tooltip resolution.
    try {
      // Gather identities of the newly-cited refs.
      const citedIdentities = new Set(
        citedRefs.map((r: any) => {
          const t = (r.type || "manual").toLowerCase();
          return `${t}:${r.externalId || r.title}`;
        })
      );
      // Delete paragraph-level refs no longer cited.
      const stale = await db.reference.findMany({
        where: { paragraphId: id },
      });
      for (const ref of stale) {
        const t = (ref.type || "manual").toLowerCase();
        const key = `${t}:${ref.externalId || ref.title}`;
        if (!citedIdentities.has(key)) {
          await db.reference.delete({ where: { id: ref.id } });
        }
      }
      // Upsert cited refs with new citationOrder.
      for (let idx = 0; idx < citedRefs.length; idx++) {
        const ref = citedRefs[idx] as any;
        // r37 fix (W1 identity — ported from ai/write): findFirst on
        // externalId alone matched ANY same-paragraph ref with a null
        // externalId — with >=2 null-extId refs (manual/web) every later one
        // collapsed into a citationOrder update on the WRONG row.
        // Identity rule: externalId present -> type+externalId; else title+type.
        const existing = ref.externalId
          ? await db.reference.findFirst({
              where: { externalId: ref.externalId, type: ref.type, paragraphId: id },
            })
          : await db.reference.findFirst({
              where: { paragraphId: id, title: ref.title, type: ref.type || "manual" },
            });
        if (!existing) {
          await db.reference.create({
            data: {
              type: ref.type || "manual",
              externalId: ref.externalId,
              title: ref.title,
              authors: ref.authors,
              journal: ref.journal,
              year: ref.year,
              url: ref.url,
              doi: ref.doi,
              abstract: ref.abstract,
              projectId: paragraph.projectId,
              paragraphId: id,
              citationOrder: idx,
            },
          });
        } else {
          await db.reference.update({
            where: { id: existing.id },
            data: { citationOrder: idx },
          });
        }
      }
    } catch (e) {
      console.warn("[regenerate] failed to rebuild paragraph references:", e);
    }

    return NextResponse.json({
      paragraph: updated,
      content: newContent,
      wordCount: countWords(newContent),
    });
  } catch (err: any) {
    console.error("[regenerate] error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Regeneration failed.") },
      { status: 500 }
    );
  }
}
