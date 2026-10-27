import type {Prisma} from '@prisma/client';
import {badRequest,conflict,forbidden,notFound} from '../../core/http/api-error.js';
import {scope,sameRequest,type BillingScope} from '../billing/billing.service.js';
export type Tx=Prisma.TransactionClient;export type A=BillingScope;
export {scope};
export async function evidence(tx:Tx,a:A,ids:string[]){for(const id of ids)if(!await tx.upload.findFirst({where:{...scope(a),id,deletedAt:null}}))throw notFound('Project evidence file not found.');}
export async function reviewerOptions(tx:Tx,a:A){
 const rows=await tx.projectMembership.findMany({where:{...scope(a),isActive:true,user:{isActive:true}},include:{user:{select:{id:true,name:true}},customRole:true}});
 const ids=new Map<string,{id:string;name:string}>();
 for(const row of rows){const permissions=row.customRole?.permissions as Record<string,{write?:boolean}>|undefined;if(!row.customRoleId&&['owner','admin','approver'].includes(row.role)||permissions?.construction_control?.write)ids.set(row.userId,{id:row.userId,name:row.user?.name??row.userId});}
 return [...ids.values()];
}
export async function validateReviewer(tx:Tx,a:A,id:string){if(id===a.userId)throw badRequest('Choose a different person for independent approval.');if(!(await reviewerOptions(tx,a)).some(r=>r.id===id))throw badRequest('Choose an active project approver or Site controls writer.');}
export async function routedReview(tx:Tx,a:A,row:{approverId:string;createdById:string}){if(row.createdById===a.userId)throw conflict('A different person must review this submission.');if(row.approverId!==a.userId)throw forbidden('This submission is routed to a different approver.');if(!(await reviewerOptions(tx,a)).some(r=>r.id===a.userId))throw forbidden('Your project approval access changed.');}
export function retryRow<T extends {createdById:string;requestHash:string}>(row:T|null,a:A,body:unknown){if(!row)return null;if(row.createdById!==a.userId)throw conflict('Request key already used.');sameRequest(row,body);return row;}
export const clean=<T extends {requestHash:string;requestKey:string}>(row:T)=>{const{requestHash,requestKey,...rest}=row;return rest;};

export async function rerouteWorkflow(tx:Tx,a:A&{roles:string[];builtinRoles?:string[]},kind:string,id:string,b:{approver_id:string;expected_approver_id:string;note:string}){
 const delegates={'requisitions':tx.constructionRequisition,'awards':tx.constructionProcurementAward,'deliveries':tx.constructionDelivery,'invoices':tx.constructionPurchaseInvoice,'scope-changes':tx.constructionScopeChange};
 const source=delegates[kind as keyof typeof delegates];if(!source)throw notFound('Workflow type not found.');
 // These five delegates share the routing fields; no other columns are writable here.
 type Row={id:string;status:string;approverId:string;createdById:string};
 const db=source as unknown as {findFirst(args:{where:{tenantId:string;projectId:string;id:string}}):Promise<Row|null>;update(args:{where:{id:string};data:{approverId:string}}):Promise<Row>};
 const row=await db.findFirst({where:{...scope(a),id}});if(!row)throw notFound('Pending workflow not found.');if(row.createdById!==a.userId&&!(a.builtinRoles??a.roles).some(r=>r==='owner'||r==='admin'))throw forbidden('Only the requester or an owner/administrator can change approval routing.');
 if(row.status!=='pending')throw conflict('Only pending requests can be rerouted.');await validateReviewer(tx,{...a,userId:row.createdById},b.approver_id);if(row.approverId===b.approver_id)return {id:row.id,status:row.status,approverId:row.approverId};if(row.approverId!==b.expected_approver_id)throw conflict('Routing changed. Refresh before assigning another reviewer.');
 const saved=await db.update({where:{id},data:{approverId:b.approver_id}});const {audit}=await import('./construction.service.js');await audit(tx,a,'workflow.rerouted',`construction_${kind}`,id,{before:row,after:saved,note:b.note});return {id:saved.id,status:saved.status,approverId:saved.approverId};
}
