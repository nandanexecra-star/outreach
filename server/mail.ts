import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import { detectMailbox, type ServerCandidate } from "../src/lib/mailbox-detect";
import { isValidEmail, normalizeEmail } from "../src/lib/email-utils";
import { toHtml, toPlainText } from "../src/lib/rich-text";
import { getAccountCredential, UPLOADS_DIR } from "./store";
import type { EmailCheckStatus, ReplyCategory } from "../src/lib/types";

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "tempmail.com",
  "10minutemail.com",
  "yopmail.com",
  "trashmail.com",
  "throwawaymail.com",
]);

export async function lookupMxForEmail(email: string): Promise<{
  domain: string;
  mxRecords: string[];
  detected: ReturnType<typeof detectMailbox>;
}> {
  const domain = (email.trim().toLowerCase().split("@")[1] ?? "").replace(/\.$/, "");
  if (!domain) {
    return { domain: "", mxRecords: [], detected: detectMailbox(email, []) };
  }
  try {
    const records = await dns.promises.resolveMx(domain);
    const sorted = records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
    return { domain, mxRecords: sorted, detected: detectMailbox(email, sorted) };
  } catch {
    return { domain, mxRecords: [], detected: detectMailbox(email, []) };
  }
}

export async function verifyEmailAddressServer(
  rawEmail: string,
  mxCache?: Map<string, string[]>,
): Promise<{
  result: EmailCheckStatus;
  reason: string;
}> {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    return { result: "invalid", reason: "Invalid email syntax" };
  }
  const domain = email.split("@")[1] ?? "";
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { result: "invalid", reason: "Disposable inbox domain" };
  }
  try {
    let hosts = mxCache?.get(domain);
    if (!hosts) {
      const mx = await dns.promises.resolveMx(domain);
      hosts = mx.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
      mxCache?.set(domain, hosts);
    }
    if (!hosts.length) {
      return { result: "invalid", reason: "Domain has no mail (MX) records" };
    }
    const primary = hosts[0] ?? "mail server";
    if (/^(info|support|sales|hello|contact|admin)@/.test(email)) {
      return { result: "risky", reason: `Role-based inbox · MX: ${primary}` };
    }
    return { result: "valid", reason: `MX verified (${primary})` };
  } catch {
    mxCache?.set(domain, []);
    return { result: "invalid", reason: "Domain MX lookup failed" };
  }
}

export class MailboxAuthError extends Error {
  code: "APP_PASSWORD_REQUIRED" | "AUTH_FAILED" | "HOST_UNREACHABLE";
  constructor(
    message: string,
    code: "APP_PASSWORD_REQUIRED" | "AUTH_FAILED" | "HOST_UNREACHABLE",
  ) {
    super(message);
    this.code = code;
  }
}

function classifySmtpError(err: Error): MailboxAuthError {
  const msg = err.message || "";
  if (/5\.7\.139|smtpclientauthentication is disabled/i.test(msg)) {
    return new MailboxAuthError(
      "Microsoft 365 has Authenticated SMTP disabled (or Security Defaults blocking basic auth). Enable Authenticated SMTP for this user in Microsoft 365 Admin, or generate an App Password if MFA is enabled.",
      "APP_PASSWORD_REQUIRED",
    );
  }
  if (
    /application-specific password|534-5\.7\.9|534 5\.7\.9|app password|invalidsecondfactor|two-factor|must use an app/i.test(
      msg,
    ) ||
    (/535-5\.7\.8/.test(msg) && /gmail|google|gsmtp/i.test(msg))
  ) {
    return new MailboxAuthError(
      "This mail provider rejected your normal password and requires an App Password (or Google sign-in).",
      "APP_PASSWORD_REQUIRED",
    );
  }
  if (/535|invalid login|authentication failed|incorrect authentication|username and password not accepted|auth/i.test(msg)) {
    return new MailboxAuthError(
      `${msg} (If 2FA is active or external SMTP/IMAP is disabled in provider settings, create an App Password or enable SMTP/IMAP access.)`,
      "AUTH_FAILED",
    );
  }
  if (/DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID|unable to verify the first certificate/i.test(msg)) {
    return new MailboxAuthError(
      `Mail server TLS certificate mismatch (${msg}). Click "Adjust host & port" and enter your hosting provider's canonical mail hostname.`,
      "HOST_UNREACHABLE",
    );
  }
  return new MailboxAuthError(msg, "HOST_UNREACHABLE");
}

function buildSmtpTransportOptions(opts: {
  host: string;
  port: number;
  email: string;
  password: string;
  timeoutMs: number;
  pool?: boolean;
}) {
  return {
    host: opts.host,
    port: opts.port,
    secure: opts.port === 465,
    requireTLS: opts.port === 587,
    tls: { minVersion: "TLSv1.2" as const },
    auth: { user: opts.email, pass: opts.password },
    connectionTimeout: opts.timeoutMs,
    greetingTimeout: opts.timeoutMs,
    socketTimeout: opts.timeoutMs,
    ...(opts.pool ? { pool: true, maxConnections: 5, maxMessages: 100 } : {}),
  };
}

export async function verifySmtpConnection(input: {
  email: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  timeoutMs?: number;
}): Promise<void> {
  const timeout = input.timeoutMs ?? 8_000;
  const transporter = nodemailer.createTransport(
    buildSmtpTransportOptions({
      host: input.smtpHost,
      port: input.smtpPort,
      email: input.email,
      password: input.password,
      timeoutMs: timeout,
    }),
  );
  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
}

export async function verifyImapConnection(input: {
  email: string;
  password: string;
  imapHost: string;
  imapPort: number;
  timeoutMs?: number;
}): Promise<void> {
  const port = input.imapPort || 993;
  const timeout = input.timeoutMs ?? 8_000;
  const client = new ImapFlow({
    host: input.imapHost,
    port,
    secure: port === 993,
    auth: { user: input.email, pass: input.password },
    logger: false,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
  });
  client.on("error", () => {});
  await client.connect();
  await client.logout().catch(() => {});
}

/**
 * Probes candidate SMTP host/ports concurrently in small batches for low latency
 * and auto-discovers working IMAP hosts so every provider connects cleanly.
 */
export async function resolveWorkingMailboxCandidate(input: {
  email: string;
  password: string;
  candidates: ServerCandidate[];
}): Promise<ServerCandidate> {
  const domain = input.email.trim().toLowerCase().split("@")[1] ?? "";
  let workingSmtp: ServerCandidate | null = null;
  let lastAuthErr: MailboxAuthError | null = null;
  let lastHostErr: MailboxAuthError | null = null;

  for (let i = 0; i < input.candidates.length; i += 3) {
    const batch = input.candidates.slice(i, i + 3);
    try {
      workingSmtp = await Promise.any(
        batch.map(async (cand) => {
          await verifySmtpConnection({
            email: input.email,
            password: input.password,
            smtpHost: cand.smtpHost,
            smtpPort: cand.smtpPort,
            timeoutMs: 5_000,
          });
          return { ...cand };
        }),
      );
      break;
    } catch (aggErr) {
      const errs = (aggErr as AggregateError).errors ?? [aggErr];
      for (const raw of errs) {
        const classified = classifySmtpError(raw as Error);
        if (classified.code === "APP_PASSWORD_REQUIRED") {
          throw classified;
        }
        if (classified.code === "AUTH_FAILED") {
          lastAuthErr = classified;
        } else {
          lastHostErr = classified;
        }
      }
    }
  }

  if (!workingSmtp) {
    throw (
      lastAuthErr ??
      lastHostErr ??
      new MailboxAuthError(
        "Could not connect to any SMTP server for this email address.",
        "HOST_UNREACHABLE",
      )
    );
  }

  // Concurrently probe matching IMAP host/ports (non-blocking for send-only SMTP relays)
  const imapTries: { host: string; port: number }[] = [
    { host: workingSmtp.imapHost, port: workingSmtp.imapPort || 993 },
  ];
  if (domain) {
    for (const h of [
      `imap.${domain}`,
      `mail.${domain}`,
      workingSmtp.smtpHost.replace(/^smtppro\./i, "imappro.").replace(/^smtp\./i, "imap."),
    ]) {
      if (h && !imapTries.some((t) => t.host === h && t.port === 993)) {
        imapTries.push({ host: h, port: 993 });
      }
    }
  }

  try {
    const workingImap = await Promise.any(
      imapTries.slice(0, 4).map(async (t) => {
        if (!t.host) throw new Error("Empty IMAP host");
        await verifyImapConnection({
          email: input.email,
          password: input.password,
          imapHost: t.host,
          imapPort: t.port,
          timeoutMs: 4_000,
        });
        return t;
      }),
    );
    workingSmtp.imapHost = workingImap.host;
    workingSmtp.imapPort = workingImap.port;
  } catch {
    // SMTP-only relay or IMAP disabled — keep best detected IMAP host
  }

  return workingSmtp;
}

// Ephemeral in-memory Gmail OAuth access tokens (never written to disk)
const ephemeralGmailTokens = new Map<string, string>();

export function setEphemeralGmailToken(email: string, accessToken: string) {
  const cleanEmail = email.trim().toLowerCase();
  if (cleanEmail && accessToken) {
    ephemeralGmailTokens.set(cleanEmail, accessToken);
  }
}

export function getEphemeralGmailToken(email: string): string | null {
  return ephemeralGmailTokens.get(email.trim().toLowerCase()) ?? null;
}

export function clearEphemeralGmailToken(email?: string) {
  if (email) ephemeralGmailTokens.delete(email.trim().toLowerCase());
  else ephemeralGmailTokens.clear();
}

export async function verifyGmailApiToken(accessToken: string): Promise<{ emailAddress: string }> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json().catch(() => ({}))) as {
    emailAddress?: string;
    error?: { message?: string };
  };
  if (!res.ok || !data.emailAddress) {
    throw new Error(data.error?.message || "Google Gmail token is invalid or expired. Please reconnect Google.");
  }
  return { emailAddress: data.emailAddress.trim().toLowerCase() };
}

function buildFileAttachments(attachments?: { kind: string; path?: string; name?: string }[]) {
  return (attachments ?? [])
    .filter((a) => a.kind === "file" && a.path)
    .map((a) => {
      const fullPath = path.join(UPLOADS_DIR, path.basename(a.path!));
      return fs.existsSync(fullPath) ? { filename: a.name || "attachment", path: fullPath } : null;
    })
    .filter(Boolean) as { filename: string; path: string }[];
}

export async function sendViaGmailApi(input: {
  email: string;
  displayName: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: { kind: string; path?: string; name?: string }[];
}): Promise<{ messageId: string }> {
  const token = getEphemeralGmailToken(input.email);
  if (!token) {
    throw new Error(
      `Google authorization expired or missing for ${input.email}. Click "Reconnect Google" in Email Accounts.`,
    );
  }

  const streamTransport = nodemailer.createTransport({
    streamTransport: true,
    newline: "unix",
    buffer: true,
  });

  const info = await streamTransport.sendMail({
    from: input.displayName ? `"${input.displayName}" <${input.email}>` : input.email,
    to: input.to,
    subject: input.subject,
    text: toPlainText(input.body),
    html: toHtml(input.body),
    inReplyTo: input.inReplyTo ?? undefined,
    references: input.references?.length ? input.references : undefined,
    attachments: buildFileAttachments(input.attachments),
  });

  const rawBuffer = info.message as Buffer;
  const raw = rawBuffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (res.status === 401) {
    clearEphemeralGmailToken(input.email);
    throw new Error(
      `Google authorization expired for ${input.email}. Click "Reconnect Google" in Email Accounts.`,
    );
  }

  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(data.error?.message || `Gmail API send failed (${res.status}).`);
  }

  return {
    messageId: info.messageId || `<${data.id || crypto.randomUUID()}@${input.email.split("@")[1] || "gmail.com"}>`,
  };
}

export async function createPooledSmtpSender(accountId: string) {
  const cred = await getAccountCredential(accountId);
  if (!cred) {
    throw new Error("Encrypted SMTP credentials not found for this mailbox. Reconnect it in Email Accounts.");
  }

  const transporter = nodemailer.createTransport(
    buildSmtpTransportOptions({
      host: cred.smtp_host,
      port: cred.smtp_port,
      email: cred.email,
      password: cred.password,
      timeoutMs: 12_000,
      pool: true,
    }),
  );

  return {
    send: async (input: {
      displayName: string;
      to: string;
      subject: string;
      body: string;
      inReplyTo?: string | null;
      references?: string[];
      attachments?: { kind: string; path?: string; name?: string }[];
    }): Promise<{ messageId: string }> => {
      const info = await transporter.sendMail({
        from: input.displayName ? `"${input.displayName}" <${cred.email}>` : cred.email,
        to: input.to,
        subject: input.subject,
        text: toPlainText(input.body),
        html: toHtml(input.body),
        inReplyTo: input.inReplyTo ?? undefined,
        references: input.references?.length ? input.references : undefined,
        attachments: buildFileAttachments(input.attachments),
      });
      return {
        messageId: info.messageId || `<${crypto.randomUUID()}@${cred.email.split("@")[1] || "mail"}>`,
      };
    },
    close: () => transporter.close(),
  };
}

export async function sendViaSmtp(input: {
  accountId: string;
  displayName: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: { kind: string; path?: string; name?: string }[];
}): Promise<{ messageId: string }> {
  const cred = await getAccountCredential(input.accountId);
  if (!cred) {
    throw new Error("Encrypted SMTP credentials not found for this mailbox. Reconnect it in Email Accounts.");
  }

  const transporter = nodemailer.createTransport(
    buildSmtpTransportOptions({
      host: cred.smtp_host,
      port: cred.smtp_port,
      email: cred.email,
      password: cred.password,
      timeoutMs: 12_000,
    }),
  );

  try {
    const info = await transporter.sendMail({
      from: input.displayName ? `"${input.displayName}" <${cred.email}>` : cred.email,
      to: input.to,
      subject: input.subject,
      text: toPlainText(input.body),
      html: toHtml(input.body), // Zero tracking pixels, zero click wrappers
      inReplyTo: input.inReplyTo ?? undefined,
      references: input.references?.length ? input.references : undefined,
      attachments: buildFileAttachments(input.attachments),
    });

    return {
      messageId: info.messageId || `<${crypto.randomUUID()}@${cred.email.split("@")[1] || "mail"}>`,
    };
  } finally {
    transporter.close();
  }
}

export function classifyInboundReply(subject: string, body: string, fromEmail: string): ReplyCategory {
  const text = `${subject}\n${body}`.toLowerCase();
  const from = fromEmail.toLowerCase();

  if (
    from.includes("mailer-daemon") ||
    from.includes("postmaster") ||
    /delivery status notification|undeliverable|550 5\.1\.1|address not found|bounce/.test(text)
  ) {
    return "bounce";
  }
  if (/out of office|automatic reply|auto-reply|vacation|away from my desk|returning on/.test(text)) {
    return "out_of_office";
  }
  if (/\bunsubscribe\b|remove me|stop emailing|take me off|opt out/.test(text)) {
    return "unsubscribe";
  }
  if (/not now|next quarter|circle back|follow up later|check back in|busy right now|few weeks|next month/.test(text)) {
    return "follow_up_later";
  }
  if (/not interested|no thanks|pass for now|already have|don't need|no budget/.test(text)) {
    return "not_interested";
  }
  if (/\?/.test(body) && /pricing|cost|how|when|examples|deck|details/.test(text)) {
    return "question";
  }
  return "interested";
}

export interface SyncedInboundMessage {
  from_email: string;
  from_name: string;
  to_email: string;
  subject: string;
  body: string;
  message_id_header: string;
  in_reply_to: string | null;
  references: string[];
  category: ReplyCategory;
  received_at: string;
}

export async function syncRepliesFromImap(accountId: string): Promise<SyncedInboundMessage[]> {
  const cred = await getAccountCredential(accountId);
  if (!cred || !cred.imap_host) {
    throw new Error("IMAP credentials not found for this mailbox.");
  }

  const client = new ImapFlow({
    host: cred.imap_host,
    port: cred.imap_port || 993,
    secure: (cred.imap_port || 993) === 993,
    auth: { user: cred.email, pass: cred.password },
    logger: false,
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 12_000,
  });
  client.on("error", () => {});

  const out: SyncedInboundMessage[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - 14 * 86_400_000);
      const uids = await client.search({ since }, { uid: true });
      const recentUids = (Array.isArray(uids) ? uids : []).slice(-50);
      if (recentUids.length > 0) {
        for await (const msg of client.fetch(recentUids, { source: true, uid: true }, { uid: true })) {
          if (!msg.source) continue;
          const parsed = await PostalMime.parse(msg.source);
          const fromEmail = parsed.from?.address?.toLowerCase() ?? "";
          if (!fromEmail || fromEmail === cred.email.toLowerCase()) continue;
          const fromName = (parsed.from?.name || "").trim();
          const toEmail = parsed.to?.[0]?.address?.toLowerCase() ?? cred.email;
          const subject = parsed.subject ?? "";
          const body = (parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "").trim();
          const refs = Array.isArray(parsed.references)
            ? parsed.references.map((r) => String(r).trim()).filter(Boolean)
            : typeof parsed.references === "string"
              ? parsed.references.split(/\s+/).filter(Boolean)
              : [];
          out.push({
            from_email: fromEmail,
            from_name: fromName,
            to_email: toEmail,
            subject,
            body: body.slice(0, 15000),
            message_id_header: parsed.messageId || `<imap-${msg.uid}@${cred.imap_host}>`,
            in_reply_to: parsed.inReplyTo || null,
            references: refs,
            category: classifyInboundReply(subject, body, fromEmail),
            received_at: parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}

export async function syncRepliesFromGmailApi(email: string): Promise<SyncedInboundMessage[]> {
  const token = getEphemeralGmailToken(email);
  if (!token) {
    throw new Error(
      `Google authorization expired or missing for ${email}. Click "Reconnect Google" in Email Accounts.`,
    );
  }

  const listUrl =
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=" +
    encodeURIComponent("in:inbox newer_than:14d") +
    "&maxResults=40";
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (listRes.status === 401) {
    clearEphemeralGmailToken(email);
    throw new Error(`Google authorization expired for ${email}.`);
  }

  const listData = (await listRes.json().catch(() => ({}))) as {
    messages?: { id: string }[];
  };
  const ids = (listData.messages ?? []).map((m) => m.id).filter(Boolean);
  const out: SyncedInboundMessage[] = [];
  const selfEmail = email.trim().toLowerCase();

  for (let i = 0; i < ids.length; i += 8) {
    const chunk = ids.slice(i, i + 8);
    const results = await Promise.all(
      chunk.map(async (id): Promise<SyncedInboundMessage | null> => {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=raw`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!msgRes.ok) return null;
        const msgJson = (await msgRes.json().catch(() => ({}))) as { raw?: string };
        if (!msgJson.raw) return null;

        const base64 = msgJson.raw.replace(/-/g, "+").replace(/_/g, "/");
        const rawBuf = Buffer.from(base64, "base64");
        const parsed = await PostalMime.parse(rawBuf);
        const fromEmail = parsed.from?.address?.toLowerCase() ?? "";
        if (!fromEmail || fromEmail === selfEmail) return null;
        const fromName = (parsed.from?.name || "").trim();

        const toEmail = parsed.to?.[0]?.address?.toLowerCase() ?? email;
        const subject = parsed.subject ?? "";
        const body = (parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "").trim();
        const refs = Array.isArray(parsed.references)
          ? parsed.references.map((r) => String(r).trim()).filter(Boolean)
          : typeof parsed.references === "string"
            ? parsed.references.split(/\s+/).filter(Boolean)
            : [];
        return {
          from_email: fromEmail,
          from_name: fromName,
          to_email: toEmail,
          subject,
          body: body.slice(0, 15000),
          message_id_header: parsed.messageId || `<gmail-${id}@gmail.com>`,
          in_reply_to: parsed.inReplyTo || null,
          references: refs,
          category: classifyInboundReply(subject, body, fromEmail),
          received_at: parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
        };
      }),
    );
    for (const r of results) {
      if (r) out.push(r);
    }
  }

  return out;
}

