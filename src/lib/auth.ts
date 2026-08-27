import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * SciWrite backend auth (round-7).
 *
 * Single-user, self-hosted deployment model:
 * - Credentials provider backed by environment variables (no Prisma User
 *   table — zero schema migration, JWT sessions only).
 * - Password is stored as SHA-256 hex in AUTH_PASSWORD_SHA256 and compared
 *   with a constant-time comparison. Zero extra dependencies (node:crypto).
 * - Brute-force protection: 5 consecutive failures for the same username
 *   locks login for 5 minutes (in-memory — resets on server restart, which
 *   is acceptable for a single-user self-hosted tool).
 *
 * NOTE: this module uses node:crypto and MUST only be imported from Node
 * runtime code (API routes). The edge middleware (src/middleware.ts) does
 * NOT import this file — it validates the JWT cookie via next-auth/jwt.
 */

const EXPECTED_USERNAME = process.env.AUTH_USERNAME || "";
const EXPECTED_HASH = process.env.AUTH_PASSWORD_SHA256 || "";

function verifyPassword(password: string): boolean {
  if (!EXPECTED_HASH) return false;
  try {
    const a = createHash("sha256").update(password, "utf8").digest();
    const b = Buffer.from(EXPECTED_HASH, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// --- tiny in-memory login rate limiter -------------------------------
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;
const failures = new Map<string, { count: number; lockedUntil: number }>();

function isLocked(username: string): boolean {
  const rec = failures.get(username);
  return !!rec && rec.lockedUntil > Date.now();
}

function recordFailure(username: string) {
  const rec = failures.get(username);
  const count = (rec?.count || 0) + 1;
  failures.set(username, {
    count,
    lockedUntil: count >= MAX_FAILURES ? Date.now() + LOCK_MS : 0,
  });
}

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  session: {
    strategy: "jwt",
    // 30 days, mirrors the share-token TTL philosophy.
    maxAge: 30 * 24 * 60 * 60,
  },
  providers: [
    CredentialsProvider({
      name: "SciWrite",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const username = (credentials?.username || "").trim();
        const password = credentials?.password || "";

        // Refuse to authenticate when the env config is missing — fail
        // closed instead of allowing an empty-credential login.
        if (!EXPECTED_USERNAME || !EXPECTED_HASH) {
          console.error("[auth] AUTH_USERNAME / AUTH_PASSWORD_SHA256 not configured");
          return null;
        }
        if (isLocked(username)) return null;

        const ok =
          username === EXPECTED_USERNAME && verifyPassword(password);
        if (ok) {
          failures.delete(username);
          return { id: "sciwrite-user", name: username };
        }
        recordFailure(username);
        return null;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user?.name) token.name = user.name;
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.name = token.name || EXPECTED_USERNAME || "user";
      }
      return session;
    },
  },
  pages: {
    // No dedicated sign-in page route (sandbox exposes only "/"). The
    // login UI is the SessionGate card rendered on "/" when anonymous.
    signIn: "/",
  },
};
