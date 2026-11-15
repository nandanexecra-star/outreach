/**
 * store.ts — Firestore-backed storage with in-memory cache.
 *
 * Architecture:
 *   - `initDb()` is called once at server startup. It loads the full database
 *     from Firestore into an in-memory cache (`cachedDb`).
 *   - `readDb()` is synchronous — returns the cached copy instantly.
 *   - `writeDb(db)` updates the cache synchronously and fires an async Firestore
 *     write in the background (non-blocking, with error logging).
 *   - Encrypted mail credentials are stored per-account in a `mail_vault` collection.
 *
 * Firestore layout (collection: "decile_app"):
 *   meta          → { workspace_auth, settings, account_daily_dates, campaign_daily_dates }
 *   accounts      → { items: SendingAccount[] }
 *   campaigns     → { items: Campaign[] }
 *   leads         → { items: Lead[] }
 *   campaign_leads→ { items: CampaignLead[] }
 *   messages      → { items: EmailMessage[] }
 *   conversations → { items: ConversationState[] }
 *   templates     → { items: Template[] }
 *   suppressions  → { items: Suppression[] }
 *
 * Collection: "mail_vault"
 *   {accountId}   → EncryptedCredential
 */

import crypto from "node:crypto";
import path from "node:path";
import { getFirestoreDb } from "./firebase-admin";
import { DEFAULT_BEHAVIOR } from "../src/lib/followups";
import type {
  AppSettings,
  Campaign,
  CampaignLead,
  ConversationState,
  EmailMessage,
  Lead,
  SendingAccount,
  Suppression,
  Template,
} from "../src/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EncryptedCredential {
  account_id: string;
  email: string;
  smtp_host: string;
  smtp_port: number;
  imap_host: string;
  imap_port: number;
  iv: string;
  tag: string;
  ciphertext: string;
  updated_at: string;
}

export interface WorkspaceAuthRecord {
  email: string;
  password_hash: string;
  salt: string;
  updated_at: string;
}

export interface DecileDatabase {
  workspace_auth: WorkspaceAuthRecord | null;
  settings: AppSettings;
  accounts: SendingAccount[];
  campaigns: Campaign[];
  leads: Lead[];
  campaign_leads: CampaignLead[];
  messages: EmailMessage[];
  conversations: ConversationState[];
  templates: Template[];
  suppressions: Suppression[];
  account_daily_dates: Record<string, string>;
  campaign_daily_dates: Record<string, string>;
}

// Uploads still land on the local ephemeral filesystem (acceptable for temp files)
export const UPLOADS_DIR = path.resolve(process.cwd(), ".data", "uploads");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function todayDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function defaultDb(): DecileDatabase {
  return {
    workspace_auth: null,
    settings: {
      send_start_hour: 9,
      send_end_hour: 18,
      send_weekdays_only: true,
      time_zone: "UTC",
      auto_close_days: 14,
      ai_context: "",
      default_signature: "",
      default_follow_up_delays: [3, 5, 7],
      default_behavior: { ...DEFAULT_BEHAVIOR },
      tracking_pixels_disabled: true,
      click_tracking_disabled: true,
    },
    accounts: [],
    campaigns: [],
    leads: [],
    campaign_leads: [],
    messages: [],
    conversations: [],
    templates: [],
    suppressions: [],
    account_daily_dates: {},
    campaign_daily_dates: {},
  };
}

// ---------------------------------------------------------------------------
// Firestore collection / document names
// ---------------------------------------------------------------------------

const COL = "decile_app";
const VAULT_COL = "mail_vault";

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let cachedDb: DecileDatabase | null = null;
// Pending write promise — we coalesce rapid successive writes
let pendingWrite: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Firestore load / save helpers
// ---------------------------------------------------------------------------

type FirestoreData = Record<string, unknown>;

function safeArray<T>(val: unknown): T[] {
  return Array.isArray(val) ? (val as T[]) : [];
}

async function loadFromFirestore(): Promise<DecileDatabase> {
  const fs = getFirestoreDb();
  const col = fs.collection(COL);

  const [metaSnap, accountsSnap, campaignsSnap, leadsSnap, clSnap, msgsSnap, convsSnap, tplsSnap, suppSnap] =
    await Promise.all([
      col.doc("meta").get(),
      col.doc("accounts").get(),
      col.doc("campaigns").get(),
      col.doc("leads").get(),
      col.doc("campaign_leads").get(),
      col.doc("messages").get(),
      col.doc("conversations").get(),
      col.doc("templates").get(),
      col.doc("suppressions").get(),
    ]);

  const meta = (metaSnap.data() ?? {}) as FirestoreData;
  const base = defaultDb();

  const db: DecileDatabase = {
    workspace_auth: (meta.workspace_auth as WorkspaceAuthRecord | null) ?? null,
    settings: {
      ...base.settings,
      ...((meta.settings as Partial<AppSettings>) ?? {}),
      tracking_pixels_disabled: true,
      click_tracking_disabled: true,
    },
    account_daily_dates: (meta.account_daily_dates as Record<string, string>) ?? {},
    campaign_daily_dates: (meta.campaign_daily_dates as Record<string, string>) ?? {},
    accounts: safeArray<SendingAccount>((accountsSnap.data() as FirestoreData | undefined)?.items),
    campaigns: safeArray<Campaign>((campaignsSnap.data() as FirestoreData | undefined)?.items),
    leads: safeArray<Lead>((leadsSnap.data() as FirestoreData | undefined)?.items),
    campaign_leads: safeArray<CampaignLead>((clSnap.data() as FirestoreData | undefined)?.items),
    messages: safeArray<EmailMessage>((msgsSnap.data() as FirestoreData | undefined)?.items),
    conversations: safeArray<ConversationState>((convsSnap.data() as FirestoreData | undefined)?.items),
    templates: safeArray<Template>((tplsSnap.data() as FirestoreData | undefined)?.items),
    suppressions: safeArray<Suppression>((suppSnap.data() as FirestoreData | undefined)?.items),
  };

  // Reset per-day counters that are stale
  const today = todayDateKey();
  for (const acc of db.accounts) {
    if (db.account_daily_dates[acc.id] !== today) acc.sent_today = 0;
  }
  for (const camp of db.campaigns) {
    if (db.campaign_daily_dates[camp.id] !== today) camp.sent_today = 0;
  }

  return db;
}

async function saveToFirestore(db: DecileDatabase): Promise<void> {
  const fs = getFirestoreDb();
  const col = fs.collection(COL);

  // Firestore doesn't accept `undefined` values — strip them via JSON round-trip
  function clean<T>(val: T): T {
    return JSON.parse(JSON.stringify(val)) as T;
  }

  await Promise.all([
    col.doc("meta").set(
      clean({
        workspace_auth: db.workspace_auth,
        settings: db.settings,
        account_daily_dates: db.account_daily_dates,
        campaign_daily_dates: db.campaign_daily_dates,
      }),
    ),
    col.doc("accounts").set(clean({ items: db.accounts })),
    col.doc("campaigns").set(clean({ items: db.campaigns })),
    col.doc("leads").set(clean({ items: db.leads })),
    col.doc("campaign_leads").set(clean({ items: db.campaign_leads })),
    col.doc("messages").set(clean({ items: db.messages })),
    col.doc("conversations").set(clean({ items: db.conversations })),
    col.doc("templates").set(clean({ items: db.templates })),
    col.doc("suppressions").set(clean({ items: db.suppressions })),
  ]);
}

// ---------------------------------------------------------------------------
// Public DB API (synchronous surface — compatible with existing call sites)
// ---------------------------------------------------------------------------

/**
 * Must be awaited once before the HTTP server starts accepting requests.
 * Loads the database from Firestore into the in-memory cache.
 */
export async function initDb(): Promise<void> {
  try {
    cachedDb = await loadFromFirestore();
    console.log("[store] Loaded database from Firestore.");
  } catch (err) {
    console.warn("[store] Could not load from Firestore, starting with empty DB:", (err as Error).message);
    cachedDb = defaultDb();
  }
}

/** Synchronous read — returns the in-memory cache. */
export function readDb(): DecileDatabase {
  if (!cachedDb) cachedDb = defaultDb();
  return cachedDb;
}

/**
 * Updates the in-memory cache synchronously (so callers see changes instantly)
 * and kicks off a background Firestore write.  Writes are coalesced — if a
 * write is already in-flight a new one is queued after it finishes.
 */
export function writeDb(db: DecileDatabase): void {
  cachedDb = db;

  if (pendingWrite) {
    // Chain onto the in-flight write so we don't flood Firestore
    pendingWrite = pendingWrite.then(() => saveToFirestore(db)).catch(logWriteError);
  } else {
    pendingWrite = saveToFirestore(db)
      .catch(logWriteError)
      .finally(() => { pendingWrite = null; });
  }
}

function logWriteError(err: unknown) {
  console.error("[store] Firestore write failed:", (err as Error).message);
}

// ---------------------------------------------------------------------------
// AES-256-GCM Encrypted Mail Credential Vault (now in Firestore)
// ---------------------------------------------------------------------------

function getEncryptionKey(): Buffer {
  const hex = process.env.MAIL_CREDENTIALS_KEY?.trim();
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) {
    return Buffer.from(hex, "hex");
  }
  return crypto
    .createHash("sha256")
    .update(process.env.APP_URL || "decile-outreach-aes-key")
    .digest();
}

export function encryptSecret(plain: string): { iv: string; tag: string; ciphertext: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: enc.toString("hex"),
  };
}

export function decryptSecret(cred: EncryptedCredential): string {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(cred.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(cred.tag, "hex"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(cred.ciphertext, "hex")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

export async function saveAccountCredential(
  accountId: string,
  data: {
    email: string;
    password: string;
    smtp_host: string;
    smtp_port: number;
    imap_host: string;
    imap_port: number;
  },
): Promise<void> {
  const enc = encryptSecret(data.password);
  const record: EncryptedCredential = {
    account_id: accountId,
    email: data.email.trim().toLowerCase(),
    smtp_host: data.smtp_host,
    smtp_port: data.smtp_port,
    imap_host: data.imap_host,
    imap_port: data.imap_port,
    ...enc,
    updated_at: new Date().toISOString(),
  };
  await getFirestoreDb().collection(VAULT_COL).doc(accountId).set(record);
}

export async function getAccountCredential(
  accountId: string,
): Promise<(EncryptedCredential & { password: string }) | null> {
  const snap = await getFirestoreDb().collection(VAULT_COL).doc(accountId).get();
  if (!snap.exists) return null;
  const entry = snap.data() as EncryptedCredential;
  return { ...entry, password: decryptSecret(entry) };
}

export async function deleteAccountCredential(accountId: string): Promise<void> {
  await getFirestoreDb().collection(VAULT_COL).doc(accountId).delete();
}

// ---------------------------------------------------------------------------
// Workspace Auth Helpers
// ---------------------------------------------------------------------------

export function hashWorkspacePassword(password: string, salt?: string): { hash: string; salt: string } {
  const usedSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, usedSalt, 64).toString("hex");
  return { hash, salt: usedSalt };
}

export function verifyWorkspacePassword(password: string, record: WorkspaceAuthRecord): boolean {
  const { hash } = hashWorkspacePassword(password, record.salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(record.password_hash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getSessionSecret(): Buffer {
  return crypto
    .createHash("sha256")
    .update(process.env.MAIL_CREDENTIALS_KEY || process.env.APP_URL || "decile-workspace-session-key")
    .digest();
}

export function createSessionToken(email: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      email: email.trim().toLowerCase(),
      exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
    }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySessionToken(token: string | undefined | null): { email: string } | null {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string;
      exp?: number;
    };
    if (!parsed.email || !parsed.exp || parsed.exp < Date.now()) return null;
    return { email: parsed.email };
  } catch {
    return null;
  }
}
