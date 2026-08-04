import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/paragraphs/batch
 *
 * Batch operations on multiple paragraphs at once. Body:
 *   { action: "restore" | "delete", ids: string[] }
 *
 * - action="restore": sets deletedAt=null for all given IDs
 * - action="delete":  permanently deletes all given IDs (hard delete)
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { action, ids } = body as { action: string; ids: string[] };

  if (!action || !Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json(
      { error: "Missing 'action' or 'ids'." },
      { status: 400 },
    );
  }

  if (!["restore", "delete"].includes(action)) {
    return NextResponse.json(
      { error: `Unknown action '${action}'. Use 'restore' or 'delete'.` },
      { status: 400 },
    );
  }

  try {
    if (action === "restore") {
      const result = await db.paragraph.updateMany({
        where: { id: { in: ids }, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
      console.log(`[paragraph batch] restored ${result.count} paragraphs`);
      return NextResponse.json({ ok: true, action: "restore", affected: result.count });
    }

    // action === "delete" (permanent)
    const result = await db.paragraph.deleteMany({
      where: { id: { in: ids } },
    });
    console.log(`[paragraph batch] permanently deleted ${result.count} paragraphs`);
    return NextResponse.json({ ok: true, action: "delete", affected: result.count });
  } catch (err: any) {
    console.error("[paragraph batch] error:", err);
    return NextResponse.json(
      { error: err?.message || "Batch operation failed." },
      { status: 500 },
    );
  }
}
