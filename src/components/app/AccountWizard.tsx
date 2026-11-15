import React, { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { connectGoogleMailbox } from "../../lib/google-gmail";
import { PROVIDERS, providerByKey } from "../../lib/providers";
import type { SendingAccount } from "../../lib/types";
import { useToast } from "../ui/ToastProvider";

interface AccountWizardProps {
  open: boolean;
  onClose: () => void;
  onConnected: (account: SendingAccount) => void;
}

function GoogleLogoSvg() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export function AccountWizard({ open, onClose, onConnected }: AccountWizardProps) {
  const { notify } = useToast();
  const [email, setEmail] = useState("");
  const [senderName, setSenderName] = useState("");
  const [emailsPerDay, setEmailsPerDay] = useState(50);
  const [providerKey, setProviderKey] = useState("auto");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(465);
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [detecting, setDetecting] = useState(false);
  const [detectedOnce, setDetectedOnce] = useState(false);
  const [mxRecords, setMxRecords] = useState<string[]>([]);
  const [mxWarning, setMxWarning] = useState("");
  const [showServerFields, setShowServerFields] = useState(false);
  const [creating, setCreating] = useState(false);
  const [googleConnecting, setGoogleConnecting] = useState(false);
  const [connectError, setConnectError] = useState<{
    message: string;
    code?: string;
    providerKey?: string;
  } | null>(null);

  const detectTimer = useRef<number | null>(null);
  const lastVerifiedEmail = useRef<string>("");

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setSenderName("");
    setEmailsPerDay(50);
    setProviderKey("auto");
    setSmtpHost("");
    setSmtpPort(465);
    setImapHost("");
    setImapPort(993);
    setPassword("");
    setShowPassword(false);
    setDetecting(false);
    setDetectedOnce(false);
    setMxRecords([]);
    setMxWarning("");
    setShowServerFields(false);
    setGoogleConnecting(false);
    setConnectError(null);
    lastVerifiedEmail.current = "";
    return () => {
      if (detectTimer.current) window.clearTimeout(detectTimer.current);
    };
  }, [open]);

  if (!open) return null;

  async function runDetectMx(targetEmail: string, force = false) {
    const trimmed = targetEmail.trim().toLowerCase();
    const parts = trimmed.split("@");
    if (parts.length !== 2 || !parts[0] || !parts[1]?.includes(".")) return;
    if (!force && lastVerifiedEmail.current === trimmed) return;

    lastVerifiedEmail.current = trimmed;
    setDetecting(true);
    setMxWarning("");
    try {
      const res = await api.detectMx(trimmed);
      setProviderKey(res.detected.providerKey || "custom");
      setMxRecords(res.mxRecords ?? []);
      setDetectedOnce(true);

      const first = res.detected.candidates[0];
      if (first) {
        setSmtpHost(first.smtpHost);
        setSmtpPort(first.smtpPort);
        setImapHost(first.imapHost);
        setImapPort(first.imapPort);
      }

      if (!res.mxRecords || res.mxRecords.length === 0) {
        setMxWarning(
          `No MX records found for ${res.domain || parts[1]}. Check the email or enter custom server settings below.`,
        );
      }
    } catch (err) {
      setMxWarning((err as Error).message || "Could not verify MX records for this domain.");
    } finally {
      setDetecting(false);
    }
  }

  function handleEmailChange(nextEmail: string) {
    setEmail(nextEmail);
    setConnectError(null);
    if (detectTimer.current) window.clearTimeout(detectTimer.current);
    const parts = nextEmail.trim().split("@");
    if (parts.length === 2 && parts[0] && parts[1]?.includes(".")) {
      detectTimer.current = window.setTimeout(() => {
        runDetectMx(nextEmail);
      }, 320);
    } else {
      setProviderKey("auto");
      setSmtpHost("");
      setImapHost("");
      setDetectedOnce(false);
      setMxRecords([]);
      setMxWarning("");
      lastVerifiedEmail.current = "";
    }
  }

  function handlePresetChange(nextKey: string) {
    setProviderKey(nextKey);
    const preset = providerByKey(nextKey);
    if (preset.smtpHost) setSmtpHost(preset.smtpHost);
    if (preset.smtpPort) setSmtpPort(preset.smtpPort);
    if (preset.imapHost) setImapHost(preset.imapHost);
    if (preset.imapPort) setImapPort(preset.imapPort);
  }

  async function handleGoogleConnect(hintEmail?: string) {
    setGoogleConnecting(true);
    setConnectError(null);
    try {
      const authRes = await connectGoogleMailbox(hintEmail);
      const created = await api.connectGoogleAccount({
        accessToken: authRes.accessToken,
        display_name: senderName.trim() || authRes.displayName,
        daily_limit: emailsPerDay || 50,
      });
      notify(`Connected ${created.email}`, {
        description: "Gmail sending and reply sync active with your Google permission.",
        kind: "success",
      });
      onConnected(created);
      onClose();
    } catch (err) {
      const message = (err as Error).message || "Could not connect with Google.";
      setConnectError({ message });
      notify(message, { kind: "error" });
    } finally {
      setGoogleConnecting(false);
    }
  }

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    setCreating(true);
    setConnectError(null);
    try {
      const created = await api.createAccount({
        email: email.trim(),
        display_name: senderName.trim() || email.split("@")[0],
        provider: "smtp",
        provider_label: providerKey === "auto" ? undefined : providerKey,
        smtp_host: smtpHost.trim() || undefined,
        smtp_port: Number(smtpPort) || 465,
        imap_host: imapHost.trim() || undefined,
        imap_port: Number(imapPort) || 993,
        password: password.trim(),
        daily_limit: emailsPerDay || 50,
        warmup_enabled: false,
        warmup_daily_cap: 30,
      });
      notify(`Connected ${created.email}`, {
        description: `Verified via ${created.smtp_host}:${created.smtp_port}`,
        kind: "success",
      });
      onConnected(created);
      onClose();
    } catch (err) {
      const apiErr = err as ApiError;
      setConnectError({
        message: apiErr.message || "Could not connect mailbox.",
        code: apiErr.code,
        providerKey: apiErr.providerKey || providerKey,
      });
      if (apiErr.code === "HOST_UNREACHABLE") {
        setShowServerFields(true);
      }
      notify(apiErr.message || "Could not connect mailbox.", { kind: "error" });
    } finally {
      setCreating(false);
    }
  }

  const detectedPreset = providerKey !== "auto" ? providerByKey(providerKey) : null;
  const errorPreset = connectError?.providerKey
    ? providerByKey(connectError.providerKey)
    : detectedPreset;
  const primaryMx = mxRecords[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div className="w-full max-w-[480px] rounded-xl border border-border bg-card shadow-xl overflow-hidden max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between px-6 pt-6 pb-2">
          <div className="pr-4">
            <h3 className="font-display text-xl font-semibold text-foreground">
              Connect a mailbox
            </h3>
            <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
              Connect Gmail in one click or enter any email and password with automatic MX, SMTP, and IMAP setup.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground pt-0.5"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 pt-3 pb-1 space-y-3">
          <button
            type="button"
            disabled={googleConnecting || creating}
            onClick={() => handleGoogleConnect(email || undefined)}
            className="w-full inline-flex items-center justify-center gap-2.5 rounded-md border border-[#747775]/45 bg-white px-4 py-2.5 text-sm font-medium text-[#1f1f1f] shadow-xs hover:bg-[#f8fafd] transition-colors disabled:opacity-50"
          >
            {googleConnecting ? (
              <Loader2 className="h-4 w-4 animate-spin text-[#4285F4]" />
            ) : (
              <GoogleLogoSvg />
            )}
            <span>
              {googleConnecting ? "Connecting Google..." : "Sign in with Google (Gmail / Workspace)"}
            </span>
          </button>

          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            <span>or connect any mailbox with email &amp; password</span>
            <div className="h-px flex-1 bg-border" />
          </div>
        </div>

        <form onSubmit={handleConnect} className="px-6 pb-6 pt-2 space-y-4">
          {/* Email Address + Automated MX Verification */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-foreground">
                Email address
              </label>
              {email.includes("@") && (
                <button
                  type="button"
                  disabled={detecting}
                  onClick={() => runDetectMx(email, true)}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${detecting ? "animate-spin" : ""}`} />
                  <span>Re-verify MX</span>
                </button>
              )}
            </div>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => handleEmailChange(e.target.value)}
              onBlur={() => runDetectMx(email)}
              placeholder="you@company.com"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-signal/70"
            />

            {detecting && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-signal shrink-0" />
                <span>Verifying domain MX records...</span>
              </div>
            )}

            {!detecting && detectedOnce && !mxWarning && detectedPreset && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                  <span>{detectedPreset.shortLabel}</span>
                </span>
                <span className="font-mono text-[11px] text-muted-foreground truncate max-w-[250px]">
                  {primaryMx ? `MX: ${primaryMx}` : `${smtpHost}:${smtpPort}`}
                </span>
              </div>
            )}

            {!detecting && mxWarning && (
              <div className="mt-2 flex items-start gap-1.5 rounded-md border border-warning/35 bg-warning-soft px-2.5 py-2 text-[11px] text-foreground">
                <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
                <span>{mxWarning}</span>
              </div>
            )}
          </div>

          {/* Password */}
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">
              Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setConnectError(null);
                }}
                placeholder="Enter your mailbox password"
                className="h-10 w-full rounded-md border border-input bg-background pl-3 pr-10 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* Sender name + Emails per day */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1.5">
                Sender name
              </label>
              <input
                type="text"
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
                placeholder="Alex Rivera"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1.5">
                Emails per day
              </label>
              <input
                type="number"
                min={1}
                max={500}
                value={emailsPerDay}
                onChange={(e) => setEmailsPerDay(Number(e.target.value) || 50)}
                className="tabular h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          {/* Inline Error Recovery (only shown if connecting fails) */}
          {connectError && (
            <div className="rounded-md border border-destructive/35 bg-destructive/5 p-3 space-y-2 text-xs">
              <div className="flex items-start gap-2 text-foreground">
                <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-medium leading-relaxed">{connectError.message}</p>
                  {(connectError.code === "APP_PASSWORD_REQUIRED" || connectError.code === "AUTH_FAILED") &&
                    errorPreset?.passwordSteps[0] && (
                      <p className="text-muted-foreground leading-relaxed">
                        {errorPreset.passwordSteps[0]}
                      </p>
                    )}
                </div>
              </div>
              {(connectError.code === "APP_PASSWORD_REQUIRED" || connectError.code === "AUTH_FAILED") &&
                (connectError.providerKey === "gmail" || errorPreset?.extraLink || errorPreset?.passwordLink) && (
                  <div className="flex flex-wrap items-center gap-2 pl-6">
                    {connectError.providerKey === "gmail" && (
                      <button
                        type="button"
                        disabled={googleConnecting}
                        onClick={() => handleGoogleConnect(email)}
                        className="inline-flex items-center gap-1.5 rounded border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-[#1f1f1f] hover:bg-muted"
                      >
                        <GoogleLogoSvg />
                        <span>Sign in with Google instead</span>
                      </button>
                    )}
                    {errorPreset?.extraLink && (
                      <a
                        href={errorPreset.extraLink.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted"
                      >
                        <span>{errorPreset.extraLink.label}</span>
                        <ExternalLink className="h-3 w-3 text-muted-foreground" />
                      </a>
                    )}
                    {errorPreset?.passwordLink && (
                      <a
                        href={errorPreset.passwordLink.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted"
                      >
                        <KeyRound className="h-3 w-3 text-muted-foreground" />
                        <span>{errorPreset.passwordLink.label}</span>
                        <ExternalLink className="h-3 w-3 text-muted-foreground" />
                      </a>
                    )}
                  </div>
                )}
            </div>
          )}

          {/* Collapsible Server Settings (auto-populated, editable only if needed) */}
          <div className="border-t border-border/70 pt-3">
            <button
              type="button"
              onClick={() => setShowServerFields((v) => !v)}
              className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground"
            >
              <span className="font-mono text-[11px] truncate">
                {smtpHost
                  ? `${smtpHost}:${smtpPort} · ${imapHost || smtpHost}:${imapPort}`
                  : "Server settings (auto-detected on connect)"}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] font-medium shrink-0 ml-2">
                <span>{showServerFields ? "Hide" : "Adjust host & port"}</span>
                {showServerFields ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </span>
            </button>

            {showServerFields && (
              <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 space-y-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-foreground mb-1">
                    Mail server preset
                  </label>
                  <select
                    value={providerKey === "auto" ? "custom" : providerKey}
                    onChange={(e) => handlePresetChange(e.target.value)}
                    className="h-8 w-full rounded border border-input bg-card px-2 text-xs text-foreground"
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <input
                    type="text"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="SMTP host (auto)"
                    aria-label="SMTP host"
                    className="col-span-3 h-8 rounded border border-input bg-card px-2 font-mono text-[11px] text-foreground"
                  />
                  <input
                    type="number"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(Number(e.target.value) || 465)}
                    aria-label="SMTP port"
                    className="tabular h-8 rounded border border-input bg-card px-2 text-[11px] text-foreground"
                  />
                  <input
                    type="text"
                    value={imapHost}
                    onChange={(e) => setImapHost(e.target.value)}
                    placeholder="IMAP host (auto)"
                    aria-label="IMAP host"
                    className="col-span-3 h-8 rounded border border-input bg-card px-2 font-mono text-[11px] text-foreground"
                  />
                  <input
                    type="number"
                    value={imapPort}
                    onChange={(e) => setImapPort(Number(e.target.value) || 993)}
                    aria-label="IMAP port"
                    className="tabular h-8 rounded border border-input bg-card px-2 text-[11px] text-foreground"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between pt-1">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-success shrink-0" />
              <span>Encrypted credentials</span>
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-2 text-xs font-semibold text-foreground hover:text-muted-foreground"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating || googleConnecting || !email.trim() || !password.trim()}
                className="rounded-md bg-signal px-5 py-2 text-xs font-semibold text-signal-foreground hover:opacity-90 disabled:opacity-45"
              >
                {creating ? "Connecting..." : "Connect"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
