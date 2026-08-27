import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

// NextAuth route handler (API route — not a page route).
// Serves: GET /api/auth/session, GET/POST /api/auth/csrf,
// POST /api/auth/callback/credentials, POST /api/auth/signout, etc.
const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
