"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Download, KeyRound, LogOut, Monitor, ShieldCheck, Smartphone } from "lucide-react";
import { Badge, Button, Callout, Dialog, DialogContent, DialogFooter, DialogHeader, Field, Input, Panel, Section, Skeleton } from "@craftpanel/ui";
import type { SessionInfo } from "@craftpanel/shared";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/queries";
import { formatDateTime, timeAgo } from "@/lib/format";
import { CopyButton } from "./server/workspace";

// ---- two-factor sign-in --------------------------------------------------------

export function TwoFactorSection() {
  const { state, refresh } = useAuth();
  const enabled = !!state?.user?.twoFactorEnabled;
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [disableOpen, setDisableOpen] = React.useState(false);
  const [codesOpen, setCodesOpen] = React.useState(false);
  return (
    <Section title="Two-factor sign-in" description="After your password, CraftPanel asks for a 6-digit code from an authenticator app (e.g. Aegis, Google Authenticator, 1Password).">
      <div className="flex flex-wrap items-center gap-3">
        {enabled ? <Badge variant="success">On</Badge> : <Badge>Off</Badge>}
        {enabled ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => setCodesOpen(true)}>
              <KeyRound /> New recovery codes
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDisableOpen(true)}>
              Turn off
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => setSetupOpen(true)}>
            <ShieldCheck /> Set up
          </Button>
        )}
      </div>
      <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
        <DialogContent>
          <TwoFactorEnrollment onDone={() => (setSetupOpen(false), void refresh())} />
        </DialogContent>
      </Dialog>
      <DisableTwoFactor open={disableOpen} onOpenChange={setDisableOpen} />
      <RegenerateCodes open={codesOpen} onOpenChange={setCodesOpen} />
    </Section>
  );
}

/** Outside a dialog (the "2FA required" page) headings can't use Radix' dialog title. */
const Standalone = React.createContext(false);

function StepHeader({ title, description }: { title: string; description: string }) {
  if (!React.useContext(Standalone)) return <DialogHeader title={title} description={description} />;
  // The page around it already shows the first step's title.
  return (
    <div className="space-y-1.5">
      {title !== "Set up two-factor sign-in" && <h2 className="text-base font-medium">{title}</h2>}
      <div className="text-sm text-muted-foreground">{description}</div>
    </div>
  );
}

/** Scan the QR code, confirm with a code, then save the recovery codes. Used in settings and when a role requires 2FA. */
export function TwoFactorEnrollment({ onDone, standalone = false }: { onDone: () => void; standalone?: boolean }) {
  return (
    <Standalone.Provider value={standalone}>
      <Enrollment onDone={onDone} />
    </Standalone.Provider>
  );
}

function Enrollment({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = React.useState<{
    secret: string;
    uri: string;
    qr: string;
  } | null>(null);
  const [code, setCode] = React.useState("");
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    api
      .post<{ secret: string; uri: string }>("/api/auth/2fa/setup")
      .then(async (r) => {
        const qr = await QRCode.toString(r.uri, {
          type: "svg",
          margin: 1,
          errorCorrectionLevel: "M",
        });
        if (!cancelled) setSetup({ ...r, qr });
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} />;
  return (
    <div className="space-y-5">
      <StepHeader title="Set up two-factor sign-in" description="1. Scan the code with your authenticator app. 2. Enter the 6-digit code it shows." />
      {error && <Callout variant="danger">{error}</Callout>}
      {!setup && !error && <Skeleton className="mx-auto size-48 rounded-lg" />}
      {setup && (
        <div className="space-y-3">
          {/* The SVG comes from the qrcode library, generated from our own otpauth URI. */}
          <div className="mx-auto size-48 rounded-lg bg-white p-2 [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: setup.qr }} aria-label="QR code for your authenticator app" role="img" />
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>Can&apos;t scan? Enter this key:</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
            <CopyButton value={setup.secret} />
          </div>
        </div>
      )}
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api.post<{ recoveryCodes: string[] }>("/api/auth/2fa/enable", { code });
            setCodes(r.recoveryCodes);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Code from the app" htmlFor="totp-code">
          <Input
            id="totp-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            className="font-mono tracking-widest"
          />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!setup || code.replace(/\s/g, "").length !== 6}>
          Turn on
        </Button>
      </form>
    </div>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join("\n");
  return (
    <div className="space-y-5">
      <StepHeader title="Save your recovery codes" description="Each code signs you in once if you lose your phone. They are shown only now." />
      <ul className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/40 p-4 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={text} label="Copy" />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(
              new Blob([`CraftPanel recovery codes\n\n${text}\n`], {
                type: "text/plain",
              }),
            );
            a.download = "craftpanel-recovery-codes.txt";
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          <Download /> Download
        </Button>
      </div>
      <DialogFooter>
        <Button onClick={onDone}>I saved them</Button>
      </DialogFooter>
    </div>
  );
}

function DisableTwoFactor({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { refresh } = useAuth();
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const disable = useAction(() => api.post("/api/auth/2fa/disable", { password, code }), {
    success: "Two-factor sign-in turned off",
    onSuccess: () => (onOpenChange(false), setPassword(""), setCode(""), void refresh()),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title="Turn off two-factor sign-in?" description="Your account is then protected by the password alone." />
        <Field label="Password" htmlFor="tfd-pw">
          <Input id="tfd-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Code from the app or a recovery code" htmlFor="tfd-code">
          <Input id="tfd-code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" />
        </Field>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" loading={disable.isPending} disabled={!password || code.length < 6} onClick={() => disable.mutate()}>
            Turn off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RegenerateCodes({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [code, setCode] = React.useState("");
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const regen = useAction(
    () =>
      api.post<{ recoveryCodes: string[] }>("/api/auth/2fa/recovery-codes", {
        code,
      }),
    { onSuccess: (r) => setCodes(r.recoveryCodes) },
  );
  const close = () => (onOpenChange(false), setCodes(null), setCode(""));
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent>
        {codes ? (
          <RecoveryCodes codes={codes} onDone={close} />
        ) : (
          <>
            <DialogHeader title="New recovery codes" description="Your old recovery codes stop working." />
            <Field label="Code from the app" htmlFor="rc-code">
              <Input id="rc-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="font-mono tracking-widest" />
            </Field>
            <DialogFooter>
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
              <Button loading={regen.isPending} disabled={code.replace(/\s/g, "").length !== 6} onClick={() => regen.mutate()}>
                Create codes
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- signed-in devices ----------------------------------------------------------

/** "Firefox on Windows" from a user-agent string; good enough to recognise one's own devices. */
export function describeUserAgent(ua: string | null): {
  label: string;
  mobile: boolean;
} {
  if (!ua) return { label: "Unknown device", mobile: false };
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : /curl|node|undici/i.test(ua)
              ? "Script"
              : "Browser";
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  return {
    label: os ? `${browser} on ${os}` : browser,
    mobile: /Mobile|Android|iPhone/.test(ua),
  };
}

export function SessionsSection() {
  const q = useQuery({
    queryKey: ["my-sessions"],
    queryFn: () => api.get<SessionInfo[]>("/api/auth/sessions"),
  });
  const revoke = useAction((id: string) => api.del(`/api/auth/sessions/${id}`), { success: "Device signed out", invalidate: [["my-sessions"]] });
  const others = useAction(() => api.post("/api/auth/sessions/sign-out-others"), { success: "All other devices signed out", invalidate: [["my-sessions"]] });
  const otherCount = q.data?.filter((s) => !s.current).length ?? 0;
  return (
    <Section
      title="Signed-in devices"
      description="Browsers where you are signed in. Sign out anything you don't recognise and change your password."
      actions={
        otherCount > 0 && (
          <Button size="sm" variant="secondary" onClick={() => others.mutate()} loading={others.isPending}>
            <LogOut /> Sign out other devices
          </Button>
        )
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-24 rounded-lg" />
      ) : q.error ? (
        <Callout variant="danger">{errorMessage(q.error)}</Callout>
      ) : (
        <SessionList sessions={q.data ?? []} onRevoke={(id) => revoke.mutate(id)} />
      )}
    </Section>
  );
}

export function SessionList({ sessions, onRevoke }: { sessions: SessionInfo[]; onRevoke?: (id: string) => void }) {
  if (!sessions.length) return <p className="text-[13px] text-muted-foreground">No active sessions.</p>;
  return (
    <Panel>
      <ul className="divide-y divide-border">
        {sessions.map((s) => {
          const d = describeUserAgent(s.userAgent);
          return (
            <li key={s.id} className="flex items-center gap-3 px-4 py-3 text-[13px]">
              {d.mobile ? <Smartphone className="size-4 shrink-0 text-muted-foreground" /> : <Monitor className="size-4 shrink-0 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">
                  {d.label}
                  {s.current && <Badge variant="success">This device</Badge>}
                </p>
                <p className="truncate text-xs text-muted-foreground" title={s.userAgent ?? undefined}>
                  {s.ip ?? "unknown address"} · active {timeAgo(s.lastSeenAt)} · signed in {formatDateTime(s.createdAt)}
                </p>
              </div>
              {!s.current && onRevoke && (
                <Button size="xs" variant="ghost" onClick={() => onRevoke(s.id)}>
                  Sign out
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
