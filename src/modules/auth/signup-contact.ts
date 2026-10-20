import type { Prisma } from "@prisma/client";
import { conflict } from "../../core/http/api-error.js";
import { prisma } from "../../core/prisma/client.js";
import { canonicalMobile, mobileLookupValues, mobilesEquivalent } from "./auth.service.js";

export const signupMobile = canonicalMobile;
export async function assertSignupMobileAvailable(mobile: string, db: Pick<Prisma.TransactionClient, "user"> = prisma) {
  const candidates = await db.user.findMany({ where: { OR: [
    { mobile: { in: mobileLookupValues(mobile) } },
    { mobile: { endsWith: mobile.replace(/\D/g, "").slice(-10) } }
  ] }, select: { mobile: true } });
  if (candidates.some(user => mobilesEquivalent(user.mobile, mobile))) {
    throw conflict("This mobile already has a FundLedger login. Sign in instead.", { owner_mobile: "This mobile is already registered." });
  }
}
