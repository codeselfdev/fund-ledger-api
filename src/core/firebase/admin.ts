import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

let initError: string | null = null;

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as {
      project_id?: string;
      client_email?: string;
      private_key?: string;
    };
  } catch {
    initError = "Firebase service account JSON is invalid";
    return null;
  }
}

export function getFirebaseAdminApp(): App | null {
  if (getApps().length > 0) return getApps()[0] ?? null;

  const serviceAccount = parseServiceAccount();
  if (!serviceAccount) {
    if (!initError) initError = "FIREBASE_SERVICE_ACCOUNT_JSON / FCM_SERVICE_ACCOUNT_JSON is not configured";
    return null;
  }

  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    initError = "Firebase service account JSON is missing required keys";
    return null;
  }

  try {
    return initializeApp({
      credential: cert({
        projectId: serviceAccount.project_id,
        clientEmail: serviceAccount.client_email,
        privateKey: serviceAccount.private_key
      })
    });
  } catch (error) {
    initError = error instanceof Error ? error.message : "Firebase Admin initialization failed";
    return null;
  }
}

export function getFirebaseAdminInitError(): string | null {
  return initError;
}

export type FirebaseAuthIdentity = {
  uid: string;
  provider: "phone" | "google";
  phoneNumber?: string;
  email?: string;
  name?: string;
  emailVerified?: boolean;
};

const DEFAULT_GOOGLE_CLIENT_IDS = [
  "953182652005-qvkt24gr8r88javb0la2q8r0iasgeojm.apps.googleusercontent.com"
];

function allowedGoogleAudiences(): string[] {
  const extra = [process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_IDS]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set([...DEFAULT_GOOGLE_CLIENT_IDS, ...extra])];
}

export async function verifyGoogleOAuthIdToken(idToken: string): Promise<FirebaseAuthIdentity> {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!response.ok) {
    throw new Error("Invalid Google ID token");
  }
  const payload = (await response.json()) as {
    aud?: string;
    sub?: string;
    email?: string;
    email_verified?: string | boolean;
    name?: string;
  };
  if (!payload.aud || !allowedGoogleAudiences().includes(payload.aud)) {
    throw new Error("Google token was issued for a different app");
  }
  const email = payload.email?.trim().toLowerCase();
  if (!email) throw new Error("Google account has no email address");
  const emailVerified = payload.email_verified === true || payload.email_verified === "true";
  if (!emailVerified) throw new Error("Google email is not verified");
  return {
    uid: payload.sub || email,
    provider: "google",
    email,
    name: payload.name?.trim(),
    emailVerified
  };
}

export async function verifyFirebaseIdToken(idToken: string): Promise<FirebaseAuthIdentity> {
  const app = getFirebaseAdminApp();
  if (!app) {
    throw new Error(initError ?? "Firebase Admin is not configured");
  }

  const decoded = await getAuth(app).verifyIdToken(idToken);
  const provider = decoded.firebase?.sign_in_provider;
  const email = decoded.email?.trim().toLowerCase() || undefined;
  const name = typeof decoded.name === "string" ? decoded.name.trim() : undefined;

  if (provider === "google.com") {
    if (!email) throw new Error("Google account has no email address");
    return {
      uid: decoded.uid,
      provider: "google",
      email,
      name,
      emailVerified: decoded.email_verified
    };
  }

  if (provider === "phone" || decoded.phone_number) {
    const phoneNumber = decoded.phone_number;
    if (!phoneNumber) throw new Error("Firebase token is not from phone authentication");
    return {
      uid: decoded.uid,
      provider: "phone",
      phoneNumber,
      email,
      name,
      emailVerified: decoded.email_verified
    };
  }

  throw new Error("Unsupported Firebase sign-in provider");
}

export async function verifyAuthIdToken(idToken: string): Promise<FirebaseAuthIdentity> {
  if (getFirebaseAdminApp()) {
    try {
      return await verifyFirebaseIdToken(idToken);
    } catch {
      // Token may be a raw Google OAuth ID token instead of a Firebase token.
    }
  }
  return verifyGoogleOAuthIdToken(idToken);
}

export async function verifyFirebasePhoneIdToken(idToken: string): Promise<{ uid: string; phoneNumber: string }> {
  const identity = await verifyFirebaseIdToken(idToken);
  if (identity.provider !== "phone" || !identity.phoneNumber) {
    throw new Error("Firebase token is not from phone authentication");
  }
  return { uid: identity.uid, phoneNumber: identity.phoneNumber };
}
