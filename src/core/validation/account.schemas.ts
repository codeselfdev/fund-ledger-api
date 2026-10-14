import { z } from "zod";

const accountFields = {
  is_default: z.boolean().optional(),
  opening_balance: z.number().int().min(0).max(2_147_483_647).optional()
};
const accountLabel = z.string().trim().min(2, "Account label needs at least 2 characters").max(64);

// Cash ignores bank-only fields; bank details are mandatory for every new bank account.
export const accountSetupInputSchema = z.discriminatedUnion("type", [
  z.object({ ...accountFields, name: accountLabel, type: z.literal("cash") }),
  z.object({
    ...accountFields,
    name: accountLabel.optional(),
    type: z.literal("bank"),
    bank_name: z.string({ required_error: "Bank name is required" }).trim().min(2, "Bank name needs at least 2 characters").max(120),
    account_name: z.string({ required_error: "Account name is required" }).trim().min(2, "Account name needs at least 2 characters").max(120),
    account_number: z.string({ required_error: "Account number is required" }).trim().min(1, "Account number is required").max(64),
    branch_name: z.string({ required_error: "Branch name is required" }).trim().min(2, "Branch name needs at least 2 characters").max(120)
  })
]).transform(input => input.type === "bank"
  ? { ...input, name: input.name ?? `${input.bank_name} · ${input.branch_name}`.slice(0, 55) + ` · ${input.account_number.slice(-4)}` }
  : input);

export function accountBankData(input: z.infer<typeof accountSetupInputSchema>) {
  return input.type === "bank"
    ? { bankName: input.bank_name, accountName: input.account_name, accountNumber: input.account_number, branchName: input.branch_name }
    : { bankName: null, accountName: null, accountNumber: null, branchName: null };
}
