import { getApp, getApps, initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import firebaseConfig from "../../firebase-applet-config.json";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

// In-memory cache ONLY (never stored in localStorage or sessionStorage)
const cachedGmailTokens = new Map<string, string>();
let isSigningIn = false;
let listenerRegistered = false;

export function initGoogleAuthListener(): () => void {
  if (listenerRegistered) return () => {};
  listenerRegistered = true;
  return onAuthStateChanged(auth, (user) => {
    if (!user && !isSigningIn) {
      cachedGmailTokens.clear();
    }
  });
}

export function getInMemoryGmailTokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [email, token] of cachedGmailTokens.entries()) {
    out[email] = token;
  }
  return out;
}

export function hasInMemoryGmailToken(email: string): boolean {
  return cachedGmailTokens.has(email.trim().toLowerCase());
}

export function clearInMemoryGmailToken(email?: string): void {
  if (email) {
    cachedGmailTokens.delete(email.trim().toLowerCase());
  } else {
    cachedGmailTokens.clear();
  }
}

export async function connectGoogleMailbox(hintEmail?: string): Promise<{
  email: string;
  displayName: string;
  accessToken: string;
}> {
  const provider = new GoogleAuthProvider();
  for (const scope of GMAIL_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({
    prompt: "select_account",
    ...(hintEmail ? { login_hint: hintEmail.trim().toLowerCase() } : {}),
  });

  isSigningIn = true;
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;
    const email = (result.user.email || hintEmail || "").trim().toLowerCase();

    if (!accessToken || !email) {
      throw new Error("Google sign-in did not return a Gmail access token. Please try again.");
    }

    cachedGmailTokens.set(email, accessToken);
    return {
      email,
      displayName: result.user.displayName || email.split("@")[0] || "",
      accessToken,
    };
  } finally {
    isSigningIn = false;
  }
}

export async function disconnectGoogleMailbox(email?: string): Promise<void> {
  clearInMemoryGmailToken(email);
  if (cachedGmailTokens.size === 0) {
    await signOut(auth).catch(() => {});
  }
}
