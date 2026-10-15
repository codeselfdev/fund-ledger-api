import catalog from './catalog.json' with { type: 'json' };
import { z } from 'zod';
export const MAX_PINS = 8;
export type ShortcutRole = string;
export const preferenceSchema = z.object({ pinned: z.array(z.string().min(1).max(80)).max(MAX_PINS).refine(v => new Set(v).size === v.length, 'Choose each tool only once'), version: z.number().int().nonnegative().max(2147483646) }).strict();
export const resetSchema = preferenceSchema.pick({ version: true });
export function availableCatalog(projectType: string, roles: readonly string[]) {
    const allowed = (t: {
        roles: string[];
        project_types: string[];
    }) => t.project_types.includes(projectType) && t.roles.some(role => roles.includes(role));
    const tools = catalog.tools.filter(allowed);
    const order = projectType === 'accounting' ? ['add_customer', 'add_sale', 'add_income', 'add_expense', 'add_notice'] : projectType === 'billing' ? ['add_customer', 'add_invoice', 'add_collection', 'add_expense', 'add_income', 'add_notice'] : ['add_member', 'add_income', 'add_expense', 'add_notice'];
    const quick_add = order.flatMap(key => catalog.quick_add.filter(t => t.key === key && allowed(t))).slice(0, 4);
    return { tools, quick_add, groups: catalog.groups.filter(g => tools.some(t => t.group === g.key)) };
}
export function defaultPins(projectType: string, roles: readonly string[], portalSettings?: unknown) {
    const available = new Set(availableCatalog(projectType, roles).tools.map(t => t.key));
    const defaults: Record<string, string[]> = {
        fund_shares: ['members', 'income', 'expenses', 'schedules', 'notices', 'reports', 'accounts', 'assets'],
        accounting: ['customers', 'sale', 'receivables', 'income', 'expenses', 'accounts', 'assets', 'quotation'],
        billing: ['customers', 'billing_invoices', 'billing_collections', 'billing_outstanding', 'billing_subscriptions', 'billing_plans', 'billing_reports', 'assets'],
        construction: ['construction_budgets', 'construction_boq', 'construction_running_bills', 'construction_suppliers', 'construction_materials', 'construction_funding', 'expenses', 'assets'],
    };
    const raw = portalSettings as {
        accountant_shortcuts?: unknown;
        member_shortcuts?: unknown;
    } | null;
    const manage = roles.some(r => r === 'owner' || r === 'admin');
    let keys: unknown = !manage && roles.includes('accountant') && Array.isArray(raw?.accountant_shortcuts) ? raw.accountant_shortcuts : defaults[projectType] ?? defaults.fund_shares;
    if (roles.every(r => r === 'member'))
        keys = Array.isArray(raw?.member_shortcuts) ? raw.member_shortcuts : ['members', 'income', 'expenses', 'ledger'];
    const aliases: Record<string, string> = { fixed_assets: 'assets', commerce: projectType === 'accounting' ? 'inventory' : 'commerce' };
    return [...new Set((keys as unknown[]).filter((v): v is string => typeof v === 'string').map(k => aliases[k] ?? k))].filter(k => available.has(k)).slice(0, MAX_PINS);
}
export function visiblePins(raw: unknown, keys: readonly string[]) {
    const allowed = new Set(keys);
    return Array.isArray(raw) ? [...new Set(raw.filter((k): k is string => typeof k === 'string' && allowed.has(k)))].slice(0, MAX_PINS) : [];
}
