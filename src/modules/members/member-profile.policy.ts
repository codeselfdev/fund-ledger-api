import { z } from "zod";
import { forbidden } from "../../core/http/api-error.js";
const text = (max = 250) => z.string().trim().max(max).nullable().optional();
export const profilePatchSchema = z.object({
  mobile: z.string().trim().min(6).max(30).optional(),
  name: z.string().trim().min(2).max(120).optional(),
  email: z.union([z.string().trim().email(), z.literal("")]).nullable().optional().transform(v => v === "" ? null : v),
  address: text(1000), father_name: text(), date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v && Date.parse(v) <= Date.now(), "Enter a valid past birth date").nullable().optional(),
  nid: text(80), occupation: text(), permanent_address: text(1000),
  nominee_name: text(), nominee_relation: text(80), nominee_mobile: text(30), nominee_nid: text(80),
  nominee_share_percent: z.number().min(0).max(100).nullable().optional()
}).strict().refine(body => Object.values(body).some(v => v !== undefined), "Provide at least one field");
export function assertProfileEditAllowed(auth: { memberId: string | null; roles: string[] }, id: string, body?: z.infer<typeof profilePatchSchema>) {
  const admin = auth.roles.some(role => role === "owner" || role === "admin");
  if (!admin && auth.memberId !== id) throw forbidden("You can only edit your own member profile");
  if (!admin && body && ["name", "mobile", "father_name", "date_of_birth", "nid"].some(key => (body as Record<string, unknown>)[key] !== undefined)) {
    throw forbidden("Identity fields can only be changed by an admin");
  }
}
