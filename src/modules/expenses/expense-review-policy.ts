import type { Role } from '@prisma/client';
/** Owners/admins may review both approval routes; delegated roles follow the tenant policy. */
export function canReviewExpense(roles:Role[],flow:string){
 if(roles.some(role=>role==='owner'||role==='admin'))return true;
 return flow==='accountant_only'?roles.includes('accountant'):roles.includes('approver');
}
