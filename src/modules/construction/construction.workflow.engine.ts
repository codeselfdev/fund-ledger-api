import type {CheckedLine,InvoiceLine} from './construction.workflow.policy.js';
export type OrderLine={id:string;itemId:string;quantity:number;unitCost:number};
export function uniqueLines(lines:{[key:string]:unknown}[],key:string){if(new Set(lines.map(l=>l[key])).size!==lines.length)throw new Error('Do not repeat a line.');}
export function receiptBalances(lines:OrderLine[],deliveries:{status:string;checkedLines:unknown}[]){
 const checked=deliveries.filter(d=>d.status==='approved').flatMap(d=>(d.checkedLines??[]) as CheckedLine[]);
 return lines.map(l=>({...l,accepted:checked.filter(c=>c.purchase_line_id===l.id).reduce((n,c)=>n+c.accepted,0),rejected:checked.filter(c=>c.purchase_line_id===l.id).reduce((n,c)=>n+c.rejected,0)})).map(l=>({...l,outstanding:l.quantity-l.accepted}));
}
export function matchInvoice(order:{totalAmount:number;lines:OrderLine[]},deliveries:{status:string;checkedLines:unknown}[],approved:{id:string;status:string;lines:unknown;amount:number;charges:number}[],invoice:{id?:string;lines:InvoiceLine[];amount:number;charges:number}){
 const prior=approved.filter(i=>i.status==='approved'&&i.id!==invoice.id),balances=receiptBalances(order.lines,deliveries);
 const rows=invoice.lines.map(i=>{const po=balances.find(l=>l.id===i.purchase_line_id),billed=prior.flatMap(p=>p.lines as InvoiceLine[]).filter(l=>l.purchase_line_id===i.purchase_line_id).reduce((n,l)=>n+l.quantity,0),orderedRemaining=(po?.quantity??0)-billed,acceptedRemaining=(po?.accepted??0)-billed;
 return {...i,ordered_quantity:po?.quantity??0,accepted_quantity:po?.accepted??0,already_invoiced:billed,ordered_remaining:orderedRemaining,accepted_remaining:acceptedRemaining,ordered_unit_cost:po?.unitCost??null,quantity_match:!!po&&i.quantity<=orderedRemaining&&i.quantity<=acceptedRemaining,price_match:!!po&&i.unit_cost===po.unitCost};});
 const orderCharges=order.totalAmount-order.lines.reduce((n,l)=>n+l.quantity*l.unitCost,0),chargesRemaining=orderCharges-prior.reduce((n,i)=>n+i.charges,0),amountRemaining=order.totalAmount-prior.reduce((n,i)=>n+i.amount,0);
 return {rows,charges_remaining:chargesRemaining,amount_remaining:amountRemaining,matched:(rows.length>0||invoice.charges>0&&balances.every(l=>l.accepted===l.quantity))&&rows.every(r=>r.quantity_match&&r.price_match)&&invoice.charges<=chargesRemaining&&invoice.amount<=amountRemaining};
}
export function safeAmount(amount:number){if(!Number.isSafeInteger(amount)||amount<0||amount>2147483647)throw new Error('Amount exceeds the supported whole-currency range.');return amount;}

export function apportionedPurchaseTax(snapshot:unknown,previousAmount:number,invoiceAmount:number,totalAmount:number){
 const tax=snapshot as {version?:number;breakdown?:{amount:number;base:number;[key:string]:unknown}[]}|null;
 if(tax?.version!==1||!tax.breakdown||!totalAmount)return null;
 const part=(n:number)=>Number(BigInt(n)*BigInt(previousAmount+invoiceAmount)/BigInt(totalAmount)-BigInt(n)*BigInt(previousAmount)/BigInt(totalAmount));
 return {...tax,breakdown:tax.breakdown.map(r=>({...r,amount:part(r.amount),base:part(r.base)}))};
}
