import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:55439/payroll_test';
process.env.JWT_SECRET ??= 'disposable-payroll-tests';
const p = await import('../dist/modules/payroll/payroll.imports.policy.js');
const key = '6f1c2d7e-1111-4a2b-9c3d-123456789abc';
const employee = { id: 'e1', name: 'Sadia Rahman', advance: 2000 };
const row = patch => p.salaryImportRow.parse({ mobile: '01711482930', basic: 30000, house_rent: 15000, medical: 2500, transport: 2000, pf: 3000, company_pf: 3000, tax: 500, ...patch });
test('spreadsheet salary rows are recalculated, and a disagreeing net is rejected', () => {
  const ok = p.importedSalaryRow(employee, row({ bonus: 1000, advance: 1000, other_deduction: 200, net: 30000 + 15000 + 2500 + 2000 + 1000 - 3000 - 500 - 1000 - 200 }), { checkAdvance: true });
  assert.equal(ok.row.gross, 50500); assert.equal(ok.row.net, 45800); assert.equal(ok.row.source, 'spreadsheet'); assert.deepEqual(ok.row.billIds, []);
  assert.match(p.importedSalaryRow(employee, row({ net: 1 }), { checkAdvance: true }).issue, /does not match/);
  assert.match(p.importedSalaryRow(employee, row({ advance: 5000 }), { checkAdvance: true }).issue, /outstanding advance/);
  assert.equal(p.importedSalaryRow(employee, row({ advance: 5000 }), { checkAdvance: false }).issue, undefined);
  assert.match(p.importedSalaryRow(employee, row({ basic: 1000, house_rent: 0, medical: 0, transport: 0 }), { checkAdvance: true }).issue, /deductions exceed/);
});
test('import payloads normalize mobiles, reject duplicates, fractions and unknown columns', () => {
  assert.equal(row({ mobile: '+880 1711-482930' }).mobile, '01711482930');
  assert.throws(() => row({ basic: 10.5 })); assert.throws(() => row({ bonus_extra: 1 }));
  const rows = [{ mobile: '01711482930', basic: 1 }, { mobile: '8801711482930', basic: 1 }];
  assert.equal(p.runImportSchema.safeParse({ month: '2026-10', rows, request_key: key }).success, false);
  assert.equal(p.historyImportSchema.safeParse({ month: '2026-09', paid_on: '2026-08-30', rows: [rows[0]], request_key: key }).success, false);
  assert.equal(p.historyImportSchema.safeParse({ month: '2026-09', paid_on: '2026-10-02', rows: [rows[0]], request_key: key }).success, true);
});
test('opening balances check dates, leave allowances and PF membership', () => {
  const base = p.openingRow.parse({ name: 'Sadia', mobile: '01711482930', joining_date: '2021-01-01', basic: 32000, pf_member: true, pf_own: 50000, pf_company: 50000, annual_used: 5 });
  assert.deepEqual(p.openingIssues(base, '2026-09-30'), []);
  assert.match(p.openingIssues({ ...base, annual_used: 25 }, '2026-09-30')[0], /20-day/);
  assert.match(p.openingIssues({ ...base, pf_member: false }, '2026-09-30')[0], /not marked as a PF member/);
  assert.match(p.openingIssues({ ...base, joining_date: '2026-10-05' }, '2026-09-30')[0], /joined after/);
  assert.equal(p.spreadsheetRun({ source: 'spreadsheet' }), true); assert.equal(p.spreadsheetRun({ rate: 10 }), false);
});
