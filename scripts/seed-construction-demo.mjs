import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { hash } from '../dist/modules/billing/billing.policy.js';

export const DEMO_NAME = 'Sunrise Heights · Demo';
const phases = [
 ['Foundation',9200000,9050000,0],['Structure (RCC frame)',21500000,3400000,5600000],
 ['Brickwork & plaster',8600000,4100000,4500000],['Electrical & plumbing',9400000,1300000,5000000],['Finishing',9300000,1650000,6800000],
];
const labor = [['Mason',8,950],['Helper',14,650],['Rod binder',6,900],['Shuttering carpenter',4,900],['Electrician',2,1100]];
const materialData = [
 ['Cement','bags',560,1180,50,318,200,42],['Bricks','pcs',14,48000,2900,11600,500,2400],
 ['MS Rod 16mm','kg',98,38500,700,4200,300,650],['Sand','cft',60,4200,290,880,800,120],['Floor tiles','sft',150,2600,210,400,500,0],
];
export async function seedConstructionDemo(db, {mobile, projectId, apply=false, date='2026-10-21'}) {
 if (!mobile || !projectId) throw new Error('Pass both --mobile and --project-id.');
 const users=await db.user.findMany({where:{mobile,isActive:true},include:{tenant:true}});
 const project=await db.project.findFirst({where:{id:projectId,isActive:true,projectType:'construction'}});
 const user=users.find(u=>u.tenantId===project?.tenantId);
 if (!project || !user || project.name!==DEMO_NAME || !/demo|review/i.test(user.tenant.name)) throw new Error('Only the named construction demo project in a demo/review organization may be seeded.');
 if (!await db.projectMembership.findFirst({where:{projectId,userId:user.id,isActive:true,role:{in:['owner','admin']}}})) throw new Error('The supplied demo phone must administer the target project.');
 const scope={tenantId:project.tenantId,projectId},marker={...scope,action:'construction.demo_seeded',entityId:projectId};
 if (await db.activity.findFirst({where:marker})) return {status:'already_seeded',projectId};
 if (!apply) return {status:'preview',projectId,project:project.name,budget:58000000,actual:34200000,cash:2650000,phases:5,contracts:3,materials:5,logDate:date};
 return db.$transaction(async tx=>{
  if (await tx.activity.findFirst({where:marker})) return {status:'already_seeded',projectId};
  const counts=await Promise.all([tx.constructionCostHead.count({where:scope}),tx.constructionSiteLog.count({where:scope}),tx.expense.count({where:scope}),tx.inventoryItem.count({where:scope}),tx.accountTransaction.count({where:scope})]);
  if (counts.some(Boolean)) throw new Error('Target has activity; refusing to overwrite or mix sample financial records.');
  const accounts=await tx.account.findMany({where:scope});
  if (accounts.some(a=>a.balance!==0)) throw new Error('Target has an existing balance.');
  const owner=user.id, imported='demo-history-import', siteManager='demo-site-manager', at=d=>new Date(d+'T00:00:00Z');
  const yesterday=new Date(at(date));yesterday.setUTCDate(yesterday.getUTCDate()-1);const prev=yesterday.toISOString().slice(0,10);
  let cash=35010000;
  const account=accounts[0]??await tx.account.create({data:{...scope,name:'Cash',type:'cash',isDefault:true}});
  const cashMovement=async(amount,direction,referenceType,referenceId,description,occurredOn=at(prev))=>{
   cash+=direction==='money_in'?amount:-amount;
   await tx.accountTransaction.create({data:{...scope,accountId:account.id,direction,amount,balanceAfter:cash,referenceType,referenceId,description,occurredOn,createdById:owner}});
  };
  // Opening funding is a fixture opening balance, followed by its full cash history.
  cash=0;await cashMovement(35010000,'money_in','opening_balance',account.id,'Demo opening project funding',at('2025-09-05'));
  const heads=[];
  for (const [name,budget,paid,forecast] of phases) {
   const head=await tx.constructionCostHead.create({data:{...scope,name,phase:name,category:'materials',budget,revisedBudget:budget,forecastRemaining:forecast,status:'approved',createdById:imported,decidedById:imported}});heads.push(head);
   const expense=await tx.expense.create({data:{...scope,title:`Demo historical cost · ${name}`,amount:paid,category:'construction',status:'paid',expenseDate:at(prev),accountId:account.id,paidAccountId:account.id,paidAt:at(prev),createdById:imported,approvedById:imported,disbursedById:imported}});
   const payload={expense_id:expense.id,cost_head_id:head.id,amount:paid,request_key:randomUUID()};
   await tx.constructionCostAllocation.create({data:{...scope,expenseId:expense.id,costHeadId:head.id,amount:paid,requestKey:payload.request_key,requestHash:hash(payload),createdById:imported}});
   await cashMovement(paid,'money_out','expense',expense.id,expense.title);
  }
  const contracts=[];
  for (const [name,title,amount,cert,paid,headIndex] of [
   ['Rahman Builders','RCC frame',18000000,12400000,10930000,1],['Delta Electric & Plumbing','MEP works',6200000,1900000,1550000,3],['Nur Tiles & Finishes','Floor & wall tiling',3100000,400000,380000,4],
  ]) {
   const contractor=await tx.constructionContractor.create({data:{...scope,name}}),requestKey=randomUUID();
   const contract=await tx.constructionContract.create({data:{...scope,contractorId:contractor.id,costHeadId:heads[headIndex].id,title,amount,revisedAmount:amount,retentionBps:500,certifiedAmount:cert,retentionHeld:Math.round(cert*.05),requestKey,requestHash:hash({requestKey}),createdById:imported}});contracts.push(contract);
   const retention=Math.round(cert*.05),bill=await tx.constructionRunningBill.create({data:{...scope,contractId:contract.id,cumulativeCertified:cert,previousCertified:0,currentCertified:cert,retention,advanceRecovery:0,netPayable:cert-retention,paidAmount:paid,billDate:at(prev),status:'approved',createdById:imported,decidedById:imported,decidedAt:at(prev),requestKey:randomUUID(),requestHash:hash({cert})}});
   const payment=await tx.constructionPayment.create({data:{...scope,kind:'running_bill',runningBillId:bill.id,accountId:account.id,amount:paid,paymentDate:at(prev),reference:'Demo historical payment',requestKey:randomUUID(),requestHash:hash({paid}),createdById:imported}});
   await cashMovement(paid,'money_out','construction_running_bill',payment.id,`Demo certified work · ${name}`);
  }
  const items=[],boqs=[];
  for (const [i,[name,unit,rate,used,wasted,left,allowance,dayQty]] of materialData.entries()) {
   const item=await tx.inventoryItem.create({data:{...scope,name,unit,costPrice:rate,quantity:used+wasted+left,reorderLevel:dayQty*3}});items.push(item);
   const location=await tx.inventoryLocation.findFirst({where:{...scope,isDefault:true}})??await tx.inventoryLocation.create({data:{...scope,name:'Main store',isDefault:true}});
   await tx.stockMovement.create({data:{...scope,itemId:item.id,locationId:location.id,type:'adjustment_increase',quantity:item.quantity,quantityAfter:item.quantity,referenceType:'opening_stock',referenceId:item.id,reason:'Demo opening stock',createdById:imported}});
   const boq=await tx.constructionBoq.create({data:{...scope,costHeadId:heads[i===0||i===2?1:i===4?4:2].id,name:name==='Cement'||name.startsWith('MS')?'7th-floor slab · '+name:name,unit,quantity:used+wasted+left,rate,estimated:(used+wasted+left)*rate}});boqs.push(boq);
   await tx.constructionWasteLimit.create({data:{...scope,itemId:item.id,allowanceBps:allowance}});
   let balance=item.quantity;
   for (const [kind,qty,reason] of [['consume',used,'Demo historical site use'],['waste',wasted,i===0?'Rain damage':i===2?'Cutting offcuts':i===3?'Over-mixing':'Breakage']]) {
    balance-=qty;const entry=await tx.constructionMaterialEntry.create({data:{...scope,itemId:item.id,boqId:boq.id,kind,quantity:qty,unitRate:rate,entryDate:at(prev),reason,...(kind==='waste'&&(i===1||i===4)?{chargeContractId:contracts[i===4?2:0].id}:{}),requestKey:randomUUID(),requestHash:hash({kind,qty}),createdById:siteManager}});
    await tx.stockMovement.create({data:{...scope,itemId:item.id,locationId:location.id,type:'adjustment_decrease',quantity:-qty,quantityAfter:balance,referenceType:`construction_${kind}`,referenceId:entry.id,reason,createdById:siteManager}});
   }
   await tx.inventoryItem.update({where:{id:item.id},data:{quantity:left}});
  }
  // Four review examples, created by the clearly labelled fictional demo site manager.
  await tx.constructionRunningBill.create({data:{...scope,contractId:contracts[0].id,cumulativeCertified:13294737,previousCertified:12400000,currentCertified:894737,retention:44737,advanceRecovery:0,netPayable:850000,billDate:at(prev),note:'Demo RB-07 for approval',createdById:siteManager,requestKey:randomUUID(),requestHash:hash({example:'running'})}});
  const vendor=await tx.vendor.create({data:{...scope,name:'Akij Cement',notes:'Demo supplier'}});
  await tx.constructionSupplierBill.create({data:{...scope,vendorId:vendor.id,costHeadId:heads[1].id,boqId:boqs[0].id,number:'DEMO-AC-600',description:'600 bags of cement',amount:336000,billDate:at(prev),createdById:siteManager,requestKey:randomUUID(),requestHash:hash({example:'supplier'})}});
  await tx.constructionLaborEntry.create({data:{...scope,costHeadId:heads[1].id,workerName:'Karim · site labor sheet',workDate:at(prev),units:1,rate:27250,amount:27250,createdById:siteManager,requestKey:randomUUID(),requestHash:hash({example:'labor'})}});
  await tx.constructionChangeOrder.create({data:{...scope,costHeadId:heads[4].id,budgetChange:460000,contractChange:0,reason:'Roof waterproofing added',createdById:siteManager,requestKey:randomUUID(),requestHash:hash({example:'change'})}});
  const todayExpenses=[];
  for (const [title,amount] of [['Truck rent · sand',3500],['Mixer machine fuel',1800],['Tea & snacks for crew',900]]) {
   const expense=await tx.expense.create({data:{...scope,title,amount,category:'construction',expenseDate:at(date),status:'draft',createdById:owner}});todayExpenses.push(expense.id);
  }
  const content={labor:labor.map(([role,workers,rate])=>({role,workers,rate,cost_head_id:heads[1].id})),materials:materialData.flatMap((m,i)=>m[7]?[{item_id:items[i].id,boq_id:boqs[i].id,quantity:m[7]}]:[]),expense_ids:todayExpenses,photo_ids:[],note:'7th-floor slab casting and level 5 brickwork. Demo draft; review before submitting.'};
  await tx.constructionSiteLog.create({data:{...scope,workDate:at(date),content,createdById:owner}});
  await tx.account.update({where:{id:account.id},data:{balance:cash}});
  if(cash!==2650000)throw new Error('Demo cash reconciliation failed');
  await tx.project.update({where:{id:projectId},data:{stockManagementEnabled:true,constructionSettings:{building:DEMO_NAME,site:'Dhaka · sample construction site',start_date:'2025-09-05',end_date:'2027-06-06',financial_target:58000000,total_shares:12,note:'Fictional sample records imported for demonstration.'}}});
  await tx.activity.create({data:{...marker,actorUserId:owner,entityType:'project',after:{seed_version:1,source:'Construction Mobile reference',cash,budget:58000000,actual:34200000,fictional_review_actor:siteManager}}});
  return {status:'seeded',projectId,budget:58000000,actual:34200000,cash};
 },{isolationLevel:'Serializable',timeout:30000});
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1],db=new PrismaClient({log:[]});
 try { console.log(JSON.stringify(await seedConstructionDemo(db,{mobile:args.includes('--mobile')?value('--mobile'):undefined,projectId:args.includes('--project-id')?value('--project-id'):undefined,date:args.includes('--date')?value('--date'):undefined,apply:args.includes('--apply')}),null,2)); }
 catch(e){console.error(e.message);process.exitCode=1;}finally{await db.$disconnect();}
}
