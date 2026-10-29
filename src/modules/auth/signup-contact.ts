import type { Prisma } from "@prisma/client";
import { conflict } from "../../core/http/api-error.js";
import { prisma } from "../../core/prisma/client.js";
import { canonicalMobile } from "./auth.service.js";
import { normalizedMobile } from "../../core/identity/tenant-accounts.js";
export const signupMobile = canonicalMobile;
export async function assertSignupMobileAvailable(mobile: string, db: Prisma.TransactionClient = prisma) {
 const key=normalizedMobile(mobile);
 if(key && await db.user.findUnique({where:{mobile:key},select:{id:true}}))
  throw conflict("This mobile already has a FundLedger login. Sign in instead.",{owner_mobile:"This mobile is already registered."});
}
