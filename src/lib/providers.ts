export type ProviderPreset = {
  key: string;
  label: string;
  shortLabel: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  spfInclude: string | null;
  dkimSelectors: string[];
  suggestedDailyLimit: number;
  help: string;
  passwordSteps: string[];
  passwordLink: { label: string; url: string } | null;
  extraLink?: { label: string; url: string };
  needsAppPassword: boolean;
};

export const PROVIDERS: ProviderPreset[] = [
  {
    key: "gmail",
    label: "Gmail / Google Workspace",
    shortLabel: "Gmail / Google Workspace",
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    imapHost: "imap.gmail.com",
    imapPort: 993,
    spfInclude: "include:_spf.google.com",
    dkimSelectors: ["google"],
    suggestedDailyLimit: 50,
    help: "Google blocks normal passwords on external SMTP/IMAP logins and requires a 16-character App Password.",
    passwordSteps: [
      "Enable 2-Step Verification on your Google account, create a 16-character App Password, and paste it into Password.",
    ],
    passwordLink: {
      label: "Create Google app password",
      url: "https://myaccount.google.com/apppasswords",
    },
    extraLink: {
      label: "Turn on 2-step verification",
      url: "https://myaccount.google.com/signinoptions/twosv",
    },
    needsAppPassword: true,
  },
  {
    key: "zoho_in",
    label: "Zoho Mail",
    shortLabel: "Zoho Mail",
    smtpHost: "smtppro.zoho.in",
    smtpPort: 465,
    imapHost: "imappro.zoho.in",
    imapPort: 993,
    spfInclude: "include:zoho.in",
    dkimSelectors: ["zmail", "zoho", "default"],
    suggestedDailyLimit: 50,
    help: "Uses your Zoho mailbox password (or an app password if 2FA is active).",
    passwordSteps: [
      "Enable IMAP in Zoho Mail Settings and enter your Zoho password (or an app password if 2FA is active).",
    ],
    passwordLink: {
      label: "Create Zoho app password",
      url: "https://accounts.zoho.in/home#security/app_password",
    },
    extraLink: {
      label: "Turn on IMAP in Zoho",
      url: "https://mail.zoho.in/zm/#settings/mail/imap",
    },
    needsAppPassword: false,
  },
  {
    key: "zoho_com",
    label: "Zoho Mail",
    shortLabel: "Zoho Mail",
    smtpHost: "smtppro.zoho.com",
    smtpPort: 465,
    imapHost: "imappro.zoho.com",
    imapPort: 993,
    spfInclude: "include:zoho.com",
    dkimSelectors: ["zmail", "zoho", "default"],
    suggestedDailyLimit: 50,
    help: "Uses your Zoho mailbox password (or an app password if 2FA is active).",
    passwordSteps: [
      "Enable IMAP in Zoho Mail Settings and enter your Zoho password (or an app password if 2FA is active).",
    ],
    passwordLink: {
      label: "Create Zoho app password",
      url: "https://accounts.zoho.com/home#security/app_password",
    },
    extraLink: {
      label: "Turn on IMAP in Zoho",
      url: "https://mail.zoho.com/zm/#settings/mail/imap",
    },
    needsAppPassword: false,
  },
  {
    key: "zoho_eu",
    label: "Zoho Mail (EU)",
    shortLabel: "Zoho Mail",
    smtpHost: "smtppro.zoho.eu",
    smtpPort: 465,
    imapHost: "imappro.zoho.eu",
    imapPort: 993,
    spfInclude: "include:zoho.eu",
    dkimSelectors: ["zmail", "zoho", "default"],
    suggestedDailyLimit: 50,
    help: "Uses your Zoho EU mailbox password (or an app password if 2FA is active).",
    passwordSteps: [
      "Enable IMAP in Zoho Mail Settings and enter your Zoho password (or an app password if 2FA is active).",
    ],
    passwordLink: {
      label: "Create Zoho app password",
      url: "https://accounts.zoho.eu/home#security/app_password",
    },
    extraLink: {
      label: "Turn on IMAP in Zoho",
      url: "https://mail.zoho.eu/zm/#settings/mail/imap",
    },
    needsAppPassword: false,
  },
  {
    key: "outlook",
    label: "Outlook / Microsoft 365",
    shortLabel: "Outlook / Microsoft 365",
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    imapHost: "outlook.office365.com",
    imapPort: 993,
    spfInclude: "include:spf.protection.outlook.com",
    dkimSelectors: ["selector1", "selector2"],
    suggestedDailyLimit: 50,
    help: "Ensure Authenticated SMTP and IMAP are enabled in Microsoft 365.",
    passwordSteps: [
      "Allow Authenticated SMTP & IMAP for this mailbox in Microsoft 365 (use an app password if MFA is enforced).",
    ],
    passwordLink: {
      label: "Microsoft security settings",
      url: "https://account.microsoft.com/security",
    },
    needsAppPassword: false,
  },
  {
    key: "godaddy",
    label: "GoDaddy Email",
    shortLabel: "GoDaddy Email",
    smtpHost: "smtpout.secureserver.net",
    smtpPort: 465,
    imapHost: "imap.secureserver.net",
    imapPort: 993,
    spfInclude: "include:secureserver.net",
    dkimSelectors: ["default", "secureserver", "s1"],
    suggestedDailyLimit: 50,
    help: "Uses your full email address and mailbox password.",
    passwordSteps: ["Enter your full email address and mailbox password."],
    passwordLink: null,
    needsAppPassword: false,
  },
  {
    key: "hostinger",
    label: "Hostinger Email",
    shortLabel: "Hostinger Email",
    smtpHost: "smtp.hostinger.com",
    smtpPort: 465,
    imapHost: "imap.hostinger.com",
    imapPort: 993,
    spfInclude: "include:_spf.mail.hostinger.com",
    dkimSelectors: ["hostingermail-a", "default"],
    suggestedDailyLimit: 50,
    help: "Uses your Hostinger mailbox email and password.",
    passwordSteps: ["Enter your Hostinger mailbox password."],
    passwordLink: null,
    needsAppPassword: false,
  },
  {
    key: "titan",
    label: "Titan Email",
    shortLabel: "Titan Email",
    smtpHost: "smtp.titan.email",
    smtpPort: 465,
    imapHost: "imap.titan.email",
    imapPort: 993,
    spfInclude: "include:spf.titan.email",
    dkimSelectors: ["titan1", "default"],
    suggestedDailyLimit: 50,
    help: "Uses your Titan mailbox email and password.",
    passwordSteps: ["Enter your Titan mailbox password (or third-party app password if 2FA is active)."],
    passwordLink: null,
    needsAppPassword: false,
  },
  {
    key: "privateemail",
    label: "Namecheap Private Email",
    shortLabel: "Private Email",
    smtpHost: "mail.privateemail.com",
    smtpPort: 465,
    imapHost: "mail.privateemail.com",
    imapPort: 993,
    spfInclude: "include:spf.privateemail.com",
    dkimSelectors: ["default"],
    suggestedDailyLimit: 50,
    help: "Uses your Private Email address and password.",
    passwordSteps: ["Enter your Namecheap Private Email password."],
    passwordLink: null,
    needsAppPassword: false,
  },
  {
    key: "fastmail",
    label: "Fastmail",
    shortLabel: "Fastmail",
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    spfInclude: "include:spf.messagingengine.com",
    dkimSelectors: ["fm1", "fm2", "fm3"],
    suggestedDailyLimit: 50,
    help: "Use an app password from Fastmail Settings → Privacy & Security → Integrations.",
    passwordSteps: ["Create an SMTP/IMAP app password in Fastmail Security settings."],
    passwordLink: {
      label: "Fastmail security settings",
      url: "https://app.fastmail.com/settings/security/devicekeys",
    },
    needsAppPassword: true,
  },
  {
    key: "icloud",
    label: "iCloud Mail",
    shortLabel: "iCloud Mail",
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    spfInclude: "include:icloud.com",
    dkimSelectors: ["sig1"],
    suggestedDailyLimit: 50,
    help: "Requires an Apple app-specific password.",
    passwordSteps: ["Generate an app-specific password in your Apple Account settings."],
    passwordLink: {
      label: "Apple Account security",
      url: "https://account.apple.com/account/manage",
    },
    needsAppPassword: true,
  },
  {
    key: "yahoo",
    label: "Yahoo Mail",
    shortLabel: "Yahoo Mail",
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    spfInclude: "include:_spf.mail.yahoo.com",
    dkimSelectors: ["s1024", "s2048"],
    suggestedDailyLimit: 50,
    help: "Requires a Yahoo app password.",
    passwordSteps: ["Generate an app password in Yahoo Account Security."],
    passwordLink: {
      label: "Yahoo account security",
      url: "https://login.yahoo.com/account/security",
    },
    needsAppPassword: true,
  },
  {
    key: "custom",
    label: "Custom SMTP / IMAP Host",
    shortLabel: "Custom mail server",
    smtpHost: "",
    smtpPort: 465,
    imapHost: "",
    imapPort: 993,
    spfInclude: null,
    dkimSelectors: ["default", "mail", "dkim", "selector1"],
    suggestedDailyLimit: 50,
    help: "Connects directly using your domain mail host or custom SMTP/IMAP server.",
    passwordSteps: [
      "Enter your mailbox password. SMTP and IMAP settings are detected automatically from your domain MX records.",
    ],
    passwordLink: null,
    needsAppPassword: false,
  },
];

export function providerByKey(key: string | null | undefined): ProviderPreset {
  return PROVIDERS.find((p) => p.key === key) ?? PROVIDERS[PROVIDERS.length - 1]!;
}

export function presetForAccount(a: {
  provider: string;
  provider_label: string;
  smtp_host: string | null;
}): ProviderPreset {
  if (a.provider === "gmail_api") return providerByKey("gmail");
  const byLabel = PROVIDERS.find((p) => p.key === a.provider_label);
  if (byLabel) return byLabel;
  const host = (a.smtp_host ?? "").toLowerCase();
  if (host.includes("zoho.in")) return providerByKey("zoho_in");
  if (host.includes("zoho.eu")) return providerByKey("zoho_eu");
  if (host.includes("zoho")) return providerByKey("zoho_com");
  if (host.includes("secureserver")) return providerByKey("godaddy");
  if (host.includes("hostinger")) return providerByKey("hostinger");
  if (host.includes("titan")) return providerByKey("titan");
  if (host.includes("privateemail")) return providerByKey("privateemail");
  if (host.includes("fastmail")) return providerByKey("fastmail");
  if (host.includes("mail.me.com")) return providerByKey("icloud");
  if (host.includes("yahoo")) return providerByKey("yahoo");
  if (host.includes("gmail") || host.includes("google")) return providerByKey("gmail");
  if (host.includes("office365") || host.includes("outlook")) return providerByKey("outlook");
  return providerByKey("custom");
}
