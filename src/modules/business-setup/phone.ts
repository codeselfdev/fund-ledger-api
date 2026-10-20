import { Prisma } from '@prisma/client';
/** Column is supplied from a static allowlist, never request text. Mirrors businessPhoneIdentity. */
export function phoneIdentitySql(column: 'mobile' | 'phone') {
  const cleaned = Prisma.sql`regexp_replace(${Prisma.raw(column)}, '[[:space:]().-]', '', 'g')`;
  const value = Prisma.sql`CASE WHEN ${cleaned} LIKE '00%' THEN '+' || substring(${cleaned} from 3) ELSE ${cleaned} END`;
  return Prisma.sql`CASE WHEN ${value} ~ '^01[0-9]{9}$' THEN '+88' || ${value} WHEN ${value} ~ '^1[0-9]{9}$' THEN '+880' || ${value} WHEN ${value} ~ '^8801[0-9]{9}$' THEN '+' || ${value} ELSE ${value} END`;
}
