/**
 * Single source of truth for the round-7 login gate.
 *
 * Set NEXT_PUBLIC_AUTH_ENABLED=true to re-enable the NextAuth credentials
 * gate (SessionGate login card + proxy.ts 401 enforcement on every /api/*
 * route). Anything else — including the variable being absent — means the
 * app behaves exactly like pre-round-7: no login card, open APIs.
 *
 * NEXT_PUBLIC_* vars are inlined into the client bundle at compile time,
 * so flipping the flag requires a dev-server restart (dev) or redeploy
 * (production). Consumed by:
 *   - src/proxy.ts                  (edge gatekeeper — pass-through when off)
 *   - src/components/sciwrite/session-gate.tsx (login card only when on)
 *   - src/app/page.tsx              ("Sign out" palette command only when on)
 *
 * Deliberately import-free so it stays edge-runtime safe (proxy.ts must
 * never pull node:crypto via src/lib/auth.ts).
 */
export const AUTH_ENABLED = process.env.NEXT_PUBLIC_AUTH_ENABLED === "true";
