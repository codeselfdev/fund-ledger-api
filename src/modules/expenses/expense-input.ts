import { z } from "zod";
import { ExpenseCategory } from "@prisma/client";

export function dhakaToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function toExpenseDate(value?: string, now = new Date()) {
  return new Date(`${value ?? dhakaToday(now)}T00:00:00Z`);
}

export const expenseBodySchema = z.object({
  title: z.string().min(2),
  amount: z.number().int().positive(),
  category: z.nativeEnum(ExpenseCategory).optional(),
  category_def_id: z.string().min(1).optional(),
  vendor: z.string().optional(),
  vendor_id: z.string().min(1).optional(),
  vendor_phone: z.string().trim().regex(/^\+?[\d\s().-]+$/, "Enter a valid vendor mobile number")
    .transform(value => value.replace(/[\s().-]/g, ""))
    .refine(value => /^\+?\d{6,15}$/.test(value), "Enter a valid vendor mobile number").nullable().optional(),
  expense_date: z.string().refine(isCalendarDate, "Use a valid YYYY-MM-DD expense date")
    .refine(value => value <= dhakaToday(), "Expense date cannot be in the future").optional(),
  account_id: z.string().min(1),
  doc_file_id: z.string().optional()
}).refine(value => value.category != null || value.category_def_id != null, {
  message: "category or category_def_id is required", path: ["category"]
});
