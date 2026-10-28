import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { z } from 'zod';
function harness({ access = true, projectType = 'fund_shares', existing = true } = {}) {
  const routes = {}, guards = [], queries = [], writes = [], audits = [];
  let stored = existing ? { incomeApprovalFlow:'accountant_only',expenseApprovalFlow:'accountant_and_approver',status:'completed',accountantUserId:'existing-accountant' } : null;
  const db = {
    projectMembership: { findFirst: async args => { queries.push(['access',args]); return access ? {} : null; } },
    project: { findFirst: async args => { queries.push(['project',args]); return { projectType }; } },
    onboardingProgress: {
      findUnique: async args => { queries.push(['progress',args]); return stored; },
      upsert: async args => { writes.push(args); stored = stored ? { ...stored,...args.update } : args.create; return stored; },
    },
    $transaction: async fn => fn(db),
  };
  const deps = {
    express: { Router: () => ({ use: fn => guards.push(fn), get: (path,...handlers) => routes.get = handlers, put: (path,...handlers) => routes.put = handlers }) },
    zod: { z }, '../../core/prisma/client.js': { prisma:db },
    '../../core/http/async-handler.js': { asyncHandler: fn => fn },
    '../../core/http/api-error.js': Object.fromEntries(['badRequest','forbidden','notFound'].map(name => [name, message => Error(name+': '+(message??''))])),
    '../../core/http/response.js': { ok: (_res,value) => value },
    '../../core/security/auth.context.js': { requireAuthContext: req => req.auth },
    '../../core/validation/validate.js': { validateBody: schema => req => schema.parse(req.body) },
    '../../core/audit/audit.service.js': { writeAudit: async (input, tx) => { assert.equal(tx,db);audits.push(input); } },
  };
  const mod={exports:{}};
  const code=ts.transpileModule(fs.readFileSync(new URL('../src/modules/projects/project-approval-flow.routes.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},mod,mod.exports);
  const req={auth:{tenantId:'tenant',userId:'admin'},params:{id:'project'},body:{income:'accountant_and_approver',expense:'accountant_only'}};
  const call=async method=>{for(const guard of guards)await guard(req,{},()=>{});for(const handler of routes[method].slice(0,-1))await handler(req,{});return routes[method].at(-1)(req,{});};
  return{call,req,queries,writes,audits,get stored(){return stored;},schema:mod.exports.approvalFlowSchema};
}
test('admin reads and changes organization rules through the selected project without restarting onboarding',async()=>{
  const h=harness();assert.equal((await h.call('get')).scope,'organization');await h.call('put');
  assert.deepEqual(h.writes[0].update,{incomeApprovalFlow:'accountant_and_approver',expenseApprovalFlow:'accountant_only'});
  assert.equal(h.stored.status,'completed');assert.equal(h.stored.accountantUserId,'existing-accountant');
  assert.equal(h.audits[0].actorUserId,'admin');assert.equal(h.audits[0].tenantId,'tenant');assert.equal(h.audits[0].after.scope,'organization');
  const access=h.queries.find(q=>q[0]==='access')[1].where;
  assert.deepEqual(access,{tenantId:'tenant',projectId:'project',userId:'admin',isActive:true,role:{in:['owner','admin']}});
});
test('members, accountants, inactive admins and cross-project or cross-tenant callers cannot read or change rules',async()=>{
  for(const method of ['get','put']){const h=harness({access:false});await assert.rejects(h.call(method),/forbidden/);assert.equal(h.writes.length,0);assert.equal(h.queries.some(q=>q[0]==='progress'),false);}
});
test('invalid flow values, extra keys and non-fund projects are rejected without writes',async()=>{
  const h=harness();for(const body of [{income:'invalid',expense:'accountant_only'},{income:'accountant_only'},{...h.req.body,tenant_id:'other'}])assert.equal(h.schema.safeParse(body).success,false);
  const business=harness({projectType:'accounting'});await assert.rejects(business.call('put'),/Fund/);assert.equal(business.writes.length,0);
});
test('legacy organizations without tracked onboarding can save rules without creating a required setup',async()=>{
  const h=harness({existing:false});assert.deepEqual(await h.call('get'),{scope:'organization',income:'accountant_only',expense:'accountant_and_approver'});
  await h.call('put');assert.equal(h.stored.status,'completed');assert.equal(h.stored.projectId,'project');
});
