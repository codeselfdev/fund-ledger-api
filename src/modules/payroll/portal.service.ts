import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { PayrollEmployee } from '@prisma/client';
import { badRequest, conflict, forbidden } from '../../core/http/api-error.js';
import { financialTransaction } from '../accounting/transaction.js';
import { day, atDate, today, mobile, monthEnd } from './payroll.policy.js';
import { officeDistance, dhakaClock, isDayOff } from './attendance.policy.js';
import { access, allowed, scope, project, employee, ownEmployee, mutate, revision, audit, history, rebuild, attendanceConfig, type PayrollAuth, type Tx } from './payroll.service.js';
import { records, record, saveRecord, mapped, type PortalRecord } from './portal.store.js';
import { defaultTerms, effectiveEmployment, allocationIssue, type employeeCreateSchema, type profileSchema, type promotionSchema, type departmentSchema, type designationSchema, type officeProjectSchema, type taskCreateSchema, type taskStatusSchema, type splitSchema, type documentSchema, type documentActionSchema, type locationConsentSchema, type locationSchema } from './portal.policy.js';
import type { EmployeeProfile, Department, Designation, OfficeProject, EmployeeTask, WorkSplit, EmployeeDocument, EmployeeLocation, EmployeePortalSnapshot } from './portal.types.js';
type Auth = PayrollAuth & { builtinRoles?: readonly string[]; menuPermissions?: Record<string,{read:boolean;write:boolean}> };
export function portalGrant(a: Auth, key: string, write = false) {
  const builtin = a.builtinRoles ?? a.roles;
  if (builtin.some(r => r === 'owner' || r === 'admin')) return true;
  if (a.menuPermissions?.[key]?.[write ? 'write' : 'read']) return true;
  return !write && key !== 'payroll_location' && builtin.includes('auditor');
}
const manage = (a: Auth, key = 'payroll_employees') => allowed(portalGrant(a,key,true));
const baseline = (e: PayrollEmployee): EmployeeProfile => ({ id:e.id,employeeId:e.id,revision:0,employeeRevision:e.revision,email:'',nationalId:'',birthDate:null,bloodGroup:'',address:'',emergencyContact:'',bankAccount:'',reportsToId:null,departmentId:null,designationId:null,grade:0,workLocation:'office',terms:defaultTerms({ basic:e.basic,medical:e.medical,transport:e.transport,pfMember:e.pfMember }),promotions:[],history:[],locationRequired:false });
async function profile(tx: Tx,a:Auth,e:PayrollEmployee) { const r=await record<EmployeeProfile>(tx,a,'profile',e.id,false); return { r, value:r ? {...mapped(r),employeeRevision:e.revision} : baseline(e) }; }
async function activeReference(tx:Tx,a:Auth,id:string|null) { if(id) await employee(tx,a,id); }
async function jobReferences(tx:Tx,a:Auth,p:{reportsToId:string|null;departmentId:string|null;designationId:string|null},self?:string) {
  if(p.reportsToId===self) throw badRequest('An employee cannot report to themselves');
  await activeReference(tx,a,p.reportsToId);
  if(p.departmentId) await record<Department>(tx,a,'department',p.departmentId);
  if(p.designationId) { const d=(await record<Designation>(tx,a,'designation',p.designationId))!; if(d.data.departmentId!==p.departmentId) throw badRequest('Choose a designation from this department'); }
}
async function ensureOwn(tx:Tx,a:Auth,id:string,key:string,write=false) {
  if(portalGrant(a,key,write)) return;
  const own=await ownEmployee(tx,a); if(!own||own.id!==id||write&&own.status==='inactive') throw forbidden('This employee record is not available to your account');
}
async function noPaidChanges(tx:Tx,a:Auth,from:string) {
  if(await tx.payrollRun.findFirst({where:{...scope(a),status:'paid',month:{gte:from.slice(0,7)}}})) throw conflict('This change affects paid payroll. Use an explicit later adjustment.');
}
export async function portalWorkspace(a:Auth):Promise<EmployeePortalSnapshot> {
  return financialTransaction(async tx=>{
    await project(tx,a); const role=access(a); allowed(role.staff||role.member||!!a.menuPermissions);
    const own=await ownEmployee(tx,a), all=await records<any>(tx,a), date=today();
    const permitted=(key:string)=>portalGrant(a,key), get=<T>(kind:string)=>all.filter(r=>r.kind===kind).map(r=>mapped(r)) as T[];
    const hr=permitted('payroll_employees');
    const builtinStaff=(a.builtinRoles??a.roles).some(r=>['owner','admin','accountant','approver','cashier','auditor'].includes(r));
    const employees=await tx.payrollEmployee.findMany({where:{...scope(a),...(hr||builtinStaff?{}:{id:own?.id??'__none__'})}});
    const profiles=employees.map(e=>{const r=all.find(r=>r.kind==='profile'&&r.record_key===e.id);return r&&(hr||e.id===own?.id)?{...mapped(r),employeeRevision:e.revision}:baseline(e);}) as EmployeeProfile[];
    const projects=get<OfficeProject>('office_project').filter(p=>permitted('payroll_projects')||p.team.some(t=>t.employeeId===own?.id)).map(p=>permitted('payroll_projects')?p:{...p,team:p.team.filter(t=>t.employeeId===own?.id)});
    const attendanceSettings=await attendanceConfig(tx,a), now=dhakaClock();
    const punches=await tx.payrollAttendance.findMany({where:{...scope(a),date:atDate(date)}});
    const canViewLocations=permitted('payroll_location');
    const locations=get<EmployeeLocation>('location').filter(l=>canViewLocations||l.employeeId===own?.id).map(l=>{
      const punch=punches.find(p=>p.employeeId===l.employeeId), off=!punch?.checkIn||!!punch.checkOut||now<attendanceSettings.shiftStart||now>=attendanceSettings.shiftEnd||isDayOff(date,attendanceSettings);
      const stale=!l.capturedAt||Date.now()-Date.parse(l.capturedAt)>5*60000;
      const status=!l.consent?'paused':off?'off_shift':stale?'stale':l.status;
      return {...l,status, ...(['paused','off_shift','stale'].includes(status)?{latitude:null,longitude:null,accuracy:null}:{}), events:l.capturedAt?.startsWith(date)?l.events:[]};
    });
    // Exact positions expire after one day even if no more pings arrive.
    await tx.$executeRaw`UPDATE payroll_portal_records SET data=data||'{"latitude":null,"longitude":null,"accuracy":null,"events":[]}'::jsonb WHERE tenant_id=${a.tenantId} AND project_id=${a.projectId} AND kind='location' AND updated_at < CURRENT_TIMESTAMP - INTERVAL '1 day' AND data->>'latitude' IS NOT NULL`;
    return {today:date,profiles,departments:hr||permitted('payroll_org')?get<Department>('department'):[],designations:hr||permitted('payroll_org')?get<Designation>('designation'):[],projects,tasks:get<EmployeeTask>('task').filter(t=>permitted('payroll_tasks')||t.employeeId===own?.id),splits:get<WorkSplit>('work_split').filter(s=>(permitted('payroll_tasks')||s.employeeId===own?.id)&&s.date.startsWith(date.slice(0,7))),documents:get<EmployeeDocument>('document').filter(d=>permitted('payroll_documents')||d.employeeId===own?.id),locations:locations as EmployeeLocation[],canManage:portalGrant(a,'payroll_employees',true),canViewLocations};
  },30000);
}
export async function createPortalEmployee(a:Auth,b:z.infer<typeof employeeCreateSchema>) {
  manage(a); return mutate(a,'portal.employee.create',b,async tx=>{
    await jobReferences(tx,a,b);
    if(await tx.payrollEmployee.findFirst({where:{...scope(a),mobile:b.mobile}})) throw conflict('This mobile already belongs to an employee');
    const users=await tx.user.findMany({where:{tenantId:a.tenantId,isActive:true},select:{id:true,mobile:true}}), matches=users.filter(u=>mobile(u.mobile)===b.mobile);
    if(matches.length>1) throw conflict('Resolve duplicate accounts for this mobile first');
    const dept=b.departmentId?(await record<Department>(tx,a,'department',b.departmentId))!.data:null;
    const desig=b.designationId?(await record<Designation>(tx,a,'designation',b.designationId))!.data:null;
    if(!dept||!desig) throw badRequest('Choose a department and designation');
    if(!desig.types.includes(b.terms.type)) throw badRequest('This designation does not permit the employment type');
    if(b.terms.type==='permanent'&&(b.terms.basic<desig.minSalary||b.terms.basic>desig.maxSalary)) throw badRequest('Basic salary must be inside the designation band');
    if(b.terms.type==='contractual'&&b.terms.contractStart!<b.joiningDate) throw badRequest('Contract start cannot precede joining');
    const permanent=b.terms.type==='permanent';
    const e=await tx.payrollEmployee.create({data:{...scope(a),name:b.name,mobile:b.mobile,userId:matches[0]?.id,designation:desig.title,department:dept.name,joiningDate:atDate(b.joiningDate),basic:permanent?b.terms.basic:b.terms.type==='contractual'?b.terms.monthlyFee:0,medical:permanent?b.terms.medical:0,transport:permanent?b.terms.transport:0,pfMember:permanent&&b.terms.pfMember,status:permanent&&b.terms.probationMonths>0?'probation':'active',probationCompletedOn:permanent&&b.terms.probationMonths===0?atDate(b.joiningDate):null}});
    const value={...baseline(e),...Object.fromEntries(['email','nationalId','birthDate','bloodGroup','address','emergencyContact','bankAccount','reportsToId','departmentId','designationId','workLocation','locationRequired'].map(k=>[k,b[k as keyof typeof b]])),terms:b.terms,grade:desig.grade,history:await history(tx,a,'Employee added')};
    await saveRecord(tx,a,'profile',e.id,value,e.id);
    const projects=(await records<OfficeProject>(tx,a,'office_project')).map(mapped);
    for(const assignment of b.assignments) {
      const old=(await record<OfficeProject>(tx,a,'office_project',assignment.projectId))!;
      const p={...mapped(old),team:[...old.data.team,{employeeId:e.id,role:assignment.role,percent:assignment.percent}]};
      const issue=allocationIssue(p,projects); if(issue) throw conflict(issue);
      await saveRecord(tx,a,'office_project',p.id,p,null,old.revision);
      projects.splice(projects.findIndex(x=>x.id===p.id),1,p);
    }
    for(const title of b.requestedDocuments){const key=randomUUID();await saveRecord(tx,a,'document',key,{employeeId:e.id,title,category:'Employment',status:'requested',fileId:null,fileName:null,uploadedBy:null,acknowledgedAt:null},e.id);}
    await rebuild(tx,a,'Reprepared after employee added'); await audit(tx,a,'employee.created','payroll_employee',e.id,{employment_type:b.terms.type});
    return {id:e.id};
  });
}
export async function updateProfile(a:Auth,id:string,b:z.infer<typeof profileSchema>) {
  manage(a); return mutate(a,`portal.profile:${id}`,b,tx=>persistEmployeeProfile(tx,a,id,b));
}
export async function persistEmployeeProfile(tx:Tx,a:Auth,id:string,b:z.infer<typeof profileSchema>) {
    const e=await employee(tx,a,id),old=await profile(tx,a,e);revision(e.revision,b.employeeRevision);revision(old.r?.revision??0,b.revision);await jobReferences(tx,a,b,id);
    // Department/designation changes go through promotion so effective pay history stays coherent.
    if(old.value.designationId&&b.designationId!==old.value.designationId||old.value.departmentId&&b.departmentId!==old.value.departmentId) throw badRequest('Use Promote for a designation change; existing department history is retained');
    if(e.userId&&b.mobile!==e.mobile) throw badRequest('A linked sign-in mobile cannot be changed here');
    const fields={email:b.email,nationalId:b.nationalId,birthDate:b.birthDate,bloodGroup:b.bloodGroup,address:b.address,emergencyContact:b.emergencyContact,bankAccount:b.bankAccount,reportsToId:b.reportsToId,departmentId:b.departmentId,designationId:b.designationId,workLocation:b.workLocation,locationRequired:b.locationRequired};
    await tx.payrollEmployee.update({where:{id:e.id},data:{name:b.name,mobile:b.mobile,revision:{increment:1}}});
    const linkedDesignation=b.designationId?(await record<Designation>(tx,a,'designation',b.designationId))?.data:null;
    const value={...old.value,...fields,grade:old.value.designationId?old.value.grade:linkedDesignation?.grade??old.value.grade,history:await history(tx,a,'Profile updated',old.value.history)};
    await saveRecord(tx,a,'profile',id,value,id,old.r?.revision??null);await audit(tx,a,'profile.updated','payroll_employee',id,{fields:Object.keys(fields)});return {id};
}
export async function promoteEmployee(a:Auth,id:string,b:z.infer<typeof promotionSchema>) {
  manage(a);return mutate(a,`portal.promote:${id}`,b,async tx=>{
    const e=await employee(tx,a,id),old=await profile(tx,a,e);revision(e.revision,b.employeeRevision);revision(old.r?.revision??0,b.revision);
    if(old.value.terms.type!=='permanent') throw badRequest('Grade promotions currently apply to permanent employees');
    if(b.effectiveDate<today()||b.effectiveDate<day(e.joiningDate)) throw badRequest('Choose today or a future date on or after joining');
    await noPaidChanges(tx,a,b.effectiveDate);
    const d=(await record<Designation>(tx,a,'designation',b.designationId))!, current=effectiveEmployment(old.value,b.effectiveDate);
    if(d.data.departmentId!==old.value.departmentId||d.data.grade<=current.grade||b.basic<d.data.minSalary||b.basic>d.data.maxSalary||!d.data.types.includes('permanent')) throw badRequest('Choose a higher grade in this department and a salary inside its band');
    if(old.value.promotions.some(p=>p.effectiveDate>=b.effectiveDate)) throw conflict('A promotion already exists on or after this date');
    const promotion={id:randomUUID(),designationId:b.designationId,designation:d.data.title,grade:d.data.grade,basic:b.basic,effectiveDate:b.effectiveDate,reason:b.reason,actor:a.userId,at:new Date().toISOString()};
    await saveRecord(tx,a,'profile',id,{...old.value,promotions:[...old.value.promotions,promotion],history:await history(tx,a,'Promotion scheduled',old.value.history,`${d.data.title} · ${b.effectiveDate} · ${b.reason}`)},id,old.r?.revision??null);
    await tx.payrollEmployee.update({where:{id},data:{revision:{increment:1}}});await rebuild(tx,a,'Reprepared after effective promotion');await audit(tx,a,'employee.promoted','payroll_employee',id,promotion);return {id,promotion};
  });
}
export async function createDepartment(a:Auth,b:z.infer<typeof departmentSchema>) {manage(a,'payroll_org');return mutate(a,'portal.department.create',b,async tx=>{
  await activeReference(tx,a,b.headId);if(b.parentId)await record(tx,a,'department',b.parentId);const all=await records<Department>(tx,a,'department');if(all.some(r=>r.data.name.toLowerCase()===b.name.toLowerCase()||r.data.code.toLowerCase()===b.code.toLowerCase()))throw conflict('Department name or code already exists');const key=randomUUID(),{request_key,...value}=b;const result=mapped(await saveRecord(tx,a,'department',key,value));await audit(tx,a,'department.created','payroll_department',key,value);return result;
});}
export async function createDesignation(a:Auth,b:z.infer<typeof designationSchema>) {manage(a,'payroll_org');return mutate(a,'portal.designation.create',b,async tx=>{
  await record(tx,a,'department',b.departmentId);if(b.reportsToId){const parent=(await record<Designation>(tx,a,'designation',b.reportsToId))!;if(parent.data.departmentId!==b.departmentId||parent.data.grade<=b.grade)throw badRequest('Reports-to designation must be a higher grade in the same department');}
  if((await records<Designation>(tx,a,'designation')).some(r=>r.data.departmentId===b.departmentId&&r.data.title.toLowerCase()===b.title.toLowerCase()))throw conflict('Designation already exists in this department');const key=randomUUID(),{request_key,...value}=b;const result=mapped(await saveRecord(tx,a,'designation',key,value));await audit(tx,a,'designation.created','payroll_designation',key,value);return result;
});}
export async function saveProject(a:Auth,id:string|null,b:z.infer<typeof officeProjectSchema>) {manage(a,'payroll_projects');return mutate(a,`portal.project:${id??'create'}`,b,async tx=>{
  const old=id?await record<OfficeProject>(tx,a,'office_project',id):null;if(old)revision(old.revision,b.revision??-1);
  if(b.departmentId)await record(tx,a,'department',b.departmentId);await activeReference(tx,a,b.leadId);for(const t of b.team)await employee(tx,a,t.employeeId);
  const key=id??randomUUID(),{request_key,revision:ignored,...value}=b,p={...value,id:key,revision:old?.revision??0};const all=(await records<OfficeProject>(tx,a,'office_project')).map(mapped);
  if(all.some(x=>x.id!==key&&x.code.toLowerCase()===b.code.toLowerCase()))throw conflict('Project code already exists');const issue=allocationIssue(p,all);if(issue)throw conflict(issue);
  const result=mapped(await saveRecord(tx,a,'office_project',key,value,null,old?.revision??null));await audit(tx,a,'office_project.saved','payroll_office_project',key,{name:b.name,team:b.team});return result;
});}
export async function createTask(a:Auth,b:z.infer<typeof taskCreateSchema>){return mutate(a,'portal.task.create',b,async tx=>{
  await ensureOwn(tx,a,b.employeeId,'payroll_tasks',true);await employee(tx,a,b.employeeId);const p=(await record<OfficeProject>(tx,a,'office_project',b.projectId))!.data;if(p.status!=='active'||!p.team.some(t=>t.employeeId===b.employeeId))throw badRequest('Choose an active project assigned to this employee');const key=randomUUID(),at=new Date().toISOString(),{request_key,...value}=b;const result=mapped(await saveRecord(tx,a,'task',key,{...value,completedAt:b.status==='done'?at:null,createdAt:at},b.employeeId));await audit(tx,a,'task.created','payroll_task',key,{employeeId:b.employeeId});return result;
});}
export async function updateTask(a:Auth,id:string,b:z.infer<typeof taskStatusSchema>){return mutate(a,`portal.task:${id}`,b,async tx=>{
  const old=(await record<EmployeeTask>(tx,a,'task',id))!;await ensureOwn(tx,a,old.data.employeeId,'payroll_tasks',true);revision(old.revision,b.revision);const result=mapped(await saveRecord(tx,a,'task',id,{...old.data,status:b.status,completedAt:b.status==='done'?new Date().toISOString():null},old.data.employeeId,old.revision));await audit(tx,a,'task.status_changed','payroll_task',id,{status:b.status});return result;
});}
export async function confirmSplit(a:Auth,b:z.infer<typeof splitSchema>){return mutate(a,'portal.work_split',b,async tx=>{
  const own=await ownEmployee(tx,a);if(!own||own.status==='inactive'||b.date!==today())throw badRequest('Confirm today’s work for your active employee profile');
  const punch=await tx.payrollAttendance.findFirst({where:{...scope(a),employeeId:own.id,date:atDate(b.date)}});if(!punch?.checkIn||punch.checkOut)throw conflict('Check in before confirming today’s work; checked-out days are locked');
  const projects=(await records<OfficeProject>(tx,a,'office_project')).map(mapped);for(const row of b.allocations)if(!projects.some(p=>p.id===row.projectId&&p.status==='active'&&p.startDate<=b.date&&p.endDate>=b.date&&p.team.some(t=>t.employeeId===own.id)))throw forbidden('Work splits require current assigned projects');
  const key=`${own.id}:${b.date}`,old=await record<WorkSplit>(tx,a,'work_split',key,false);if((old?.revision??null)!==b.revision)throw conflict('Today’s split changed. Refresh first');return mapped(await saveRecord(tx,a,'work_split',key,{employeeId:own.id,date:b.date,allocations:b.allocations,confirmedAt:new Date().toISOString()},own.id,old?.revision??null));
});}
export async function requestDocument(a:Auth,b:z.infer<typeof documentSchema>){manage(a,'payroll_documents');return mutate(a,'portal.document.request',b,async tx=>{
  await employee(tx,a,b.employeeId);const key=randomUUID(),{request_key,...value}=b;return mapped(await saveRecord(tx,a,'document',key,{...value,status:'requested',fileId:null,fileName:null,uploadedBy:null,acknowledgedAt:null},b.employeeId));
});}
export async function actDocument(a:Auth,id:string,b:z.infer<typeof documentActionSchema>){return mutate(a,`portal.document:${id}:${b.action}`,b,async tx=>{
  const old=(await record<EmployeeDocument>(tx,a,'document',id))!;await ensureOwn(tx,a,old.data.employeeId,'payroll_documents',b.action!=='acknowledge');revision(old.revision,b.revision);const value={...old.data};
  if(b.action==='verify'){manage(a,'payroll_documents');if(value.status!=='uploaded'||!value.fileId)throw conflict('Upload a document before verifying it');value.status='verified';}
  if(b.action==='acknowledge'){const own=await ownEmployee(tx,a);if(own?.id!==value.employeeId||!value.fileId)throw forbidden('Only the linked employee can acknowledge an uploaded document');value.status='acknowledged';value.acknowledgedAt=new Date().toISOString();}
  if(b.action==='upload'){if(!b.fileId)throw badRequest('Choose a file');const file=await tx.upload.findFirst({where:{id:b.fileId,...scope(a),userId:a.userId,purpose:'payroll_employee_document',deletedAt:null}});if(!file||(!file.mimeType.startsWith('image/')&&file.mimeType!=='application/pdf'))throw badRequest('Attach your own employee image or PDF');value.fileId=file.id;value.fileName=file.fileName;value.uploadedBy=a.userId;value.status='uploaded';value.acknowledgedAt=null;}
  const result=mapped(await saveRecord(tx,a,'document',id,value,value.employeeId,old.revision));await audit(tx,a,`document.${b.action}`,'payroll_document',id,{employeeId:value.employeeId});return result;
});}
export async function locationConsent(a:Auth,b:z.infer<typeof locationConsentSchema>){return mutate(a,'portal.location.consent',b,async tx=>{
  const own=await ownEmployee(tx,a);if(!own||own.status==='inactive')throw forbidden('Link an active employee profile first');const old=await record<EmployeeLocation>(tx,a,'location',own.id,false);const value={employeeId:own.id,consent:b.consent,status:b.consent?'off_shift':'paused',latitude:null,longitude:null,accuracy:null,capturedAt:null,place:'',events:[]};await saveRecord(tx,a,'location',own.id,value,own.id,old?.revision??null);await audit(tx,a,'location.consent_changed','payroll_employee',own.id,{consent:b.consent});return {consent:b.consent};
});}
export async function pingLocation(a:Auth,b:z.infer<typeof locationSchema>){
  // Location fixes are transient updates, not durable idempotency receipts containing coordinates.
  return financialTransaction(async tx=>{await project(tx,a);const own=await ownEmployee(tx,a);if(!own||own.status==='inactive')throw forbidden('Link an active employee profile first');const old=await record<EmployeeLocation>(tx,a,'location',own.id,false);if(!old?.data.consent)throw forbidden('Enable location sharing on your device first');const p=await profile(tx,a,own);if(!p.value.locationRequired)throw forbidden('Location sharing is not enabled for this employee');
    const date=today(),settings=await attendanceConfig(tx,a),clock=dhakaClock(),punch=await tx.payrollAttendance.findFirst({where:{...scope(a),employeeId:own.id,date:atDate(date)}});
    if(!punch?.checkIn||punch.checkOut||clock<settings.shiftStart||clock>=settings.shiftEnd||isDayOff(date,settings))throw conflict('Location sharing is allowed only during a checked-in shift');
    if(b.mocked||Math.abs(Date.now()-Date.parse(b.captured_at))>120000||b.accuracy>100)throw badRequest('A fresh, accurate location is required');
    if(old.data.capturedAt&&b.captured_at<=old.data.capturedAt)return {accepted:true};
    let status='outside',place='Outside geofences';if(settings.latitude!==null&&settings.longitude!==null&&officeDistance(b.latitude,b.longitude,settings.latitude,settings.longitude)<=settings.radiusM){status='office';place=settings.officeName;}
    const projects=(await records<OfficeProject>(tx,a,'office_project')).map(mapped);if(status==='outside')for(const x of projects)if(x.status==='active'&&x.startDate<=date&&x.endDate>=date&&x.team.some(t=>t.employeeId===own.id)&&x.latitude!==null&&x.longitude!==null&&officeDistance(b.latitude,b.longitude,x.latitude,x.longitude)<=x.radiusM){status='site';place=x.name;break;}
    const events=old.data.capturedAt?.startsWith(date)?old.data.events:[];if(status!==old.data.status||place!==old.data.place)events.push({at:new Date().toISOString(),status,place});
    await saveRecord(tx,a,'location',own.id,{...old.data,status,place,latitude:b.latitude,longitude:b.longitude,accuracy:b.accuracy,capturedAt:b.captured_at,events:events.slice(-50)},own.id,old.revision);return {accepted:true};
  });
}
