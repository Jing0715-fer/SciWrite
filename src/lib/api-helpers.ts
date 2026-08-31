import { NextResponse } from "next/server";

/**
 * Shared API-route helpers (code-review hardening).
 *
 * 1. safeError — error-response sanitization. Raw `err.message` from Prisma
 *    leaks schema/field/constraint details ("Foreign key constraint failed on
 *    field: `paragraphId`", "Invalid `db.project.create()` invocation...").
 *    This helper logs the full error server-side and returns a generic
 *    message to the client. Known-safe Prisma codes are mapped to friendly
 *    404/400 responses.
 */

/** Errors safe to show the client verbatim (never contain schema details). */
const CLIENT_SAFE_ERROR_CODES = new Set(["P2025"]); // record not found

export function safeErrorMessage(err: unknown, fallback: string): string {
  const anyErr = err as any;
  // Known-safe Prisma codes → friendly text.
  if (anyErr?.code === "P2025") return "Record not found.";
  if (anyErr?.code === "P2002") return "A record with the same unique value already exists.";
  if (anyErr?.code === "P2003") return "Related record not found.";
  return fallback;
}

/**
 * Standard 500 response: logs the real error server-side, returns a generic
 * message. Usage:
 *   catch (err) {
 *     return serverError(err, res, "Failed to create project.");
 *   }
 */
export function serverError(err: unknown, fallback: string, status = 500) {
  console.error(`[api] ${fallback}`, err);
  return NextResponse.json({ error: safeErrorMessage(err, fallback) }, { status });
}

// ---------------------------------------------------------------------------
// 2. SSRF guard for user-controlled URLs (deep-read / import endpoints).
//    Blocks private/loopback/link-local targets (cloud metadata endpoints,
//    localhost services, internal hostnames) before any outbound fetch.
// ---------------------------------------------------------------------------

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local — includes AWS/GCP metadata endpoints
  /^::1$/,
  /^\[?::1\]?$/,
  /^fc00:/i,
  /^fe80:/i,
  /^fd[0-9a-f]{2}:/i, // r37: was /^fd/i — matched "fda.gov" (real site!)
  /^::ffff:127\./i,   // r37: IPv4-mapped IPv6 loopback bypass
  /^::ffff:10\./i,
  /^::ffff:192\.168\./i,
  /^0x[0-9a-f]+$/i,   // r37: hex loopback (0x7f000001)
  /^\d{8,10}$/,       // r37: decimal loopback (2130706433)
  /^0[0-7]+\./,       // r37: octal loopback (0177.0.0.1)
  /\.internal$/i,
  /\.local$/i,
  /^metadata\./i,
];

export class UnsafeUrlError extends Error {
  constructor(url: string) {
    super(`Blocked unsafe URL target: ${new URL(url).host}`);
    this.name = "UnsafeUrlError";
  }
}

/**
 * Throws UnsafeUrlError if the URL points at a private/internal target.
 * Only http(s) is allowed. Returns the parsed URL on success.
 */
export function assertSafeExternalUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError(rawUrl);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeUrlError(rawUrl);
  }
  const host = parsed.hostname;
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new UnsafeUrlError(rawUrl);
  }
  return parsed;
}
