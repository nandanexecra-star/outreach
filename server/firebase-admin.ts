import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";

let _firestore: Firestore | null = null;

/**
 * Returns a singleton Firestore instance initialised from env vars.
 *
 * Required env vars (set in Render dashboard):
 *   FIREBASE_PROJECT_ID   – from your service-account JSON
 *   FIREBASE_CLIENT_EMAIL – from your service-account JSON
 *   FIREBASE_PRIVATE_KEY  – from your service-account JSON (the full PEM string)
 *
 * In local dev, set these in your .env file.
 * On Google Cloud (Cloud Run, etc.) Application Default Credentials are used as fallback.
 */
export function getFirestoreDb(): Firestore {
  if (_firestore) return _firestore;

  if (getApps().length === 0) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    // Render stores multi-line secrets as literal \n — convert back to newlines
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (projectId && clientEmail && privateKey) {
      initializeApp({
        credential: cert({ projectId, clientEmail, privateKey }),
        projectId,
      });
    } else {
      // Fallback: Application Default Credentials (works on Google Cloud infra)
      initializeApp({ projectId: projectId ?? "ai-studio-applet-webapp-58eee" });
    }
  }

  _firestore = getFirestore();
  return _firestore;
}
