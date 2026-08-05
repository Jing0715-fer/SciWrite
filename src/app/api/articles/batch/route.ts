import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/articles/batch
 *
 * Batch operations on multiple articles at once. Body:
 *   { action: "restore" | "delete", ids: string[] }
 *
 * - action="restore": sets deletedAt=null for all given IDs (move back to active)
 * - action="delete":  permanently deletes all given IDs (hard delete)
 *
 * Returns { ok: true, affected: N } where N is the number of articles
 * actually modified. If some IDs don't exist, they're silently skipped
 * (the user doesn't need to know — the trash UI re-fetches after).
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
      const result = await db.article.updateMany({
        where: { id: { in: ids }, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
      console.log(`[batch] restored ${result.count} articles`);
      return NextResponse.json({ ok: true, action: "restore", affected: result.count });
    }

    // action === "delete" (permanent)
    const result = await db.article.deleteMany({
      where: { id: { in: ids } },
    });
    console.log(`[batch] permanently deleted ${result.count} articles`);
    return NextResponse.json({ ok: true, action: "delete", affected: result.count });
  } catch (err: any) {
    console.error("[batch] error:", err);
    return NextResponse.json(
      { error: err?.message || "Batch operation failed." },
      { status: 500 },
    );
  }
}
