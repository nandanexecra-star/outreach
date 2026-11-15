import { appendLinks } from "../src/lib/attachments";
import { composeEmail, pickSignature } from "../src/lib/compose";
import { isValidEmail, normalizeEmail, renderTemplate } from "../src/lib/email-utils";
import {
  inSendingWindow,
  parseBehavior,
  parseFollowUps,
  parseSchedule,
  replyAction,
  zonedDateTimeToUtcMs,
} from "../src/lib/followups";
import { assignAccounts, MANUAL_BATCH_SIZE, remainingAllowance, SENDS_PER_RUN } from "../src/lib/sending-rules";
import type {
  Attachment,
  Campaign,
  DashboardDailyMetric,
  DashboardStats,
  EmailMessage,
  InboxThreadItem,
  Lead,
  SendingAccount,
} from "../src/lib/types";
import { classifyInboundReplyWithAi, getAiStatus } from "./ai";
import {
  createPooledSmtpSender,
  sendViaGmailApi,
  sendViaSmtp,
  syncRepliesFromGmailApi,
  syncRepliesFromImap,
  type SyncedInboundMessage,
} from "./mail";
import { type DecileDatabase, newId, readDb, todayDateKey, writeDb } from "./store";

export function syncScheduledCampaignStatuses(db: DecileDatabase, now = new Date()): boolean {
  let changed = false;
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  for (const camp of db.campaigns) {
    if (!camp.schedule?.enabled) continue;
    const tz = camp.schedule.time_zone || db.settings.time_zone || "UTC";
    const startMs = camp.schedule.start_at ? zonedDateTimeToUtcMs(camp.schedule.start_at, tz) : null;
    const endMs = camp.schedule.end_at ? zonedDateTimeToUtcMs(camp.schedule.end_at, tz) : null;

    if (endMs !== null && nowMs >= endMs && (camp.status === "running" || camp.status === "scheduled")) {
      camp.status = "paused";
      camp.updated_at = nowIso;
      changed = true;
      continue;
    }

    if (camp.status === "scheduled" && startMs !== null && nowMs >= startMs) {
      camp.status = "running";
      camp.updated_at = nowIso;
      changed = true;
    }
  }

  return changed;
}

export function buildDashboardPayload() {
  const db = readDb();
  const now = new Date();
  if (syncScheduledCampaignStatuses(db, now)) {
    writeDb(db);
  }
  const dailyMap = new Map<string, DashboardDailyMetric>();

  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    dailyMap.set(key, {
      date: key,
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      sent: 0,
      replies: 0,
      bounces: 0,
    });
  }

  const todayKey = todayDateKey();
  let totalSent = 0;
  let sentToday = 0;
  let totalReplies = 0;
  let positiveReplies = 0;
  let bounces = 0;

  for (const m of db.messages) {
    const dateKey = m.created_at.slice(0, 10);
    const bucket = dailyMap.get(dateKey);
    if (m.direction === "outbound") {
      if (bucket) {
        bucket.sent += 1;
        totalSent += 1;
      }
      if (dateKey === todayKey) sentToday += 1;
    } else {
      if (m.category === "bounce") {
        bounces += 1;
        if (bucket) bucket.bounces += 1;
      } else if (m.category !== "out_of_office") {
        totalReplies += 1;
        if (bucket) bucket.replies += 1;
        if (m.category === "interested" || m.category === "question") {
          positiveReplies += 1;
        }
      }
    }
  }

  const totalOutboundAllTime = db.messages.filter((m) => m.direction === "outbound").length;
  const denom = Math.max(1, totalOutboundAllTime);

  const stats: DashboardStats = {
    total_sent: totalSent,
    sent_today: sentToday,
    total_replies: totalReplies,
    positive_replies: positiveReplies,
    reply_rate: totalOutboundAllTime ? Number(((totalReplies / denom) * 100).toFixed(1)) : 0,
    positive_rate: totalOutboundAllTime ? Number(((positiveReplies / denom) * 100).toFixed(1)) : 0,
    bounce_rate: totalOutboundAllTime ? Number(((bounces / denom) * 100).toFixed(1)) : 0,
    active_campaigns: db.campaigns.filter((c) => c.status === "running").length,
    open_threads: db.conversations.filter((c) => c.status === "open").length,
    verified_leads: db.leads.filter((l) => l.email_check === "valid").length,
    daily_series: Array.from(dailyMap.values()),
  };

  const campaigns = db.campaigns.map((c) => {
    const cls = db.campaign_leads.filter((cl) => cl.campaign_id === c.id);
    return {
      ...c,
      enrolled_count: cls.length,
      replied_count: cls.filter((cl) => cl.status === "replied").length,
    };
  });

  const leadMap = new Map(db.leads.map((l) => [l.id, l]));
  const campMap = new Map(db.campaigns.map((c) => [c.id, c]));
  const msgsByThread = new Map<string, EmailMessage[]>();
  for (const m of db.messages) {
    const arr = msgsByThread.get(m.thread_id) ?? [];
    arr.push(m);
    msgsByThread.set(m.thread_id, arr);
  }

  const recentThreads = db.conversations
    .slice()
    .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at))
    .slice(0, 6)
    .map((conv) => {
      const lead = leadMap.get(conv.lead_id);
      const tMsgs = msgsByThread.get(conv.thread_id) ?? [];
      const lastMessage = tMsgs[tMsgs.length - 1];
      if (!lead || !lastMessage) return null;
      return {
        conv,
        lead,
        lastMessage,
        campaign: conv.campaign_id ? campMap.get(conv.campaign_id) ?? null : null,
      };
    })
    .filter(Boolean) as {
    conv: InboxThreadItem["state"];
    lead: Lead;
    lastMessage: EmailMessage;
    campaign: Campaign | null;
  }[];

  return { stats, campaigns, recentThreads, accounts: db.accounts };
}

export function buildInboxPayload(statusFilter: "open" | "closed" | "all") {
  const db = readDb();
  const leadMap = new Map(db.leads.map((l) => [l.id, l]));
  const campMap = new Map(db.campaigns.map((c) => [c.id, c]));
  const accMap = new Map(db.accounts.map((a) => [a.id, a]));
  const msgsByThread = new Map<string, EmailMessage[]>();

  for (const m of db.messages) {
    const arr = msgsByThread.get(m.thread_id) ?? [];
    arr.push(m);
    msgsByThread.set(m.thread_id, arr);
  }

  const allItems: InboxThreadItem[] = [];
  for (const conv of db.conversations) {
    const lead = leadMap.get(conv.lead_id);
    const tMsgs = (msgsByThread.get(conv.thread_id) ?? []).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    const lastMessage = tMsgs[tMsgs.length - 1];
    if (!lead || !lastMessage) continue;
    const acc = accMap.get(conv.account_id);
    const camp = conv.campaign_id ? campMap.get(conv.campaign_id) : undefined;
    allItems.push({
      state: conv,
      lead,
      campaign: camp ? { id: camp.id, name: camp.name } : null,
      account: acc
        ? {
            id: acc.id,
            email: acc.email,
            display_name: acc.display_name,
            signature: acc.signature,
          }
        : {
            id: conv.account_id,
            email: lastMessage.direction === "outbound" ? lastMessage.from_email : lastMessage.to_email,
            display_name: "",
            signature: "",
          },
      messages: tMsgs,
      last_message: lastMessage,
    });
  }

  allItems.sort((a, b) => b.state.last_message_at.localeCompare(a.state.last_message_at));
  const openCount = allItems.filter((i) => i.state.status === "open").length;
  const closedCount = allItems.filter((i) => i.state.status === "closed").length;
  const filtered =
    statusFilter === "all" ? allItems : allItems.filter((i) => i.state.status === statusFilter);

  return { threads: filtered, counts: { open: openCount, closed: closedCount } };
}

export async function sendTestEmailServer(
  campaignId: string,
  payload: { toEmail: string; accountId?: string; sampleLeadId?: string },
) {
  const db = readDb();
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  if (!campaign) throw new Error("Campaign not found.");

  const acc =
    (payload.accountId && db.accounts.find((a) => a.id === payload.accountId)) ||
    db.accounts.find((a) => campaign.account_ids.includes(a.id) && a.status === "active") ||
    db.accounts.find((a) => a.status === "active");

  if (!acc) {
    throw new Error("No active mailbox found. Connect an email account first.");
  }

  const sampleLead =
    (payload.sampleLeadId && db.leads.find((l) => l.id === payload.sampleLeadId)) ||
    db.leads[0] || {
      first_name: "Alex",
      last_name: "Rivera",
      company: "Example Co",
      designation: "Founder",
      industry: "SaaS",
      email: payload.toEmail,
      ai_line: "",
      custom_fields: {},
    };

  const composed = composeEmail({
    subject: campaign.subject || "Test email",
    body: campaign.body,
    signature: pickSignature(acc.signature, db.settings.default_signature),
    lead: sampleLead,
    optOut: true,
    attachments: campaign.attachments,
  });

  if (acc.provider === "gmail_api") {
    await sendViaGmailApi({
      email: acc.email,
      displayName: acc.display_name,
      to: payload.toEmail.trim(),
      subject: `[TEST] ${composed.subject}`,
      body: composed.body,
      attachments: campaign.attachments,
    });
  } else {
    await sendViaSmtp({
      accountId: acc.id,
      displayName: acc.display_name,
      to: payload.toEmail.trim(),
      subject: `[TEST] ${composed.subject}`,
      body: composed.body,
      attachments: campaign.attachments,
    });
  }

  return {
    ok: true,
    mode: acc.provider === "gmail_api" ? "gmail_api" : "smtp",
    preview: composed,
  };
}

export async function replyToThreadServer(
  threadId: string,
  payload: { body: string; attachments?: Attachment[] },
) {
  const db = readDb();
  const conv = db.conversations.find((c) => c.thread_id === threadId);
  if (!conv) throw new Error("Conversation thread not found.");
  const lead = db.leads.find((l) => l.id === conv.lead_id);
  if (!lead) throw new Error("Contact record missing.");
  const account = db.accounts.find((a) => a.id === conv.account_id) ?? db.accounts.find((a) => a.status === "active");
  if (!account) throw new Error("Sending mailbox missing or disconnected.");

  const threadMsgs = db.messages
    .filter((m) => m.thread_id === threadId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const lastMsg = threadMsgs[threadMsgs.length - 1];
  const baseSubj = (lastMsg?.subject || "Re: Following up").replace(/^re:\s*/i, "");
  const subject = `Re: ${baseSubj}`;
  const rawSignature = pickSignature(account.signature, db.settings.default_signature);
  const signature = rawSignature.trim() ? renderTemplate(rawSignature, lead).trim() : "";
  const bodyWithLinks = appendLinks(renderTemplate(payload.body, lead).trim(), payload.attachments ?? []);
  const fullBody = signature ? `${bodyWithLinks}\n\n${signature}` : bodyWithLinks;

  const sendInput = {
    displayName: account.display_name,
    to: lead.email,
    subject,
    body: fullBody,
    inReplyTo: lastMsg?.message_id_header ?? null,
    references: threadMsgs.map((m) => m.message_id_header).filter(Boolean),
    attachments: payload.attachments ?? [],
  };
  const sent =
    account.provider === "gmail_api"
      ? await sendViaGmailApi({ email: account.email, ...sendInput })
      : await sendViaSmtp({ accountId: account.id, ...sendInput });

  const nowIso = new Date().toISOString();
  const msg: EmailMessage = {
    id: newId("msg"),
    thread_id: threadId,
    campaign_id: conv.campaign_id,
    lead_id: lead.id,
    account_id: account.id,
    direction: "outbound",
    step: 0,
    is_manual: true,
    from_email: account.email,
    to_email: lead.email,
    subject,
    body: fullBody,
    attachments: payload.attachments ?? [],
    message_id_header: sent.messageId,
    in_reply_to: lastMsg?.message_id_header ?? null,
    category: null,
    created_at: nowIso,
  };
  db.messages.push(msg);
  conv.last_message_at = nowIso;
  conv.unread = false;
  writeDb(db);

  return {
    ok: true,
    message: msg,
    mode: account.provider === "gmail_api" ? "gmail_api" : "smtp",
  };
}

export async function sendDirectEmailServer(payload: {
  toEmail: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  accountId: string;
  subject: string;
  body: string;
  attachments?: Attachment[];
  includeSignature?: boolean;
}) {
  const db = readDb();
  const toNorm = normalizeEmail(payload.toEmail ?? "");
  if (!toNorm || !isValidEmail(toNorm)) {
    throw new Error("Enter a valid recipient email address.");
  }
  if (!payload.subject?.trim()) {
    throw new Error("Email subject is required.");
  }
  if (!payload.body?.trim()) {
    throw new Error("Email body cannot be empty.");
  }

  const suppressed = db.suppressions.some((s) => normalizeEmail(s.email) === toNorm);
  if (suppressed) {
    throw new Error(`${toNorm} is on your Global Suppression List (unsubscribed or bounced).`);
  }

  const account =
    db.accounts.find((a) => a.id === payload.accountId) ||
    db.accounts.find((a) => a.status === "active" && a.has_credentials);
  if (!account) {
    throw new Error("No active mailbox found. Connect an email account first.");
  }
  if (account.status !== "active" || !account.has_credentials) {
    throw new Error(`Mailbox ${account.email} is paused or missing credentials.`);
  }

  const nowIso = new Date().toISOString();
  let lead = db.leads.find((l) => normalizeEmail(l.email) === toNorm);
  if (!lead) {
    lead = {
      id: newId("lead"),
      email: toNorm,
      first_name: (payload.firstName ?? "").trim(),
      last_name: (payload.lastName ?? "").trim(),
      company: (payload.company ?? "").trim(),
      designation: "",
      industry: "",
      tags: ["1-to-1"],
      status: "contacted",
      email_check: "unchecked",
      email_check_reason: null,
      email_checked_at: null,
      ai_line: null,
      ai_line_at: null,
      custom_fields: {},
      created_at: nowIso,
    };
    db.leads.push(lead);
  } else {
    if (!lead.first_name && payload.firstName?.trim()) lead.first_name = payload.firstName.trim();
    if (!lead.last_name && payload.lastName?.trim()) lead.last_name = payload.lastName.trim();
    if (!lead.company && payload.company?.trim()) lead.company = payload.company.trim();
    if (lead.status === "new") lead.status = "contacted";
  }

  const includeSignature = payload.includeSignature !== false;
  const rawSignature = includeSignature
    ? pickSignature(account.signature, db.settings.default_signature)
    : "";
  const composed = composeEmail({
    subject: payload.subject.trim(),
    body: payload.body.trim(),
    signature: rawSignature,
    lead,
    optOut: false,
    attachments: payload.attachments ?? [],
  });

  const sendInput = {
    displayName: account.display_name,
    to: lead.email,
    subject: composed.subject,
    body: composed.body,
    attachments: payload.attachments ?? [],
  };
  const sent =
    account.provider === "gmail_api"
      ? await sendViaGmailApi({ email: account.email, ...sendInput })
      : await sendViaSmtp({ accountId: account.id, ...sendInput });

  const threadId = newId("thr");
  const sentIso = new Date().toISOString();
  const msg: EmailMessage = {
    id: newId("msg"),
    thread_id: threadId,
    campaign_id: null,
    lead_id: lead.id,
    account_id: account.id,
    direction: "outbound",
    step: 0,
    is_manual: true,
    from_email: account.email,
    to_email: lead.email,
    subject: composed.subject,
    body: composed.body,
    attachments: payload.attachments ?? [],
    message_id_header: sent.messageId,
    in_reply_to: null,
    category: null,
    created_at: sentIso,
  };
  db.messages.push(msg);
  db.conversations.push({
    thread_id: threadId,
    lead_id: lead.id,
    campaign_id: null,
    account_id: account.id,
    status: "open",
    last_message_at: sentIso,
    closed_at: null,
    auto_closed: false,
    unread: false,
  });

  account.sent_today += 1;
  db.account_daily_dates[account.id] = todayDateKey();
  writeDb(db);

  return {
    ok: true,
    threadId,
    message: msg,
    mode: account.provider === "gmail_api" ? "gmail_api" : "smtp",
  };
}

export async function runSendBatchServer(manual: boolean): Promise<{
  sent: number;
  skipped: number;
  failed: number;
  notes: string[];
}> {
  const db = readDb();
  const now = new Date();
  const scheduleChanged = syncScheduledCampaignStatuses(db, now);
  const globalWindowOpen = manual || inSendingWindow(now, db.settings.time_zone, db.settings);

  const runningCampaigns = db.campaigns.filter(
    (c) => c.status === "running" && (globalWindowOpen || Boolean(c.schedule?.enabled)),
  );
  if (runningCampaigns.length === 0) {
    if (scheduleChanged) writeDb(db);
    return {
      sent: 0,
      skipped: 0,
      failed: 0,
      notes: [
        !globalWindowOpen
          ? `Outside sending hours (${db.settings.send_start_hour}:00–${db.settings.send_end_hour}:00 ${db.settings.time_zone}).`
          : "No running campaigns to process.",
      ],
    };
  }

  const suppressedEmails = new Set(db.suppressions.map((s) => normalizeEmail(s.email)));
  const leadMap = new Map(db.leads.map((l) => [l.id, l]));
  const accMap = new Map(db.accounts.map((a) => [a.id, a]));
  const today = todayDateKey();
  const notes: string[] = [];

  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const maxBatch = manual ? MANUAL_BATCH_SIZE : SENDS_PER_RUN;

  type PreparedSendTask = {
    camp: Campaign;
    cl: (typeof db.campaign_leads)[number];
    lead: Lead;
    acc: SendingAccount;
    stepIndex: number;
    steps: ReturnType<typeof parseFollowUps>;
    stepAttachments: Attachment[];
    threadId: string;
    lastPriorId: string | null;
    priorMessageIds: string[];
    composed: { subject: string; body: string };
  };

  const tasks: PreparedSendTask[] = [];
  const plannedAccountSends = new Map<string, number>();

  for (const camp of runningCampaigns) {
    if (tasks.length >= maxBatch) break;
    const steps = parseFollowUps(camp.follow_ups);
    const eligibleAccounts = camp.account_ids
      .map((id) => accMap.get(id))
      .filter((a): a is SendingAccount => Boolean(a && a.status === "active" && a.has_credentials));

    if (eligibleAccounts.length === 0) {
      notes.push(`Campaign "${camp.name}" has no active connected mailboxes.`);
      continue;
    }

    const dueItems = db.campaign_leads.filter((cl) => {
      if (cl.campaign_id !== camp.id || cl.sequence_stopped_at) return false;
      if (cl.status === "pending" && cl.current_step === 0) return true;
      if (cl.status === "active") {
        if (!cl.next_send_at) return true;
        return new Date(cl.next_send_at).getTime() <= now.getTime();
      }
      return false;
    });

    if (dueItems.length === 0) continue;

    const remainingSlots = Math.max(0, maxBatch - tasks.length);
    if (remainingSlots <= 0) break;

    const totalAccountRemaining = eligibleAccounts.reduce((sum, a) => {
      const cap = a.warmup_enabled ? Math.min(a.daily_limit, a.warmup_daily_cap) : a.daily_limit;
      const used = a.sent_today + (plannedAccountSends.get(a.id) ?? 0);
      return sum + Math.max(0, cap - used);
    }, 0);

    const totalAccountSent = eligibleAccounts.reduce(
      (s, a) => s + a.sent_today + (plannedAccountSends.get(a.id) ?? 0),
      0,
    );

    const allowance = remainingAllowance({
      accountDailyLimit: totalAccountRemaining + totalAccountSent,
      accountSentToday: totalAccountSent,
      campaignDailyLimit: camp.daily_limit,
      campaignSentToday: camp.sent_today,
      slotsThisRun: remainingSlots,
    });

    if (allowance <= 0) {
      skippedCount += dueItems.length;
      notes.push(`Daily cap reached for "${camp.name}".`);
      continue;
    }

    const validDueItems: typeof dueItems = [];
    for (const cl of dueItems) {
      const lead = leadMap.get(cl.lead_id);
      if (!lead) {
        skippedCount += 1;
        continue;
      }
      if (suppressedEmails.has(normalizeEmail(lead.email)) || lead.email_check === "invalid") {
        const isSup = suppressedEmails.has(normalizeEmail(lead.email));
        cl.status = isSup ? "unsubscribed" : "bounced";
        cl.sequence_stopped_at = now.toISOString();
        cl.stop_reason = isSup ? "suppressed" : "invalid_email";
        skippedCount += 1;
        continue;
      }
      validDueItems.push(cl);
    }

    const assignedIds = assignAccounts(
      eligibleAccounts.map((a) => {
        const cap = a.warmup_enabled ? Math.min(a.daily_limit, a.warmup_daily_cap) : a.daily_limit;
        const used = a.sent_today + (plannedAccountSends.get(a.id) ?? 0);
        return { id: a.id, remaining: Math.max(0, cap - used) };
      }),
      Math.min(allowance, validDueItems.length),
    );

    let assignIdx = 0;
    for (const cl of validDueItems) {
      if (tasks.length >= maxBatch || assignIdx >= assignedIds.length) break;
      const lead = leadMap.get(cl.lead_id)!;

      const preferredAcc = cl.account_id ? accMap.get(cl.account_id) : null;
      let acc: SendingAccount | null = null;
      if (preferredAcc && preferredAcc.status === "active" && preferredAcc.has_credentials) {
        const cap = preferredAcc.warmup_enabled
          ? Math.min(preferredAcc.daily_limit, preferredAcc.warmup_daily_cap)
          : preferredAcc.daily_limit;
        const used = preferredAcc.sent_today + (plannedAccountSends.get(preferredAcc.id) ?? 0);
        if (cap - used > 0) acc = preferredAcc;
      }
      if (!acc) {
        const chosenId = assignedIds[assignIdx++];
        acc = chosenId ? accMap.get(chosenId) ?? null : null;
      } else {
        assignIdx++;
      }
      if (!acc) {
        skippedCount += 1;
        continue;
      }

      const stepIndex = cl.current_step;
      let stepBody = camp.body;
      let stepAttachments = camp.attachments;
      if (stepIndex === 99) {
        stepBody = camp.behavior.later_body;
        stepAttachments = [];
      } else if (stepIndex > 0) {
        const fu = steps[stepIndex - 1];
        if (!fu) {
          cl.status = "completed";
          cl.next_send_at = null;
          skippedCount += 1;
          continue;
        }
        stepBody = fu.body;
        stepAttachments = fu.attachments ?? [];
      }

      const priorMsgs = db.messages
        .filter((m) => m.campaign_id === camp.id && m.lead_id === lead.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const threadId = priorMsgs[0]?.thread_id ?? newId("thr");
      const lastPrior = priorMsgs[priorMsgs.length - 1];

      const composed = composeEmail({
        subject: stepIndex === 0 ? camp.subject : `Re: ${camp.subject.replace(/^re:\s*/i, "")}`,
        body: stepBody,
        signature: pickSignature(acc.signature, db.settings.default_signature),
        lead,
        optOut: stepIndex === 0,
        attachments: stepAttachments,
      });

      plannedAccountSends.set(acc.id, (plannedAccountSends.get(acc.id) ?? 0) + 1);
      tasks.push({
        camp,
        cl,
        lead,
        acc,
        stepIndex,
        steps,
        stepAttachments,
        threadId,
        lastPriorId: lastPrior?.message_id_header ?? null,
        priorMessageIds: priorMsgs.map((m) => m.message_id_header).filter(Boolean),
        composed,
      });
    }
  }

  // Reuse authenticated pooled SMTP connections and dispatch up to 5 sends concurrently
  const smtpPools = new Map<string, ReturnType<typeof createPooledSmtpSender>>();
  const getSmtpPool = (accountId: string) => {
    let pool = smtpPools.get(accountId);
    if (!pool) {
      pool = createPooledSmtpSender(accountId);
      smtpPools.set(accountId, pool);
    }
    return pool;
  };

  let cursor = 0;
  const workerCount = Math.min(5, tasks.length);

  async function runWorker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      if (!task) break;
      const {
        camp,
        cl,
        lead,
        acc,
        stepIndex,
        steps,
        stepAttachments,
        threadId,
        lastPriorId,
        priorMessageIds,
        composed,
      } = task;

      try {
        const batchInput = {
          displayName: acc.display_name,
          to: lead.email,
          subject: composed.subject,
          body: composed.body,
          inReplyTo: lastPriorId,
          references: priorMessageIds,
          attachments: stepAttachments,
        };
        const res =
          acc.provider === "gmail_api"
            ? await sendViaGmailApi({ email: acc.email, ...batchInput })
            : await (await getSmtpPool(acc.id)).send(batchInput);

        const sentIso = new Date().toISOString();
        db.messages.push({
          id: newId("msg"),
          thread_id: threadId,
          campaign_id: camp.id,
          lead_id: lead.id,
          account_id: acc.id,
          direction: "outbound",
          step: stepIndex,
          is_manual: false,
          from_email: acc.email,
          to_email: lead.email,
          subject: composed.subject,
          body: composed.body,
          attachments: stepAttachments,
          message_id_header: res.messageId,
          in_reply_to: lastPriorId,
          category: null,
          created_at: sentIso,
        });

        const existingConv = db.conversations.find((c) => c.thread_id === threadId);
        if (existingConv) {
          existingConv.status = "open";
          existingConv.last_message_at = sentIso;
          existingConv.closed_at = null;
          existingConv.auto_closed = false;
          existingConv.unread = false;
        } else {
          db.conversations.push({
            thread_id: threadId,
            lead_id: lead.id,
            campaign_id: camp.id,
            account_id: acc.id,
            status: "open",
            last_message_at: sentIso,
            closed_at: null,
            auto_closed: false,
            unread: false,
          });
        }

        const nextStepObj = stepIndex === 99 ? null : steps[stepIndex];
        cl.account_id = acc.id;
        cl.last_sent_at = sentIso;
        cl.error = null;
        if (!nextStepObj) {
          cl.status = "completed";
          cl.next_send_at = null;
        } else {
          cl.current_step = stepIndex + 1;
          cl.status = "active";
          cl.next_send_at = new Date(Date.now() + nextStepObj.delay_days * 86_400_000).toISOString();
        }

        acc.sent_today += 1;
        db.account_daily_dates[acc.id] = today;
        camp.sent_today += 1;
        db.campaign_daily_dates[camp.id] = today;
        if (lead.status === "new") lead.status = "contacted";

        sentCount += 1;
      } catch (err) {
        failedCount += 1;
        cl.error = (err as Error).message;
        notes.push(`${lead.email}: ${(err as Error).message}`);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  } finally {
    for (const poolPromise of smtpPools.values()) {
      try {
        (await poolPromise).close();
      } catch {
        // ignore close errors
      }
    }
  }

  writeDb(db);
  return { sent: sentCount, skipped: skippedCount, failed: failedCount, notes };
}

export async function runCheckInboxServer(): Promise<{
  syncedAccounts: number;
  newReplies: number;
  autoClosedThreads: number;
  nurtureScheduled: number;
}> {
  const db = readDb();
  const leadByEmail = new Map(db.leads.map((l) => [normalizeEmail(l.email), l]));
  const existingMsgIds = new Set(db.messages.map((m) => m.message_id_header).filter(Boolean));
  const msgByHeaderId = new Map(db.messages.map((m) => [m.message_id_header, m]));
  const campMap = new Map(db.campaigns.map((c) => [c.id, c]));
  const suppressedSet = new Set(db.suppressions.map((s) => normalizeEmail(s.email)));

  const activeAccounts = db.accounts.filter((a) => a.status === "active" && a.has_credentials);
  const syncResults = await Promise.allSettled(
    activeAccounts.map(async (acc) => {
      const inboundList =
        acc.provider === "gmail_api"
          ? await syncRepliesFromGmailApi(acc.email)
          : await syncRepliesFromImap(acc.id);
      return { acc, inboundList };
    }),
  );

  let syncedAccounts = 0;
  let newReplies = 0;
  let nurtureScheduled = 0;

  for (const res of syncResults) {
    if (res.status !== "fulfilled") continue;
    const { acc, inboundList } = res.value as {
      acc: SendingAccount;
      inboundList: SyncedInboundMessage[];
    };
    syncedAccounts += 1;
    acc.last_synced_at = new Date().toISOString();

    for (const inbound of inboundList) {
      if (existingMsgIds.has(inbound.message_id_header)) continue;
      const senderEmail = normalizeEmail(inbound.from_email);
      if (!senderEmail || !isValidEmail(senderEmail)) continue;

      let replyParent = inbound.in_reply_to ? msgByHeaderId.get(inbound.in_reply_to) : undefined;
      if (!replyParent && inbound.references?.length) {
        for (let i = inbound.references.length - 1; i >= 0; i--) {
          const hit = msgByHeaderId.get(inbound.references[i]!);
          if (hit) {
            replyParent = hit;
            break;
          }
        }
      }

      let lead =
        (replyParent && db.leads.find((l) => l.id === replyParent.lead_id)) ||
        leadByEmail.get(senderEmail);

      // Receive ALL new incoming messages in Unified Inbox even if sender was not previously a lead
      if (!lead) {
        const nameParts = (inbound.from_name || "").trim().split(/\s+/).filter(Boolean);
        const firstName = nameParts[0] || senderEmail.split("@")[0] || "";
        const lastName = nameParts.slice(1).join(" ");
        lead = {
          id: newId("lead"),
          email: senderEmail,
          first_name: firstName,
          last_name: lastName,
          company: "",
          designation: "",
          industry: "",
          tags: ["inbound"],
          status: "replied",
          email_check: "valid",
          email_check_reason: "Inbound message received",
          email_checked_at: inbound.received_at,
          ai_line: null,
          ai_line_at: null,
          custom_fields: {},
          created_at: inbound.received_at,
        };
        db.leads.push(lead);
        leadByEmail.set(senderEmail, lead);
      }

      const matchingConv =
        db.conversations.find((c) => c.lead_id === lead!.id && c.account_id === acc.id) ||
        db.conversations.find((c) => c.lead_id === lead!.id);
      const threadId = replyParent?.thread_id || matchingConv?.thread_id || newId("thr");
      const campaignId = replyParent?.campaign_id || matchingConv?.campaign_id || null;

      let category = inbound.category;
      const hasActiveCampLead = db.campaign_leads.some(
        (cl) => cl.lead_id === lead!.id && !cl.sequence_stopped_at,
      );
      if (
        hasActiveCampLead &&
        (category === "interested" || category === "question") &&
        getAiStatus().configured
      ) {
        const aiCat = await classifyInboundReplyWithAi(inbound.subject, inbound.body, senderEmail);
        if (aiCat) category = aiCat;
      }

      const msg: EmailMessage = {
        id: newId("msg"),
        thread_id: threadId,
        campaign_id: campaignId,
        lead_id: lead.id,
        account_id: acc.id,
        direction: "inbound",
        step: 0,
        is_manual: false,
        from_email: senderEmail,
        to_email: acc.email,
        subject: inbound.subject,
        body: inbound.body,
        attachments: [],
        message_id_header: inbound.message_id_header,
        in_reply_to: inbound.in_reply_to,
        category,
        created_at: inbound.received_at,
      };
      db.messages.push(msg);
      existingMsgIds.add(inbound.message_id_header);
      msgByHeaderId.set(inbound.message_id_header, msg);
      newReplies += 1;

      const existingConv = db.conversations.find((c) => c.thread_id === threadId);
      if (existingConv) {
        existingConv.status = "open";
        existingConv.last_message_at = msg.created_at;
        existingConv.closed_at = null;
        existingConv.auto_closed = false;
        existingConv.unread = true;
        existingConv.account_id = acc.id;
      } else {
        db.conversations.push({
          thread_id: threadId,
          lead_id: lead.id,
          campaign_id: campaignId,
          account_id: acc.id,
          status: "open",
          last_message_at: msg.created_at,
          closed_at: null,
          auto_closed: false,
          unread: true,
        });
      }

      const activeCls = db.campaign_leads.filter(
        (cl) => cl.lead_id === lead!.id && !cl.sequence_stopped_at,
      );
      for (const cl of activeCls) {
        const camp = campMap.get(cl.campaign_id);
        if (!camp) continue;
        const action = replyAction(category, camp.behavior);
        if (category === "unsubscribe" || category === "bounce") {
          if (!suppressedSet.has(normalizeEmail(lead.email))) {
            db.suppressions.push({
              id: newId("sup"),
              email: normalizeEmail(lead.email),
              reason: category === "bounce" ? "bounced" : "unsubscribed",
              source: `Inbox sync (${acc.email})`,
              created_at: new Date().toISOString(),
            });
            suppressedSet.add(normalizeEmail(lead.email));
          }
          cl.status = category === "bounce" ? "bounced" : "unsubscribed";
          cl.sequence_stopped_at = new Date().toISOString();
          cl.stop_reason = category;
          cl.next_send_at = null;
          lead.status = category === "bounce" ? "bounced" : "unsubscribed";
        } else if (action === "nurture") {
          cl.current_step = 99;
          cl.status = "active";
          cl.next_send_at = new Date(
            Date.now() + camp.behavior.later_delay_days * 86_400_000,
          ).toISOString();
          nurtureScheduled += 1;
        } else if (action === "stop") {
          cl.status = "replied";
          cl.sequence_stopped_at = new Date().toISOString();
          cl.stop_reason = category || "replied";
          cl.next_send_at = null;
          lead.status =
            category === "interested"
              ? "interested"
              : category === "not_interested"
                ? "not_interested"
                : "replied";
        }
      }
    }
  }

  let autoClosedThreads = 0;
  const cutoff = Date.now() - db.settings.auto_close_days * 86_400_000;
  for (const conv of db.conversations) {
    if (conv.status === "open" && conv.last_message_at && new Date(conv.last_message_at).getTime() < cutoff) {
      conv.status = "closed";
      conv.closed_at = new Date().toISOString();
      conv.auto_closed = true;
      conv.unread = false;
      autoClosedThreads += 1;
    }
  }

  writeDb(db);
  return { syncedAccounts, newReplies, autoClosedThreads, nurtureScheduled };
}

export function applyThreadBehaviorServer(
  threadId: string,
  payload: {
    action: "send_reply" | "schedule_later_nurture" | "continue_sequence" | "stop_and_close" | "suppress";
    delayDays?: number;
    followUpBody?: string;
  },
): { ok: boolean; message: string; nextSendAt?: string | null } {
  const db = readDb();
  const conv = db.conversations.find((c) => c.thread_id === threadId);
  if (!conv) throw new Error("Conversation thread not found.");
  const lead = db.leads.find((l) => l.id === conv.lead_id);
  if (!lead) throw new Error("Contact record missing.");

  const now = new Date();
  const nowIso = now.toISOString();
  const relatedCls = db.campaign_leads.filter(
    (cl) => cl.lead_id === lead.id && (!conv.campaign_id || cl.campaign_id === conv.campaign_id),
  );

  if (payload.action === "schedule_later_nurture") {
    const days = Math.max(1, Math.min(365, Math.round(payload.delayDays || 21)));
    const nextSendAt = new Date(now.getTime() + days * 86_400_000).toISOString();
    if (relatedCls.length > 0) {
      for (const cl of relatedCls) {
        cl.current_step = 99;
        cl.status = "active";
        cl.sequence_stopped_at = null;
        cl.stop_reason = null;
        cl.next_send_at = nextSendAt;
        const camp = db.campaigns.find((c) => c.id === cl.campaign_id);
        if (camp && payload.followUpBody?.trim()) {
          camp.behavior.later_check_in = true;
          camp.behavior.later_delay_days = days;
          camp.behavior.later_body = payload.followUpBody.trim();
        }
      }
    }
    conv.unread = false;
    conv.status = "open";
    writeDb(db);
    return {
      ok: true,
      nextSendAt,
      message:
        relatedCls.length > 0
          ? `Scheduled Step 99 follow-up nurture in ${days} day(s).`
          : `Thread marked for follow-up in ${days} day(s) (draft copied to composer).`,
    };
  }

  if (payload.action === "continue_sequence") {
    for (const cl of relatedCls) {
      cl.status = "active";
      cl.sequence_stopped_at = null;
      cl.stop_reason = null;
      if (!cl.next_send_at) cl.next_send_at = nowIso;
    }
    conv.unread = false;
    writeDb(db);
    return { ok: true, message: "Sequence resumed for this contact." };
  }

  if (payload.action === "stop_and_close") {
    for (const cl of relatedCls) {
      cl.status = "replied";
      cl.sequence_stopped_at = nowIso;
      cl.stop_reason = "ai_behavior_stop";
      cl.next_send_at = null;
    }
    conv.status = "closed";
    conv.closed_at = nowIso;
    conv.unread = false;
    writeDb(db);
    return { ok: true, message: "Sequence stopped and thread closed." };
  }

  if (payload.action === "suppress") {
    const norm = normalizeEmail(lead.email);
    if (!db.suppressions.some((s) => normalizeEmail(s.email) === norm)) {
      db.suppressions.push({
        id: newId("sup"),
        email: norm,
        reason: "unsubscribed",
        source: "AI Behavior action",
        created_at: nowIso,
      });
    }
    for (const cl of db.campaign_leads.filter((c) => c.lead_id === lead.id)) {
      cl.status = "unsubscribed";
      cl.sequence_stopped_at = nowIso;
      cl.stop_reason = "unsubscribed";
      cl.next_send_at = null;
    }
    lead.status = "unsubscribed";
    conv.status = "closed";
    conv.closed_at = nowIso;
    conv.unread = false;
    writeDb(db);
    return { ok: true, message: `${lead.email} added to suppression list and closed.` };
  }

  conv.unread = false;
  writeDb(db);
  return { ok: true, message: "Ready to send reply." };
}

export function scheduleWeeklyCampaignsServer(payload: {
  accountId: string;
  baseName: string;
  startDate: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  timeZone?: string;
  dailyLimit?: number;
  days?: number;
  subject: string;
  body: string;
  followUps?: Campaign["follow_ups"];
  leadIds?: string[];
  leadTag?: string;
}): { campaigns: Campaign[]; enrolledTotal: number } {
  const db = readDb();
  const account = db.accounts.find((a) => a.id === payload.accountId);
  if (!account) throw new Error("Selected mailbox not found.");
  if (!payload.baseName?.trim()) throw new Error("Campaign series name is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.startDate || "")) {
    throw new Error("Start date must be YYYY-MM-DD.");
  }
  if (!/^\d{2}:\d{2}$/.test(payload.startTime || "")) {
    throw new Error("Start time must be HH:mm.");
  }

  const totalDays = Math.max(1, Math.min(14, Math.round(payload.days || 7)));
  const dailyLimit = Math.max(1, Math.min(500, Math.round(payload.dailyLimit || 50)));
  const timeZone = (payload.timeZone || db.settings.time_zone || "UTC").trim();
  const suppressed = new Set(db.suppressions.map((s) => normalizeEmail(s.email)));

  let poolLeadIds: string[] = [];
  if (Array.isArray(payload.leadIds) && payload.leadIds.length > 0) {
    poolLeadIds = payload.leadIds.filter((id) => {
      const lead = db.leads.find((l) => l.id === id);
      return Boolean(lead && lead.email_check !== "invalid" && !suppressed.has(normalizeEmail(lead.email)));
    });
  } else if (payload.leadTag?.trim()) {
    poolLeadIds = db.leads
      .filter(
        (l) =>
          l.tags.includes(payload.leadTag!.trim()) &&
          l.email_check !== "invalid" &&
          !suppressed.has(normalizeEmail(l.email)),
      )
      .map((l) => l.id);
  }

  const [yStr, mStr, dStr] = payload.startDate.split("-");
  const baseDateUtc = new Date(Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr)));
  const created: Campaign[] = [];
  let leadCursor = 0;
  let enrolledTotal = 0;
  const nowIso = new Date().toISOString();

  for (let i = 0; i < totalDays; i++) {
    const slotDate = new Date(baseDateUtc.getTime() + i * 86_400_000);
    const dateKey = slotDate.toISOString().slice(0, 10);
    const dayLabel = slotDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    const endDate = new Date(slotDate.getTime() + 86_400_000).toISOString().slice(0, 10);

    const cmp: Campaign = {
      id: newId("cmp"),
      name: `${payload.baseName.trim()} · Day ${i + 1} (${dayLabel})`,
      status: "scheduled",
      account_ids: [account.id],
      subject: payload.subject || "Quick question about {{company}}",
      body: payload.body || "Hi {{first_name|there}},\n\n",
      attachments: [],
      follow_ups: parseFollowUps(payload.followUps ?? []),
      daily_limit: dailyLimit,
      sent_today: 0,
      behavior: parseBehavior(db.settings.default_behavior),
      schedule: parseSchedule(
        {
          enabled: true,
          start_at: `${dateKey}T${payload.startTime}`,
          end_at: `${endDate}T${payload.startTime}`,
          time_zone: timeZone,
        },
        timeZone,
      ),
      created_at: nowIso,
      updated_at: nowIso,
    };
    db.campaigns.push(cmp);
    created.push(cmp);

    if (poolLeadIds.length > 0 && leadCursor < poolLeadIds.length) {
      const slice = poolLeadIds.slice(leadCursor, leadCursor + dailyLimit);
      leadCursor += slice.length;
      for (const lid of slice) {
        db.campaign_leads.push({
          id: newId("cl"),
          campaign_id: cmp.id,
          lead_id: lid,
          account_id: account.id,
          current_step: 0,
          status: "pending",
          last_sent_at: null,
          next_send_at: null,
          sequence_stopped_at: null,
          stop_reason: null,
          error: null,
        });
        enrolledTotal += 1;
      }
    }
  }

  syncScheduledCampaignStatuses(db, new Date());
  writeDb(db);
  return { campaigns: created, enrolledTotal };
}
