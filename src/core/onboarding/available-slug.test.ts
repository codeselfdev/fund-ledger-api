import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOrganizationSlugCollision, withAvailableOrganizationSlug } from './available-slug.js';

test('keeps the requested slug when it is available', async () => {
 const tried: string[] = [];
 const result = await withAvailableOrganizationSlug('foundation', async slug => { tried.push(slug); return { slug }; });
 assert.deepEqual(tried, ['foundation']); assert.equal(result.slug, 'foundation');
});
test('automatically tries another slug for prechecked collisions and database races', async () => {
 const tried: string[] = [];
 const result = await withAvailableOrganizationSlug('foundation', async slug => {
  tried.push(slug);
  if (tried.length === 1) throw { code: 'SLUG_TAKEN' };
  if (tried.length === 2) throw { code: 'P2002', meta: { modelName: 'Tenant', target: ['slug'] } };
  return slug;
 });
 assert.deepEqual(tried, ['foundation', 'foundation-2', 'foundation-3']); assert.equal(result, 'foundation-3');
});
test('popular and maximum-length names use bounded random alternatives within 48 characters', async () => {
 const tried: string[] = [];
 const result = await withAvailableOrganizationSlug('a'.repeat(48), async slug => { tried.push(slug); if (tried.length < 4) throw { code: 'SLUG_TAKEN' }; return slug; });
 assert.match(result, /^a+-[0-9a-f]{8}$/); assert.ok(tried.every(slug => slug.length <= 48));
});
test('other failures are never retried, preventing accidental duplicate signups', async () => {
 for (const error of [{ code: 'EMAIL_TAKEN' }, { code: 'MOBILE_TAKEN' }, { code: 'P2002', meta: { modelName: 'User', target: ['tenant_id', 'mobile'] } }, { code: 'P2002', meta: { target: ['email'] } }, new Error('Connection lost')]) {
  let attempts = 0;
  await assert.rejects(withAvailableOrganizationSlug('foundation', async () => { attempts++; throw error; }), value => value === error);
  assert.equal(attempts, 1);
 }
});
test('database constraint detection recognizes slug keys but excludes other models', () => {
 assert.equal(isOrganizationSlugCollision({ code: 'P2002', meta: { target: 'tenants_slug_key' } }), true);
 assert.equal(isOrganizationSlugCollision({ code: 'P2002', meta: { modelName: 'Other', target: ['slug'] } }), false);
 assert.equal(isOrganizationSlugCollision({ code: 'P2002' }), false);
});
test('exhausted collisions produce a useful retry message instead of exposing slugs', async () => {
 let attempts = 0;
 await assert.rejects(withAvailableOrganizationSlug('foundation', async () => { attempts++; throw { code: 'SLUG_TAKEN' }; }), /Could not finish creating your organization/);
 assert.equal(attempts, 8);
});
