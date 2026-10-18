import test,{beforeEach,after}from'node:test';
import assert from'node:assert/strict';
import{createHmac}from'node:crypto';
Object.assign(process.env,{DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',JWT_SECRET:'telegram-tests-only',TELEGRAM_BOT_TOKEN:'test-token',TELEGRAM_BOT_USERNAME:'FundNestaBot',TELEGRAM_WEBHOOK_SECRET:'test-webhook',AI_SERVICE_URL:'http://127.0.0.1:4010',AI_SERVICE_SHARED_SECRET:'test-shared-secret-more-than-thirty-two'});
const{prisma}=await import('../dist/core/prisma/client.js');
const{receiveTelegramUpdate,telegramLinkStatus}=await import('../dist/modules/integrations/telegram.service.js');
const{confirmTelegramIdentityLink,forwardTelegramAssistantUpdate}=await import('../dist/modules/integrations/telegram-assistant.service.js');
const scope={tenantId:'tenant',projectId:'project',userId:'user'},originalFetch=globalThis.fetch;
let link,identity,checks,forwarded,memberStatus;
beforeEach(()=>{
 link={id:'link',...scope,codeHash:'hash',targetChatId:'-100',chatId:null,senderId:null,expiresAt:new Date(Date.now()+600000),consumedAt:null};identity=null;checks=0;forwarded=[];memberStatus='member';
 prisma.telegramLink.findUnique=async()=>link;
 prisma.telegramLink.findFirst=async({where})=>where.userId===scope.userId&&where.tenantId===scope.tenantId&&where.projectId===scope.projectId?link:null;
 prisma.telegramLink.updateMany=async({where,data})=>{if((where.chatId===null&&link.chatId!==null)||(where.consumedAt===null&&link.consumedAt)||where.expiresAt?.gt>=link.expiresAt)return{count:0};Object.assign(link,data);return{count:1};};
 prisma.telegramConnection.findFirst=async()=>({tenantId:'tenant',projectId:'project',chatId:'-100'});
 prisma.telegramBotIdentity.upsert=async({create,update})=>{identity=identity?{...identity,...update}:create;return identity;};
 prisma.telegramBotIdentity.findUnique=async()=>identity;
 prisma.$transaction=async fn=>fn(prisma);prisma.activity.create=async()=>({});
 globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith('https://api.telegram.org/')){checks++;return Response.json({ok:true,result:{status:memberStatus}});}
  forwarded.push({url:String(url),headers:options.headers,body:options.body});return new Response('OK');
 };
});
after(async()=>{globalThis.fetch=originalFetch;await prisma.$disconnect();});
const command=(chat=-100,bot='FundNestaBot')=>({message:{text:`/connect@${bot} FL-0123456789ABCDEF`,chat:{id:chat,type:'supergroup',title:'Committee'},from:{id:123,first_name:'Alice',username:'alice',is_bot:false}}});
test('personal linking binds only the target group and records the exact sender for app review',async()=>{
 await receiveTelegramUpdate(command(-200));assert.equal(link.chatId,null);assert.equal(checks,0);
 await receiveTelegramUpdate(command(-100,'OtherBot'));assert.equal(link.chatId,null);
 await receiveTelegramUpdate(command());assert.equal(link.chatId,'-100');assert.equal(link.senderId,'123');assert.match((await telegramLinkStatus(scope,'link')).sender_name,/Alice/);assert.equal(identity,null);
 await confirmTelegramIdentityLink(scope,'link');assert.equal(identity.telegramUserId,'123');assert.equal(identity.userId,'user');
 await confirmTelegramIdentityLink(scope,'link');assert.equal(identity.telegramUserId,'123');
});
test('expired, foreign-user and unverified identities cannot be confirmed',async()=>{
 await assert.rejects(confirmTelegramIdentityLink(scope,'link'));
 await receiveTelegramUpdate(command());await assert.rejects(confirmTelegramIdentityLink({...scope,userId:'foreign'},'link'));
 link.expiresAt=new Date(0);await assert.rejects(confirmTelegramIdentityLink(scope,'link'));assert.equal(identity,null);
});
test('initial group mapping still requires a group administrator',async()=>{
 link.targetChatId=null;await receiveTelegramUpdate(command());assert.equal(link.chatId,null);
 memberStatus='administrator';await receiveTelegramUpdate(command());assert.equal(link.chatId,'-100');
});
test('bridge forwards only mentions and preserves integrity with a body signature',async()=>{
 const update={update_id:1,message:{text:'@FundNestaBot balance',chat:{id:-100,type:'supergroup'},from:{id:123,is_bot:false}}};
 await forwardTelegramAssistantUpdate({...update,message:{...update.message,text:'ordinary conversation'}});assert.equal(forwarded.length,0);
 await forwardTelegramAssistantUpdate(update);assert.equal(forwarded.length,1);const f=forwarded[0];assert.equal(f.url,'http://127.0.0.1:4010/webhooks/telegram');assert.equal(f.headers['x-fundnesta-signature'],`sha256=${createHmac('sha256',process.env.AI_SERVICE_SHARED_SECRET).update(f.body).digest('hex')}`);
});
