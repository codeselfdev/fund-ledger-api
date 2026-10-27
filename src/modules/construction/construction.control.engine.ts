/** Calendar and costing calculations are pure, deterministic and independent of server time. */
export type WorkCalendar={weekdays:number[];holidays:string[]};
export type ScheduleTask={task_id:string;duration:number;not_before?:string;delay_reason?:string;dependencies:{task_id:string;type:'FS'|'SS'|'FF'|'SF';lag:number}[]};
const stamp=(day:string)=>Date.parse(`${day}T00:00:00Z`);
export const dateAdd=(day:string,n:number)=>new Date(stamp(day)+n*86400000).toISOString().slice(0,10);
export function isWorkday(day:string,calendar:WorkCalendar){return calendar.weekdays.includes(new Date(`${day}T00:00:00Z`).getUTCDay())&&!calendar.holidays.includes(day);}
export function calculateSchedule(anchor:string,tasks:ScheduleTask[],calendar:WorkCalendar){
 if(!calendar.weekdays.length)throw new Error('Select at least one working weekday.');
 const dates:string[]=[];let day=anchor;
 for(let i=0;dates.length<10001&&i<75000;i++,day=dateAdd(day,1))if(isWorkday(day,calendar))dates.push(day);
 const index=(value:string)=>{const found=dates.findIndex(d=>d>=value);if(found<0)throw new Error('Schedule exceeds the supported calendar horizon.');return found;};
 const map=new Map(tasks.map(t=>[t.task_id,t]));if(map.size!==tasks.length)throw new Error('Each task may appear only once.');
 const order:ScheduleTask[]=[],visiting=new Set<string>(),done=new Set<string>();
 const visit=(task:ScheduleTask)=>{if(visiting.has(task.task_id))throw new Error('Task dependencies contain a cycle.');if(done.has(task.task_id))return;visiting.add(task.task_id);
  for(const link of task.dependencies){const predecessor=map.get(link.task_id);if(!predecessor)throw new Error('A dependency refers to an unscheduled task.');visit(predecessor);}
  visiting.delete(task.task_id);done.add(task.task_id);order.push(task);
 };tasks.forEach(visit);
 const starts=new Map<string,number>(),latest=new Map<string,number>();
 const offset=(before:ScheduleTask,after:ScheduleTask,type:string,lag:number)=>type==='FS'?before.duration+lag:type==='SS'?lag:type==='FF'?before.duration-after.duration+lag:-after.duration+lag;
 let finish=0;
 for(const task of order){let start=index(task.not_before&&task.not_before>anchor?task.not_before:anchor);
  for(const dep of task.dependencies)start=Math.max(start,starts.get(dep.task_id)!+offset(map.get(dep.task_id)!,task,dep.type,dep.lag));
  if(start+task.duration>=dates.length)throw new Error('Schedule exceeds the supported calendar horizon.');starts.set(task.task_id,start);finish=Math.max(finish,start+task.duration);
 }
 for(const task of [...order].reverse()){let last=finish-task.duration;
  for(const after of tasks)for(const dep of after.dependencies)if(dep.task_id===task.task_id)last=Math.min(last,latest.get(after.task_id)!-offset(task,after,dep.type,dep.lag));
  latest.set(task.task_id,last);
 }
 return {anchor:dates[0],finish:finish?dates[finish-1]:dates[0],calendar,tasks:tasks.map(task=>({...task,start:dates[starts.get(task.task_id)!],end:dates[starts.get(task.task_id)!+task.duration-1],float_days:latest.get(task.task_id)!-starts.get(task.task_id)!,critical:latest.get(task.task_id)===starts.get(task.task_id)}))};
}
export function scheduleFraction(start:string,end:string,asOf:string,calendar:WorkCalendar){
 if(asOf<start)return 0;if(asOf>=end)return 1;let total=0,elapsed=0;
 for(let day=start;day<=end;day=dateAdd(day,1)){if(isWorkday(day,calendar)){total++;if(day<=asOf)elapsed++;}}
 return total?elapsed/total:0;
}
export const SCALE=1000000n;
export function micro(value:number|string){
 const n=typeof value==='number'?value:Number(value);if(!Number.isFinite(n)||Math.abs(n)>2147483647)throw new Error('Value exceeds the supported range.');
 const fixed=n.toFixed(6);if(Math.abs(Number(fixed)-n)>0.00000001)throw new Error('Use at most six decimal places.');
 const sign=fixed.startsWith('-')?-1n:1n;const[a,b]=fixed.replace('-','').split('.');return sign*(BigInt(a)*SCALE+BigInt(b));
}
export const moneyFromMicro=(value:bigint)=>Number(value)/1000000;
export const roundedMoney=(value:bigint)=>Number(value>=0n?(value+SCALE/2n)/SCALE:-((-value+SCALE/2n)/SCALE));
export function proportional(value:bigint,part:number,whole:number){if(!Number.isSafeInteger(part)||!Number.isSafeInteger(whole)||part<0||whole<=0||part>whole)throw new Error('Invalid valuation quantity.');return part===whole?value:value*BigInt(part)/BigInt(whole);}
export type BoqResource={kind:'material'|'labor';item_id?:string;name:string;unit:string;quantity_per_unit:number;rate:number};
export type ControlBoqLine={id:string;cost_head_id:string;task_id?:string;name:string;unit:string;quantity:number;rate:number;rate_mode:'manual'|'recipe';resources:BoqResource[]};
export function priceBoq(line:ControlBoqLine){
 const recipe=line.resources.reduce((sum,r)=>sum+micro(r.quantity_per_unit)*micro(r.rate)/SCALE,0n);
 const rate=line.rate_mode==='recipe'?roundedMoney(recipe):line.rate;
 if(line.rate_mode==='recipe'&&!line.resources.length)throw new Error('Add material or labor resources for a recipe rate.');
 const estimated=roundedMoney(micro(line.quantity)*BigInt(rate));if(estimated>2147483647)throw new Error('BOQ estimate exceeds the supported range.');
 return {...line,rate,estimated,recipe_unit_cost:moneyFromMicro(recipe)};
}
export function compareBoq(previous:ReturnType<typeof priceBoq>[],next:ReturnType<typeof priceBoq>[]){
 const ids=new Set([...previous.map(x=>x.id),...next.map(x=>x.id)]);
 return [...ids].map(id=>{const a=previous.find(x=>x.id===id),b=next.find(x=>x.id===id);return {id,name:b?.name??a!.name,before:a??null,after:b??null,quantity_change:(b?.quantity??0)-(a?.quantity??0),cost_change:(b?.estimated??0)-(a?.estimated??0)};});
}
