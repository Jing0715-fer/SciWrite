import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { safeErrorMessage } from "@/lib/api-helpers";

export const runtime = "nodejs";

/**
 * POST /api/articles/purge-expired
 *
 * Permanently deletes articles that have been in the trash for more than
 * PURGE_AFTER_DAYS days. Called by the scheduled cron job (every 15 min).
 *
 * This endpoint is idempotent — if no articles are eligible for purge, it
 * returns { purged: 0 }.
 *
 * Security: requires a CRON_SECRET header to prevent external abuse. The
 * secret is read from the CRON_SECRET env var. When not set (local dev),
 * the endpoint is open so the cron tool can call it.
 */
const PURGE_AFTER_DAYS = 30;

export async function POST(req: NextRequest) {
  // Verify cron secret if configured
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    const provided = authHeader?.replace("Bearer ", "");
    if (provided !== cronSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const cutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000);

  try {
    // Find articles eligible for purge (deletedAt < cutoff)
    const expired = await db.article.findMany({
      where: {
        deletedAt: { not: null, lt: cutoff },
      },
      select: { id: true, title: true, deletedAt: true },
    });

    if (expired.length === 0) {
      return NextResponse.json({ purged: 0, message: "No expired articles." });
    }

    // Hard-delete all expired articles in a batch
    const result = await db.article.deleteMany({
      where: {
        id: { in: expired.map((a) => a.id) },
      },
    });

    console.log(
      `[purge-expired] Permanently deleted ${result.count} articles that were trashed before ${cutoff.toISOString()}`,
      expired.map((a) => ({ id: a.id, title: a.title.slice(0, 60), deletedAt: a.deletedAt })),
    );

    return NextResponse.json({
      purged: result.count,
      cutoff: cutoff.toISOString(),
      articles: expired.map((a) => ({ id: a.id, title: a.title.slice(0, 80) })),
    });
  } catch (err: any) {
    console.error("[purge-expired] error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Purge failed.") },
      { status: 500 },
    );
  }
}
