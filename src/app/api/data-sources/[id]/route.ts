import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";

// r37 fix: unguarded P2025 (row already deleted — double-click / stale UI)
// threw an unhandled 500; malformed PATCH bodies also 500'd without a JSON
// error. Mapped to clean 404/400 like the sibling [id] routes.

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const data: Record<string, unknown> = {};
  if (body.pinned !== undefined) data.pinned = Boolean(body.pinned);
  if (body.summary !== undefined) data.summary = String(body.summary);
  try {
    const source = await db.dataSource.update({ where: { id }, data });
    return NextResponse.json({ dataSource: source });
  } catch (err: any) {
    if (err?.code === "P2025") {
      return NextResponse.json({ error: "Data source not found." }, { status: 404 });
    }
    console.error("[/api/data-sources/[id]] PATCH error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Update failed.") },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await db.dataSource.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    if (err?.code === "P2025") {
      // Already gone — idempotent success (double-click safe).
      return NextResponse.json({ ok: true, alreadyDeleted: true });
    }
    console.error("[/api/data-sources/[id]] DELETE error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Delete failed.") },
      { status: 500 }
    );
  }
}
