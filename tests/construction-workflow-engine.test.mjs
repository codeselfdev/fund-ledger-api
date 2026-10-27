import {test} from 'node:test';
import assert from 'node:assert/strict';
import {receiptBalances,matchInvoice,apportionedPurchaseTax,safeAmount} from '../dist/modules/construction/construction.workflow.engine.js';
const order={totalAmount:1100,lines:[{id:'l',itemId:'i',quantity:10,unitCost:100}]},receipts=[{status:'approved',checkedLines:[{purchase_line_id:'l',accepted:4,rejected:2}]},{status:'pending',checkedLines:[{purchase_line_id:'l',accepted:6,rejected:0}]}];
test('only approved accepted receipts reduce purchase balance; rejected goods remain replaceable',()=>{
 assert.deepEqual(receiptBalances(order.lines,receipts)[0],{...order.lines[0],accepted:4,rejected:2,outstanding:6});
});
test('three-way matching checks PO quantity, accepted quantity, prior invoices, price and cumulative charges',()=>{
 const bill={id:'a',lines:[{purchase_line_id:'l',quantity:4,unit_cost:100}],charges:40,amount:440};assert.equal(matchInvoice(order,receipts,[],bill).matched,true);
 for(const changed of [{lines:[{purchase_line_id:'l',quantity:5,unit_cost:100}],amount:540},{lines:[{purchase_line_id:'l',quantity:4,unit_cost:101}],amount:444},{charges:101,amount:501}])assert.equal(matchInvoice(order,receipts,[],{...bill,...changed}).matched,false);
 assert.equal(matchInvoice(order,receipts,[{...bill,status:'approved'}],{...bill,id:'b'}).matched,false);
 assert.equal(matchInvoice(order,receipts,[{...bill,status:'approved'}],bill).matched,true);
 assert.equal(matchInvoice(order,receipts,[],{lines:[],amount:100,charges:100}).matched,false);
 const full=[{status:'approved',checkedLines:[{purchase_line_id:'l',accepted:10,rejected:0}]}];assert.equal(matchInvoice(order,full,[],{lines:[],amount:100,charges:100}).matched,true);
});
test('partial invoice tax apportionment conserves every rounded amount and base through the last invoice',()=>{
 const original={version:1,breakdown:[{id:'tax',amount:7,base:100},{id:'withhold',amount:3,base:100}]};let previous=0;const chunks=[33,33,34].map(amount=>{const result=apportionedPurchaseTax(original,previous,amount,100);previous+=amount;return result;});for(let i=0;i<2;i++){assert.equal(chunks.reduce((n,c)=>n+c.breakdown[i].amount,0),original.breakdown[i].amount);assert.equal(chunks.reduce((n,c)=>n+c.breakdown[i].base,0),100);}assert.equal(apportionedPurchaseTax(null,0,10,100),null);
});
test('unsafe line totals cannot become payable amounts',()=>{assert.equal(safeAmount(2147483647),2147483647);for(const n of [2147483648,-1,.5,Infinity,Number.MAX_SAFE_INTEGER])assert.throws(()=>safeAmount(n));});
