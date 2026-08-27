import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { AUTH_ENABLED } from "@/lib/auth-mode";

/**
 * API gatekeeper (round-7 backend auth, toggleable).
 *
 * - DISABLED by default: unless NEXT_PUBLIC_AUTH_ENABLED=true, every
 *   request passes straight through (pre-round-7 open behavior — the
 *   login gate was rolled back because it blocked project creation in
 *   the sandbox preview; re-enable via env when needed).
 * - When enabled, guards every /api/* route except an explicit public
 *   allowlist.
 * - Unauthenticated API calls receive a clean 401 JSON (no redirect —
 *   the frontend api-client surfaces the error message directly).
 * - The page itself ("/") is NOT gated here: the SessionGate client
 *   component on "/" renders the login card when anonymous, because the
 *   sandbox only exposes a single page route.
 *
 * Public allowlist:
 *   /api/auth/*      — NextAuth's own endpoints (session/csrf/callback/signout)
 *   /api/shared/*    — share links must stay accessible to logged-out
 *                      collaborators holding a valid token
 *
 * Edge-runtime safe: only next-auth/jwt (jose) — never imports
 * src/lib/auth.ts (node:crypto).
 *
 * Named "proxy" per the Next.js 16 file convention (replaces the
 * deprecated "middleware" convention with identical semantics).
 */

const PUBLIC_PREFIXES = ["/api/auth", "/api/shared"];

export default async function proxy(req: NextRequest) {
  // Toggle off → pass through everything, no session lookup at all.
  if (!AUTH_ENABLED) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;

  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
    // v4 writes the cookie under different names depending on secure mode;
    // the raw name is used in dev (http).
    cookieName: process.env.NODE_ENV === "production" ? "__Secure-next-auth.session-token" : "next-auth.session-token",
  });

  if (token) {
    return NextResponse.next();
  }

  return NextResponse.json(
    { error: "Unauthorized", message: "Sign in to use the SciWrite API." },
    { status: 401 }
  );
}

export const config = {
  // Match all API routes; static assets (_next/*, favicon) are skipped.
  matcher: ["/api/:path*"],
};
