import type { Prisma, ConstructionWorkLocation } from '@prisma/client';
import { badRequest, notFound } from '../../core/http/api-error.js';
import { scope, type BillingScope } from '../billing/billing.service.js';
import { locationKinds } from './construction.structure.policy.js';
type Tx = Prisma.TransactionClient;
export type WorkContextInput = {phase_id?: string; work_package_id?: string; task_id?: string; location_id?: string};
export async function locationChain(tx: Tx, a: BillingScope, id: string, active = true) {
 const rows: ConstructionWorkLocation[] = []; const seen = new Set<string>(); let current: string | null = id;
 while (current) {
  if (seen.has(current) || seen.size >= 4) throw badRequest('Invalid construction location hierarchy');
  seen.add(current);
  const row: ConstructionWorkLocation | null = await tx.constructionWorkLocation.findFirst({where:{...scope(a), id:current}});
  if (!row) throw notFound('Construction work location not found');
  if (active && !row.isActive) throw badRequest('Choose an active work location and parent');
  rows.unshift(row); current = row.parentId;
 }
 for (let i=1; i<rows.length; i++) if (locationKinds.indexOf(rows[i].kind as typeof locationKinds[number]) <= locationKinds.indexOf(rows[i-1].kind as typeof locationKinds[number])) throw badRequest('Use Building → Block → Floor → Zone order');
 return rows;
}
export async function resolveWorkContext(tx: Tx, a: BillingScope, b: WorkContextInput, expectedPhaseId?: string) {
 const task = b.task_id ? await tx.constructionTask.findFirst({where:{...scope(a),id:b.task_id}}) : null;
 if (b.task_id && !task) throw notFound('Construction task not found');
 if (task && !task.isActive) throw badRequest('Choose an active task');
 if (task && b.work_package_id && task.workPackageId !== b.work_package_id) throw badRequest('Task belongs to a different work package');
 const packageId = b.work_package_id ?? task?.workPackageId;
 const pack = packageId ? await tx.constructionWorkPackage.findFirst({where:{...scope(a),id:packageId}}) : null;
 if (packageId && !pack) throw notFound('Construction work package not found');
 if (pack && !pack.isActive) throw badRequest('Choose an active work package');
 const phaseId = b.phase_id ?? pack?.phaseId ?? expectedPhaseId;
 if (pack && phaseId !== pack.phaseId || expectedPhaseId && phaseId !== expectedPhaseId) throw badRequest('Work package must belong to the selected phase');
 const phase = phaseId ? await tx.constructionPhase.findFirst({where:{...scope(a),id:phaseId}}) : null;
 if (phaseId && !phase) throw notFound('Construction phase not found');
 const locationId = b.location_id ?? pack?.locationId ?? undefined;
 const locations = locationId ? await locationChain(tx,a,locationId) : [];
 if (pack?.locationId && !locations.some(row=>row.id===pack.locationId)) throw badRequest('Choose the work package location or one of its children');
 return {phaseId:phase?.id??null,workPackageId:pack?.id??null,taskId:task?.id??null,locationId:locationId??null,
  label:[phase?.name,pack?.name,task?.name,locations.map(row=>row.name).join(' / ')].filter(Boolean).join(' · ')};
}
export async function validateSiteWorkContext(tx: Tx, a: BillingScope, content: WorkContextInput & {labor: {cost_head_id:string}[];materials:{boq_id?:string;cost_head_id?:string}[]}) {
 const context = await resolveWorkContext(tx,a,content);
 const heads = new Set([...content.labor.map(l=>l.cost_head_id),...content.materials.flatMap(m=>m.cost_head_id?[m.cost_head_id]:[])]);
 for (const material of content.materials) if (material.boq_id) {
  const b = await tx.constructionBoq.findFirst({where:{...scope(a),id:material.boq_id,isActive:true}});
  if (!b) throw notFound('Active BOQ item not found'); heads.add(b.costHeadId);
 }
 for (const id of heads) {
  const h = await tx.constructionCostHead.findFirst({where:{...scope(a),id}});
  if (!h) throw notFound('Cost head not found');
  if (context.phaseId) {
   const phase = await tx.constructionPhase.findFirst({where:{...scope(a),id:context.phaseId}});
   if (h.phaseId ? h.phaseId !== context.phaseId : h.phase !== phase?.name) throw badRequest('Site log entries must belong to its selected phase');
  }
  if (context.workPackageId && h.workPackageId && context.workPackageId !== h.workPackageId) throw badRequest('Cost head belongs to another work package');
  if (context.taskId && h.taskId && context.taskId !== h.taskId) throw badRequest('Cost head belongs to another task');
  if (context.locationId && h.locationId) {
   const logChain = await locationChain(tx,a,context.locationId), headChain = await locationChain(tx,a,h.locationId);
   if (!logChain.some(l=>l.id===h.locationId) && !headChain.some(l=>l.id===context.locationId)) throw badRequest('Cost head belongs to another work location');
  }
 }
 return context;
}
export const contextInput = (context: Awaited<ReturnType<typeof resolveWorkContext>>) => ({
 phase_id:context.phaseId??undefined,work_package_id:context.workPackageId??undefined,task_id:context.taskId??undefined,location_id:context.locationId??undefined,
});
