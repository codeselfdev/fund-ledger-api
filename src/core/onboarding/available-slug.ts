import { randomBytes } from 'node:crypto';
import { serviceUnavailable } from '../http/api-error.js';

export function isOrganizationSlugCollision(error: unknown): boolean {
  const failure = error as { code?: string; meta?: { target?: unknown; modelName?: string } } | null;
  if (failure?.code === 'SLUG_TAKEN') return true;
  if (failure?.code !== 'P2002' || (failure.meta?.modelName && failure.meta.modelName !== 'Tenant')) return false;
  const target = failure.meta?.target;
  return Array.isArray(target) ? target.length === 1 && target[0] === 'slug'
    : typeof target === 'string' && /(?:^|_)slug(?:_|$)/i.test(target);
}
/** Each callback must atomically create or roll back the organization before a retry. */
export async function withAvailableOrganizationSlug<T>(preferred: string, create: (slug: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = attempt < 3 ? String(attempt + 1) : randomBytes(4).toString('hex');
    const candidate = attempt === 0 ? preferred : `${preferred.slice(0, 47 - suffix.length).replace(/-+$/g, '')}-${suffix}`;
    try { return await create(candidate); }
    catch (error) { if (!isOrganizationSlugCollision(error)) throw error; }
  }
  throw serviceUnavailable('Could not finish creating your organization. Please try again.');
}
