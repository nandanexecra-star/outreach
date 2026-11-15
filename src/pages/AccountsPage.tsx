import React, { useEffect, useState } from "react";
import {
  Activity,
  Mail,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { api } from "../lib/api";
import {
  connectGoogleMailbox,
  disconnectGoogleMailbox,
  hasInMemoryGmailToken,
} from "../lib/google-gmail";
import { presetForAccount } from "../lib/providers";
import type { SendingAccount } from "../lib/types";
import { AccountWizard } from "../components/app/AccountWizard";
import { ConfirmDialog } from "../components/app/ConfirmDialog";
import { LinkableTextarea } from "../components/app/LinkableTextarea";
import { PageHeader, StatusTag, formatDateTime } from "../components/app/SharedUi";
import { useToast } from "../components/ui/ToastProvider";

export function AccountsPage() {
  const { notify } = useToast();
  const [accounts, setAccounts] = useState<SendingAccount[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  // Selected account editable fields
  const [displayName, setDisplayName] = useState("");
  const [dailyLimit, setDailyLimit] = useState(50);
  const [warmupEnabled, setWarmupEnabled] = useState(false);
  const [warmupCap, setWarmupCap] = useState(30);
  const [signature, setSignature] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SendingAccount | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [wizardOpen, setWizardOpen] = useState(false);

  async function load(selectFirst = false) {
    setLoading(true);
    try {
      const rows = await api.listAccounts();
      setAccounts(rows);
      if ((selectFirst || !selectedId) && rows[0]) {
        pickAccount(rows[0]);
      } else if (rows.length === 0) {
        setSelectedId("");
      }
    } catch (err) {
      notify((err as Error).message, { kind: "error" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(true);
  }, []);

  function pickAccount(acc: SendingAccount) {
    setSelectedId(acc.id);
    setDisplayName(acc.display_name);
    setDailyLimit(acc.daily_limit);
    setWarmupEnabled(acc.warmup_enabled);
    setWarmupCap(acc.warmup_daily_cap);
    setSignature(acc.signature);
  }

  async function handleTestConnection(acc: SendingAccount) {
    setTesting(true);
    try {
      await api.testAccount(acc.id);
      notify(
        acc.provider === "gmail_api"
          ? "Gmail API connection verified"
          : "SMTP & IMAP connection verified",
        {
          description: "Both outbound sending and inbound reply syncing succeeded.",
          kind: "success",
        },
      );
    } catch (err) {
      notify((err as Error).message, { kind: "error" });
    } finally {
      setTesting(false);
    }
  }

  async function handleReconnectGoogle(acc: SendingAccount) {
    setReconnecting(true);
    try {
      const authRes = await connectGoogleMailbox(acc.email);
      const updated = await api.reconnectGoogleAccount(acc.id, authRes.accessToken);
      setAccounts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      notify(`Reconnected ${updated.email}`, {
        description: "Google permission refreshed for sending and inbox sync.",
        kind: "success",
      });
    } catch (err) {
      notify((err as Error).message, { kind: "error" });
    } finally {
      setReconnecting(false);
    }
  }

  async function saveAccount() {
    if (!selectedId) return;
    setSaving(true);
    try {
      const updated = await api.updateAccount(selectedId, {
        display_name: displayName,
        daily_limit: dailyLimit,
        warmup_enabled: warmupEnabled,
        warmup_daily_cap: warmupCap,
        signature,
      });
      setAccounts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      notify("Mailbox settings saved", { kind: "success" });
    } catch (err) {
      notify((err as Error).message, { kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(acc: SendingAccount) {
    const next = acc.status === "active" ? "paused" : "active";
    try {
      const updated = await api.updateAccount(acc.id, { status: next });
      setAccounts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      notify(`${acc.email} is now ${next}`, { kind: "success" });
    } catch (err) {
      notify((err as Error).message, { kind: "error" });
    }
  }

  async function confirmRemoveAccount() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteAccount(deleteTarget.id);
      if (deleteTarget.provider === "gmail_api") {
        await disconnectGoogleMailbox(deleteTarget.email);
      }
      setDeleteTarget(null);
      setSelectedId("");
      notify("Mailbox removed", { kind: "info" });
      await load(true);
    } catch (err) {
      notify((err as Error).message, { kind: "error" });
    } finally {
      setDeleting(false);
    }
  }

  const activeAccount = accounts.find((a) => a.id === selectedId) ?? null;
  const activePreset = activeAccount ? presetForAccount(activeAccount) : null;
  const isGmailOAuth = activeAccount?.provider === "gmail_api";
  const gmailSessionReady = activeAccount ? hasInMemoryGmailToken(activeAccount.email) : false;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Deliverability Infrastructure"
        title="Email Accounts"
        description="Connect Gmail in one click via Google sign-in, or connect Zoho Mail, Outlook, GoDaddy, Hostinger, or custom domain mailboxes with automatic MX setup."
        actions={
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-signal px-4 py-2 text-xs font-medium text-signal-foreground hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Connect mailbox</span>
          </button>
        }
      />

      {loading ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-xs text-muted-foreground">
          Loading mailboxes...
        </div>
      ) : accounts.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-10 text-center space-y-3">
          <Mail className="h-7 w-7 text-signal mx-auto" />
          <h2 className="text-base font-semibold text-foreground">No mailboxes connected yet</h2>
          <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
            Sign in with Google for Gmail mailboxes without app passwords, or enter any domain email and password for automatic SMTP &amp; IMAP configuration.
          </p>
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-signal px-4 py-2 text-xs font-medium text-signal-foreground hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Connect a mailbox</span>
          </button>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
          {/* Left List */}
          <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
            {accounts.map((acc) => (
              <button
                key={acc.id}
                type="button"
                onClick={() => pickAccount(acc)}
                className={`w-full text-left px-4 py-4 transition-colors ${
                  selectedId === acc.id ? "bg-accent/70" : "hover:bg-muted/30"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground truncate">{acc.email}</span>
                  <StatusTag value={acc.status} />
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {acc.display_name || acc.email.split("@")[0]} ·{" "}
                    {acc.provider === "gmail_api" ? "Google OAuth" : "SMTP/IMAP"}
                  </span>
                  <span className="tabular">
                    {acc.sent_today}/
                    {acc.warmup_enabled ? Math.min(acc.daily_limit, acc.warmup_daily_cap) : acc.daily_limit} today
                  </span>
                </div>
              </button>
            ))}
          </div>

          {/* Right Detail Panel */}
          {activeAccount && (
            <div className="rounded-lg border border-border bg-card p-6 space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-signal" />
                    <h2 className="text-lg font-semibold text-foreground">{activeAccount.email}</h2>
                    <StatusTag value={activeAccount.status} />
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground flex flex-wrap items-center gap-2">
                    <span>
                      {activePreset?.shortLabel}
                      {isGmailOAuth ? " (Google OAuth)" : ""}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>Last synced: {formatDateTime(activeAccount.last_synced_at)}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {isGmailOAuth && (
                    <button
                      type="button"
                      disabled={reconnecting}
                      onClick={() => handleReconnectGoogle(activeAccount)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 text-signal ${reconnecting ? "animate-spin" : ""}`} />
                      <span>{gmailSessionReady ? "Refresh Google" : "Reconnect Google"}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={testing}
                    onClick={() => handleTestConnection(activeAccount)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                  >
                    <Activity className="h-3.5 w-3.5 text-success" />
                    <span>
                      {testing
                        ? "Testing..."
                        : isGmailOAuth
                          ? "Test Gmail API"
                          : "Test SMTP & IMAP"}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleStatus(activeAccount)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
                  >
                    {activeAccount.status === "active" ? (
                      <>
                        <Pause className="h-3.5 w-3.5" /> Pause
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5" /> Activate
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(activeAccount)}
                    className="rounded-md border border-border bg-background p-1.5 text-muted-foreground hover:text-destructive"
                    aria-label="Remove mailbox"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={saveAccount}
                    className="inline-flex items-center gap-1.5 rounded-md bg-signal px-4 py-1.5 text-xs font-medium text-signal-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    <Save className="h-3.5 w-3.5" />
                    <span>{saving ? "Saving..." : "Save"}</span>
                  </button>
                </div>
              </div>

              {isGmailOAuth && !gmailSessionReady && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/35 bg-warning-soft px-4 py-3 text-xs text-foreground">
                  <span>
                    Your Google access session is not cached in this browser tab yet. Click{" "}
                    <strong>Reconnect Google</strong> to send or sync replies.
                  </span>
                  <button
                    type="button"
                    disabled={reconnecting}
                    onClick={() => handleReconnectGoogle(activeAccount)}
                    className="rounded border border-border bg-card px-3 py-1 font-medium hover:bg-muted shrink-0"
                  >
                    {reconnecting ? "Connecting..." : "Reconnect Google"}
                  </button>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium mb-1">From display name</label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Daily sending limit</label>
                  <input
                    type="number"
                    min={5}
                    max={500}
                    value={dailyLimit}
                    onChange={(e) => setDailyLimit(Number(e.target.value) || 50)}
                    className="tabular h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  />
                </div>
              </div>

              <div className="rounded-md border border-border bg-background p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-xs font-medium text-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={warmupEnabled}
                      onChange={(e) => setWarmupEnabled(e.target.checked)}
                    />
                    <span>Enable Warmup Ramp Cap</span>
                  </label>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Warmup max/day:</span>
                    <input
                      type="number"
                      min={5}
                      max={200}
                      disabled={!warmupEnabled}
                      value={warmupCap}
                      onChange={(e) => setWarmupCap(Number(e.target.value) || 30)}
                      className="tabular h-7 w-16 rounded border border-input bg-card px-2 text-xs disabled:opacity-50"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  When enabled, outbound volume for this mailbox is capped at the warmup limit until domain reputation matures.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">
                  Mailbox Signature (supports markdown links like <code>[DECILE](https://decilemedia.co)</code>)
                </label>
                <LinkableTextarea
                  rows={4}
                  value={signature}
                  onValueChange={setSignature}
                  placeholder="Leave blank to use your global default signature from Settings."
                  className="w-full rounded-md border border-input bg-background p-3 text-sm leading-relaxed"
                />
              </div>

              {activePreset && (
                <div className="rounded-md border border-border bg-muted/30 p-4 space-y-1.5 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <ShieldCheck className="h-3.5 w-3.5 text-success" />
                    <span>Connection &amp; DNS Profile</span>
                  </div>
                  <div className="font-mono text-muted-foreground">
                    {isGmailOAuth
                      ? "Transport: Gmail REST API (Google OAuth · No app password required)"
                      : `SMTP: ${activeAccount.smtp_host}:${activeAccount.smtp_port} · IMAP: ${activeAccount.imap_host}:${activeAccount.imap_port}`}
                  </div>
                  {activePreset.spfInclude && (
                    <div className="font-mono text-muted-foreground">
                      Expected SPF include: {activePreset.spfInclude} · DKIM selectors:{" "}
                      {activePreset.dkimSelectors.join(", ")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <AccountWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onConnected={async (created) => {
          await load();
          pickAccount(created);
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Remove connected mailbox?"
        description={
          deleteTarget
            ? `Disconnect ${deleteTarget.email} from this workspace? Existing sent history remains in Unified Inbox, but scheduled emails will no longer use this mailbox.`
            : ""
        }
        confirmLabel="Remove mailbox"
        busy={deleting}
        onConfirm={confirmRemoveAccount}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
