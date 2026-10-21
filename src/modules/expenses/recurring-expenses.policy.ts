import { z } from 'zod';
import { isCalendarDate } from './expense-input.js';
export const frequencies = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type Frequency = typeof frequencies[number];
export function stepDue(date: string, frequency: Frequency, day: number) {
  const value = new Date(`${date}T00:00:00Z`);
  if (frequency === 'weekly') value.setUTCDate(value.getUTCDate() + 7);
  else {
    value.setUTCDate(1);
    value.setUTCMonth(value.getUTCMonth() + ({ monthly: 1, quarterly: 3, yearly: 12 }[frequency]));
    value.setUTCDate(Math.min(day, new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate()));
  }
  return value.toISOString().slice(0, 10);
}
export const calendarDateSchema = z.string().refine(isCalendarDate, 'Choose a valid calendar date');
const money = z.number().int().positive().max(2147483647);
export const recurringBillSchema = z.object({
  preset: z.enum(['payroll', 'electricity', 'gas', 'water', 'internet', 'security', 'cleaner', 'sweeper', 'citycorp', 'rent', 'custom']),
  name: z.string().trim().min(2).max(160),
  vendor: z.string().trim().min(2).max(200),
  vendor_id: z.string().min(1).nullable().optional(),
  category_def_id: z.string().min(1),
  account_id: z.string().min(1),
  kind: z.enum(['fixed', 'variable']),
  amount: money,
  frequency: z.enum(frequencies),
  day: z.number().int().min(1).max(31),
  next_due: calendarDateSchema,
  mode: z.enum(['auto', 'remind']),
  remind_days: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(7)]),
  reference: z.string().trim().max(200).default(''),
  end_date: calendarDateSchema.nullable(),
  staff: z.array(z.object({ name: z.string().trim().min(1).max(160), amount: money })).max(200).default([]),
}).superRefine((bill, ctx) => {
  if (bill.kind === 'variable' && bill.mode === 'auto') ctx.addIssue({ code: 'custom', path: ['mode'], message: 'Variable bills must remind you to enter the actual amount' });
  if (bill.end_date && bill.end_date < bill.next_due) ctx.addIssue({ code: 'custom', path: ['end_date'], message: 'End date must be on or after the next due date' });
  if (bill.preset === 'payroll' && (!bill.staff.length || bill.kind !== 'fixed')) ctx.addIssue({ code: 'custom', path: ['staff'], message: 'Payroll needs at least one named salary and a fixed amount' });
  if (bill.preset !== 'payroll' && bill.staff.length) ctx.addIssue({ code: 'custom', path: ['staff'], message: 'Only payroll bills have staff salaries' });
  if (bill.staff.length && bill.staff.reduce((total, row) => total + row.amount, 0) !== bill.amount) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Amount must equal the total salaries' });
  if (bill.frequency !== 'weekly') {
    const actual = Number(bill.next_due.slice(8));
    const monthEnd = new Date(Date.UTC(Number(bill.next_due.slice(0, 4)), Number(bill.next_due.slice(5, 7)), 0)).getUTCDate();
    if (actual !== Math.min(bill.day, monthEnd)) ctx.addIssue({ code: 'custom', path: ['next_due'], message: 'The due date must match the selected day of the month' });
  }
});
export type RecurringBillInput = z.infer<typeof recurringBillSchema>;
