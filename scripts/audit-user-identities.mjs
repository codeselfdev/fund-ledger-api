/** Read-only preflight for the global identity migration. Reports IDs, never secrets. */
import { pathToFileURL } from 'node:url';
export const emailKey = value => typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
export function mobileKey(value) {
 if (!value || !value.trim() || /^[ge]:/.test(value)) return null;
 const raw=value.trim(),digits=raw.replace(/\D/g,'');
 return /^01\d{9}$/.test(digits)?`+880${digits.slice(1)}`:/^1\d{9}$/.test(digits)?`+880${digits}`:raw.startsWith('00')?`+${digits.slice(2)}`:`+${digits}`;
}
export function analyzeLegacyUsers(rows) {
 const byId=new Map(rows.map(row=>[row.id,row])),issues=[],roots=rows.filter(row=>!row.identity_root_id),scopes=new Map();
 for(const row of rows){
  const root=row.identity_root_id?byId.get(row.identity_root_id):row;
  if(!root||root.identity_root_id){issues.push({type:'invalid_identity_link',account_ids:[row.id]});continue;}
  const scope=JSON.stringify([row.tenant_id,root.id]);
  if(scopes.has(scope))issues.push({type:'duplicate_tenant_membership',account_ids:[scopes.get(scope),row.id]});else scopes.set(scope,row.id);
  if(root!==row&&((emailKey(row.email)&&emailKey(row.email)!==emailKey(root.email))||(mobileKey(row.mobile)&&mobileKey(row.mobile)!==mobileKey(root.mobile))||(row.password_hash&&row.password_hash!==root.password_hash)))issues.push({type:'linked_contact_or_credential_conflict',account_ids:[root.id,row.id]});
 }
 for(const key of ['email','mobile']){
  const groups=new Map();for(const root of roots){const value=key==='email'?emailKey(root.email):mobileKey(root.mobile);if(value)groups.set(value,[...(groups.get(value)??[]),root.id]);}
  for(const ids of groups.values())if(ids.length>1)issues.push({type:`duplicate_${key}`,account_ids:ids});
 }
 for(const row of roots){const mobile=mobileKey(row.mobile);if((!mobile&&!emailKey(row.email))||(mobile&&!/^\+[1-9]\d{6,14}$/.test(mobile)))issues.push({type:'invalid_or_missing_login_contact',account_ids:[row.id]});}
 return {account_count:rows.length,global_user_count:roots.length,ready:issues.length===0,issues};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 await import('dotenv/config');const {PrismaClient}=await import('@prisma/client'),db=new PrismaClient();
 try{
  const rows=await db.$transaction(async tx=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');return tx.$queryRawUnsafe('SELECT id,tenant_id,identity_root_id,email,mobile,password_hash FROM users ORDER BY id');});
  const report=analyzeLegacyUsers(rows);console.log(JSON.stringify(report,null,2));if(!report.ready)process.exitCode=2;
 }finally{await db.$disconnect();}
}
