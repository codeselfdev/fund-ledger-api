import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { migrateTelegramGroup, telegramGroupMigration } from './telegram-migration.service.js';
import { ApiError } from '../../core/http/api-error.js';
import { prisma } from '../../core/prisma/client.js';
import { badRequest, conflict, notFound, serviceUnavailable, unauthorized } from '../../core/http/api-error.js';
import type { Scope } from '../reports/report.policy.js';
export const telegramConfigured = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_USERNAME && process.env.TELEGRAM_WEBHOOK_SECRET);
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export function checkWebhookSecret(provided: string | undefined) {
  const expected=process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || !provided || !timingSafeEqual(Buffer.from(hash(expected)),Buffer.from(hash(provided)))) throw unauthorized('Invalid webhook secret');
}
export class TelegramGroupMigratedError extends ApiError {
  constructor(public readonly chatId: string) { super(400, 'TELEGRAM_GROUP_MIGRATED', 'Telegram upgraded this group. Reconnect the project group.'); }
}
export async function telegramApi<T>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
  if (!telegramConfigured()) throw serviceUnavailable('Telegram is not configured on the server');
  const form = body instanceof FormData;
  let response: Response;
  try { response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, { method:'POST', headers: form?undefined:{'Content-Type':'application/json'}, body:form?body:JSON.stringify(body), signal:AbortSignal.timeout(20000) }); }
  catch { throw serviceUnavailable('Telegram request failed or timed out'); }
  const result=await response.json() as {ok:boolean;result:T;description?:string;parameters?:{migrate_to_chat_id?:number}};
  if ((!response.ok || !result.ok) && Number.isSafeInteger(result.parameters?.migrate_to_chat_id) && Number(result.parameters?.migrate_to_chat_id) < -1000000000000) throw new TelegramGroupMigratedError(String(result.parameters!.migrate_to_chat_id));
  if (!response.ok || !result.ok) throw badRequest(result.description || 'Telegram rejected the request');
  return result.result;
}
export async function startTelegramLink(scope: Scope, targetChatId?: string) {
  if (!telegramConfigured()) throw serviceUnavailable('Fund Nesta is preparing the Telegram bot. Please try again later.');
  const code=`FL-${randomBytes(8).toString('hex').toUpperCase()}`;
  const link=await prisma.$transaction(async tx=> {
    await tx.telegramLink.updateMany({where:{tenantId:scope.tenantId,projectId:scope.projectId,userId:scope.userId,consumedAt:null},data:{expiresAt:new Date()}});
    return tx.telegramLink.create({data:{tenantId:scope.tenantId,projectId:scope.projectId,userId:scope.userId,targetChatId,codeHash:hash(code),expiresAt:new Date(Date.now()+600000)}});
  });
  return {id:link.id,code,command:`/connect ${code}`,expires_at:link.expiresAt,bot_username:process.env.TELEGRAM_BOT_USERNAME!.replace(/^@/,'')};
}
export async function receiveTelegramUpdate(update: unknown) {
  const migration = telegramGroupMigration(update);
  if (migration) { await migrateTelegramGroup(migration.from, migration.to); return; }
  const message=(update as {message?:{text?:string;chat?:{id:number;type:string;title?:string};from?:{id:number;is_bot?:boolean;first_name?:string;last_name?:string;username?:string}}})?.message;
  if(typeof message?.text!=='string') return;
  const match=message.text.trim().match(/^\/(?:connect|start)(?:@(\w+))?\s+(FL-[A-F0-9]{16})$/i);
  if (!match || !message?.chat || !['group','supergroup'].includes(message.chat.type) || !Number.isSafeInteger(message.chat.id) || !message.from || !Number.isSafeInteger(message.from.id) || message.from.is_bot) return;
  if(match[1] && match[1].toLowerCase()!==process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/,'').toLowerCase()) return;
  const link=await prisma.telegramLink.findUnique({where:{codeHash:hash(match[2].toUpperCase())}});
  if (!link || link.expiresAt <= new Date() || link.consumedAt) return;
  if(link.targetChatId && link.targetChatId!==String(message.chat.id)) return;
  const member=await telegramApi<{status:string}>('getChatMember',{chat_id:message.chat.id,user_id:message.from.id});
  if (link.targetChatId ? !['creator','administrator','member'].includes(member.status) : !['creator','administrator'].includes(member.status)) return;
  // First verified group wins. Replayed updates cannot change the candidate.
  await prisma.telegramLink.updateMany({where:{id:link.id,chatId:null,consumedAt:null,expiresAt:{gt:new Date()}},data:{chatId:String(message.chat.id),chatTitle:message.chat.title??'Telegram group',senderId:String(message.from.id),senderName:[message.from.first_name,message.from.last_name,message.from.username?`@${message.from.username}`:null].filter(Boolean).join(' ')||'Telegram member'}});
}
export async function telegramLinkStatus(scope: Scope,id:string) {
  const link=await prisma.telegramLink.findFirst({where:{id,tenantId:scope.tenantId,projectId:scope.projectId,userId:scope.userId}});
  if(!link) throw notFound('Connection request not found');
  return {id:link.id,chat_id:link.chatId,chat_title:link.chatTitle,expires_at:link.expiresAt,expired:link.expiresAt<=new Date(),consumed:!!link.consumedAt,sender_name:link.senderName??null};
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
      if(link.senderId) await tx.telegramBotIdentity.upsert({
        where:{projectId_userId:{projectId:scope.projectId,userId:scope.userId}},
        create:{tenantId:scope.tenantId,projectId:scope.projectId,userId:scope.userId,telegramUserId:link.senderId,displayName:link.senderName},
        update:{telegramUserId:link.senderId,displayName:link.senderName}
      });
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
