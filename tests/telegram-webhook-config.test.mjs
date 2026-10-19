import test from 'node:test';
import assert from 'node:assert/strict';
import {buttonWebhookSettings,configureTelegramButtons} from '../scripts/configure-telegram-webhook.mjs';
test('button setup preserves the existing endpoint, update types, queued events and connection settings',()=>{
 const body=buttonWebhookSettings({url:'https://example.test/v1/integrations/telegram/webhook',allowed_updates:['message','my_chat_member'],max_connections:20,ip_address:'192.0.2.1'},'secret');
 assert.deepEqual(body.allowed_updates,['message','my_chat_member','callback_query']);assert.equal(body.drop_pending_updates,false);assert.equal(body.max_connections,20);assert.equal(body.ip_address,'192.0.2.1');assert.equal(body.secret_token,'secret');
 assert.deepEqual(buttonWebhookSettings({url:'https://example.test',allowed_updates:[]},'secret').allowed_updates,[]);
 assert.throws(()=>buttonWebhookSettings({url:'https://example.test',has_custom_certificate:true},'secret'),/custom certificate/);
});
test('setup is read-only by default and only explicit apply updates a filtered webhook',async()=>{
 const calls=[],fetcher=async(url,options)=>{calls.push({method:url.split('/').at(-1),body:JSON.parse(options.body)});return Response.json({ok:true,result:calls.at(-1).method==='getWebhookInfo'?{url:'https://example.test/webhook',allowed_updates:['message']}:true});};
 const settings={fetcher,token:'mock',secret:'secret'};
 assert.match(await configureTelegramButtons(settings),/filtered out/);assert.deepEqual(calls.map(c=>c.method),['getWebhookInfo']);
 assert.match(await configureTelegramButtons({...settings,apply:true}),/enabled/);assert.deepEqual(calls.map(c=>c.method),['getWebhookInfo','getWebhookInfo','setWebhook']);assert.equal(calls.at(-1).body.drop_pending_updates,false);
});
