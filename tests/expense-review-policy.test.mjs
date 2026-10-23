import test from 'node:test';
import assert from 'node:assert/strict';
import { canReviewExpense } from '../dist/modules/expenses/expense-review-policy.js';
test('expense approval preserves both configured routes and owner/admin authority',()=>{
 for(const flow of ['accountant_only','accountant_and_approver']){
  for(const role of ['owner','admin'])assert.equal(canReviewExpense([role],flow),true);
  for(const role of ['member','cashier','auditor'])assert.equal(canReviewExpense([role],flow),false);
  assert.equal(canReviewExpense(['accountant'],flow),flow==='accountant_only');
  assert.equal(canReviewExpense(['approver'],flow),flow==='accountant_and_approver');
 }
 assert.equal(canReviewExpense([], 'accountant_and_approver'),false);
});
