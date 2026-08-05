import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";

/**
 * POST /api/projects/[id]/share
 *
 * Generates a share token for the project. If a token already exists,
 * returns the existing one (so the share link is stable). The token
 * allows read-only access via GET /api/shared/[token].
 *
 * Body: { action: "create" | "revoke" }
 *  - create: generate or return existing token
 *  - revoke: set shareToken to null (disables all share links)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = body.action || "create";

  const project = await db.project.findUnique({ where: { id } });
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  if (action === "revoke") {
    await db.project.update({
      where: { id },
      data: { shareToken: null },
    });
    return NextResponse.json({ ok: true, shareToken: null });
  }

  // action === "create"
  if (project.shareToken) {
    return NextResponse.json({ shareToken: project.shareToken });
  }

  // Generate a 24-byte URL-safe token
  const token = randomBytes(24).toString("base64url");
  await db.project.update({
    where: { id },
    data: { shareToken: token },
  });

  return NextResponse.json({ shareToken: token }, { status: 201 });
}
