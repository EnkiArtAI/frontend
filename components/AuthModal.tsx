"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, Wallet, ArrowLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useEmailAuth } from "@/hooks/useEmailAuth";

type Mode = "signin" | "signup" | "forgot";

/**
 * Email + password auth. Register / sign in / forgot-password in one compact,
 * responsive card; wallet login is the optional route at the bottom (opens the
 * existing wallet picker via onWallet). 2FA prompts get layered on later.
 */
export function AuthModal({
  open,
  onClose,
  onWallet,
}: {
  open: boolean;
  onClose: () => void;
  onWallet?: () => void;
}) {
  const { register, login, forgot } = useEmailAuth();
  const { toast } = useToast();

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [socialNote, setSocialNote] = useState<string | null>(null);

  const reset = () => { setError(null); setSent(false); setSocialNote(null); };
  // Google and X hand the window to the OAuth start route. That backend is not
  // built yet, so probe first and say so instead of landing on a 404.
  const social = async (provider: "google" | "x") => {
    const url = `/api/auth/oauth/${provider}/start?next=${encodeURIComponent(window.location.pathname)}`;
    setSocialNote(null);
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "manual" });
      // A live start route answers 302, which redirect: "manual" surfaces as
      // opaqueredirect. Anything else (404, 503, the 401 of the beta gate) is not it.
      const live = res.type === "opaqueredirect" || res.ok;
      if (!live) throw new Error("unavailable");
      window.location.href = url;
    } catch {
      setSocialNote(`${provider === "google" ? "Google" : "X"} sign in is not available yet.`);
    }
  };
  const go = (m: Mode) => { reset(); setPassword(""); setConfirm(""); setMode(m); };
  // Clear a stale server error as soon as the user edits a field.
  const edit = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    if (error) setError(null);
    setter(e.target.value);
  };
  const close = () => { setMode("signin"); setEmail(""); setPassword(""); setConfirm(""); reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "signup" && password !== confirm) { setError("Passwords don't match"); return; }
    setLoading(true);
    try {
      if (mode === "signin") { await login(email.trim(), password); toast({ title: "Welcome back" }); close(); }
      else if (mode === "signup") { await register(email.trim(), password); toast({ title: "Account created" }); close(); }
      else { await forgot(email.trim()); setSent(true); }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const title = mode === "signup" ? "Create account" : mode === "forgot" ? "Reset password" : "Sign in";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="sm:max-w-sm p-5">
        <DialogHeader>
          <div className="flex items-center gap-2">
            {mode === "forgot" && (
              <button type="button" onClick={() => go("signin")} aria-label="Back"
                className="-ml-1 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                <ArrowLeft size={18} />
              </button>
            )}
            <DialogTitle className="text-base">{title}</DialogTitle>
          </div>
          <DialogDescription className="sr-only">Sign in or create an account with email and password.</DialogDescription>
        </DialogHeader>

        {sent ? (
          <div className="py-2 text-sm text-muted-foreground">
            If an account exists for <strong className="text-foreground">{email}</strong>, a reset link is on its way.
            <Button variant="outline" className="mt-4 w-full" onClick={() => go("signin")}>Back to sign in</Button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            {mode !== "forgot" && (
              <>
                <div role="group" aria-label="Continue with a social account" className="flex justify-center gap-3.5">
                  <Button type="button" variant="outline" className="h-11 w-11 p-0 [&_svg]:size-5" aria-label="Continue with Google" onClick={() => social("google")}>
                    <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
                  </Button>
                  <Button type="button" variant="outline" className="h-11 w-11 p-0 [&_svg]:size-[18px]" aria-label="Continue with X" onClick={() => social("x")}>
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                  </Button>
                </div>
                {socialNote && <p className="text-center text-xs text-muted-foreground" aria-live="polite">{socialNote}</p>}
                <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <span className="h-px flex-1 bg-border" /> or with email <span className="h-px flex-1 bg-border" />
                </div>
              </>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="auth-email" className="text-xs">{mode === "signin" ? "Email or username" : "Email"}</Label>
              <Input id="auth-email" type={mode === "signin" ? "text" : "email"} required autoFocus
                autoComplete={mode === "signin" ? "username" : "email"}
                placeholder={mode === "signin" ? "you@example.com or username" : "you@example.com"}
                value={email} onChange={edit(setEmail)} />
            </div>

            {mode !== "forgot" && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="auth-password" className="text-xs">Password</Label>
                  {mode === "signin" && (
                    <button type="button" onClick={() => go("forgot")}
                      className="text-xs text-muted-foreground hover:text-foreground">Forgot?</button>
                  )}
                </div>
                <Input id="auth-password" type="password" required minLength={8}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder="••••••••"
                  value={password} onChange={edit(setPassword)} />
              </div>
            )}

            {mode === "signup" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="auth-confirm" className="text-xs">Confirm password</Label>
                <Input id="auth-confirm" type="password" required minLength={8} autoComplete="new-password" placeholder="••••••••"
                  value={confirm} onChange={edit(setConfirm)} />
              </div>
            )}

            {error && <p className="text-xs text-red-500">{error}</p>}

            <Button type="submit" disabled={loading} className="mt-1 w-full">
              {loading && <Loader2 size={15} className="mr-2 animate-spin" />}
              {mode === "signup" ? "Create account" : mode === "forgot" ? "Send reset link" : "Sign in"}
            </Button>

            {mode !== "forgot" && (
              <p className="text-center text-xs text-muted-foreground">
                {mode === "signin" ? "New here? " : "Already have an account? "}
                <button type="button" onClick={() => go(mode === "signin" ? "signup" : "signin")}
                  className="font-medium text-foreground hover:underline">
                  {mode === "signin" ? "Create one" : "Sign in"}
                </button>
              </p>
            )}
          </form>
        )}

        {onWallet && mode !== "forgot" && (
          <>
            <div className="my-1 flex items-center gap-3 text-[11px] uppercase tracking-wide text-muted-foreground">
              <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
            </div>
            <Button variant="outline" className="w-full" onClick={() => { close(); onWallet(); }}>
              <Wallet size={15} className="mr-2" /> Continue with a wallet
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
