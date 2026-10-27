import type { EmployeeProfile, EmploymentTerms } from './portal.types.js';
export function effectiveEmployment(profile: Pick<EmployeeProfile,'terms'|'promotions'|'grade'|'designationId'>,date:string){
 const promotion=[...profile.promotions].filter(p=>p.effectiveDate<=date).sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate))[0];
 return {...profile.terms,...(promotion?{basic:promotion.basic}:{}),grade:promotion?.grade??profile.grade,designationId:promotion?.designationId??profile.designationId,designation:promotion?.designation};
}
export const defaultTerms=(e:{basic:number;medical:number;transport:number;pfMember:boolean}):EmploymentTerms=>({type:'permanent',...e,probationMonths:6,noticeDays:60,contractStart:null,contractEnd:null,monthlyFee:0,hourlyRate:0,weeklyHours:48,workingDays:[6,0,1,2,3,4]});
/** Effective dates prorate salaried compensation by calendar days. Hourly pay uses completed punches. */
export function monthlyEmployment(joined:string,p:EmployeeProfile,month:string,attendance:{date:Date;status:string;checkIn?:Date|null;checkOut?:Date|null}[]){
 const [year,m]=month.split('-').map(Number),days=new Date(Date.UTC(year,m,0)).getUTCDate();let basic=0,medical=0,transport=0,hours=0;
 for(let d=1;d<=days;d++){
  const date=`${month}-${String(d).padStart(2,'0')}`,t=effectiveEmployment(p,date);if(date<joined)continue;
  if(t.type==='permanent'){basic+=t.basic/days;medical+=t.medical/days;transport+=t.transport/days;}
  if(t.type==='contractual'&&t.contractStart&&t.contractEnd&&date>=t.contractStart&&date<=t.contractEnd)basic+=t.monthlyFee/days;
  if(t.type==='part_time'){const r=attendance.find(r=>r.date.toISOString().slice(0,10)===date);if(r?.checkIn&&r.checkOut&&r.status!=='absent'){const h=Math.max(0,Math.min(24,(r.checkOut.getTime()-r.checkIn.getTime())/3600000));hours+=h;basic+=h*t.hourlyRate;}}
 }
 const rounded=Math.round(basic),type=p.terms.type;
 return {basic:rounded,medical:Math.round(medical),transport:Math.round(transport),houseRent:type==='permanent'?Math.round(rounded*.5):0,pfMember:type==='permanent'&&p.terms.pfMember,employmentType:type,payableHours:Math.round(hours*100)/100,hourlyRate:p.terms.hourlyRate};
}
