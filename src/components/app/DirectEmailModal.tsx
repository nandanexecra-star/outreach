import React, { useEffect, useState } from "react";
import { Mail, Send, X } from "lucide-react";
import { api } from "../../lib/api";
import { pickSignature } from "../../lib/compose";
import { STANDARD_VARIABLES } from "../../lib/email-utils";
import type { Attachment, Lead, SendingAccount } from "../../lib/types";
import { useToast } from "../ui/ToastProvider";
import { AttachmentsPicker } from "./AttachmentsPicker";
import { ConfirmDialog } from "./ConfirmDialog";
import { LinkableTextarea } from "./LinkableTextarea";
import { TemplatePicker } from "./TemplatePicker";

interface DirectEmailModalProps {
  open: boolean;
  initialLead?: Partial<Lead> | null;
  onClose: () => void;
  onSent?: (threadId: string) => void;
}

export function DirectEmailModal({
  open,
  initialLead,
  onClose,
  onSent,
}: DirectEmailModalProps) {
  const { notify } = useToast();
  const [accounts, setAccounts] = useState<SendingAccount[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [defaultSignature, setDefaultSignature] = useState("");
  const [loading, setLoading] = useState(false);

  const [accountId, setAccountId] = useState("");
  const [toEmail, setToEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [company, setCompany] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [includeSignature, setIncludeSignature] = useState(true);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setToEmail(initialLead?.email ?? "");
    setFirstName(initialLead?.first_name ?? "");
    setLastName(initialLead?.last_name ?? "");
    setCompany(initialLead?.company ?? "");
    setSubject("");
    setBody("");
    setAttachments([]);
    setIncludeSignature(true);
    setConfirmOpen(false);

    let active = true;
    setLoading(true);
    Promise.all([api.listAccounts(), api.listLeads(), api.getSettings()])
      .then(([accs, leadRows, settingsRes]) => {
        if (!active) return;
        setAccounts(accs);
        setLeads(leadRows);
        setDefaultSignature(settingsRes.settings.default_signature ?? "");
        const firstActive =
          accs.find((a) => a.status === "active" && a.has_credentials) ?? accs[0];
        if (firstActive) setAccountId(firstActive.id);
      })
      .catch((err) => {
        if (!active) return;
        notify((err as Error).message, { kind: "error" });
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [open, initialLead]);

  if (!open) return null;

  const activeAccounts = accounts.filter((a) => a.status === "active" && a.has_credentials);
  const selectedAccount = accounts.find((a) => a.id === accountId) ?? activeAccounts[0] ?? null;
  const effectiveSignature = pickSignature(selectedAccount?.signature, defaultSignature).trim();

  function handleSelectExistingLead(leadId: string) {
    const match = leads.find((l) => l.id === leadId);
    if (!match) return;
    setToEmail(match.email);
    setFirstName(match.first_name);
    setLastName(match.last_name);
    setCompany(match.company);
  }

  function handleReviewSend(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId) {
      notify("Connect an active mailbox first.", { kind: "error" });
      return;
    }
    if (!toEmail.trim() || !subject.trim() || !body.trim()) return;
    setConfirmOpen(true);
  }

  async function executeSend() {
    if (!accountId || !toEmail.trim() || !subject.trim() || !body.trim()) return;
    setSending(true);
    try {
      const res = await api.sendDirectEmail({
        toEmail: toEmail.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        company: company.trim(),
        accountId,
        subject: subject.trim(),
        body: body.trim(),
        attachments,
        includeSignature,
      });
      notify(`Email sent (${res.mode})`, {
        description: `Delivered directly to ${toEmail.trim()} and logged in Unified Inbox.`,
        kind: "success",
      });
      setConfirmOpen(false);
      onSent?.(res.threadId);
      onClose();
    } catch (err) {
      notify((err as Error).message, { kind: "error" });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-xl overflow-hidden max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-signal" />
            <div>
              <h2 className="text-base font-semibold text-foreground">Send 1-to-1 Email</h2>
              <p className="text-xs text-muted-foreground">
                Send immediately to one recipient without setting up a campaign.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleReviewSend} className="p-6 space-y-4">
          {loading ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              Loading mailboxes...
            </div>
          ) : activeAccounts.length === 0 ? (
            <div className="rounded-md border border-warning/35 bg-warning-soft p-4 text-xs text-foreground">
              No active connected mailbox found. Connect an email account in Email Accounts first.
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    From mailbox
                  </label>
                  <select
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    {activeAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.display_name ? `${acc.display_name} <${acc.email}>` : acc.email}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    Pick saved contact (optional)
                  </label>
                  <select
                    defaultValue=""
                    onChange={(e) => handleSelectExistingLead(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="">Type custom recipient below...</option>
                    {leads.map((l) => (
                      <option key={l.id} value={l.id}>
                        {`${l.first_name} ${l.last_name}`.trim() || l.email} — {l.email}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-12">
                <div className="sm:col-span-5">
                  <label className="block text-xs font-medium text-foreground mb-1">
                    To email *
                  </label>
                  <input
                    type="email"
                    required
                    value={toEmail}
                    onChange={(e) => setToEmail(e.target.value)}
                    placeholder="recipient@company.com"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <div className="sm:col-span-3">
                  <label className="block text-xs font-medium text-foreground mb-1">
                    First name
                  </label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Alex"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <div className="sm:col-span-4">
                  <label className="block text-xs font-medium text-foreground mb-1">
                    Company
                  </label>
                  <input
                    type="text"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="Acme Inc."
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <label className="text-xs font-medium text-foreground">Subject *</label>
                <TemplatePicker
                  kinds={["email", "reply"]}
                  onPick={(tpl) => {
                    if (tpl.subject) setSubject(tpl.subject);
                    setBody(tpl.body);
                  }}
                />
              </div>
              <input
                type="text"
                required
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Quick question about {{company}}"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                  <label className="text-xs font-medium text-foreground">Message *</label>
                  <div className="flex flex-wrap items-center gap-1">
                    {STANDARD_VARIABLES.slice(0, 4).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() =>
                          setBody((prev) => `${prev}${prev.endsWith(" ") || !prev ? "" : " "}{{${v}}}`)
                        }
                        className="font-mono text-[11px] rounded border border-border bg-background px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                      >
                        {`{{${v}}}`}
                      </button>
                    ))}
                  </div>
                </div>
                <LinkableTextarea
                  rows={6}
                  required
                  value={body}
                  onValueChange={setBody}
                  placeholder="Write your direct 1-to-1 email..."
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              <div>
                <div className="text-xs font-medium text-foreground mb-1.5">
                  Attachments &amp; links
                </div>
                <AttachmentsPicker value={attachments} onChange={setAttachments} />
              </div>

              <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
                <label className="flex items-center gap-2 text-xs font-medium text-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeSignature}
                    onChange={(e) => setIncludeSignature(e.target.checked)}
                  />
                  <span>
                    Include signature from {selectedAccount?.email || "selected mailbox"}
                  </span>
                </label>
                {includeSignature && (
                  <p className="whitespace-pre-wrap text-[11px] text-muted-foreground pl-5 leading-relaxed">
                    {effectiveSignature || "No signature saved yet (edit in Email Accounts or Settings)."}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sending || !toEmail.trim() || !subject.trim() || !body.trim()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-signal px-4 py-2 text-xs font-medium text-signal-foreground hover:opacity-90 disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>{sending ? "Sending..." : "Send 1-to-1 email"}</span>
                </button>
              </div>
            </>
          )}
        </form>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Send 1-to-1 email now?"
        description={`Send this email immediately from ${selectedAccount?.email || "your mailbox"} to ${toEmail.trim()}?`}
        confirmLabel="Confirm & send"
        busy={sending}
        onConfirm={executeSend}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
