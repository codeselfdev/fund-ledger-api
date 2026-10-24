import {test} from 'node:test';
import assert from 'node:assert/strict';
import {documentPresentation,selectionSchema} from '../dist/modules/accounting/document-settings.js';
const auth={tenantId:'t',projectId:'p'},profile={name:'Company',address:'',phone:'',email:'',website:'',footer:''};
const settings={revision:1,profile,itemDetails:{quotation:['description','sku'],order:[],sale:[]},terms:{enabled:false,text:''},disclaimer:{enabled:false,text:''}};
const db={project:{findFirst:async()=>({documentSettings:settings})},tenant:{findFirst:async()=>({name:'Company',documentPrefix:'COM',documentPrefixRevision:0})}};
test('new documents exclude Description; selection and saved snapshots retain the document choice',async()=>{
 const fresh=await documentPresentation(db,auth);assert.equal(fresh.includeItemDescription,false);
 const selection={revision:1,terms:false,disclaimer:false,item_description:true};assert.ok(selectionSchema.safeParse(selection).success);assert.equal(selectionSchema.safeParse({...selection,item_description:'yes'}).success,false);
 const included=await documentPresentation(db,auth,selection);assert.equal(included.includeItemDescription,true);assert.deepEqual(included.itemDetails,settings.itemDetails);
 const kept=await documentPresentation(db,auth,undefined,included);assert.equal(kept.includeItemDescription,true);
 const excluded=await documentPresentation(db,auth,{...selection,item_description:false},kept);assert.equal(excluded.includeItemDescription,false);assert.equal(kept.includeItemDescription,true);
 const legacy={...fresh};delete legacy.includeItemDescription;assert.equal((await documentPresentation(db,auth,{revision:1,terms:false,disclaimer:false},legacy)).includeItemDescription,undefined);
 const updated=await documentPresentation(db,auth,{...selection,revision:1}, {...included,settingsRevision:0});assert.equal(updated.includeItemDescription,true);
 await assert.rejects(documentPresentation(db,auth,{...selection,revision:99}),/templates changed/);
});
