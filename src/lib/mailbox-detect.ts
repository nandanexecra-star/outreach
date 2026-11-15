export type ServerCandidate = {
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
};

export type Detected = {
  providerKey: string;
  candidates: ServerCandidate[];
};

const c = (
  smtpHost: string,
  imapHost: string,
  smtpPort = 465,
  imapPort = 993,
): ServerCandidate => ({
  smtpHost,
  smtpPort,
  imapHost,
  imapPort,
});

function dedupeCandidates(list: ServerCandidate[]): ServerCandidate[] {
  const seen = new Set<string>();
  const out: ServerCandidate[] = [];
  for (const item of list) {
    if (!item.smtpHost) continue;
    const key = `${item.smtpHost.toLowerCase()}:${item.smtpPort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function detectMailbox(email: string, mxRecords: string[]): Detected {
  const domain = (email.trim().toLowerCase().split("@")[1] ?? "").replace(/\.$/, "");
  const cleanMx = mxRecords.map((r) => r.toLowerCase().replace(/\.$/, "")).filter(Boolean);
  const mx = cleanMx.join(" ");

  if (["gmail.com", "googlemail.com"].includes(domain) || /(google|googlemail)\.com/.test(mx)) {
    return {
      providerKey: "gmail",
      candidates: [
        c("smtp.gmail.com", "imap.gmail.com", 465),
        c("smtp.gmail.com", "imap.gmail.com", 587),
      ],
    };
  }

  if (["zohomail.in", "zoho.in"].includes(domain) || /zoho\.in\b/.test(mx)) {
    return {
      providerKey: "zoho_in",
      candidates: [
        c("smtppro.zoho.in", "imappro.zoho.in", 465),
        c("smtp.zoho.in", "imap.zoho.in", 465),
        c("smtppro.zoho.in", "imappro.zoho.in", 587),
        c("smtp.zoho.in", "imap.zoho.in", 587),
      ],
    };
  }
  if (["zohomail.eu", "zoho.eu"].includes(domain) || /zoho\.eu\b/.test(mx)) {
    return {
      providerKey: "zoho_eu",
      candidates: [
        c("smtppro.zoho.eu", "imappro.zoho.eu", 465),
        c("smtp.zoho.eu", "imap.zoho.eu", 465),
        c("smtppro.zoho.eu", "imappro.zoho.eu", 587),
        c("smtp.zoho.eu", "imap.zoho.eu", 587),
      ],
    };
  }
  if (["zohomail.com.au", "zoho.com.au"].includes(domain) || /zoho\.com\.au\b/.test(mx)) {
    return {
      providerKey: "zoho_com",
      candidates: [
        c("smtppro.zoho.com.au", "imappro.zoho.com.au", 465),
        c("smtp.zoho.com.au", "imap.zoho.com.au", 465),
        c("smtp.zoho.com.au", "imap.zoho.com.au", 587),
      ],
    };
  }
  if (["zohomail.jp", "zoho.jp"].includes(domain) || /zoho\.jp\b/.test(mx)) {
    return {
      providerKey: "zoho_com",
      candidates: [
        c("smtppro.zoho.jp", "imappro.zoho.jp", 465),
        c("smtp.zoho.jp", "imap.zoho.jp", 465),
        c("smtp.zoho.jp", "imap.zoho.jp", 587),
      ],
    };
  }
  if (["zohomail.com", "zoho.com"].includes(domain) || /zoho(mail)?\.com\b/.test(mx)) {
    return {
      providerKey: "zoho_com",
      candidates: [
        c("smtppro.zoho.com", "imappro.zoho.com", 465),
        c("smtp.zoho.com", "imap.zoho.com", 465),
        c("smtppro.zoho.com", "imappro.zoho.com", 587),
        c("smtp.zoho.com", "imap.zoho.com", 587),
      ],
    };
  }

  if (/secureserver\.net/.test(mx)) {
    return {
      providerKey: "godaddy",
      candidates: [
        c("smtpout.secureserver.net", "imap.secureserver.net", 465),
        c("smtpout.secureserver.net", "imap.secureserver.net", 587),
      ],
    };
  }

  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain)) {
    return {
      providerKey: "outlook",
      candidates: [
        c("smtp-mail.outlook.com", "outlook.office365.com", 587),
        c("smtp.office365.com", "outlook.office365.com", 587),
      ],
    };
  }
  if (/protection\.outlook\.com|outlook\.com/.test(mx)) {
    return {
      providerKey: "outlook",
      candidates: [
        c("smtp.office365.com", "outlook.office365.com", 587),
        c("smtp-mail.outlook.com", "outlook.office365.com", 587),
      ],
    };
  }

  if (/hostinger/.test(mx)) {
    return {
      providerKey: "hostinger",
      candidates: [
        c("smtp.hostinger.com", "imap.hostinger.com", 465),
        c("smtp.hostinger.com", "imap.hostinger.com", 587),
      ],
    };
  }

  if (/titan\.email/.test(mx)) {
    return {
      providerKey: "titan",
      candidates: [
        c("smtp.titan.email", "imap.titan.email", 465),
        c("smtp.titan.email", "imap.titan.email", 587),
      ],
    };
  }

  if (/privateemail\.com/.test(mx)) {
    return {
      providerKey: "privateemail",
      candidates: [
        c("mail.privateemail.com", "mail.privateemail.com", 465),
        c("mail.privateemail.com", "mail.privateemail.com", 587),
      ],
    };
  }

  if (/emailsrvr\.com/.test(mx)) {
    return {
      providerKey: "custom",
      candidates: [
        c("secure.emailsrvr.com", "secure.emailsrvr.com", 465),
        c("secure.emailsrvr.com", "secure.emailsrvr.com", 587),
      ],
    };
  }

  if (/messagingengine\.com/.test(mx)) {
    return {
      providerKey: "fastmail",
      candidates: [
        c("smtp.fastmail.com", "imap.fastmail.com", 465),
        c("smtp.fastmail.com", "imap.fastmail.com", 587),
      ],
    };
  }

  if (["icloud.com", "me.com", "mac.com"].includes(domain) || /mail\.icloud\.com/.test(mx)) {
    return {
      providerKey: "icloud",
      candidates: [c("smtp.mail.me.com", "imap.mail.me.com", 587)],
    };
  }

  if (["yahoo.com", "yahoo.co.in", "ymail.com", "aol.com"].includes(domain) || /yahoodns\.net/.test(mx)) {
    return {
      providerKey: "yahoo",
      candidates: [
        c("smtp.mail.yahoo.com", "imap.mail.yahoo.com", 465),
        c("smtp.mail.yahoo.com", "imap.mail.yahoo.com", 587),
      ],
    };
  }

  if (/yandex\.(net|ru|com)/.test(mx) || ["yandex.com", "yandex.ru"].includes(domain)) {
    return {
      providerKey: "custom",
      candidates: [
        c("smtp.yandex.com", "imap.yandex.com", 465),
        c("smtp.yandex.com", "imap.yandex.com", 587),
      ],
    };
  }

  if (/migadu\.com/.test(mx)) {
    return {
      providerKey: "custom",
      candidates: [
        c("smtp.migadu.com", "imap.migadu.com", 465),
        c("smtp.migadu.com", "imap.migadu.com", 587),
      ],
    };
  }

  if (/purelymail\.com/.test(mx)) {
    return {
      providerKey: "custom",
      candidates: [c("smtp.purelymail.com", "imap.purelymail.com", 465)],
    };
  }

  const customCandidates: ServerCandidate[] = [];
  if (domain) {
    customCandidates.push(
      c(`mail.${domain}`, `mail.${domain}`, 465),
      c(`mail.${domain}`, `mail.${domain}`, 587),
      c(`smtp.${domain}`, `imap.${domain}`, 465),
      c(`smtp.${domain}`, `imap.${domain}`, 587),
    );
  }
  const primaryMx = cleanMx[0];
  if (primaryMx && !primaryMx.endsWith(`.${domain}`) && primaryMx !== domain) {
    customCandidates.push(c(primaryMx, primaryMx, 465), c(primaryMx, primaryMx, 587));
  } else if (primaryMx) {
    customCandidates.push(c(primaryMx, `imap.${domain}`, 465), c(primaryMx, `imap.${domain}`, 587));
  }

  return {
    providerKey: "custom",
    candidates: dedupeCandidates(customCandidates),
  };
}
