import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Mail,
  Plus,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import type { Campaign, Lead, SendingAccount } from "../lib/types";
import { LinkableTextarea } from "../components/app/LinkableTextarea";
import { PageHeader } from "../components/app/SharedUi";
import { useToast } from "../components/ui/ToastProvider";

type CampaignRow = Campaign & {
  enrolled_count: number;
  active_count: number;
  replied_count: number;
  completed_count: number;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const COMMON_TIMEZONES = [
  "UTC",
  "Asia/Kolkata",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Dubai",
  "Asia/Singapore",
  "Australia/Sydney",
];

function toLocalDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatReadableDate(dateKey: string): string {
  const parts = dateKey.split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return dateKey;
  const d = new Date(parts[0]!, parts[1]! - 1, parts[2]!);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const STATUS_DOT_TEXT: Record<string, string> = {
  running: "text-success",
  scheduled: "text-signal",
  paused: "text-warning",
  draft: "text-muted-foreground",
  completed: "text-muted-foreground",
};

export function CalendarPage() {
  const navigate = useNavigate();
  const { notify } = useToast();
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [accounts, setAccounts] = useState<SendingAccount[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);

  const now = new Date();
  const todayKey = toLocalDateKey(now);
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [mailboxFilter, setMailboxFilter] = useState<string>("all");

  // Single-campaign modal
  const [modalOpen, setModalOpen] = useState(false);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState(todayKey);
  const [startTime, setStartTime] = useState("09:00");
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [dailyLimit, setDailyLimit] = useState(50);
  const [leadTag, setLeadTag] = useState("");
  const [subject, setSubject] = useState("Quick question about {{company}}");
  const [body, setBody] = useState(
    "Hi {{first_name|there}},\n\n{{ai_line|Noticed what your team has been shipping this quarter.}}\n\nOpen to a quick chat next week?",
  );
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [c, a, l] = await Promise.all([
        api.listCampaigns(),
        api.listAccounts(),
        api.listLeads(),
      ]);
      setCampaigns(c);
      setAccounts(a);
      setLeads(l);
      if (!accountId && a[0]) {
        setAccountId(a.find((x) => x.status === "active")?.id ?? a[0].id);
      }
    } catch (err) {
      notify((err as Error).message, { kind: "error" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const allTags = useMemo(
    () => Array.from(new Set(leads.flatMap((l) => l.tags))).sort(),
    [leads],
  );
  const accMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const schedulableExisting = useMemo(
    () => campaigns.filter((c) => c.status !== "running"),
    [campaigns],
  );

  const visibleCampaigns = useMemo(
    () =>
      campaigns.filter((c) => {
        if (mailboxFilter !== "all" && !c.account_ids.includes(mailboxFilter)) return false;
        return true;
      }),
    [campaigns, mailboxFilter],
  );

  const campaignsByDay = useMemo(() => {
    const map = new Map<string, CampaignRow[]>();
    for (const c of visibleCampaigns) {
      const rawDate =
        c.schedule?.enabled && c.schedule.start_at
          ? c.schedule.start_at.slice(0, 10)
          : c.created_at.slice(0, 10);
      const list = map.get(rawDate) ?? [];
      list.push(c);
      map.set(rawDate, list);
    }
    return map;
  }, [visibleCampaigns]);

  const firstDayOfMonth = new Date(viewYear, viewMonth, 1);
  const startDow = firstDayOfMonth.getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;

  function prevMonth() {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  }

  function nextMonth() {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  function jumpToday() {
    const t = new Date();
    setViewYear(t.getFullYear());
    setViewMonth(t.getMonth());
  }

  function openDayModal(dateKey: string) {
    setStartDate(dateKey);
    setMode("new");
    setName("");
    if (schedulableExisting[0]) {
      setSelectedCampaignId(schedulableExisting[0].id);
    }
    setModalOpen(true);
  }

  async function handleSubmit(e: React.FormEvent, openEditorAfter = false) {
    e.preventDefault();
    if (!startDate || !startTime) {
      notify("Pick a date and time first.", { kind: "error" });
      return;
    }

    setSubmitting(true);
    try {
      const startAt = `${startDate}T${startTime}`;
      const tz = timeZone.trim() || "UTC";

      if (mode === "existing") {
        if (!selectedCampaignId) {
          notify("Select a campaign to schedule.", { kind: "error" });
          return;
        }
        await api.updateCampaign(selectedCampaignId, {
          status: "scheduled",
          schedule: {
            enabled: true,
            start_at: startAt,
            end_at: null,
            time_zone: tz,
          },
        });
        notify("Campaign scheduled on calendar", {
          description: `${formatReadableDate(startDate)} at ${startTime} (${tz})`,
          kind: "success",
        });
        setModalOpen(false);
        if (openEditorAfter) {
          navigate(`/campaigns/${selectedCampaignId}`);
          return;
        }
        await load();
        return;
      }

      if (!accountId) {
        notify("Connect an email account first in Email Accounts.", { kind: "error" });
        return;
      }
      if (!name.trim()) {
        notify("Enter a campaign name.", { kind: "error" });
        return;
      }

      const leadIds = leadTag
        ? leads
            .filter((l) => l.tags.includes(leadTag) && l.email_check !== "invalid")
            .slice(0, dailyLimit)
            .map((l) => l.id)
        : [];

      const created = await api.createCampaign({
        name: name.trim(),
        subject,
        body,
        account_ids: [accountId],
        daily_limit: dailyLimit,
        lead_ids: leadIds,
        status: "scheduled",
        schedule: {
          enabled: true,
          start_at: startAt,
          end_at: null,
          time_zone: tz,
        },
      });

      notify("Campaign scheduled", {
        description: `${formatReadableDate(startDate)} at ${startTime} (${tz})`,
        kind: "success",
      });
      setModalOpen(false);
      if (openEditorAfter) {
        navigate(`/campaigns/${created.id}`);
        return;
      }
      await load();
    } catch (err) {
      notify((err as Error).message, { kind: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const tzOptions = COMMON_TIMEZONES.includes(timeZone)
    ? COMMON_TIMEZONES
    : [timeZone, ...COMMON_TIMEZONES];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Calendar"
        title="Outreach Calendar"
        description="Click any day on the calendar to schedule a campaign one by one with its date, time, and mailbox."
        actions={
          <button
            type="button"
            onClick={() => openDayModal(todayKey)}
            className="inline-flex items-center gap-1.5 rounded-md bg-signal px-4 py-2 text-xs font-medium text-signal-foreground hover:opacity-90 whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Schedule campaign</span>
          </button>
        }
      />

      {/* Calendar Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={prevMonth}
            className="rounded border border-border bg-background p-1.5 hover:bg-muted"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="font-display text-base font-semibold min-w-[155px] text-center">
            {monthLabel}
          </span>
          <button
            type="button"
            onClick={nextMonth}
            className="rounded border border-border bg-background p-1.5 hover:bg-muted"
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          <select
            value={viewYear}
            onChange={(e) => setViewYear(Number(e.target.value))}
            className="ml-1 h-8 rounded border border-input bg-background px-2 text-xs"
            aria-label="Select year"
          >
            {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1, now.getFullYear() + 2].map(
              (yr) => (
                <option key={yr} value={yr}>
                  {yr}
                </option>
              ),
            )}
          </select>

          <button
            type="button"
            onClick={jumpToday}
            className="h-8 rounded border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted whitespace-nowrap"
          >
            Today
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Mail className="h-3.5 w-3.5 text-muted-foreground" />
          <select
            value={mailboxFilter}
            onChange={(e) => setMailboxFilter(e.target.value)}
            className="h-8 rounded border border-input bg-background px-2.5 text-xs"
          >
            <option value="all">All mailboxes ({accounts.length})</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Month Grid */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="grid grid-cols-7 border-b border-border bg-muted/40">
          {WEEKDAYS.map((wd) => (
            <div
              key={wd}
              className="px-3 py-2 text-center font-mono text-[11px] uppercase tracking-wider text-muted-foreground"
            >
              {wd}
            </div>
          ))}
        </div>

        {loading ? (
          <div className="p-10 text-center text-xs text-muted-foreground">
            Loading calendar...
          </div>
        ) : (
          <div className="grid grid-cols-7 divide-x divide-y divide-border">
            {Array.from({ length: totalCells }).map((_, idx) => {
              const dayNum = idx - startDow + 1;
              const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
              const dateKey = inMonth
                ? `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`
                : "";
              const isToday = inMonth && dateKey === todayKey;
              const dayItems = inMonth ? campaignsByDay.get(dateKey) ?? [] : [];

              return (
                <div
                  key={idx}
                  onClick={() => {
                    if (inMonth) openDayModal(dateKey);
                  }}
                  className={`min-h-[124px] p-2 flex flex-col gap-1.5 transition-colors ${
                    !inMonth
                      ? "bg-muted/20 text-muted-foreground/40"
                      : "bg-card hover:bg-muted/20 cursor-pointer"
                  }`}
                >
                  {inMonth && (
                    <div className="flex items-center justify-between">
                      <span
                        className={`tabular-nums text-xs font-medium px-1.5 py-0.5 rounded ${
                          isToday
                            ? "bg-signal text-signal-foreground font-semibold"
                            : "text-foreground"
                        }`}
                      >
                        {dayNum}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDayModal(dateKey);
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title={`Schedule on ${dateKey}`}
                        aria-label={`Schedule campaign on ${dateKey}`}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}

                  <div className="space-y-1 overflow-y-auto max-h-[100px]">
                    {dayItems.map((cmp) => {
                      const mbEmail = cmp.account_ids[0]
                        ? accMap.get(cmp.account_ids[0])?.email
                        : undefined;
                      const timeStr =
                        cmp.schedule?.enabled && cmp.schedule.start_at
                          ? cmp.schedule.start_at.slice(11, 16)
                          : "";
                      const statusCls = STATUS_DOT_TEXT[cmp.status] ?? "text-muted-foreground";
                      return (
                        <Link
                          key={cmp.id}
                          to={`/campaigns/${cmp.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="block rounded border border-border bg-background/90 px-2 py-1.5 text-[11px] hover:border-signal transition-colors"
                        >
                          <div className="font-medium text-foreground truncate">{cmp.name}</div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground tabular-nums">
                            <span className={`capitalize font-medium ${statusCls}`}>{cmp.status}</span>
                            <span aria-hidden="true">·</span>
                            <span>{timeStr || "Draft"}</span>
                            <span aria-hidden="true">·</span>
                            <span>{cmp.daily_limit}/day</span>
                          </div>
                          {mbEmail && (
                            <div className="truncate text-[10px] text-muted-foreground/80">
                              {mbEmail}
                            </div>
                          )}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Single Campaign Schedule Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 overflow-y-auto">
          <div className="w-full max-w-xl rounded-lg border border-border bg-card shadow-xl my-6">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  Schedule Campaign
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {formatReadableDate(startDate)} — set up one campaign for this day.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={(e) => handleSubmit(e, false)} className="p-6 space-y-4">
              {/* Simple switch: new vs existing */}
              {schedulableExisting.length > 0 && (
                <div className="flex items-center gap-1 rounded-md bg-muted p-1 w-fit">
                  <button
                    type="button"
                    onClick={() => setMode("new")}
                    className={`rounded px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                      mode === "new"
                        ? "bg-card text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    New campaign
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("existing")}
                    className={`rounded px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                      mode === "existing"
                        ? "bg-card text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Schedule existing ({schedulableExisting.length})
                  </button>
                </div>
              )}

              {/* Date, Time, Timezone */}
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Date</label>
                  <input
                    type="date"
                    required
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Start time</label>
                  <input
                    type="time"
                    required
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Timezone</label>
                  <select
                    value={timeZone}
                    onChange={(e) => setTimeZone(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs"
                  >
                    {tzOptions.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {mode === "existing" ? (
                <div>
                  <label className="block text-xs font-medium mb-1">Pick a campaign</label>
                  <select
                    value={selectedCampaignId}
                    onChange={(e) => setSelectedCampaignId(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
                  >
                    {schedulableExisting.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.status} · {c.enrolled_count} leads · {c.daily_limit}/day)
                      </option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    This sets its start date &amp; time on your calendar. It will launch automatically when that time arrives.
                  </p>
                </div>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium mb-1">Campaign name</label>
                      <input
                        type="text"
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g. Founders Outreach — Nov 14"
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">Sending mailbox</label>
                      <select
                        required
                        value={accountId}
                        onChange={(e) => setAccountId(e.target.value)}
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
                      >
                        {accounts.length === 0 && <option value="">No mailboxes connected</option>}
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.email} ({a.status})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-medium">Mails per day</label>
                        <div className="flex items-center gap-1">
                          {[50, 75, 100].map((preset) => (
                            <button
                              key={preset}
                              type="button"
                              onClick={() => setDailyLimit(preset)}
                              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                                dailyLimit === preset
                                  ? "border-signal bg-signal-soft text-signal"
                                  : "border-border text-muted-foreground"
                              }`}
                            >
                              {preset}
                            </button>
                          ))}
                        </div>
                      </div>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={dailyLimit}
                        onChange={(e) => setDailyLimit(Number(e.target.value) || 50)}
                        className="tabular-nums h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Enroll leads by tag (optional)
                      </label>
                      <select
                        value={leadTag}
                        onChange={(e) => setLeadTag(e.target.value)}
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
                      >
                        <option value="">None (enroll in editor)</option>
                        {allTags.map((t) => (
                          <option key={t} value={t}>
                            Tag: {t}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium mb-1">Subject line</label>
                    <input
                      type="text"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium mb-1">Email body</label>
                    <LinkableTextarea
                      rows={4}
                      value={body}
                      onValueChange={setBody}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    />
                  </div>
                </>
              )}

              <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-signal shrink-0" />
                  <span>
                    Starts <strong className="text-foreground">{startDate}</strong> at{" "}
                    <strong className="text-foreground">{startTime}</strong> ({timeZone})
                  </span>
                </span>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-md border border-border px-4 py-2 text-xs font-medium hover:bg-muted"
                >
                  Cancel
                </button>
                {mode === "new" && (
                  <button
                    type="button"
                    disabled={submitting || !accountId}
                    onClick={(e) => handleSubmit(e, true)}
                    className="rounded-md border border-border bg-background px-4 py-2 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    Save &amp; add follow-ups
                  </button>
                )}
                <button
                  type="submit"
                  disabled={submitting || (mode === "new" && !accountId)}
                  className="rounded-md bg-signal px-4 py-2 text-xs font-medium text-signal-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {submitting ? "Scheduling..." : "Schedule on calendar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
