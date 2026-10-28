import test,{beforeEach,after}from'node:test';
import assert from'node:assert/strict';
import{createHmac}from'node:crypto';
Object.assign(process.env,{DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',JWT_SECRET:'telegram-tests-only',TELEGRAM_BOT_TOKEN:'test-token',TELEGRAM_BOT_USERNAME:'FundNestaBot',TELEGRAM_WEBHOOK_SECRET:'test-webhook',AI_SERVICE_URL:'http://127.0.0.1:4010',AI_SERVICE_SHARED_SECRET:'test-shared-secret-more-than-thirty-two'});
const{prisma}=await import('../dist/core/prisma/client.js');
const{receiveTelegramUpdate,telegramLinkStatus}=await import('../dist/modules/integrations/telegram.service.js');
const{confirmTelegramIdentityLink,forwardTelegramAssistantUpdate,assertTelegramReplyDelivery}=await import('../dist/modules/integrations/telegram-assistant.service.js');
const scope={tenantId:'tenant',projectId:'project',userId:'user'},originalFetch=globalThis.fetch;
let link,identity,checks,forwarded,memberStatus,botStatus,botUsername,readAllMessages,webhook;
beforeEach(()=>{
 link={id:'link',...scope,codeHash:'hash',targetChatId:'-100',chatId:null,senderId:null,expiresAt:new Date(Date.now()+600000),consumedAt:null};identity=null;checks=0;forwarded=[];memberStatus='member';botStatus='administrator';botUsername='FundNestaBot';readAllMessages=false;webhook={url:'https://api.example.test/v1/integrations/telegram/webhook',allowed_updates:['message','callback_query']};
 prisma.telegramLink.findUnique=async()=>link;
 prisma.telegramLink.findFirst=async({where})=>where.userId===scope.userId&&where.tenantId===scope.tenantId&&where.projectId===scope.projectId?link:null;
 prisma.telegramLink.updateMany=async({where,data})=>{if((where.chatId===null&&link.chatId!==null)||(where.consumedAt===null&&link.consumedAt)||where.expiresAt?.gt>=link.expiresAt)return{count:0};Object.assign(link,data);return{count:1};};
 prisma.telegramConnection.findFirst=async()=>({tenantId:'tenant',projectId:'project',chatId:'-100'});
 prisma.telegramBotIdentity.upsert=async({create,update})=>{identity=identity?{...identity,...update}:create;return identity;};
 prisma.telegramBotIdentity.findUnique=async()=>identity;
 prisma.$transaction=async fn=>fn(prisma);prisma.activity.create=async()=>({});
 globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith('https://api.telegram.org/')){
   checks++;
   const method=String(url).split('/').at(-1);
   if(method==='getMe')return Response.json({ok:true,result:{id:456,username:botUsername,can_read_all_group_messages:readAllMessages}});
   if(method==='getWebhookInfo')return Response.json({ok:true,result:webhook});
   return Response.json({ok:true,result:{status:JSON.parse(options.body).user_id===456?botStatus:memberStatus}});
  }
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
 const update={update_id:1,message:{message_id:1,text:'@FundNestaBot balance',chat:{id:-100,type:'supergroup'},from:{id:123,is_bot:false}}};
 await forwardTelegramAssistantUpdate({...update,message:{...update.message,text:'ordinary conversation'}});assert.equal(forwarded.length,0);
 await forwardTelegramAssistantUpdate(update);assert.equal(forwarded.length,1);const f=forwarded[0];assert.equal(f.url,'http://127.0.0.1:4010/webhooks/telegram');assert.equal(f.headers['x-fundnesta-signature'],`sha256=${createHmac('sha256',process.env.AI_SERVICE_SHARED_SECRET).update(f.body).digest('hex')}`);
});

test('bridge forwards our native button callbacks using the clicker and signs the complete update',async()=>{
 const update={update_id:2,callback_query:{id:'click-2',data:'fn:'+'x'.repeat(43),from:{id:123,is_bot:false},message:{message_id:99,date:0,chat:{id:-100,type:'supergroup'},from:{id:456,is_bot:true,username:'FundNestaBot'}}}};
 await forwardTelegramAssistantUpdate(update);assert.equal(forwarded.length,1);
 const f=forwarded[0];assert.deepEqual(JSON.parse(f.body),update);assert.equal(f.headers['x-fundnesta-signature'],`sha256=${createHmac('sha256',process.env.AI_SERVICE_SHARED_SECRET).update(f.body).digest('hex')}`);
});
test('bridge rejects private, anonymous, foreign-bot, bot-clicker and malformed callbacks',async()=>{
 const original={update_id:3,callback_query:{id:'click-3',data:'fn:'+'x'.repeat(43),from:{id:123,is_bot:false},message:{message_id:99,chat:{id:-100,type:'supergroup'},from:{id:456,is_bot:true,username:'FundNestaBot'}}}};
 for(const mutate of [u=>u.callback_query.from.is_bot=true,u=>u.callback_query.message.chat={id:123,type:'private'},u=>u.callback_query.message.sender_chat={id:-100},u=>u.callback_query.message.from.username='OtherBot',u=>u.callback_query.data='CONFIRM abc',u=>u.callback_query.inline_message_id='inline',u=>u.callback_query.message.message_id=0]){const update=structuredClone(original);mutate(update);await forwardTelegramAssistantUpdate(update);}
 assert.equal(forwarded.length,0);
});


test('reply setup detects an outgoing-only bot that cannot receive mentions',async()=>{
 botStatus='member';
 await assert.rejects(assertTelegramReplyDelivery(scope),error=>error.code==='TELEGRAM_BOT_PERMISSIONS_REQUIRED'&&/group administrator/.test(error.message));
 assert.equal(identity,null);assert.equal(link.consumedAt,null);assert.equal(forwarded.length,0);
});
test('reply setup allows group admins and privacy-disabled member bots without changing Telegram settings',async()=>{
 await assertTelegramReplyDelivery(scope);
 botStatus='member';readAllMessages=true;
 await assertTelegramReplyDelivery(scope);
 assert.equal(identity,null);assert.equal(forwarded.length,0);
});
test('reply setup rejects missing message webhooks, wrong bot usernames and removed bots',async()=>{
 for(const value of [{url:''},{url:'https://api.example.test/webhook',allowed_updates:['callback_query']}]){
  webhook=value;await assert.rejects(assertTelegramReplyDelivery(scope),error=>error.code==='TELEGRAM_WEBHOOK_REQUIRED');
 }
 webhook={url:'https://api.example.test/webhook',allowed_updates:[]};
 await assertTelegramReplyDelivery(scope);
 botUsername='OtherBot';await assert.rejects(assertTelegramReplyDelivery(scope),error=>error.code==='TELEGRAM_BOT_CONFIGURATION_REQUIRED');
 botUsername='FundNestaBot';botStatus='left';await assert.rejects(assertTelegramReplyDelivery(scope),error=>error.code==='TELEGRAM_BOT_PERMISSIONS_REQUIRED');
 assert.equal(link.consumedAt,null);assert.equal(identity,null);
});
test('reply setup looks up only the current tenant and project group',async()=>{
 let requested;
 prisma.telegramConnection.findFirst=async args=>{requested=args;return null;};
 await assert.rejects(assertTelegramReplyDelivery(scope),/Connect your project Telegram group/);
 assert.deepEqual(requested.where,{tenantId:'tenant',projectId:'project'});assert.equal(checks,0);
});
