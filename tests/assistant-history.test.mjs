import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantHistoryQuery, assistantHistoryWindow } from '../dist/modules/assistant/assistant-history.js';
const scope={tenantId:'tenant',projectId:'project',userId:'user',authorizationHash:'current-authorization',channel:'ai_chat'};
test('archive cursors preserve authorization and use stable time/ID ordering',async()=>{
 const calls=[],date=new Date('2026-10-23T08:00:00Z');
 const db={assistantReply:{findFirst:async args=>{calls.push(args);assert.deepEqual(args.where.AND,[scope,{id:'cursor'}]);return{id:'cursor',createdAt:date};}}};
 const query=await assistantHistoryQuery(db,scope,{page:'true',before:'cursor'});
 assert.equal(query.take,31);assert.equal(query.paged,true);assert.deepEqual(query.where.AND[0],scope);assert.deepEqual(query.orderBy,[{createdAt:'desc'},{id:'desc'}]);assert.deepEqual(query.where.AND[1].OR,[{createdAt:{lt:date}},{createdAt:date,id:{lt:'cursor'}}]);assert.equal(calls.length,1);
 const first=await assistantHistoryQuery(db,scope,{});assert.equal(first.take,30);assert.equal(first.paged,false);assert.deepEqual(first.where,scope);
});
test('foreign, revoked or expired archive cursors fail without broadening scope',async()=>{
 const db={assistantReply:{findFirst:async args=>{assert.deepEqual(args.where.AND[0],scope);return null;}}};
 await assert.rejects(assistantHistoryQuery(db,scope,{page:'true',before:'foreign'}),/cursor is unavailable/);
 await assert.rejects(assistantHistoryQuery(db,scope,{page:'true',before:''}));
});
test('history pages return 30 chronological records with a cursor only when more records exist',()=>{
 const input=Array.from({length:31},(_,index)=>({id:String(100-index)}));
 const page=assistantHistoryWindow(input,true);assert.equal(page.rows.length,30);assert.equal(page.rows[0].id,'71');assert.equal(page.rows.at(-1).id,'100');assert.equal(page.next_cursor,'71');assert.equal(input.length,31);
 assert.equal(assistantHistoryWindow(input.slice(0,30),true).next_cursor,null);assert.equal(assistantHistoryWindow([],true).next_cursor,null);assert.equal(assistantHistoryWindow(input,false).next_cursor,null);
});
