import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { env } from '../../config/env.js';
import { ApiError } from '../../core/http/api-error.js';

export type AssistantPhase = 'connecting' | 'checking_access' | 'understanding_question' | 'reading_attachment' | 'reading_records' | 'preparing_draft' | 'verifying_result' | 'completed' | 'failed';
const phases = new Set<string>(['connecting','checking_access','understanding_question','reading_attachment','reading_records','preparing_draft','verifying_result','completed','failed']);
const tickets = new Map<string, {scope:string; owner:string; expires:number}>();
const listeners = new Map<string, Set<(phase:AssistantPhase)=>void>>();
const sockets = new Map<WebSocket, string>();
const ownerOf = (a:{tenantId:string;projectId?:string|null;userId:string;sessionId:string}) => JSON.stringify([a.tenantId,a.projectId,a.userId,a.sessionId]);
export const assistantEventScope = (a:Parameters<typeof ownerOf>[0], requestKey:string) => JSON.stringify([ownerOf(a),requestKey]);
export function assistantEventTicket(a:Parameters<typeof ownerOf>[0], requestKey:string) {
  const now=Date.now(),owner=ownerOf(a);
  for(const [key,value] of tickets)if(value.expires<=now)tickets.delete(key);
  if(tickets.size+sockets.size>=1000 || [...tickets.values()].filter(t=>t.owner===owner).length+[...sockets.values()].filter(value=>value===owner).length>=3)
    throw new ApiError(429,'AI_PROGRESS_LIMIT','Too many live chat connections.');
  const ticket=randomBytes(32).toString('hex');
  tickets.set(ticket,{scope:assistantEventScope(a,requestKey),owner,expires:now+30000});
  return {ticket,path:'/v1/ai-service/events'};
}
export function publishAssistantPhase(scope:string, phase:string) {
  if(!phases.has(phase))return;
  for(const listener of listeners.get(scope)??[])listener(phase as AssistantPhase);
}
export function attachAssistantEvents(server:Server) {
  const wss=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
  server.on('upgrade',(request,socket,head)=>{
    if(request.url!=='/v1/ai-service/events'){socket.destroy();return;}
    const origin=request.headers.origin;
    if(origin&&env.corsOrigin!=='*'&&origin!==env.corsOrigin){socket.destroy();return;}
    if(wss.clients.size>=1000){socket.destroy();return;}
    wss.handleUpgrade(request,socket,head,ws=>wss.emit('connection',ws,request));
  });
  wss.on('connection',ws=>{
    let scope:string|undefined,listener:((phase:AssistantPhase)=>void)|undefined;
    const authTimer=setTimeout(()=>ws.close(1008,'Authentication required'),5000);
    const lifetime=setTimeout(()=>ws.close(1000,'Progress subscription expired'),120000);
    ws.on('error',()=>{});
    ws.on('message',raw=>{
      if(scope){ws.close(1008,'Already subscribed');return;}
      let ticket:unknown;try{ticket=JSON.parse(raw.toString()).ticket;}catch{ws.close(1008,'Invalid subscription');return;}
      if(typeof ticket!=='string'){ws.close(1008,'Invalid subscription');return;}
      const grant=tickets.get(ticket);tickets.delete(ticket);
      if(!grant||grant.expires<=Date.now()){ws.close(1008,'Subscription expired');return;}
      clearTimeout(authTimer);scope=grant.scope;sockets.set(ws,grant.owner);
      listener=phase=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'progress',phase}));};
      const group=listeners.get(scope)??new Set();group.add(listener);listeners.set(scope,group);
      ws.send(JSON.stringify({type:'ready'}));
    });
    ws.on('close',()=>{
      clearTimeout(authTimer);clearTimeout(lifetime);sockets.delete(ws);
      if(scope&&listener){const group=listeners.get(scope);group?.delete(listener);if(!group?.size)listeners.delete(scope);}
    });
  });
  return ()=>{for(const ws of wss.clients)ws.terminate();wss.close();tickets.clear();};
}
