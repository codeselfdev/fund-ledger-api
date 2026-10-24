import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildProfessionalDocument} from '../dist/modules/accounting/document-pdf.js';
import {documentLogo} from '../dist/modules/accounting/document-logo.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZsAAAAASUVORK5CYII=','base64');
const data={kind:'quotation',number:'ABCQ26101001',status:'draft',documentDate:'2026-10-22',customerSnapshot:{name:'Sample customer'},lines:[{description:'Equipment',quantity:1,unit_price:1000}],subtotal:1000,discount:0,tax:0,total:1000};
const profile={name:'Test company',address:'Dhaka',phone:'',email:'',website:'',footer:'Test footer'};
test('five layouts render embedded logos, profile signatures, custom colors and independent paragraph snapshots',async()=>{
 const outputs=[];
 for(const templateId of ['classic','executive','minimal','corporate','elegant']){
  const result=await buildProfessionalDocument({...data,presentationSnapshot:{version:1,templateId,accentColor:'#F6CA75',profile,terms:{enabled:true,text:'**Equipment terms**'},disclaimer:{enabled:true,text:'*Specific disclaimer*'},preparedByName:'Amina Rahman',preparedBy:{id:'u',name:'Amina Rahman',designation:'Sales manager',mobile:'+8801711000009',email:'sales@example.com'}}},'BDT','Test company',{buffer:png,mime:'image/png'});
  assert.ok(result.pdf.subarray(0,5).equals(Buffer.from('%PDF-')));assert.match(result.pdf.toString('latin1'),/\/Subtype \/Image/);assert.match(result.html,/data:image\/png;base64/);assert.match(result.html,/Amina/);assert.match(result.html,/manager/);assert.match(result.html,/#F6CA75/);if(!['minimal','elegant'].includes(templateId))assert.match(result.html,/fill="#000000"/);outputs.push(result.html);
 }
 assert.equal(new Set(outputs).size,5);
});
test('project logo lookup is scoped, skips missing files and respects a saved no-logo snapshot',async()=>{
 const scope={tenantId:'t',projectId:'p'};let lookup,reads=0;
 const db={project:{findFirst:async()=>({logoFileId:'logo'})},upload:{findFirst:async({where})=>{lookup=where;return {storageKey:'project/logo.png',mimeType:'image/png'};}}};
 const read=async key=>{reads++;assert.equal(key,'project/logo.png');return {buffer:png};};
 assert.ok(await documentLogo(db,scope,{},read));assert.equal(lookup.tenantId,'t');assert.equal(lookup.projectId,'p');assert.equal(lookup.purpose,'project_logo');
 assert.equal(await documentLogo(db,scope,{logoFileId:null},read),null);assert.equal(reads,1);
 db.upload.findFirst=async()=>null;assert.equal(await documentLogo(db,scope,{logoFileId:'foreign'},read),null);assert.equal(reads,1);
});

test('empty PDF values omit their labels, section titles and unused optional item columns',async()=>{
 const result=await buildProfessionalDocument({...data,dueDate:null,note:'  ',customerSnapshot:{name:'Customer',address:'  ',email:null,mobile:''},quotationPersonSnapshot:{name:'Buyer',designation:' ',email:'',mobile:null},presentationSnapshot:{version:1,profile:{...profile,address:' ',phone:' ',email:' ',website:''},terms:{enabled:true,text:'  '},disclaimer:{enabled:true,text:''},preparedByName:'',preparedBy:{id:'u',name:' ',designation:'',mobile:'',email:''}}},'BDT','Company');
 const html=result.html.slice(result.html.indexOf('<body>'));
 for(const label of ['Address:', 'Designation:', 'Email:', 'Phone:', 'Valid / due until:', 'Prepared by:', 'Terms and Conditions', 'DISCLAIMER', '>Note<', '>Item code<', '>Model<', '>UOM<'])assert.ok(!html.includes(label),'Unexpected empty label '+label);
 assert.match(html,/Customer/);assert.match(html,/Buyer/);assert.match(html,/1,000.00/);assert.match(html,/Description/);
});
test('populated addresses and optional item columns remain, and zero prices are still displayed',async()=>{
 const result=await buildProfessionalDocument({...data,customerSnapshot:{name:'Customer',address:'Dhaka, Bangladesh',mobile:'+8801711000009'},lines:[{description:'Free accessory',quantity:1,unit_price:0,item_code:'ACC-1',model:'Model A',unit:'pcs'},{description:'Equipment',quantity:1,unit_price:1000}]},'BDT','Company');
 const html=result.html.slice(result.html.indexOf('<body>'));assert.match(html,/Address:/);assert.match(html,/Phone:/);assert.match(html,/Item code/);assert.match(html,/>Model</);assert.match(html,/>UOM</);assert.match(html,/0.00/);assert.match(html,/ACC-1/);
});

test('configured properties appear under descriptions in selected order for each document type',async()=>{
 const itemDetails={quotation:['attributes.warranty','sku'],order:[],sale:['sku']},line={description:'Test equipment',quantity:1,unit_price:1000,item_code:'LEGACY-CODE',model:'LEGACY-MODEL',item_details:[{key:'sku',label:'SKU',value:'SN-001'},{key:'attributes.warranty',label:'Warranty',value:'No'},{key:'cost_price',label:'INTERNAL',value:'12345'}]};
 for(const kind of ['quotation','order','sale']){
  const r=await buildProfessionalDocument({...data,kind,lines:[line],presentationSnapshot:{version:1,profile,itemDetails,terms:{enabled:false,text:''},disclaimer:{enabled:false,text:''}}},'BDT','Company');const html=r.html.slice(r.html.indexOf('<body>'));assert.ok(!html.includes('LEGACY-'));assert.ok(!html.includes('INTERNAL'));assert.ok(!html.includes('Item code'));assert.equal(html.includes('SN-001'),kind!=='order');assert.equal(html.includes('Warranty:'),kind==='quotation');if(kind==='quotation')assert.ok(html.indexOf('Warranty:')<html.indexOf('SKU:'));assert.match(html,/1,000.00/);
 }
});
test('long selected property values paginate safely and HTML previews escape markup',async()=>{
 const r=await buildProfessionalDocument({...data,lines:[{description:'Long specifications',quantity:1,unit_price:1000,item_details:[{key:'attributes.spec',label:'<Spec>',value:'<script>example</script> '+('detailed specification '.repeat(1500))}]}],presentationSnapshot:{version:1,profile,itemDetails:{quotation:['attributes.spec'],order:[],sale:[]},terms:{enabled:false,text:''},disclaimer:{enabled:false,text:''}}},'BDT','Company');assert.ok(r.pages>1);assert.match(r.html,/&lt;Spec&gt;/);assert.ok(!r.html.includes('<script>'));assert.ok(r.html.includes('1 / '+r.pages));
});

test('PDF Description choice affects only Description across all layouts and document kinds',async()=>{
 for(const templateId of ['classic','executive','minimal','corporate','elegant']) for(const kind of ['quotation','order','sale']) for(const choice of [false,true,undefined]){
  const itemDetails={quotation:['description','sku'],order:['description','sku'],sale:['description','sku']};
  const line={description:'Essential item name',quantity:1,unit_price:1000,item_details:[{key:'description',label:'Description',value:'OPTIONALDESC'},{key:'sku',label:'SKU',value:'KEEPSKU'}]};
  const result=await buildProfessionalDocument({...data,kind,lines:[line],presentationSnapshot:{version:1,templateId,profile,itemDetails,includeItemDescription:choice,terms:{enabled:false,text:''},disclaimer:{enabled:false,text:''}}},'BDT','Company');
  assert.ok(result.pdf.subarray(0,5).equals(Buffer.from('%PDF-')));assert.equal(result.html.includes('OPTIONALDESC'),choice!==false);assert.match(result.html,/KEEPSKU/);assert.match(result.html,/Essential/);assert.match(result.html,/1,000.00/);
 }
 const legacy=await buildProfessionalDocument({...data,lines:[{description:'Item',quantity:1,unit_price:1000,item_code:'L-1',item_details:[{key:'description',label:'Description',value:'ADDEDDESC'}]}],presentationSnapshot:{version:1,profile,itemDetails:null,includeItemDescription:true,terms:{enabled:false,text:''},disclaimer:{enabled:false,text:''}}},'BDT','Company');assert.match(legacy.html,/ADDEDDESC/);assert.match(legacy.html,/L-1/);
});
