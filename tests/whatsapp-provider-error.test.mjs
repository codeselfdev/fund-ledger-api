import test from 'node:test';
import assert from 'node:assert/strict';
import { whatsappProviderFailure, checkWhatsAppGroupsAccess } from '../dist/core/whatsapp/whatsapp-provider-error.js';

test('Meta failures map to fixed customer messages and safe support references', () => {
  for (const [status, error, category] of [
    [400, { code: 190, error_subcode: 463 }, 'credentials'],
    [403, { code: 200 }, 'permissions'],
    [400, { code: 100, message: 'Phone number is not eligible for groups' }, 'groups_access'],
    [429, { code: 4 }, 'rate_limit'],
    [400, { code: 100 }, 'request'],
    [500, {}, 'provider'],
  ]) {
    const failure = whatsappProviderFailure(status, { error });
    assert.equal(failure.category, category); assert.match(failure.customer_message, /WA-/);
  }
});
test('provider strings, trace IDs and malformed code fields cannot leak into output', () => {
  const secret = 'sensitive-provider-controlled-data';
  const result = whatsappProviderFailure(400, { error: { code: secret, error_subcode: secret, message: secret, fbtrace_id: secret, error_data: { details: secret } } });
  assert.equal(result.code, null); assert.equal(result.subcode, null);
  assert.ok(!JSON.stringify(result).includes(secret));
  for (const payload of [null, [], 'bad', { error: null }]) assert.doesNotThrow(() => whatsappProviderFailure(403, payload));
});
test('provider check reads groups without returning group data or making a creation request', async () => {
  const config = { phone: 'test-phone', token: 'secret-token', version: 'v23.0' };
  const result = await checkWhatsAppGroupsAccess(config, async (url, options) => {
    assert.equal(url, 'https://graph.facebook.com/v23.0/test-phone/groups?limit=1');
    assert.equal(options.method, undefined); assert.equal(options.headers.Authorization, 'Bearer secret-token');
    return Response.json({ data: { groups: [{ id: 'private-group', subject: 'private-subject' }] } });
  });
  assert.deepEqual(result, { accessible: true, http_status: 200 });
  assert.equal((await checkWhatsAppGroupsAccess(config, async () => Response.json({ error: { code: 190 } }, { status: 400 }))).category, 'credentials');
  assert.equal((await checkWhatsAppGroupsAccess(config, async () => { throw Error('network secret-token'); })).category, 'network');
  assert.equal((await checkWhatsAppGroupsAccess(config, async () => Response.json({}))).category, 'unexpected_response');
});
