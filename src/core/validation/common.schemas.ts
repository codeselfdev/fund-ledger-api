import { z } from "zod";

export const idParamSchema = z.object({
  id: z.string().min(1)
});

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25)
});

export const penaltyPolicySchema = z.object({
  enabled: z.boolean(),
  grace_months: z.number().int().min(0).max(2),
  onetime_percent: z.number().min(0).max(100).optional(),
  recurring_percent: z.number().min(0).max(100).optional(),
  recurring_period: z.enum(["weekly", "monthly"]).optional(),
  compounding: z.boolean().optional(),
  max_percent: z.number().min(0).max(100).optional()
}).superRefine((value, ctx) => {
  if (value.recurring_percent && !value.recurring_period) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recurring_period"],
      message: "recurring_period is required when recurring_percent is set"
    });
  }
});

export const optionalPenaltyPolicySchema = penaltyPolicySchema.optional();
