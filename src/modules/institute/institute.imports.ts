import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ApiError, forbidden } from '../../core/http/api-error.js';
import { assertPersonCapacity } from '../../core/subscription/quota.service.js';
import { createUser, type Tx, type Access } from './institute.service.js';
import { date, day, today } from './institute.policy.js';
import { saveRoutine } from './institute.routine.js';

export const importKind = z.enum(['groups','subjects','teachers','students','routine']);
type Kind = z.infer<typeof importKind>;
export const importArea = (kind: Kind) => kind === 'routine' ? 'routine' : kind;
export const importBody = z.object({
  rows: z.array(z.object({ row_number: z.number().int().min(2).max(2002), values: z.record(z.string().max(2000)) }).strict()).min(1).max(1000),
  group_id: z.string().min(1).optional(), revision: z.number().int().nonnegative().optional(), preview_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
type Body = z.infer<typeof importBody>;
const columns: Record<Kind,string[]> = {
  groups:['name','section','academic_year'], subjects:['name','code','pass_percent','written','mcq','practical'],
  teachers:['name','mobile','group_name','academic_year','subject_code','is_class_teacher'],
  students:['name','roll_no','student_code','mobile','group_name','academic_year'],
  routine:['weekday','starts_at','ends_at','subject_code','teacher_mobile','room','effective_from','effective_to'],
};
const mobilePattern = /^\+[1-9]\d{6,14}$/;
/** Preview is read-only. Commit revalidates the entire file in the idempotent serializable transaction. */
export async function instituteImport(db: Tx | PrismaClient, a: Access, kind: Kind, body: Body, commit: boolean) {
  if (a.portal !== 'office') throw forbidden();
  if(kind==='routine'&&body.rows.length>100)throw new ApiError(422,'IMPORT_INVALID','A class routine supports up to 100 sessions.');
  const [groups,subjects,students,assignments,users] = await Promise.all([
    db.instituteGroup.findMany({where:a.scope,orderBy:{id:'asc'}}), db.instituteSubject.findMany({where:a.scope,orderBy:{id:'asc'}}),
    kind==='students'?db.instituteStudent.findMany({where:a.scope,orderBy:{id:'asc'}}):Promise.resolve([]),
    ['teachers','routine'].includes(kind)?db.instituteTeacherAssignment.findMany({where:a.scope,orderBy:{id:'asc'}}):Promise.resolve([]),
    ['teachers','students','routine'].includes(kind)?tenantAccounts(db).findMany({where:{tenantId:a.scope.tenantId,mobile:{in:body.rows.flatMap(r=>[r.values.mobile,r.values.teacher_mobile].filter(Boolean))}},orderBy:{id:'asc'},select:{id:true,mobile:true,name:true,isActive:true}}):Promise.resolve([]),
  ]);
  const operations: (()=>Promise<unknown>)[] = [], seen = new Set<string>();
  const mobileNames=new Map<string,string>();
  const reviews: {row_number:number;label:string;action:'create'|'keep'|'replace'|'error';issues:string[]}[] = [];
  const routineSlots: {weekday:number;starts_at:string;ends_at:string;subject_id:string;teacher_user_id:string;room:string;effective_from:string;effective_to?:string}[] = [];
  const selectedGroup=groups.find(g=>g.id===body.group_id&&g.isActive);
  for(const row of body.rows) {
    const v=Object.fromEntries(Object.entries(row.values).map(([k,value])=>[k,value.trim()]));
    const issues:string[]=[], review={row_number:row.row_number,label:v.name||v.subject_code||`Row ${row.row_number}`,action:'create' as 'create'|'keep'|'replace'|'error',issues};
    reviews.push(review);
    const required=(key:string,max=120,min=1)=>{if(!v[key]||v[key].length<min||v[key].length>max)issues.push(`${key}: use ${min}–${max} characters.`);};
    const duplicate=(key:string)=>{if(seen.has(key))issues.push('Duplicate key in this file. Keep one row.');seen.add(key);};
    if(Object.keys(v).some(k=>!columns[kind].includes(k)))issues.push('Unknown columns. Use the sample headings.');
    const g=groups.find(g=>g.name===v.group_name&&g.academicYear===v.academic_year&&g.isActive);
    const subject=subjects.find(s=>s.code===v.subject_code), user=users.find(u=>u.mobile===(v.mobile||v.teacher_mobile));
    if(['teachers','students'].includes(kind)&&!g)issues.push('Class/course and academic_year must match a saved active group.');
    if(['teachers','students'].includes(kind))required('name',120,2);
    if(v.mobile&&!mobilePattern.test(v.mobile))issues.push('mobile: use a country code, for example +8801700000001.');
    if(v.mobile){const earlier=mobileNames.get(v.mobile);if(earlier&&earlier!==v.name)issues.push('This mobile has different names in the file.');mobileNames.set(v.mobile,v.name);}
    if(kind==='students'&&user&&user.name!==v.name)issues.push('This mobile belongs to a different name. Review the person before linking access.');
    if(user&&!user.isActive)issues.push('The sign-in account is inactive. Ask an admin to review it.');
    if(kind==='groups') {
      required('name');required('academic_year',32);if((v.section||'').length>32)issues.push('section: maximum 32 characters.');
      duplicate(`${v.academic_year}:${v.name}`);
      const old=groups.find(g=>g.academicYear===v.academic_year&&g.name===v.name);
      if(old){review.action='keep';if(!old.isActive|| (old.section||'')!==(v.section||''))issues.push('This group exists with different details. Review it before importing.');}
      else operations.push(()=>db.instituteGroup.create({data:{...a.scope,name:v.name,section:v.section||null,academicYear:v.academic_year}}));
    } else if(kind==='subjects') {
      required('name');required('code',64);duplicate(v.code);
      const components=['written','mcq','practical'].filter(k=>!!v[k]).map(key=>({key,label:key==='mcq'?'MCQ':key[0].toUpperCase()+key.slice(1),max:Number(v[key])}));
      if(!components.length)components.push({key:'written',label:'Written',max:100});
      const pass=Number(v.pass_percent||(a.config.grading==='bands'?'40':'33'));
      if(!Number.isInteger(pass)||pass<0||pass>100)issues.push('pass_percent: use a whole number from 0 to 100.');
      if(components.some(c=>!Number.isFinite(c.max)||c.max<=0)||components.reduce((n,c)=>n+c.max,0)!==100)issues.push('written + mcq + practical must total 100.');
      const old=subjects.find(s=>s.code===v.code);
      if(old){review.action='keep';if(old.name!==v.name||old.passPercent!==pass||JSON.stringify((old.components as {key:string;label:string;max:number}[]).map(c=>[c.key,c.label,c.max]).sort())!==JSON.stringify(components.map(c=>[c.key,c.label,c.max]).sort()))issues.push('This subject code already has different details. Existing mark schemes are kept.');}
      else operations.push(()=>db.instituteSubject.create({data:{...a.scope,name:v.name,code:v.code,passPercent:pass,components}}));
    } else if(kind==='teachers') {
      required('mobile',16);if(!['true','false'].includes(v.is_class_teacher))issues.push('is_class_teacher: use true or false.');
      if(v.subject_code&&!subject)issues.push('subject_code must match a saved subject.');
      if(!v.subject_code&&v.is_class_teacher!=='true')issues.push('Choose a subject or set is_class_teacher to true.');
      duplicate(`${v.mobile}:${g?.id}:${v.subject_code}`);
      if(user&&user.name!==v.name)issues.push('This mobile belongs to a different name. Review the person before linking access.');
      const old=assignments.find(t=>t.userId===user?.id&&t.groupId===g?.id&&(t.subjectId||'')===(subject?.id||''));
      if(old){review.action='keep';if(old.isClassTeacher!==(v.is_class_teacher==='true'))issues.push('This assignment has a different class-teacher setting. Review it manually.');}
      operations.push(async()=>{
        await assertPersonCapacity(a.scope.tenantId,{mobile:v.mobile},db as Tx);
        const teacher=await createUser(db as Tx,a,v.mobile,v.name,'teacher');
        if(!old)await db.instituteTeacherAssignment.create({data:{...a.scope,userId:teacher.id,groupId:g!.id,subjectId:subject?.id,isClassTeacher:v.is_class_teacher==='true'}});
      });
    } else if(kind==='students') {
      required('roll_no',32);if((v.student_code||'').length>64)issues.push('student_code: maximum 64 characters.');
      duplicate(`${g?.id}:${v.roll_no}`);if(v.student_code)duplicate(`code:${v.student_code}`);
      const old=students.find(s=>s.groupId===g?.id&&s.rollNo===v.roll_no), byCode=v.student_code?students.find(s=>s.studentCode===v.student_code):undefined;
      if(byCode&&byCode.id!==old?.id)issues.push('Student code belongs to another roll/class. Use a reviewed transfer instead.');
      if(old){review.action='keep';if(old.name!==v.name||old.status!=='active'||v.student_code&&old.studentCode!==v.student_code||v.mobile&&old.userId!==user?.id)issues.push('This roll already has different student details. Existing records are kept.');}
      else operations.push(async()=>{
        await assertPersonCapacity(a.scope.tenantId,{mobile:v.mobile||undefined},db as Tx);
        const studentUser=v.mobile?await createUser(db as Tx,a,v.mobile,v.name,'member'):null;
        return db.instituteStudent.create({data:{...a.scope,name:v.name,rollNo:v.roll_no,studentCode:v.student_code||null,userId:studentUser?.id,groupId:g!.id,joinedOn:date(today(a.config.timezone))}});
      });
    } else {
      review.action='replace';
      const weekday=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf((v.weekday||'').toLowerCase());
      if(weekday<0)issues.push('weekday: use Sunday through Saturday.');
      if(!selectedGroup)issues.push('Choose an active class/course before importing a routine.');
      if(!subject)issues.push('subject_code must match a saved subject.');
      if(!mobilePattern.test(v.teacher_mobile||'')||!user||!assignments.some(t=>t.userId===user.id&&t.groupId===selectedGroup?.id))issues.push('teacher_mobile must match a teacher assigned to this class/course.');
      if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.starts_at||'')||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.ends_at||'')||v.ends_at<=v.starts_at)issues.push('Use HH:MM times with the end after the start.');
      if(!day.safeParse(v.effective_from).success||v.effective_to&&(!day.safeParse(v.effective_to).success||v.effective_to<v.effective_from))issues.push('Use valid YYYY-MM-DD effective dates.');
      if(!issues.length)routineSlots.push({weekday,starts_at:v.starts_at,ends_at:v.ends_at,subject_id:subject!.id,teacher_user_id:user!.id,room:v.room||'',effective_from:v.effective_from,...(v.effective_to?{effective_to:v.effective_to}:{})});
    }
  }
  if(kind==='routine'&&!reviews.some(r=>r.issues.length)) {
    try{await saveRoutine(db as Tx,a,body.group_id!,{revision:body.revision,slots:routineSlots},true);}
    catch(error){if(!(error instanceof ApiError)&&!(error instanceof z.ZodError))throw error;reviews[0].issues.push(error instanceof ApiError?error.message:'Reload the class before importing.');}
  }
  for(const r of reviews)if(r.issues.length)r.action='error';
  // Replacing the same class template after another edit requires another review.
  const otherSlots=kind==='routine'?await db.instituteRoutineSlot.findMany({where:a.scope,orderBy:{id:'asc'}}):[];
  const hash=createHash('sha256').update(JSON.stringify({kind,rows:body.rows,group:body.group_id,revision:body.revision,groups,subjects,students,assignments,users,otherSlots})).digest('hex');
  const result={valid:!reviews.some(r=>r.issues.length),rows:reviews,total:reviews.length,preview_hash:hash,created:reviews.filter(r=>r.action==='create').length,kept:reviews.filter(r=>r.action==='keep').length};
  if(!commit)return result;
  if(!result.valid)throw new ApiError(422,'IMPORT_INVALID',`Row ${reviews.find(r=>r.issues.length)!.row_number}: ${reviews.find(r=>r.issues.length)!.issues.join(' ')}`,{rows:reviews});
  if(body.preview_hash!==hash)throw new ApiError(409,'IMPORT_PREVIEW_CHANGED','Saved records changed. Review the file again before importing.');
  if(kind==='routine')await saveRoutine(db as Tx,a,body.group_id!,{revision:body.revision,slots:routineSlots});
  else for(const operation of operations)await operation();
  return {...result,imported:result.total};
}
