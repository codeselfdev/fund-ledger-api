import { constructionMenuKeys } from "../../modules/construction/construction.menu.js";
import { billingMenuKeys } from "../../modules/billing/billing.menu.js";
import { z } from "zod";
import { prisma } from "../prisma/client.js";

export const projectTypeSchema = z.enum(["fund_shares", "accounting", "billing", "construction"]);
export const memberShortcutKeys = ["members", "ledger", "expenses", "income"] as const;
export const accountantShortcutKeys = ["members", "expenses", "ledger", "commerce", "approvals", "pending_expenses", "accounts", "income", ...billingMenuKeys, ...constructionMenuKeys] as const;
const unique = (items: string[]) => new Set(items).size === items.length;
export const portalSettingsSchema = z.object({
  deposit_review: z.enum(["automatic", "admin_only"]),
  member_shortcuts: z.array(z.enum(memberShortcutKeys)).max(memberShortcutKeys.length).refine(unique, "Shortcuts must be unique"),
  accountant_shortcuts: z.array(z.enum(accountantShortcutKeys)).max(accountantShortcutKeys.length).refine(unique, "Shortcuts must be unique")
}).strict();
export type PortalSettings = z.infer<typeof portalSettingsSchema>;
export function normalizePortalSettings(raw: unknown, projectType: string = "fund_shares"): PortalSettings {
  const defaults: PortalSettings = { deposit_review: "automatic", member_shortcuts: [...memberShortcutKeys], accountant_shortcuts: ["members", "expenses", "ledger", "commerce", "income"] };
  if (projectType === "billing") { defaults.member_shortcuts = []; defaults.accountant_shortcuts = ["customers", "billing_invoices", "billing_collections", "billing_outstanding", "billing_reports"]; }
  if (projectType === "construction") { defaults.member_shortcuts = ["ledger", "expenses", "income"]; defaults.accountant_shortcuts = ["construction_budgets", "construction_boq", "construction_running_bills", "construction_funding", "expenses", "accounts"]; }
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
