import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { randomBytes } from "node:crypto";
import { serverError } from "@/lib/api-helpers";

export const runtime = "nodejs";

/** Share links expire after 30 days. Expired tokens are rotated on next create. */
const SHARE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function makeExpiry(): Date {
  return new Date(Date.now() + SHARE_TOKEN_TTL_MS);
}

/**
 * POST /api/projects/[id]/share
 *
 * Generates a share token for the project. If a valid (non-expired) token
 * already exists, returns it so the share link stays stable. Legacy tokens
 * created before expiry was introduced get their expiry stamped on the next
 * create call (link stays valid). Expired tokens are rotated to a fresh one.
 * The token allows read-only access via GET /api/shared/[token].
 *
 * Body: { action: "create" | "revoke" }
 *  - create: generate / return / rotate token (30-day TTL)
 *  - revoke: set shareToken to null (disables all share links)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = body.action || "create";

  try {
    const project = await db.project.findUnique({ where: { id } });
    if (!project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    if (action === "revoke") {
      await db.project.update({
        where: { id },
        data: { shareToken: null, shareTokenExpiresAt: null },
      });
      return NextResponse.json({ ok: true, shareToken: null, expiresAt: null });
    }

    // action === "create"
    const expired =
      !!project.shareTokenExpiresAt &&
      project.shareTokenExpiresAt.getTime() <= Date.now();

    if (project.shareToken && !expired) {
      // Legacy token without an expiry stamp → keep the same token (link
      // stays stable) but stamp a fresh 30-day window on it.
      if (!project.shareTokenExpiresAt) {
        const expiresAt = makeExpiry();
        await db.project.update({
          where: { id },
          data: { shareTokenExpiresAt: expiresAt },
        });
        return NextResponse.json({
          shareToken: project.shareToken,
          expiresAt,
        });
      }
      return NextResponse.json({
        shareToken: project.shareToken,
        expiresAt: project.shareTokenExpiresAt,
      });
    }

    // No token yet, or the previous one expired → issue a fresh token.
    const token = randomBytes(24).toString("base64url");
    const expiresAt = makeExpiry();
    await db.project.update({
      where: { id },
      data: { shareToken: token, shareTokenExpiresAt: expiresAt },
    });

    return NextResponse.json(
      { shareToken: token, expiresAt },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err, "Failed to update share settings.");
  }
}
