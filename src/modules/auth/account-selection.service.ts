import { nanoid } from "nanoid";
import { badRequest, unauthorized } from "../../core/http/api-error.js";
import { getActiveUserForLogin, issueLoginSession } from "./auth.service.js";

type LoginUser = Awaited<ReturnType<typeof getActiveUserForLogin>>;
export type AccountSelectionPayload = {
  kind: "account_selection";
  ticket: string;
  expires_at: string;
  accounts: Array<{ account_id: string; tenant_id: string; tenant_name: string; tenant_slug: string; account_name: string }>;
};
type Selection = {
  expiresAt: number;
  projectId?: string;
  verifiedEmail?: string | null;
  users: Array<{ id: string; tenantId: string; email: string | null; mobile: string; rootId: string }>;
};
const selections = new Map<string, Selection>();
const SELECTION_TTL_MS = 5 * 60 * 1000;

/** Only call after verifying the login identity; contact data alone is not proof. */
export function createAccountSelection(users: LoginUser[], projectId?: string, verifiedEmail?: string | null): AccountSelectionPayload {
  const now = Date.now();
  for (const [ticket, selection] of selections) {
    if (selection.expiresAt <= now) selections.delete(ticket);
  }
  const ticket = nanoid(32);
  const expiresAt = now + SELECTION_TTL_MS;
  selections.set(ticket, {
    expiresAt,
    projectId,
    verifiedEmail,
    users: users.map(user => ({
      id: user.id, tenantId: user.tenantId, email: user.email, mobile: user.mobile,
      rootId: user.identityRootId ?? user.id
    }))
  });
  return {
    kind: "account_selection", ticket, expires_at: new Date(expiresAt).toISOString(),
    accounts: users.map(user => ({
      account_id: user.id, tenant_id: user.tenantId, tenant_name: user.tenant.name, tenant_slug: user.tenant.slug,
      account_name: user.name
    })).sort((a, b) => a.tenant_name.localeCompare(b.tenant_name) || a.tenant_slug.localeCompare(b.tenant_slug))
  };
}

export async function completeAccountSelection(ticket: string, accountId: string) {
  const selection = selections.get(ticket);
  if (!selection || selection.expiresAt <= Date.now()) {
    selections.delete(ticket);
    throw unauthorized("Your sign-in session expired. Please sign in again.");
  }
  const candidate = selection.users.find(user => user.id === accountId);
  if (!candidate) throw badRequest("Choose an organization from the list.");
  // Claim synchronously before any await, so concurrent requests cannot reuse proof.
  selections.delete(ticket);
  try {
    const user = await getActiveUserForLogin(candidate.id);
    if (!user.isActive || user.tenantId !== candidate.tenantId || user.email !== candidate.email
      || user.mobile !== candidate.mobile || (user.identityRootId ?? user.id) !== candidate.rootId) {
      throw unauthorized("Your account has changed. Please sign in again.");
    }
    return await issueLoginSession(user, selection.projectId, true, selection.verifiedEmail);
  } catch (error) {
    if (selection.expiresAt > Date.now()) selections.set(ticket, selection);
    throw error;
  }
}
