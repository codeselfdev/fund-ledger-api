import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { prisma } from "../../core/prisma/client.js";
export async function customerDetails(tenantId: string, userId?: string | null) {
    const user = await tenantAccounts(prisma).findFirst({ where: { tenantId, ...(userId ? { id: userId } : { memberships: { some: { role: "owner" } } }) }, select: { id: true, name: true, mobile: true, email: true }, orderBy: { createdAt: "asc" } });
    if (!user)
        return null;
    const members = await prisma.member.findMany({ where: { tenantId, OR: [{ userId: user.id }, { mobile: user.mobile }] }, select: { id: true, mid: true, shares: true, status: true, project: { select: { id: true, name: true } } } });
    return { ...user, shares: members.filter(m => m.status === "active").reduce((sum, m) => sum + m.shares, 0), members };
}
