import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
Object.assign(process.env,{DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',JWT_SECRET:'test-socket-secret',CORS_ORIGIN:'https://app.example'});
const {attachAssistantEvents,assistantEventTicket,assistantEventScope,publishAssistantPhase}=await import('../dist/modules/ai-service/assistant-events.js');
const auth={tenantId:'tenant',projectId:'project',userId:'user',sessionId:'session'};
async function fixture(t){
 const server=createServer();const stop=attachAssistantEvents(server);server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{stop();await new Promise(r=>server.close(r));});
 const connect=async(ticket,origin='https://app.example')=>{const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/ai-service/events`,{origin});await once(ws,'open');const response=once(ws,'message');ws.send(JSON.stringify({ticket}));return {ws,response};};
 return {connect,server};
}
test('socket progress is isolated by tenant, project, user, session and request key',async t=>{
 const {connect}=await fixture(t),grant=assistantEventTicket(auth,'request');
 const {ws,response}=await connect(grant.ticket);assert.equal(JSON.parse((await response)[0]).type,'ready');
 const events=[];ws.on('message',raw=>events.push(JSON.parse(raw)));
 for(const field of ['tenantId','projectId','userId','sessionId'])publishAssistantPhase(assistantEventScope({...auth,[field]:'other'},'request'),'reading_records');
 publishAssistantPhase(assistantEventScope(auth,'other-request'),'reading_records');
 publishAssistantPhase(assistantEventScope(auth,'request'),'untrusted phase');
 const received=once(ws,'message');publishAssistantPhase(assistantEventScope(auth,'request'),'reading_records');await received;
 assert.deepEqual(events,[{type:'progress',phase:'reading_records'}]);
 ws.close();await once(ws,'close');
});
test('socket tickets are single use, expired tickets are rejected and only one subscription is accepted',async t=>{
 const {connect}=await fixture(t),grant=assistantEventTicket(auth,'request');
 const first=await connect(grant.ticket);await first.response;
 const replay=await connect(grant.ticket);replay.response.catch(()=>{});const [code]=await once(replay.ws,'close');assert.equal(code,1008);
 const closed=once(first.ws,'close');first.ws.send(JSON.stringify({ticket:grant.ticket}));assert.equal((await closed)[0],1008);
 const expired=assistantEventTicket(auth,'request');const oldNow=Date.now;Date.now=()=>oldNow()+31000;
 try{const client=await connect(expired.ticket);client.response.catch(()=>{});assert.equal((await once(client.ws,'close'))[0],1008);}finally{Date.now=oldNow;}
});
test('socket upgrades reject unapproved browser origins',async t=>{
 const {server}=await fixture(t);
 const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/ai-service/events`,{origin:'https://evil.example'});
 await assert.rejects(once(ws,'open'));
});
