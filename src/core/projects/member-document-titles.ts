import type { Prisma } from "@prisma/client";
import { nanoid } from "nanoid";

export const DEFAULT_MEMBER_DOCUMENT_TITLES = [
  "Identity card",
  "Business card",
  "Address proof",
  "Legal document",
  "Property document",
  "Passport"
] as const;

/** Titles belong to the organization. A configured list, including an empty one, is preserved. */
export function withDefaultMemberDocumentTitles(contact: unknown, projectType: string): Prisma.InputJsonObject {
  const base = contact && typeof contact === "object" && !Array.isArray(contact)
    ? contact as Prisma.InputJsonObject : {};
  if (projectType !== "fund_shares" || Object.prototype.hasOwnProperty.call(base, "member_document_titles")) return base;
  const now = new Date().toISOString();
  return {
    ...base,
    member_document_titles: DEFAULT_MEMBER_DOCUMENT_TITLES.map(title => ({
      id: nanoid(), title, is_active: true, created_at: now, updated_at: now
    }))
  };
}

export async function seedMemberDocumentTitles(tx: Prisma.TransactionClient, tenantId: string, projectType: string) {
  if (projectType !== "fund_shares") return;
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId }, select: { contact: true, updatedAt: true }
  });
  const contact = withDefaultMemberDocumentTitles(tenant.contact, projectType);
  if (contact === tenant.contact) return;
  // A concurrent settings edit must roll back project creation rather than overwrite contact data.
  await tx.tenant.update({
    where: { id: tenantId, updatedAt: tenant.updatedAt }, data: { contact }
  });
}
