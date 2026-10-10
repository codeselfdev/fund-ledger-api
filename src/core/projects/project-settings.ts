import { z } from "zod";
import { prisma } from "../prisma/client.js";

export const projectTypeSchema = z.enum(["fund_shares", "accounting", "billing"]);
export const memberShortcutKeys = ["members", "ledger", "expenses"] as const;
export const accountantShortcutKeys = ["members", "expenses", "ledger", "commerce", "approvals", "pending_expenses", "accounts"] as const;
const unique = (items: string[]) => new Set(items).size === items.length;
export const portalSettingsSchema = z.object({
  deposit_review: z.enum(["automatic", "admin_only"]),
  member_shortcuts: z.array(z.enum(memberShortcutKeys)).max(memberShortcutKeys.length).refine(unique, "Shortcuts must be unique"),
  accountant_shortcuts: z.array(z.enum(accountantShortcutKeys)).max(accountantShortcutKeys.length).refine(unique, "Shortcuts must be unique")
}).strict();
export type PortalSettings = z.infer<typeof portalSettingsSchema>;
export function normalizePortalSettings(raw: unknown): PortalSettings {
  const defaults: PortalSettings = { deposit_review: "automatic", member_shortcuts: [...memberShortcutKeys], accountant_shortcuts: ["members", "expenses", "ledger", "commerce"] };
  const parsed = portalSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaults;
}
export function resolveDepositRoute(mode: PortalSettings["deposit_review"], hasAccountant: boolean): "admin" | "accountant" {
  return mode === "admin_only" || !hasAccountant ? "admin" : "accountant";
}
export async function projectDepositRoute(tenantId: string, projectId: string) {
  const [project, accountant] = await Promise.all([
    prisma.project.findFirstOrThrow({ where: { id: projectId, tenantId }, select: { portalSettings: true } }),
    prisma.projectMembership.findFirst({ where: { tenantId, projectId, role: "accountant", isActive: true, user: { isActive: true } }, select: { id: true } })
  ]);
  return resolveDepositRoute(normalizePortalSettings(project.portalSettings).deposit_review, Boolean(accountant));
}
