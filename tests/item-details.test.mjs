import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/test';process.env.JWT_SECRET='isolated-item-fields-test';
const {documentItemFields,validateItemDetails,snapshotItemDetails,selectedItemDetails}=await import('../dist/modules/accounting/item-details.js');
const field=(key,type='text',extra={})=>({id:key,key,label:key==='warranty'?'Warranty':key,type,options:[],required:false,searchable:false,match:'contains',filterable:false,showInList:false,position:0,archived:false,...extra});
const auth={tenantId:'tenant',projectId:'project'},config={quotation:['attributes.warranty','sku','cost_price'],order:[],sale:['attributes.sizes','attributes.blank','category']};
function fixture(){const queries=[];const item={id:'i',tenantId:'tenant',projectId:'project',isActive:true,sku:'OLD-SKU',costPrice:0,attributes:{warranty:false,sizes:['Small','Large'],blank:'  '},category:{name:'Equipment'}};const db={businessField:{findMany:async args=>{queries.push(args.where);return[field('warranty','boolean'),field('sizes','multi_select',{options:['Small','Large']}),field('blank'),field('archived','text',{archived:true})];}},businessConfiguration:{findFirst:async()=>null},inventoryItem:{findMany:async args=>{queries.push(args.where);return[item];}}};return{db,item,queries};}
test('catalog uses existing active fields from the current tenant and project',async()=>{const {db,queries}=fixture();const fields=await documentItemFields(db,auth);assert.ok(fields.some(f=>f.key==='attributes.warranty'));assert.ok(!fields.some(f=>f.key==='attributes.archived'));assert.deepEqual(queries[0],{...auth,entity:'item'});await assert.rejects(validateItemDetails(db,auth,{...config,sale:['attributes.archived']}),/unavailable or archived/);});
test('snapshot formats false, zero, choice lists and category; selection controls order and hides empty properties',async()=>{const {db,queries}=fixture();const [line]=await snapshotItemDetails(db,auth,[{item_id:'i'}],config);assert.deepEqual(selectedItemDetails(line,config,'quotation').map(f=>f.value),['No','OLD-SKU','0']);assert.deepEqual(selectedItemDetails(line,config,'sale').map(f=>f.value),['Small, Large','Equipment']);assert.deepEqual(selectedItemDetails(line,config,'order'),[]);assert.deepEqual(queries[1],{...auth,id:{in:['i']},isActive:true});});
test('saved values and labels survive catalog changes, field archival and line reordering',async()=>{const {db,item}=fixture();const [first]=await snapshotItemDetails(db,auth,[{item_id:'i'}],config);item.sku='NEW-SKU';db.businessField.findMany=()=>assert.fail('No live lookup for unchanged saved properties');const [other,again]=await snapshotItemDetails(db,auth,[{item_id:'i'},{item_id:'i'}],config,{lines:[first],presentationSnapshot:{itemDetails:config}});assert.equal(again.item_details.find(f=>f.key==='sku').value,'OLD-SKU');assert.notEqual(again.item_details,first.item_details);assert.deepEqual(other.item_details,again.item_details);});
test('applying a new field configuration refreshes inventory snapshots; missing scoped items fail',async()=>{const {db,item}=fixture();const lines=await snapshotItemDetails(db,auth,[{item_id:'i'}],config);item.sku='NEW-SKU';const [updated]=await snapshotItemDetails(db,auth,[{item_id:'i'}],{...config,quotation:['sku']},{lines,presentationSnapshot:{itemDetails:config}});assert.equal(updated.item_details.find(f=>f.key==='sku').value,'NEW-SKU');db.inventoryItem.findMany=async()=>[];await assert.rejects(snapshotItemDetails(db,auth,[{item_id:'foreign'}],config),/Catalog item not found/);});
test('external lines only use known external properties and edits update their captured values',async()=>{const {db}=fixture();const config={quotation:['sku','attributes.warranty'],order:[],sale:[]};const [line]=await snapshotItemDetails(db,auth,[{source:'external',item_code:'EX-1'}],config);assert.deepEqual(line.item_details,[{key:'sku',label:'SKU',value:'EX-1'}]);const [updated]=await snapshotItemDetails(db,auth,[{...line,item_code:'EX-2'}],config,{lines:[line],presentationSnapshot:{itemDetails:config}});assert.equal(updated.item_details[0].value,'EX-2');});

test('document Description choice captures catalog text independently of PDF settings and preserves saved values',async()=>{
 const {db,item}=fixture();item.description='Original technical description';
 const withoutDescription={quotation:['sku'],order:[],sale:[]};
 const [line]=await snapshotItemDetails(db,auth,[{item_id:'i'}],withoutDescription,undefined,true);
 assert.equal(selectedItemDetails(line,withoutDescription,'quotation',true).find(f=>f.key==='description').value,'Original technical description');
 assert.deepEqual(selectedItemDetails(line,withoutDescription,'quotation',false).map(f=>f.key),['sku']);
 item.description='Changed catalog description';item.sku='NEW-SKU';
 const [saved]=await snapshotItemDetails(db,auth,[{item_id:'i'}],withoutDescription,{lines:[line],presentationSnapshot:{itemDetails:withoutDescription,includeItemDescription:true}},true);
 assert.equal(saved.item_details.find(f=>f.key==='description').value,'Original technical description');assert.equal(saved.item_details.find(f=>f.key==='sku').value,'OLD-SKU');
 const [legacy]=await snapshotItemDetails(db,auth,[{item_id:'i'}],null,undefined,true);assert.deepEqual(legacy.item_details.map(f=>f.key),['description']);
 const [untrusted]=await snapshotItemDetails(db,auth,[{description:'Service',item_details:[{key:'description',label:'Description',value:'Injected'}]}],null,undefined,true);assert.deepEqual(untrusted.item_details,[]);
});

test('enabling Description on a saved document keeps its other historical property values',async()=>{
 const {db,item}=fixture(),config={quotation:['sku'],order:[],sale:[]};
 const lines=await snapshotItemDetails(db,auth,[{item_id:'i'}],config,undefined,false);item.sku='CHANGED';item.description='Added description';
 const [updated]=await snapshotItemDetails(db,auth,[{item_id:'i'}],config,{lines,presentationSnapshot:{itemDetails:config,includeItemDescription:false}},true);
 assert.equal(updated.item_details.find(v=>v.key==='sku').value,'OLD-SKU');assert.equal(updated.item_details.find(v=>v.key==='description').value,'Added description');
 item.sku='CHANGED AGAIN';
 const [excluded]=await snapshotItemDetails(db,auth,[{item_id:'i'}],config,{lines:[updated],presentationSnapshot:{itemDetails:config,includeItemDescription:true}},false);
 assert.equal(excluded.item_details.find(v=>v.key==='sku').value,'OLD-SKU');
 assert.deepEqual(selectedItemDetails(excluded,config,'quotation',false).map(v=>v.key),['sku']);
});

test('external descriptions are optional, validated separately from names and precede configured fields',async()=>{
 const {lineSchema,calculate}=await import('../dist/modules/accounting/workflow.js');
 const {db}=fixture(),config={quotation:['sku'],order:['sku'],sale:['sku']};
 const raw={description:'External equipment',item_description:'SPECIFICATION_ONE\nSPECIFICATION_TWO',source:'external',item_code:'EXTERNAL_CODE',quantity:1,unit_price:100};
 assert.equal(lineSchema.parse(raw).item_description,raw.item_description);
 assert.ok(lineSchema.safeParse({...raw,item_description:'x'.repeat(2000)}).success);
 assert.equal(lineSchema.safeParse({...raw,item_description:'x'.repeat(2001)}).success,false);
 assert.equal(lineSchema.safeParse({...raw,description:''}).success,false);
 const totals=calculate([lineSchema.parse(raw)],0,0);
 const [line]=await snapshotItemDetails(db,auth,totals.lines,config,undefined,true);
 for(const kind of ['quotation','order','sale'])assert.deepEqual(selectedItemDetails(line,config,kind,true).map(v=>v.key),['description','sku']);
 assert.deepEqual(selectedItemDetails(line,config,'quotation',false).map(v=>v.value),['EXTERNAL_CODE']);
 const [updated]=await snapshotItemDetails(db,auth,[{...line,item_description:'CHANGED_SPEC'}],config,{lines:[line],presentationSnapshot:{itemDetails:config,includeItemDescription:true}},true);
 assert.equal(selectedItemDetails(updated,config,'quotation',true)[0].value,'CHANGED_SPEC');
 const [blank]=await snapshotItemDetails(db,auth,[{...raw,item_description:''}],config,undefined,true);
 assert.deepEqual(selectedItemDetails(blank,config,'quotation',true).map(v=>v.key),['sku']);
 const [disabled]=await snapshotItemDetails(db,auth,[raw],null,undefined,false);assert.equal(disabled.item_description,raw.item_description);
 const [enabled]=await snapshotItemDetails(db,auth,[disabled],null,undefined,true);assert.equal(enabled.item_details[0].value,raw.item_description);
});
test('inventory descriptions are captured from the catalog rather than client line text',async()=>{
 const {db,item}=fixture();item.description='CATALOG_DESCRIPTION';
 const [line]=await snapshotItemDetails(db,auth,[{item_id:'i',item_description:'CLIENT_DESCRIPTION'}],null,undefined,true);
 assert.equal(line.item_details[0].value,'CATALOG_DESCRIPTION');
});
