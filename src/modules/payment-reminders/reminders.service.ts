import { Prisma, type PaymentReminderRule as RuleRow, type PaymentReminderSettings as SettingsRow } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { badRequest, notFound } from "../../core/http/api-error.js";
import { notifyProjectMembers } from "../../core/notifications/notification.service.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { calculateDueBalance } from "../members/member-settlement.service.js";
import { outstanding as invoiceOutstanding } from "../billing/billing.policy.js";
import { DEFAULT_RULES, DEFAULT_SETTINGS, MAX_SENDS_PER_DUE, addDays, dhakaNow, keyOf, offDayReason, planRule, relativeLabel, renderMessage, ruleLabel, shortDate, sendsFor, timeFor, totalSends, type OffDayRule, type ReminderRule, type ReminderSettings } from "./reminders.policy.js";

export const REMINDER_PROJECT_TYPES = ["fund_shares", "billing"] as const;
type Scope = { tenantId: string; projectId: string };
/** One unpaid deadline for one recipient: a member's installment due, or a customer's invoice. */
export interface DueItem { recipientId: string; recipientName: string; groupKey: string; groupName: string; dueDate: string; amount: number; email?: string | null }

const settingsOf = (row: SettingsRow): ReminderSettings => ({ enabled: row.enabled, preferredTime: row.preferredTime, sendingDays: [...row.sendingDays].sort(), offDayRule: row.offDayRule as OffDayRule, treatHolidays: row.treatHolidays, pauseForPromises: row.pauseForPromises });
const ruleOf = (row: RuleRow): ReminderRule & { id: string } => ({ id: row.id, kind: row.kind as ReminderRule["kind"], days: row.days, ownTime: row.ownTime, repeatEvery: row.repeatEvery, repeatCount: row.repeatCount, message: row.message, enabled: row.enabled });
const order = { before: 0, due: 1, after: 2 } as const;
const sortRules = <T extends ReminderRule>(rules: T[]) => [...rules].sort((a, b) => order[a.kind] - order[b.kind] || (a.kind === "before" ? b.days - a.days : a.days - b.days));

export async function reminderProject(scope: Scope) {
  const project = await prisma.project.findFirst({ where: { id: scope.projectId, tenantId: scope.tenantId }, select: { id: true, name: true, projectType: true } });
  if (!project) throw notFound("Project not found");
  if (!(REMINDER_PROJECT_TYPES as readonly string[]).includes(project.projectType)) throw notFound("Payment reminders are available in Fund / Shares and Billing projects");
  return project;
}
/** First open seeds the recommended reminders, switched off until an admin turns them on. */
export async function ensureReminderSetup(scope: Scope) {
  const existing = await prisma.paymentReminderSettings.findUnique({ where: { projectId: scope.projectId } });
  if (existing) return { settings: existing, created: false };
  try {
    const settings = await prisma.$transaction(async tx => {
      const row = await tx.paymentReminderSettings.create({ data: { ...scope, ...{ enabled: DEFAULT_SETTINGS.enabled, preferredTime: DEFAULT_SETTINGS.preferredTime, sendingDays: DEFAULT_SETTINGS.sendingDays, offDayRule: DEFAULT_SETTINGS.offDayRule, treatHolidays: DEFAULT_SETTINGS.treatHolidays, pauseForPromises: DEFAULT_SETTINGS.pauseForPromises } } });
      await tx.paymentReminderRule.createMany({ data: DEFAULT_RULES.map(rule => ({ ...scope, kind: rule.kind, days: rule.days, ownTime: rule.ownTime, repeatEvery: rule.repeatEvery, repeatCount: rule.repeatCount, message: rule.message, enabled: rule.enabled })), skipDuplicates: true });
      return row;
    });
    return { settings, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { settings: (await prisma.paymentReminderSettings.findUniqueOrThrow({ where: { projectId: scope.projectId } })), created: false };
    throw error;
  }
}
export async function loadRules(scope: Scope) {
  return sortRules((await prisma.paymentReminderRule.findMany({ where: { tenantId: scope.tenantId, projectId: scope.projectId } })).map(ruleOf));
}
/** Every rule must leave a due with at most ten sends in all. */
export function assertSendLimit(rules: ReminderRule[]) {
  const total = totalSends(rules);
  if (total > MAX_SENDS_PER_DUE) throw badRequest(`These reminders add up to ${total} sends per unpaid due. Keep it to ${MAX_SENDS_PER_DUE} or fewer.`);
}

/** Unpaid deadlines within the reminder window, by project type. */
export async function loadDueItems(scope: Scope, projectType: string, from: string, to: string): Promise<DueItem[]> {
  const range = { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59Z`) };
  if (projectType === "billing") {
    const invoices = await prisma.billingInvoice.findMany({ where: { ...scope, status: "issued", dueDate: range }, include: { customer: { select: { id: true, name: true, email: true, isActive: true } } } });
    return invoices.filter(invoice => invoice.customer.isActive && invoiceOutstanding(invoice) > 0).map(invoice => ({ recipientId: invoice.customerId, recipientName: invoice.customer.name, groupKey: invoice.id, groupName: `Invoice ${invoice.number}`, dueDate: keyOf(invoice.dueDate), amount: invoiceOutstanding(invoice), email: invoice.customer.email }));
  }
  const dues = await prisma.due.findMany({ where: { ...scope, status: { notIn: ["paid", "waived"] }, dueDate: range, member: { status: "active" } }, select: { memberId: true, scheduleId: true, amount: true, paidAmount: true, waivedAmount: true, penaltyDue: true, penaltyPaid: true, dueDate: true, schedule: { select: { name: true } }, member: { select: { name: true } } } });
  return dues.map(due => ({ recipientId: due.memberId, recipientName: due.member.name, groupKey: due.scheduleId, groupName: due.schedule.name, dueDate: keyOf(due.dueDate), amount: calculateDueBalance(due).total })).filter(item => item.amount > 0);
}
/** Reminders reach back up to ~4 months after a deadline (15 days + 9 repeats of 7 days, plus off days). */
export const windowFor = (today: string) => ({ from: addDays(today, -110), to: addDays(today, 75) });

export interface PlannedGroupSend { date: string; time: string; groupKey: string; label: string; dueDate: string; recipients: number; movedFrom: string | null; ruleId?: string }
/** Group-level plan for a date range (one row per installment/invoice date, rule and day). */
export function planGroups(items: DueItem[], rules: ReminderRule[], settings: ReminderSettings, from: string, to: string, billing = false): PlannedGroupSend[] {
  const groups = new Map<string, { name: string; dueDate: string; recipients: Set<string> }>();
  for (const item of items) {
    const key = billing ? item.dueDate : item.groupKey;
    const group = groups.get(key) ?? { name: billing ? `Invoices due ${shortDate(item.dueDate)}` : item.groupName, dueDate: item.dueDate, recipients: new Set<string>() };
    group.recipients.add(item.recipientId); groups.set(key, group);
  }
  const rows: PlannedGroupSend[] = [];
  for (const [groupKey, group] of groups) for (const rule of rules.filter(rule => rule.enabled)) for (const send of planRule(rule, group.dueDate, settings)) {
    if (send.date < from || send.date > to) continue;
    rows.push({ date: send.date, time: timeFor(rule, settings), groupKey, label: `${group.name} · ${relativeLabel(group.dueDate, send.movedFrom ?? send.date)}`, dueDate: group.dueDate, recipients: group.recipients.size, movedFrom: send.movedFrom, ruleId: rule.id });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.label.localeCompare(b.label));
}

const settingsPayload = (s: ReminderSettings) => ({ enabled: s.enabled, preferred_time: s.preferredTime, sending_days: s.sendingDays, off_day_rule: s.offDayRule, treat_holidays: s.treatHolidays, pause_for_promises: s.pauseForPromises });
export const rulePayload = (rule: ReminderRule & { id?: string }) => ({ id: rule.id, kind: rule.kind, days: rule.days, own_time: rule.ownTime, repeat_every: rule.repeatEvery, repeat_count: rule.repeatCount, message: rule.message, enabled: rule.enabled, label: ruleLabel(rule), sends: sendsFor({ ...rule, enabled: true }) });
const sendPayload = (row: PlannedGroupSend) => ({ date: row.date, time: row.time, label: row.label, due_date: row.dueDate, recipients: row.recipients, moved_from: row.movedFrom, rule_id: row.ruleId });

export async function reminderOverview(scope: Scope, now = new Date()) {
  const project = await reminderProject(scope);
  const { settings: row, created } = await ensureReminderSetup(scope);
  const settings = settingsOf(row), rules = await loadRules(scope), { date: today, time } = dhakaNow(now);
  const billing = project.projectType === "billing", window = windowFor(today);
  const items = await loadDueItems(scope, project.projectType, window.from, window.to);
  const plan = planGroups(items, rules, settings, today, addDays(today, 30), billing);
  const upcoming = plan.filter(row => row.date > today || row.time > time);
  const next = upcoming[0];
  const nextSend = next ? { date: next.date, time: next.time, items: upcoming.filter(row => row.date === next.date && row.time === next.time).map(sendPayload) } : null;
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i)).map(date => ({ date, off: offDayReason(date, settings), sends: plan.filter(row => row.date === date).length }));
  return {
    project: { name: project.name, type: project.projectType, audience: billing ? "customers" : "members", channel: billing ? "email" : "push" },
    first_time: created || (!row.enabled && !row.updatedById),
    settings: settingsPayload(settings), rules: rules.map(rulePayload),
    sends_per_due: totalSends(rules), max_sends_per_due: MAX_SENDS_PER_DUE,
    unpaid: { recipients: new Set(items.map(item => item.recipientId)).size, dues: items.length },
    next_send: nextSend,
    week, week_sends: plan.filter(row => row.date <= addDays(today, 6)).map(sendPayload),
    today, now: time,
  };
}

/** Exact days and wording one draft rule would produce for the nearest real deadline. */
export async function reminderPreview(scope: Scope, rule: ReminderRule, now = new Date()) {
  const project = await reminderProject(scope);
  const { settings: row } = await ensureReminderSetup(scope);
  const settings = settingsOf(row), { date: today } = dhakaNow(now), window = windowFor(today);
  const items = (await loadDueItems(scope, project.projectType, window.from, window.to)).sort((a, b) => Math.abs(Date.parse(a.dueDate) - Date.parse(addDays(today, 7))) - Math.abs(Date.parse(b.dueDate) - Date.parse(addDays(today, 7))));
  const sample = items.find(item => item.dueDate >= today) ?? items[0] ?? { recipientId: "sample", recipientName: project.projectType === "billing" ? "Rahim Uddin" : "Rahim Uddin", groupKey: "sample", groupName: project.projectType === "billing" ? "Invoice INV-0001" : "Installment", dueDate: addDays(today, 10), amount: 12000 };
  const dates = planRule({ ...rule, enabled: true }, sample.dueDate, settings);
  const sendDate = dates[0]?.movedFrom ?? dates[0]?.date ?? sample.dueDate;
  return {
    sample: { name: sample.recipientName, group: sample.groupName, due_date: sample.dueDate, amount: sample.amount, example: sample.recipientId === "sample" },
    time: timeFor(rule, settings),
    dates: dates.map(send => ({ date: send.date, moved_from: send.movedFrom, past: send.date < today })),
    message: renderMessage(rule.message, { name: sample.recipientName, amount: sample.amount, schedule: sample.groupName, dueDate: sample.dueDate, sendDate }),
  };
}

// ---------------------------------------------------------------- sending
const processed = new Map<string, Set<string>>();
let running = false;
/** Send every reminder whose time has come today. Safe to run every minute: each recipient is claimed once a day. */
export async function runPaymentReminders(now = new Date()) {
  if (running) return { projects: 0, sent: 0 };
  running = true;
  let projects = 0, sent = 0;
  try {
    const { date: today, time } = dhakaNow(now);
    for (const key of processed.keys()) if (!key.endsWith(today)) processed.delete(key);
    const rows = await prisma.paymentReminderSettings.findMany({ where: { enabled: true }, include: { project: { select: { name: true, projectType: true, deletionStartedAt: true } } } });
    for (const row of rows) {
      if (!(REMINDER_PROJECT_TYPES as readonly string[]).includes(row.project.projectType) || row.project.deletionStartedAt) continue;
      const settings = settingsOf(row), scope = { tenantId: row.tenantId, projectId: row.projectId };
      const rules = (await loadRules(scope)).filter(rule => rule.enabled && timeFor(rule, settings) <= time);
      const doneKey = `${row.projectId}|${today}`, done = processed.get(doneKey) ?? new Set<string>();
      const slots = [...new Set(rules.map(rule => timeFor(rule, settings)))].filter(slot => !done.has(slot));
      if (!slots.length) continue;
      try {
        projects++;
        sent += await sendProject(scope, row.project, settings, rules, today);
        slots.forEach(slot => done.add(slot)); processed.set(doneKey, done);
      } catch (error) { console.error("[payment-reminders] project run failed", row.projectId, error); }
    }
  } finally { running = false; }
  return { projects, sent };
}

interface Candidate { item: DueItem; rule: ReminderRule; sendDate: string }
export function candidatesFor(items: DueItem[], rules: ReminderRule[], settings: ReminderSettings, today: string): Candidate[] {
  const result: Candidate[] = [];
  for (const item of items) for (const rule of rules) {
    const send = planRule(rule, item.dueDate, settings).find(entry => entry.date === today);
    if (send) result.push({ item, rule, sendDate: send.movedFrom ?? send.date });
  }
  return result;
}
/** One message per recipient a day: the earliest deadline leads, any others are summarized. */
export function combinedMessage(list: Candidate[]) {
  const sorted = [...list].sort((a, b) => a.item.dueDate.localeCompare(b.item.dueDate));
  const lead = sorted[0], others = [...new Map(sorted.slice(1).filter(c => c.item.groupKey !== lead.item.groupKey || c.item.dueDate !== lead.item.dueDate).map(c => [`${c.item.groupKey}|${c.item.dueDate}`, c])).values()];
  const total = [...new Map(sorted.map(c => [`${c.item.groupKey}|${c.item.dueDate}`, c.item.amount])).values()].reduce((sum, amount) => sum + amount, 0);
  let body = renderMessage(lead.rule.message, { name: lead.item.recipientName, amount: lead.item.amount, schedule: lead.item.groupName, dueDate: lead.item.dueDate, sendDate: lead.sendDate });
  if (others.length) body += ` You also have ${others.length} other unpaid ${others.length === 1 ? "due" : "dues"}; ৳${total.toLocaleString("en-IN")} in total.`;
  return { body, total, lead };
}

async function sendProject(scope: Scope, project: { name: string; projectType: string }, settings: ReminderSettings, rules: ReminderRule[], today: string) {
  const window = windowFor(today), items = await loadDueItems(scope, project.projectType, window.from, window.to);
  let candidates = candidatesFor(items, rules, settings, today);
  if (!candidates.length) return 0;
  const byRecipient = new Map<string, Candidate[]>();
  if (project.projectType === "billing") {
    for (const c of candidates) if (c.item.email) byRecipient.set(c.item.recipientId, [...(byRecipient.get(c.item.recipientId) ?? []), c]);
    let queued = 0;
    for (const [customerId, list] of byRecipient) {
      const { body, lead } = combinedMessage(list);
      try {
        await prisma.billingMessage.create({ data: { ...scope, recipient: lead.item.email!, dedupeKey: `auto-reminder:${customerId}:${today}`, subject: `Payment reminder · ${lead.item.groupName}`, body } });
        queued++;
      } catch (error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error; }
    }
    if (queued) await writeAudit({ tenantId: scope.tenantId, projectId: scope.projectId, actorUserId: null, action: "payment_reminders.queued", entityType: "project", entityId: scope.projectId, after: { date: today, customers: queued } });
    return queued;
  }
  const memberIds = [...new Set(candidates.map(c => c.item.recipientId))];
  const [already, promises] = await Promise.all([
    prisma.memberReminder.findMany({ where: { projectId: scope.projectId, memberId: { in: memberIds }, reminderDate: new Date(`${today}T00:00:00Z`) }, select: { memberId: true } }),
    settings.pauseForPromises ? prisma.paymentCommitment.findMany({ where: { ...scope, memberId: { in: memberIds }, status: "pending", promisedDate: { gte: new Date(`${today}T00:00:00Z`) } }, select: { memberId: true } }) : Promise.resolve([]),
  ]);
  const reminded = new Set(already.map(row => row.memberId)), promised = new Set(promises.map(row => row.memberId));
  // While a payment promise is open, only overdue reminders wait; before/due-date reminders still go out.
  candidates = candidates.filter(c => !reminded.has(c.item.recipientId) && !(c.rule.kind === "after" && promised.has(c.item.recipientId)));
  for (const c of candidates) byRecipient.set(c.item.recipientId, [...(byRecipient.get(c.item.recipientId) ?? []), c]);
  let delivered = 0;
  for (const [memberId, list] of byRecipient) {
    const { body, total } = combinedMessage(list);
    let reminder;
    try { reminder = await prisma.memberReminder.create({ data: { ...scope, memberId, reminderDate: new Date(`${today}T00:00:00Z`), outstanding: total, deliveredCount: 0, source: "automatic" } }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue; throw error; }
    let count = 0;
    try {
      count = (await notifyProjectMembers({ ...scope, memberIds: [memberId], type: "payment.reminder", title: `Payment reminder · ৳${total.toLocaleString("en-IN")}`, body, entityType: "member", entityId: memberId, push: { androidChannelId: "payment-reminders-v1", sound: "payment_reminder", highPriority: true } })).count;
    } catch (error) { console.error("[payment-reminders] delivery failed", error); }
    await prisma.memberReminder.update({ where: { id: reminder.id }, data: { deliveredCount: count } });
    delivered++;
  }
  if (delivered) await writeAudit({ tenantId: scope.tenantId, projectId: scope.projectId, actorUserId: null, action: "payment_reminders.sent", entityType: "project", entityId: scope.projectId, after: { date: today, members: delivered } });
  return delivered;
}
