import { financialTransaction } from '../accounting/transaction.js';
import { scope, type BillingScope } from './billing.service.js';
import { day, outstanding, today } from './billing.policy.js';

/** All counters and previews use the complete project ledger, never a paginated list. */
export async function billingHome(a: BillingScope, month: string) {
 return financialTransaction(async tx => {
  const [customers, invoices, payments, assignments, adjustments, complaints, reminders] = await Promise.all([
   tx.customer.findMany({where:scope(a)}),
   tx.billingInvoice.findMany({where:{...scope(a),status:'issued'}}),
   tx.billingPayment.findMany({where:scope(a),orderBy:[{paymentDate:'desc'},{createdAt:'desc'}]}),
   tx.billingAssignment.findMany({where:{...scope(a),status:'active'},include:{unit:true,plan:true},orderBy:{createdAt:'asc'}}),
   tx.billingAdjustment.findMany({where:{...scope(a),status:'pending'},orderBy:{createdAt:'asc'}}),
   tx.billingComplaint.findMany({where:scope(a),orderBy:[{urgent:'desc'},{createdAt:'desc'}]}),
   tx.billingMessage.findMany({where:{...scope(a),dedupeKey:{startsWith:'reminder:'}}}),
  ]);
  const asOf=today(),period=invoices.filter(i=>day(i.invoiceDate).slice(0,7)===month);
  const customerMap=new Map(customers.map(c=>[c.id,c]));
  const names=(id:string)=>({customerId:id,name:customerMap.get(id)?.name??'Customer',unit:assignments.filter(s=>s.customerId===id).map(s=>s.unit?.name??s.label).join(', ')});
  const dueMap=new Map<string,{customerId:string;name:string;unit:string;outstanding:number;overdue:number;oldestDue:string}>();
  for(const i of invoices){
   const due=outstanding(i);if(due<=0)continue;
   const row=dueMap.get(i.customerId)??{...names(i.customerId),outstanding:0,overdue:0,oldestDue:day(i.dueDate)};
   row.outstanding+=due;row.overdue+=day(i.dueDate)<asOf?due:0;row.oldestDue=row.oldestDue<day(i.dueDate)?row.oldestDue:day(i.dueDate);dueMap.set(i.customerId,row);
  }
  const unpaid=[...dueMap.values()].sort((a,b)=>b.outstanding-a.outstanding||a.name.localeCompare(b.name));
  const receipts=payments.filter(p=>day(p.paymentDate)===asOf),open=complaints.filter(c=>c.status!=='resolved');
  const billedIds=new Set(period.map(i=>i.customerId));
  const unpaidPeriodIds=new Set(period.filter(i=>outstanding(i)>0).map(i=>i.customerId));
  return {
   month,as_of:asOf,customers:customers.filter(c=>c.isActive).length,
   billed_customers:billedIds.size,paid_customers:billedIds.size-unpaidPeriodIds.size,unpaid_customers:unpaid.length,
   month_billed:period.reduce((n,i)=>n+i.total+i.lateFeeAmount+i.debitAmount-i.creditAmount,0),
   month_collected:payments.filter(p=>day(p.paymentDate).slice(0,7)===month).reduce((n,p)=>n+p.amount,0),
   month_settled:period.reduce((n,i)=>n+i.paidAmount,0),
   outstanding:unpaid.reduce((n,c)=>n+c.outstanding,0),overdue_customers:unpaid.filter(c=>c.overdue>0).length,
   today_collected:receipts.reduce((n,p)=>n+p.amount,0),today_cash:receipts.filter(p=>p.method==='cash').reduce((n,p)=>n+p.amount,0),today_receipt_count:receipts.length,
   receipts:receipts.slice(0,5).map(p=>({...names(p.customerId),id:p.id,amount:p.amount,method:p.method,createdAt:p.createdAt,reference:p.reference})),
   unpaid:unpaid.slice(0,3),pending_approvals:adjustments.length,
   approvals:adjustments.slice(0,3).map(r=>({...r,...names(r.customerId)})),
   open_complaints:open.length,complaints:open.slice(0,2).map(c=>({...c,...names(c.customerId)})),
   active_subscriptions:assignments.length,
   reminders:{queued:reminders.filter(m=>m.dedupeKey.endsWith(`:${asOf}`)&&['queued','sending'].includes(m.status)).length,sent:reminders.filter(m=>m.dedupeKey.endsWith(`:${asOf}`)&&m.status==='sent').length,failed:reminders.filter(m=>m.dedupeKey.endsWith(`:${asOf}`)&&m.status==='failed').length},
  };
 });
}
