import crypto from "node:crypto";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { env } from "../../config/env.js";
import { slugifyOrgName } from "../../core/onboarding/onboarding.service.js";
import { badRequest, conflict, serviceUnavailable, unauthorized } from "../../core/http/api-error.js";
import { verifyGoogleOAuthIdToken } from "../../core/firebase/admin.js";
import { provisionTenant } from "../tenants/tenants.service.js";
import {
  findActiveUsersByEmail,
  getActiveUserForLogin,
  googlePlaceholderMobile,
  toLoginSessionPayload,
  type LoginSessionPayload
} from "./auth.service.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const IDENTITY_TICKET_TTL_MS = 30 * 60 * 1000;

type GoogleOAuthState = {
  intent: "login" | "signup";
  redirectUri: string;
  callbackUri: string;
  tenantSlug?: string;
  codeVerifier: string;
};

export type GoogleIdentity = {
  uid: string;
  email: string;
  name: string;
};

export type GoogleCompleteResult =
  | ({ kind: "session" } & LoginSessionPayload)
  | { kind: "identity"; email: string; name: string; ticket: string; id_token: string };

type TicketRecord =
  | { kind: "session"; payload: LoginSessionPayload; expiresAt: number }
  | { kind: "identity"; identity: GoogleIdentity; idToken: string; expiresAt: number };

const tickets = new Map<string, TicketRecord>();

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(env.googleOAuth.clientId && env.googleOAuth.clientSecret);
}

export function backendGoogleRedirectUri(req: Request): string {
  if (env.googleOAuth.redirectUri) return env.googleOAuth.redirectUri;
  if (env.googleOAuth.publicApiUrl) {
    return `${env.googleOAuth.publicApiUrl.replace(/\/$/, "")}/v1/auth/google/callback`;
  }
  const proto = (req.get("x-forwarded-proto") ?? req.protocol ?? "http").split(",")[0]?.trim() || "http";
  const host = req.get("x-forwarded-host") ?? req.get("host");
  if (!host) throw badRequest("GOOGLE_OAUTH_REDIRECT_URI is not configured");
  return `${proto}://${host}/v1/auth/google/callback`;
}

export function isAllowedAppRedirect(uri: string): boolean {
  if (env.googleOAuth.appRedirectAllowlist.some((prefix) => uri.startsWith(prefix))) return true;
  try {
    const url = new URL(uri);
    if (url.protocol === "fundledger:") return true;
    if (url.protocol === "exp:" || url.protocol === "exps:") return true;
    if (url.protocol === "http:" || url.protocol === "https:") {
      const host = url.hostname;
      if (host === "localhost" || host === "127.0.0.1") return true;
      if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      if (url.protocol === "https:" && (host === "auth.expo.io" || host.endsWith(".expo.io") || host.endsWith(".exp.direct"))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function appendQueryParams(uri: string, params: Record<string, string>): string {
  try {
    const url = new URL(uri);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    const qs = new URLSearchParams(params).toString();
    const hashIndex = uri.indexOf("#");
    const base = hashIndex >= 0 ? uri.slice(0, hashIndex) : uri;
    const hash = hashIndex >= 0 ? uri.slice(hashIndex) : "";
    return `${base}${base.includes("?") ? "&" : "?"}${qs}${hash}`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function isHttpRedirect(uri: string): boolean {
  return uri.startsWith("http://") || uri.startsWith("https://");
}

export function sendOAuthResult(res: Response, redirectUri: string, params: Record<string, string>) {
  const target = redirectUri && isAllowedAppRedirect(redirectUri) ? appendQueryParams(redirectUri, params) : "";
  if (target && isHttpRedirect(target)) {
    return res.redirect(target);
  }

  const message =
    params.error ?? (params.ticket ? "Google sign-in completed. Return to Fund Nesta." : "Google sign-in failed.");
  const safeTarget = target ? escapeHtml(target) : "";
  return res
    .status(params.error ? 400 : 200)
    .type("html")
    .send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${target ? `<meta http-equiv="refresh" content="0;url=${safeTarget}">` : ""}
    <title>Fund Nesta</title>
  </head>
  <body style="font-family:sans-serif;padding:24px;line-height:1.4">
    <p>${escapeHtml(message)}</p>
    ${target ? `<p><a href="${safeTarget}">Open Fund Nesta</a></p>` : ""}
  </body>
</html>`);
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pkceVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function signState(state: GoogleOAuthState): string {
  return jwt.sign(state, env.jwtSecret, { expiresIn: "10m" });
}

function readState(token: string): GoogleOAuthState {
  const payload = jwt.verify(token, env.jwtSecret) as GoogleOAuthState;
  if (payload.intent !== "login" && payload.intent !== "signup") {
    throw badRequest("Invalid Google sign-in state");
  }
  if (!payload.redirectUri || !payload.callbackUri || !payload.codeVerifier) {
    throw badRequest("Invalid Google sign-in state");
  }
  return payload;
}

function pruneTickets() {
  const now = Date.now();
  for (const [id, row] of tickets) {
    if (row.expiresAt <= now) tickets.delete(id);
  }
}

function storeIdentityTicket(identity: GoogleIdentity, idToken: string): string {
  pruneTickets();
  const ticket = nanoid(24);
  tickets.set(ticket, {
    kind: "identity",
    identity,
    idToken,
    expiresAt: Date.now() + IDENTITY_TICKET_TTL_MS
  });
  return ticket;
}

export function resolveGoogleAuthTicket(ticket: string): GoogleCompleteResult {
  pruneTickets();
  const row = tickets.get(ticket);
  if (!row) throw unauthorized("Google sign-in expired. Try again.");
  if (row.kind === "session") {
    tickets.delete(ticket);
    return { kind: "session", ...row.payload };
  }
  return {
    kind: "identity",
    email: row.identity.email,
    name: row.identity.name,
    ticket,
    id_token: row.idToken
  };
}

export function buildGoogleAuthorizationUrl(req: Request): string {
  if (!isGoogleOAuthConfigured()) {
    throw serviceUnavailable(
      "Google sign-in is not configured on the server. Add a Web OAuth client ID and GOOGLE_OAUTH_CLIENT_SECRET."
    );
  }

  const intent = queryString(req, "intent") === "signup" ? "signup" : "login";
  const redirectUri = queryString(req, "redirect_uri");
  if (!redirectUri) throw badRequest("redirect_uri is required");
  if (!isAllowedAppRedirect(redirectUri)) throw badRequest("This app redirect is not allowed");

  const callbackUri = backendGoogleRedirectUri(req);
  const codeVerifier = pkceVerifier();
  const state = signState({
    intent,
    redirectUri,
    callbackUri,
    tenantSlug: queryString(req, "tenant_slug"),
    codeVerifier
  });

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.googleOAuth.clientId);
  url.searchParams.set("redirect_uri", callbackUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("access_type", "online");
  return url.toString();
}

async function exchangeGoogleCode(code: string, state: GoogleOAuthState): Promise<string> {
  const body = new URLSearchParams({
    code,
    client_id: env.googleOAuth.clientId,
    client_secret: env.googleOAuth.clientSecret!,
    redirect_uri: state.callbackUri,
    grant_type: "authorization_code",
    code_verifier: state.codeVerifier
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = (await response.json()) as {
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.id_token) {
    throw unauthorized(payload.error_description || payload.error || "Google did not return an ID token");
  }
  return payload.id_token;
}

function toGoogleIdentity(identity: { uid: string; email?: string; name?: string }): GoogleIdentity {
  const email = identity.email?.trim().toLowerCase();
  if (!email) throw badRequest("Google account has no email address");
  const name = identity.name?.trim() || email.split("@")[0] || "Owner";
  return { uid: identity.uid, email, name };
}

export async function completeGoogleAuthorization(
  code: string,
  stateToken: string
): Promise<{ identity: GoogleIdentity; idToken: string }> {
  const idToken = await exchangeGoogleCode(code, readState(stateToken));
  const verified = await verifyGoogleOAuthIdToken(idToken);
  return { identity: toGoogleIdentity(verified), idToken };
}

export async function signupWithGoogleTicket(input: {
  ticket: string;
  orgName: string;
  ownerName?: string;
  ownerMobile?: string;
  projectName?: string;
  totalShares?: number;
}): Promise<LoginSessionPayload> {
  pruneTickets();
  const row = tickets.get(input.ticket);
  if (!row) throw unauthorized("Google sign-in expired. Connect Google again.");
  if (row.kind !== "identity") {
    throw conflict("This Google account already has a FundLedger login. Sign in instead.");
  }
  tickets.delete(input.ticket);

  const existing = await findActiveUsersByEmail(row.identity.email);
  if (existing.length > 0) {
    tickets.set(input.ticket, { ...row, expiresAt: Date.now() + IDENTITY_TICKET_TTL_MS });
    throw conflict("This Google account already has a FundLedger login. Sign in instead.");
  }

  const ownerName = input.ownerName?.trim() || row.identity.name;
  const ownerMobile = input.ownerMobile || googlePlaceholderMobile(row.identity.uid);
  let result;
  try {
    result = await provisionTenant({
      name: input.orgName,
      slug: slugifyOrgName(input.orgName),
      projectName: input.projectName,
      projectTotalShares: input.totalShares,
      adminName: ownerName,
      adminMobile: ownerMobile,
      adminEmail: row.identity.email,
      source: "self_signup"
    });
  } catch (error) {
    tickets.set(input.ticket, { ...row, expiresAt: Date.now() + IDENTITY_TICKET_TTL_MS });
    if ((error as { code?: string }).code === "SLUG_TAKEN") {
      throw conflict("This organization slug is already taken. Choose another organization name.");
    }
    throw error;
  }

  const user = await getActiveUserForLogin(result.ownerUserId);
  return toLoginSessionPayload(user, result.token, result.defaultProjectId);
}

export async function handleGoogleOAuthCallback(req: Request, res: Response) {
  const stateToken = queryString(req, "state") ?? "";
  let redirectUri = "";
  try {
    if (stateToken) redirectUri = readState(stateToken).redirectUri;
    if (req.query.error) {
      const description =
        queryString(req, "error_description") || queryString(req, "error") || "Google sign-in was cancelled.";
      return sendOAuthResult(res, redirectUri, { error: description });
    }
    const code = queryString(req, "code");
    if (!code || !stateToken) {
      return sendOAuthResult(res, redirectUri, { error: "Google sign-in did not complete." });
    }
    const { identity, idToken } = await completeGoogleAuthorization(code, stateToken);
    const ticket = storeIdentityTicket(identity, idToken);
    return sendOAuthResult(res, redirectUri, { ticket, status: "identity" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google sign-in failed.";
    return sendOAuthResult(res, redirectUri, { error: message });
  }
}
