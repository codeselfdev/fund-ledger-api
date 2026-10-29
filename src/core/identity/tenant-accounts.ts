import type { Prisma, PrismaClient, TenantUser, User, Tenant, ProjectMembership, Project, Member, ProjectRole } from '@prisma/client';
import { conflict, notFound } from '../http/api-error.js';

/** An organization account projection. Its id is a tenant_users id; userId is global. */
export type TenantAccount = TenantUser & Omit<User, 'id' | 'isActive' | 'mobile' | 'createdAt' | 'updatedAt' | 'passwordHash'> & {
  mobile: string;
  tenant: Tenant & {subscription: import("@prisma/client").TenantSubscription | null};
  memberships: (ProjectMembership & { project: Project; member: Member | null; customRole: ProjectRole | null })[];
};
type Db = Prisma.TransactionClient | PrismaClient;
type Args = Record<string, any>;
const identityFields = new Set(['name', 'email', 'mobile', 'passwordHash', 'emailVerifiedAt', 'mobileVerifiedAt']);
export function normalizedEmail(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}
export function normalizedMobile(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || /^[ge]:/.test(value)) return null;
  const raw = value.trim(), digits = raw.replace(/\D/g, '');
  const mobile = /^01\d{9}$/.test(digits) ? `+880${digits.slice(1)}` : /^1\d{9}$/.test(digits) ? `+880${digits}` : raw.startsWith('00') ? `+${digits.slice(2)}` : `+${digits}`;
  if (!/^[+0-9().\s-]+$/.test(raw) || !/^\+[1-9]\d{6,14}$/.test(mobile)) throw conflict('Enter a valid international mobile number.');
  return mobile;
}
function where(input: Args = {}): Args {
  const out: Args = {}, global: Args = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (['AND','OR','NOT'].includes(key)) out[key] = Array.isArray(value) ? value.map(where) : where(value);
    else if (key === 'tenantId_mobile') Object.assign(out, where({ tenantId: value.tenantId, mobile: normalizedMobile(value.mobile) }));
    else if (identityFields.has(key)) {
      const normalize = key === 'mobile' ? normalizedMobile : key === 'email' ? normalizedEmail : null;
      global[key] = normalize && typeof value === 'string' ? normalize(value) : normalize && value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([operator,operand]) => [operator,
          ['equals','not'].includes(operator) && typeof operand === 'string' ? normalize(operand) :
          ['in','notIn'].includes(operator) && Array.isArray(operand) ? [...new Set(operand.map(normalize).filter(item=>item!==null))] : operand])) : value;
    }
    else out[key] = value;
  }
  if (input.isActive === true) global.isActive = true;
  if (Object.keys(global).length) out.identity = { ...out.identity, ...global };
  return out;
}
function selection(input: Args = {}): Args {
  const out: Args = {}, identity: Args = { id: true, isActive: true };
  for (const [key, value] of Object.entries(input)) {
    if (identityFields.has(key)) identity[key] = value;
    else out[key] = value;
  }
  return { ...out, id: true, tenantId: true, userId: true, isActive: true, identity: { select: identity } };
}
export function accountProjection(row: any): TenantAccount | null {
  if (!row) return null;
  const { identity, ...local } = row;
  if (!identity) throw new Error("Organization account projection requires its global identity");
  const { passwordHash: _password, ...profile } = identity;
  return { ...profile, ...local, mobile: identity.mobile ?? '',
    isActive: Boolean(local.isActive && identity?.isActive) };
}
/** Explicit repository keeps organization IDs stable while identity data lives only in users. */
export function tenantAccounts(db: Db) {
  const readArgs = (args: Args = {}): any => {
    const { select, include, ...rest } = args;
    const orderBy = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]).map((order: Args) => Object.fromEntries(Object.entries(order).map(([key,value]) => identityFields.has(key) ? ['identity',{[key]:value}] : [key,value]))) : undefined;
    return { ...rest, ...(orderBy ? {orderBy} : {}), where: where(args.where), ...(select ? { select: selection(select) } : { include: { ...include, identity: true } }) };
  };
  const findMany = async (args: Args = {}): Promise<TenantAccount[]> => (await db.tenantUser.findMany(readArgs(args))).map(row => accountProjection(row)!);
  const findFirst = async (args: Args): Promise<TenantAccount | null> => accountProjection(await db.tenantUser.findFirst(readArgs(args)));
  const findFirstOrThrow = async (args: Args): Promise<TenantAccount> => { const row = await findFirst(args); if (!row) throw notFound('Organization account not found'); return row; };
  const create = async (args: Args): Promise<TenantAccount> => {
    const run = async (tx: Prisma.TransactionClient) => {
      const data = { ...args.data };
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${data.tenantId} FOR NO KEY UPDATE`;
      const email = normalizedEmail(data.email), mobile = normalizedMobile(data.mobile);
      const explicit = data.userId;
      let identity = explicit ? await tx.user.findUniqueOrThrow({ where: { id: explicit } }) : null;
      if (!identity) {
        if (!email && !mobile) throw conflict('A user must have an email or mobile number.');
        // Serialize canonical contact acquisition before creating identity or membership.
        for (const key of [email && `email:${email}`, mobile && `mobile:${mobile}`].filter(Boolean).sort())
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
        const existing = await tx.user.findMany({ where: { OR: [...(email ? [{ email }] : []), ...(mobile ? [{ mobile }] : [])] } });
        if (existing.length > 1) throw conflict('Email and mobile belong to different users. Verify the correct account before linking.');
        identity = existing[0] ?? null;
        if (identity && ((email && identity.email !== email) || (mobile && identity.mobile !== mobile)))
          throw conflict('These contact details conflict with an existing user. Verify the account before changing login contacts.');
        if (!identity) identity = await tx.user.create({ data: { ...(data.id ? { id: data.id } : {}), name: data.name, email, mobile, passwordHash: data.passwordHash } });
      }
      if (!identity.isActive) throw conflict('This user account is suspended.');
      for (const key of [...identityFields]) delete data[key];
      data.userId = identity.id;
      const { where: _where, ...projection } = readArgs(args);
      const row = await tx.tenantUser.create({ ...projection, data: data as Prisma.TenantUserUncheckedCreateInput });
      return accountProjection(row)!;
    };
    return '$transaction' in db ? db.$transaction(run) : run(db);
  };
  const update = async (args: Args): Promise<TenantAccount> => {
    if (!Object.keys(args.data).some(key=>identityFields.has(key)||key==='userId'))
      return accountProjection(await db.tenantUser.update({...readArgs(args),where:where(args.where),data:args.data}))!;
    const run = async (tx: Prisma.TransactionClient) => {
      const account = await tenantAccounts(tx).findFirstOrThrow({ where: args.where });
      const data = { ...args.data };
      for (const key of identityFields) {
        if (data[key] === undefined) continue;
        // Organization profile names belong to Member; global identity is user-managed.
        if (key === 'name') { delete data[key]; continue; }
        const normalized = key === 'email' ? normalizedEmail(data[key]) : key === 'mobile' ? normalizedMobile(data[key]) : data[key];
        if (normalized !== (account as any)[key]) throw conflict('Login identity changes require verified account settings. Update organization contact details on the member record.');
        delete data[key];
      }
      if ('userId' in data && data.userId !== account.userId) throw conflict('Account identities cannot be reassigned.');
      const row = await tx.tenantUser.update({ ...readArgs(args), where: { id: account.id }, data });
      return accountProjection(row)!;
    };
    return '$transaction' in db ? db.$transaction(run) : run(db);
  };
  return {
    findMany, findFirst, findFirstOrThrow, findUnique: findFirst, findUniqueOrThrow: findFirstOrThrow, create, update,
    count: (args: Args = {}) => db.tenantUser.count({ ...args, where: where(args.where) }),
    groupBy: (args: Args): Promise<Array<{ tenantId: string; _max: { lastActiveAt: Date | null }; _count: number }>> => (db.tenantUser.groupBy as any)({ ...args, where: where(args.where) }),
    upsert: async (args: Args) => {
      const run = async (tx: Prisma.TransactionClient) => {
        const tenantId = args.where.tenantId_mobile?.tenantId ?? args.create.tenantId;
        await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR NO KEY UPDATE`;
        const repo = tenantAccounts(tx), row = await repo.findFirst({ where: args.where });
        return row ? repo.update({ where: { id: row.id }, data: args.update, select: args.select, include: args.include }) : repo.create({ data: args.create, select: args.select, include: args.include });
      };
      return '$transaction' in db ? db.$transaction(run) : run(db);
    },
    updateMany: async (args: Args) => {
      if (Object.keys(args.data).some(key => identityFields.has(key) || key === 'userId')) throw conflict('Update identities individually through verified account settings.');
      return db.tenantUser.updateMany({ data: args.data, where: where(args.where) });
    },
    delete: async (args: Args) => {
      const row = await findFirstOrThrow(args);
      await db.tenantUser.delete({ where: { id: row.id } });
      return row;
    },
    deleteMany: (args: Args) => db.tenantUser.deleteMany({ ...args, where: where(args.where) }),
  };
}
