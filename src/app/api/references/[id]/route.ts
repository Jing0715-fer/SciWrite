import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";

// r37 fix: unguarded P2025 (row already deleted — double-click / stale UI)
// threw an unhandled 500. Mapped to idempotent success / clean 500-with-JSON.

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await db.reference.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    if (err?.code === "P2025") {
      // Already gone — idempotent success (double-click safe).
      return NextResponse.json({ ok: true, alreadyDeleted: true });
    }
    console.error("[/api/references/[id]] DELETE error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Delete failed.") },
      { status: 500 }
    );
  }
}
