import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../../core/prisma/client.js';
import { badRequest, conflict, notFound, serviceUnavailable, unauthorized } from '../../core/http/api-error.js';
import type { Scope } from '../reports/report.policy.js';
export const telegramConfigured = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_USERNAME && process.env.TELEGRAM_WEBHOOK_SECRET);
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export function checkWebhookSecret(provided: string | undefined) {
  const expected=process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || !provided || !timingSafeEqual(Buffer.from(hash(expected)),Buffer.from(hash(provided)))) throw unauthorized('Invalid webhook secret');
}
export async function telegramApi<T>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
  if (!telegramConfigured()) throw serviceUnavailable('Telegram is not configured on the server');
  const form = body instanceof FormData;
  let response: Response;
  try { response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, { method:'POST', headers: form?undefined:{'Content-Type':'application/json'}, body:form?body:JSON.stringify(body), signal:AbortSignal.timeout(20000) }); }
  catch { throw serviceUnavailable('Telegram request failed or timed out'); }
  const result=await response.json() as {ok:boolean;result:T;description?:string};
  if (!response.ok || !result.ok) throw badRequest(result.description || 'Telegram rejected the request');
  return result.result;
}
export async function startTelegramLink(scope: Scope) {
  if (!telegramConfigured()) throw serviceUnavailable('Ask the server administrator to configure the Telegram bot and webhook');
  const code=`FL-${randomBytes(8).toString('hex').toUpperCase()}`;
  const link=await prisma.$transaction(async tx=> {
    await tx.telegramLink.updateMany({where:{tenantId:scope.tenantId,projectId:scope.projectId,userId:scope.userId,consumedAt:null},data:{expiresAt:new Date()}});
    return tx.telegramLink.create({data:{tenantId:scope.tenantId,projectId:scope.projectId,userId:scope.userId,codeHash:hash(code),expiresAt:new Date(Date.now()+600000)}});
  });
  return {id:link.id,code,command:`/connect ${code}`,expires_at:link.expiresAt,bot_username:process.env.TELEGRAM_BOT_USERNAME!.replace(/^@/,'')};
}
export async function receiveTelegramUpdate(update: unknown) {
  const message=(update as {message?:{text?:string;chat?:{id:number;type:string;title?:string};from?:{id:number;is_bot?:boolean}}})?.message;
  if(typeof message?.text!=='string') return;
  const match=message.text.trim().match(/^\/connect(?:@\w+)?\s+(FL-[A-F0-9]{16})$/i);
  if (!match || !message?.chat || !['group','supergroup'].includes(message.chat.type) || !Number.isSafeInteger(message.chat.id) || !message.from || !Number.isSafeInteger(message.from.id) || message.from.is_bot) return;
  const link=await prisma.telegramLink.findUnique({where:{codeHash:hash(match[1].toUpperCase())}});
  if (!link || link.expiresAt <= new Date() || link.consumedAt) return;
  const member=await telegramApi<{status:string}>('getChatMember',{chat_id:message.chat.id,user_id:message.from.id});
  if (!['creator','administrator'].includes(member.status)) return;
  // First verified group wins. Replayed updates cannot change the candidate.
  await prisma.telegramLink.updateMany({where:{id:link.id,chatId:null,consumedAt:null,expiresAt:{gt:new Date()}},data:{chatId:String(message.chat.id),chatTitle:message.chat.title??'Telegram group'}});
}
export async function telegramLinkStatus(scope: Scope,id:string) {
  const link=await prisma.telegramLink.findFirst({where:{id,tenantId:scope.tenantId,projectId:scope.projectId,userId:scope.userId}});
  if(!link) throw notFound('Connection request not found');
  return {id:link.id,chat_id:link.chatId,chat_title:link.chatTitle,expires_at:link.expiresAt,expired:link.expiresAt<=new Date(),consumed:!!link.consumedAt};
}
export async function confirmTelegramLink(scope: Scope,id:string) {
  const link=await prisma.telegramLink.findFirst({where:{id,tenantId:scope.tenantId,projectId:scope.projectId,userId:scope.userId}});
  if(!link || !link.chatId || link.expiresAt<=new Date() || link.consumedAt) throw badRequest('Connection code has expired or no group has been verified');
  const me=await telegramApi<{id:number}>('getMe',{});
  const member=await telegramApi<{status:string}>('getChatMember',{chat_id:link.chatId,user_id:me.id});
  if(!['member','administrator','creator'].includes(member.status)) throw badRequest('Add the bot to the group and allow it to post messages and files');
  const chat=await telegramApi<{title?:string}>('getChat',{chat_id:link.chatId});
  try {
    return await prisma.$transaction(async tx=>{
      const consumed=await tx.telegramLink.updateMany({where:{id:link.id,consumedAt:null,expiresAt:{gt:new Date()}},data:{consumedAt:new Date()}});
      if(!consumed.count) throw conflict('Connection code was already used');
      return tx.telegramConnection.upsert({where:{projectId:scope.projectId},create:{tenantId:scope.tenantId,projectId:scope.projectId,chatId:link.chatId!,chatTitle:chat.title??link.chatTitle??'Telegram group'},update:{chatId:link.chatId!,chatTitle:chat.title??link.chatTitle??'Telegram group',connectedAt:new Date()}});
    });
  } catch(error) { if ((error as {code?:string}).code==='P2002') throw conflict('This group is already connected to another project'); throw error; }
}
export async function sendTelegramPost(scope: Pick<Scope,'tenantId'|'projectId'>,label:string,key:string,text:string,files:{filename:string;buffer:Buffer}[]=[]): Promise<void> {
  const connection=await prisma.telegramConnection.findFirst({where:scope});
  if(!connection) throw badRequest('Connect a Telegram group first');
  let post;
  try { post=await prisma.integrationPost.create({data:{...scope,label,dedupeKey:key}}); }
  catch(error) { if((error as {code?:string}).code==='P2002') return; throw error; }
  try {
    if(files.length) for(const file of files) {
      const form=new FormData();form.append('chat_id',connection.chatId);form.append('caption',text.slice(0,1024));form.append('document',new Blob([new Uint8Array(file.buffer)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),file.filename);
      await telegramApi('sendDocument',form);
    } else await telegramApi('sendMessage',{chat_id:connection.chatId,text:text.slice(0,4096)});
    await prisma.integrationPost.update({where:{id:post.id},data:{status:'sent'}});
  } catch(error) { await prisma.integrationPost.update({where:{id:post.id},data:{status:'failed',error:error instanceof Error?error.message:'Delivery failed'}});throw error; }
}
