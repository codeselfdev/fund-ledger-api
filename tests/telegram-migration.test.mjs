import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env,{DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',JWT_SECRET:'migration-tests-only'});
const {prisma}=await import('../dist/core/prisma/client.js');
const {telegramGroupMigration,migrateTelegramGroup,resolveTelegramConnection}=await import('../dist/modules/integrations/telegram-migration.service.js');
const {receiveTelegramUpdate,telegramApi,TelegramGroupMigratedError}=await import('../dist/modules/integrations/telegram.service.js');
const from='-200',to='-1000000000200',originalFetch=globalThis.fetch;
let connections,links,identities;
beforeEach(()=>{
 connections=[{id:'connection',tenantId:'tenant',projectId:'project',chatId:from,chatTitle:'Same group',report:true}];
 links=[{tenantId:'tenant',projectId:'project',chatId:from,targetChatId:from,consumedAt:null,expiresAt:new Date(Date.now()+600000)}];
 identities=[{tenantId:'tenant',projectId:'project'}];
 prisma.$transaction=async fn=>fn(prisma);
 prisma.telegramConnection.findUnique=async({where})=>connections.find(c=>c.chatId===where.chatId)??null;
 prisma.telegramConnection.findMany=async({where})=>connections.filter(c=>where.OR.some(i=>i.tenantId===c.tenantId&&i.projectId===c.projectId));
 prisma.telegramConnection.updateMany=async({where,data})=>{const c=connections.find(c=>c.id===where.id&&c.chatId===where.chatId);if(!c)return{count:0};Object.assign(c,data);return{count:1};};
 prisma.telegramLink.updateMany=async({where,data})=>{let count=0;for(const l of links)if(l.consumedAt===null&&l.expiresAt>where.expiresAt.gt&&(!where.chatId||l.chatId===where.chatId)&&(!where.targetChatId||l.targetChatId===where.targetChatId)){Object.assign(l,data);count++;}return{count};};
 prisma.telegramBotIdentity.findMany=async()=>identities;
});
after(async()=>{globalThis.fetch=originalFetch;await prisma.$disconnect();});
test('both Telegram service-message shapes migrate the same configured group idempotently',async()=>{
 const oldEvent={message:{chat:{id:Number(from),type:'group'},migrate_to_chat_id:Number(to)}};
 const newEvent={message:{chat:{id:Number(to),type:'supergroup'},migrate_from_chat_id:Number(from)}};
 for(const event of [oldEvent,newEvent])assert.deepEqual(telegramGroupMigration(event),{from,to});
 await receiveTelegramUpdate(oldEvent);await receiveTelegramUpdate(newEvent);
 assert.equal(connections.length,1);assert.equal(connections[0].chatId,to);assert.equal(connections[0].projectId,'project');assert.equal(connections[0].report,true);
 assert.equal(links[0].chatId,to);assert.equal(links[0].targetChatId,to);
});
test('text, forwards, private chats and malformed migration fields never change project mapping',()=>{
 for(const event of [
  {message:{forward_origin:{type:'user'},chat:{id:Number(from),type:'group'},migrate_to_chat_id:Number(to)}},
  {message:{text:'migrate_to_chat_id '+to,chat:{id:Number(from),type:'group'}}},
  {message:{chat:{id:123,type:'private'},migrate_to_chat_id:Number(to)}},
  {message:{chat:{id:Number(from),type:'group'},migrate_to_chat_id:to}},
  {message:{chat:{id:Number(from),type:'group'},migrate_to_chat_id:Number(to),migrate_from_chat_id:-123}},
  {message:{chat:{id:Number(from),type:'group'},migrate_to_chat_id:-123}},
 ])assert.equal(telegramGroupMigration(event),null);
});
test('missed migration is repaired only after Telegram proves the exact destination for a known identity',async()=>{
 let probes=0;
 assert.equal(await resolveTelegramConnection(to,'123',async id=>{probes++;assert.equal(id,from);return '-1000000000999';}),null);
 assert.equal(connections[0].chatId,from);
 const c=await resolveTelegramConnection(to,'123',async()=>to);assert.equal(c.chatId,to);assert.equal(probes,1);
 let unnecessary=0;await resolveTelegramConnection(to,'123',async()=>{unnecessary++;});assert.equal(unnecessary,0);
});
test('unknown identities and ambiguous migrations never bind a group',async()=>{
 identities=[];let probes=0;assert.equal(await resolveTelegramConnection(to,'999',async()=>{probes++;return to;}),null);assert.equal(probes,0);
 identities=[{tenantId:'tenant',projectId:'project'},{tenantId:'other',projectId:'other'}];
 connections.push({id:'other',tenantId:'other',projectId:'other',chatId:'-300'});
 assert.equal(await resolveTelegramConnection(to,'123',async()=>to),null);assert.equal(connections[0].chatId,from);
});
test('migration cannot overwrite a group assigned to another project',async()=>{
 connections.push({id:'foreign',tenantId:'foreign',projectId:'foreign',chatId:to});
 await assert.rejects(migrateTelegramGroup(from,to),e=>e.code==='CONFLICT');assert.equal(connections[0].chatId,from);
});
test('Telegram canonical ID errors are structured without relying on translated error text',async()=>{
 Object.assign(process.env,{TELEGRAM_BOT_TOKEN:'test-token',TELEGRAM_BOT_USERNAME:'FundNestaBot',TELEGRAM_WEBHOOK_SECRET:'test-secret'});
 globalThis.fetch=async()=>Response.json({ok:false,description:'translated provider message',parameters:{migrate_to_chat_id:Number(to)}},{status:400});
 await assert.rejects(telegramApi('getChat',{chat_id:from}),e=>e instanceof TelegramGroupMigratedError&&e.chatId===to);
});
