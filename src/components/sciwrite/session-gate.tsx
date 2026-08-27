"use client";

import * as React from "react";
import { signIn } from "next-auth/react";
import { Loader2, LockKeyhole, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";

/**
 * SessionGate (round-7 backend auth).
 *
 * Client-side gate for the single "/" route: while anonymous, renders the
 * login card instead of the app; once signed in, mounts the app fresh so
 * all initial queries fire with the session cookie present.
 *
 * The actual enforcement lives in src/proxy.ts (every /api/* route returns
 * 401 without a valid session) — this component only provides the UI.
 */

type AuthStatus = "checking" | "signed-out" | "signed-in";

export function SessionGate({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<AuthStatus>("checking");

  React.useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/auth/session", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (!cancelled) setStatus(data?.user ? "signed-in" : "signed-out");
      } catch {
        if (!cancelled) setStatus("signed-out");
      }
    };
    check();
    // Re-check on window focus so a sign-out in another tab is honored.
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", check);
    };
  }, []);

  if (status === "checking") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
        <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center ring-academic">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
        <p className="text-xs font-serif-text tracking-tight">
          {t("auth.checkingSession")}
        </p>
      </div>
    );
  }

  if (status === "signed-out") {
    return <LoginCard onSignedIn={() => setStatus("signed-in")} />;
  }

  return <>{children}</>;
}

function LoginCard({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useI18n();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await signIn("credentials", {
        redirect: false,
        username: username.trim(),
        password,
      });
      if (res?.ok) {
        onSignedIn();
      } else {
        // CredentialsSignin covers both wrong credentials and the
        // 5-failure/5-minute rate-limit lock.
        setError(t("auth.invalidCredentials"));
      }
    } catch {
      setError(t("auth.invalidCredentials"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm acad-fade-in">
        <div className="surface-card rounded-2xl border border-border/60 shadow-lg p-6 sm:p-8 space-y-6">
          {/* Brand header */}
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="h-12 w-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center ring-academic">
              <LockKeyhole className="h-6 w-6" />
            </div>
            <h1 className="text-xl font-serif-text font-bold tracking-tight text-foreground">
              SciWrite
            </h1>
            <p className="text-sm font-medium text-foreground">
              {t("auth.signInTitle")}
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("auth.signInDesc")}
            </p>
          </div>

          {/* Login form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="auth-username" className="text-xs font-medium">
                {t("auth.username")}
              </Label>
              <Input
                id="auth-username"
                autoComplete="username"
                autoFocus
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t("auth.usernamePlaceholder")}
                className="h-9 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="auth-password" className="text-xs font-medium">
                {t("auth.password")}
              </Label>
              <div className="relative">
                <Input
                  id="auth-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("auth.passwordPlaceholder")}
                  className="h-9 text-sm pr-9"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-xs text-red-600 dark:text-red-400 leading-relaxed" role="alert">
                {error}
              </p>
            )}

            <Button
              type="submit"
              disabled={busy || !username.trim() || !password}
              className="w-full h-9 text-sm gap-1.5 btn-gradient-primary text-primary-foreground hover:shadow-md transition-all"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              {busy ? t("auth.signingIn") : t("auth.signIn")}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
