import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableCatalog, defaultPins, visiblePins } from '../dist/modules/shortcuts/shortcuts.policy.js';

test('payroll catalogue includes shared business tools and dedicated payroll tools', () => {
  const config = availableCatalog('payroll_pf', ['owner']);
  for (const key of ['accounts','income','expenses','assets','notices','polls','notifications','payroll_settings','payroll_import']) assert.ok(config.tools.some(t => t.key === key), key);
  assert.deepEqual(config.quick_add.map(t => t.key), ['payroll_add_bill','add_income','add_expense','add_notice']);
  assert.deepEqual(defaultPins('payroll_pf', ['owner']), ['payroll_employees','payroll_run','payroll_leave','payroll_bills','payroll_pf','accounts','expenses','income']);
});
test('payroll member metadata and old pins cannot expose private financial tools', () => {
  const config = availableCatalog('payroll_pf', ['member']);
  const keys = config.tools.map(t => t.key);
  assert.deepEqual(keys, ['payroll_run','payroll_leave','payroll_bills','payroll_pf']);
  assert.deepEqual(config.quick_add.map(t => t.key), ['payroll_apply_leave','payroll_add_bill']);
  assert.deepEqual(visiblePins(['accounts','income','expenses','ledger','payroll_run'], keys), ['payroll_run']);
  assert.deepEqual(defaultPins('payroll_pf', ['member'], {member_shortcuts: ['income']}), keys);
  assert.ok(!availableCatalog('fund_shares', ['owner']).tools.some(t => t.key.startsWith('payroll_')));
});
test('payroll staff defaults ignore legacy fund shortcuts and respect role restrictions', () => {
  for (const role of ['accountant','cashier','approver','auditor']) {
    const config = availableCatalog('payroll_pf', [role]);
    assert.ok(defaultPins('payroll_pf', [role], {accountant_shortcuts: ['members']}).includes('payroll_run'));
    for (const key of ['accounts','income','expenses','ledger']) assert.ok(config.tools.some(t => t.key === key), `${role}: ${key}`);
    for (const key of ['payroll_settings','payroll_import','roles','polls','notices']) assert.ok(!config.tools.some(t => t.key === key), `${role}: ${key}`);
  }
});
