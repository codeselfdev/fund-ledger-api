import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { whatsappConfigurationDiagnostics, managedWhatsAppConfiguration, logWhatsAppConfiguration } from '../dist/core/whatsapp/whatsapp.configuration.js';
const configured = () => ({
  WHATSAPP_ENABLED: 'true', WHATSAPP_GROUPS_ENABLED: 'true', WHATSAPP_WABA_ID: 'business-id', WHATSAPP_PHONE_NUMBER_ID: 'phone-id',
  WHATSAPP_APP_SECRET: 'private-app-secret', WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'private-verify-token', WHATSAPP_CREDENTIALS_KEY: 'private-encryption-key',
  WHATSAPP_ACCESS_TOKEN: 'private-access-token-which-is-long-enough', WHATSAPP_GRAPH_API_VERSION: 'v23.0', AI_SERVICE_URL: 'http://127.0.0.1:4010', AI_SERVICE_SHARED_SECRET: 'private-shared-secret-at-least-thirty-two',
});
test('the operator check and creation gate agree for every required runtime setting', () => {
  const complete = configured();
  assert.equal(whatsappConfigurationDiagnostics(complete).ready, true);
  assert.ok(managedWhatsAppConfiguration(complete));
  for (const name of Object.keys(complete).filter(name => name !== 'WHATSAPP_GRAPH_API_VERSION')) {
    const incomplete = { ...complete }; delete incomplete[name];
    const result = whatsappConfigurationDiagnostics(incomplete);
    assert.equal(result.ready, false, name);
    assert.deepEqual(result.checks.filter(check => !check.ok).map(check => check.name), [name]);
    assert.equal(managedWhatsAppConfiguration(incomplete), null);
  }
});
test('configuration defaults the API version and rejects invalid values and disabled flags', () => {
  const source = configured();
  delete source.WHATSAPP_GRAPH_API_VERSION;
  assert.equal(managedWhatsAppConfiguration(source).version, 'v23.0');
  for (const [name, invalid] of [['WHATSAPP_ACCESS_TOKEN', 'short'], ['AI_SERVICE_SHARED_SECRET', 'short'], ['WHATSAPP_GRAPH_API_VERSION', '23.0'], ['WHATSAPP_GRAPH_API_VERSION', ''], ['WHATSAPP_GROUPS_ENABLED', 'false'], ['WHATSAPP_ENABLED', 'TRUE']]) {
    const result = whatsappConfigurationDiagnostics({ ...source, [name]: invalid });
    assert.equal(result.ready, false); assert.ok(result.checks.some(check => check.name === name && !check.ok));
  }
});
test('diagnostic output and startup warnings never contain secret values', () => {
  const source = configured(), output = [], original = console.warn;
  source.WHATSAPP_GROUPS_ENABLED = 'false';
  console.warn = message => output.push(message);
  try { logWhatsAppConfiguration(source); } finally { console.warn = original; }
  const serialized = JSON.stringify(whatsappConfigurationDiagnostics(source)) + output.join('\n');
  for (const [name, secret] of Object.entries(source).filter(([name]) => /TOKEN|SECRET|KEY$/.test(name))) assert.ok(!serialized.includes(secret), name);
  assert.match(output[0], /WHATSAPP_GROUPS_ENABLED/); assert.match(output[0], /runtime/);
});
test('container diagnostic CLI succeeds without a database and does not echo credentials', () => {
  const source = configured();
  const run = spawnSync(process.execPath, [new URL('../scripts/check-whatsapp.mjs', import.meta.url).pathname, '--json'], { env: { ...process.env, ...source }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(run.stdout); assert.equal(data.ready, true);
  assert.ok(!run.stdout.includes(source.WHATSAPP_ACCESS_TOKEN)); assert.ok(!run.stdout.includes(source.AI_SERVICE_SHARED_SECRET));
});
