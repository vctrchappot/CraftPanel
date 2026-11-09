"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Button, Callout, Field, Input } from "@craftpanel/ui";
import { api, ApiError, errorMessage, setCsrfToken } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Logo } from "./logo";
import { TwoFactorEnrollment } from "./account-security";

function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-3 text-center">
          <Logo className="mx-auto h-11 w-[38px]" />
          <div className="space-y-1">
            <h1 className="text-xl font-medium tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function LoginForm() {
  const { state, refresh } = useAuth();
  const router = useRouter();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  /** Set when the password was right and a second factor is needed. */
  const [challenge, setChallenge] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (state?.setupRequired) router.replace("/setup/");
    else if (state?.user) router.replace("/");
  }, [state, router]);

  if (challenge)
    return (
      <SecondFactor
        challenge={challenge}
        onBack={() => (setChallenge(null), setPassword(""))}
        onSignedIn={async () => {
          await refresh();
          router.replace("/");
        }}
      />
    );

  return (
    <AuthLayout title="Sign in to CraftPanel" subtitle="Manage your Minecraft servers">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api.post<{ csrfToken?: string; twoFactorRequired?: boolean; challenge?: string }>("/api/auth/login", { username, password });
            if (r.twoFactorRequired && r.challenge) return setChallenge(r.challenge);
            setCsrfToken(r.csrfToken ?? null);
            await refresh();
            router.replace("/");
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Username" htmlFor="username">
          <Input id="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}

function SecondFactor({ challenge, onBack, onSignedIn }: { challenge: string; onBack: () => void; onSignedIn: () => Promise<void> }) {
  const [code, setCode] = React.useState("");
  const [recovery, setRecovery] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  return (
    <AuthLayout title="Two-factor sign-in" subtitle={recovery ? "Enter one of your recovery codes" : "Enter the 6-digit code from your authenticator app"}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api.post<{ csrfToken: string }>("/api/auth/login/2fa", { challenge, code });
            setCsrfToken(r.csrfToken);
            await onSignedIn();
          } catch (err) {
            if (err instanceof ApiError && err.code === "challenge_expired") return onBack();
            setError(errorMessage(err));
            setCode("");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={recovery ? "Recovery code" : "Code"} htmlFor="code">
          <Input
            id="code"
            autoFocus
            autoComplete="one-time-code"
            inputMode={recovery ? "text" : "numeric"}
            maxLength={recovery ? 20 : 7}
            placeholder={recovery ? "abcd-efgh" : "123456"}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="font-mono tracking-widest"
            required
          />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" loading={busy}>
          Verify
        </Button>
        <div className="flex justify-between text-xs">
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onBack}>
            Back
          </button>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => (setRecovery(!recovery), setCode(""), setError(null))}>
            {recovery ? "Use the authenticator app" : "Use a recovery code"}
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}

/** Shown instead of the dashboard when the user's role requires two-factor sign-in and it isn't set up yet. */
export function TwoFactorRequired() {
  const { refresh } = useAuth();
  const router = useRouter();
  return (
    <AuthLayout title="Set up two-factor sign-in" subtitle="Your role requires a second factor. This takes about a minute.">
      <div className="rounded-xl border border-border bg-surface p-5">
        <TwoFactorEnrollment standalone onDone={() => void refresh()} />
      </div>
      <button
        type="button"
        className="mx-auto block text-xs text-muted-foreground hover:text-foreground"
        onClick={async () => {
          await api.post("/api/auth/logout").catch(() => undefined);
          await refresh();
          router.replace("/login/");
        }}
      >
        Sign out
      </button>
    </AuthLayout>
  );
}

export function SetupForm() {
  const { state, refresh } = useAuth();
  const router = useRouter();
  const [username, setUsername] = React.useState("admin");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [token, setToken] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submitted = React.useRef(false);
  React.useEffect(() => {
    if (state && !state.setupRequired && !submitted.current) router.replace(state.user ? "/" : "/login/");
  }, [state, router]);

  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <AuthLayout title="Welcome to CraftPanel" subtitle="Create the owner account for this installation">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (password !== confirm) return setError("Passwords do not match");
          setBusy(true);
          setError(null);
          try {
            submitted.current = true;
            const r = await api.post<{ csrfToken: string }>("/api/auth/setup", { username, password, setupToken: token || undefined });
            setCsrfToken(r.csrfToken);
            await refresh();
            router.replace("/servers/new/");
          } catch (err) {
            submitted.current = false;
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {state?.setupTokenRequired && (
          <>
            <Callout icon={<ShieldCheck />} title="Setup token required">
              This dashboard is reachable from your network. Enter the one-time token printed in the CraftPanel log on the host (also saved as <code>setup-token.txt</code> in the data directory).
            </Callout>
            <Field label="Setup token" htmlFor="token">
              <Input id="token" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" className="font-mono" />
            </Field>
          </>
        )}
        <Field label="Username" htmlFor="username" help="Letters, digits, '.', '_' and '-'.">
          <Input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} />
        </Field>
        <Field label="Password" htmlFor="password" help="At least 10 characters. A passphrase works well.">
          <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
        </Field>
        <Field label="Confirm password" htmlFor="confirm" error={mismatch ? "Passwords do not match" : null}>
          <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required aria-invalid={mismatch} />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" loading={busy}>
          Create owner account
        </Button>
        <p className="text-center text-xs text-muted-foreground">No account with any third party is created. Everything stays on this machine.</p>
      </form>
    </AuthLayout>
  );
}
