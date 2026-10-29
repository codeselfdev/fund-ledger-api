import test from 'node:test';import assert from 'node:assert/strict';
import {analyzeLegacyUsers,mobileKey} from '../scripts/audit-user-identities.mjs';
const row=(id,tenant_id,email,mobile,identity_root_id=null)=>({id,tenant_id,email,mobile,identity_root_id,password_hash:null});
test('explicit identity groups migrate without merging independent contacts',()=>{
 const root=row('a','org1','Owner@EXAMPLE.test','01711000001'),linked=row('b','org2','owner@example.test','+8801711000001','a');
 assert.deepEqual(analyzeLegacyUsers([root,linked]),{account_count:2,global_user_count:1,ready:true,issues:[]});
 assert.equal(analyzeLegacyUsers([root,{...linked,identity_root_id:null}]).ready,false);
});
test('email-only users have no synthetic mobile, and canonical phone formats collide',()=>{
 assert.equal(mobileKey('g:google-subject'),null);assert.equal(mobileKey('008801711000001'),'+8801711000001');
 assert.equal(analyzeLegacyUsers([row('a','x','a@example.test','g:abc')]).ready,true);
 const report=analyzeLegacyUsers([row('a','x','a@example.test','01711000001'),row('b','y','b@example.test','+8801711000001')]);
 assert.deepEqual(report.issues,[{type:'duplicate_mobile',account_ids:['a','b']}]);
});
test('conflicting linked contacts, nested links and duplicate tenant memberships block migration',()=>{
 const a=row('a','x','a@example.test','01711000001'),b=row('b','x','other@example.test','01711000002','a'),c=row('c','z',null,'01711000003','b');
 const types=analyzeLegacyUsers([a,b,c]).issues.map(i=>i.type);
 for(const type of ['duplicate_tenant_membership','linked_contact_or_credential_conflict','invalid_identity_link'])assert.ok(types.includes(type));
});
