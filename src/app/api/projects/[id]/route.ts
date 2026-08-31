import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/** Allowed project status values (schema integrity — PATCH validates against this). */
const PROJECT_STATUSES = new Set(["active", "archived", "draft"]);

/** Max length for user-provided text fields (guards against multi-MB payloads bloating SQLite). */
const MAX_TEXT_FIELD_LEN = 5000;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await db.project.findUnique({
    where: { id },
    include: {
      paragraphs: {
        // Only return active (non-trashed) paragraphs. Trashed paragraphs
        // are accessed via the paragraph trash dialog.
        where: { deletedAt: null },
        orderBy: { order: "asc" },
        include: {
          annotations: { orderBy: { createdAt: "desc" } },
          references: { orderBy: [{ citationOrder: "asc" }, { createdAt: "asc" }] },
          _count: { select: { annotations: true, references: true } },
          // r37: article-paragraph links (all articles — the client filters
          // to the article it is viewing; previously this data was absent so
          // the viewer's Sections-tab filter was a no-op `|| true`).
          articleParagraph: { select: { articleId: true, order: true } },
        },
      },
      dataSources: { orderBy: { createdAt: "desc" } },
      articles: { where: { deletedAt: null }, orderBy: { updatedAt: "desc" }, include: { _count: { select: { articleParagraph: true } } } },
      references: { where: { paragraphId: null }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!project) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Deduplicate references WITHIN each paragraph (same type+externalId = same ref)
  // but allow the same reference to appear in multiple paragraphs
  for (const p of project.paragraphs) {
    const seenInPara = new Set<string>();
    const uniqueRefs: typeof p.references = [];
    for (const r of p.references) {
      const key = `${r.type}:${r.externalId || r.title}`;
      if (!seenInPara.has(key)) {
        seenInPara.add(key);
        uniqueRefs.push(r);
      }
    }
    (p as any).references = uniqueRefs;
  }

  return NextResponse.json({ project });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // ---- Input validation (code-review fix: arbitrary status strings were
  // persisted verbatim, and text fields had no length cap) ----
  if (body.status !== undefined && !PROJECT_STATUSES.has(String(body.status))) {
    return NextResponse.json(
      { error: `Invalid status. Must be one of: ${[...PROJECT_STATUSES].join(", ")}.` },
      { status: 400 }
    );
  }
  for (const field of ["title", "topic", "description", "field"]) {
    if (body[field] !== undefined && String(body[field]).length > MAX_TEXT_FIELD_LEN) {
      return NextResponse.json(
        { error: `Field '${field}' exceeds the ${MAX_TEXT_FIELD_LEN}-character limit.` },
        { status: 400 }
      );
    }
  }

  try {
    const project = await db.project.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: String(body.title) } : {}),
        ...(body.topic !== undefined ? { topic: String(body.topic) } : {}),
        ...(body.description !== undefined
          ? { description: String(body.description) }
          : {}),
        ...(body.field !== undefined ? { field: String(body.field) } : {}),
        ...(body.status !== undefined ? { status: String(body.status) } : {}),
      },
    });
    return NextResponse.json({ project });
  } catch (err: any) {
    // Prisma P2025 = record not found; anything else is logged server-side
    // and surfaced as a generic message (no schema/field leakage).
    if (err?.code === "P2025") {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    console.error("[api/projects/:id PATCH]", err);
    return NextResponse.json({ error: "Failed to update project." }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await db.project.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    if (err?.code === "P2025") {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    console.error("[api/projects/:id DELETE]", err);
    return NextResponse.json({ error: "Failed to delete project." }, { status: 500 });
  }
}
