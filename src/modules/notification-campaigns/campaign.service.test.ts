import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { createCampaignService } from './campaign.service.js';
const delegates = Object.fromEntries(['member', 'projectMembership', 'due', 'project', 'notificationCampaign', 'notificationDelivery', 'upload'].map(name => [name, Object.fromEntries(['findMany', 'findFirst', 'findFirstOrThrow', 'create', 'groupBy', 'updateMany', 'update'].map(method => [method, async () => { throw Error(`Unexpected database call ${name}.${method}`); }]))]));
const prisma = { ...delegates, $transaction: async () => { throw Error('Unexpected transaction'); } } as unknown as PrismaClient;
const { createCampaign, loadPeople, previewCampaign, processCampaignQueue, retryCampaign } = createCampaignService(prisma);
import { draftSchema } from './campaign.policy.js';
import { requireRoles } from '../../core/security/auth.middleware.js';
const scope = { tenantId: 'tenant-a', projectId: 'project-a', userId: 'admin-a' };
const draft = draftSchema.parse({ audience: 'all', title: 'Hello {first_name}', body: 'Balance {due_amount}', push: false });
const user = { id: 'u1', name: 'Amina', email: 'amina@example.test', deviceId: 'token' };
function audienceFixture() {
 mock.method(prisma.member, 'findMany', async (args: any) => {
  assert.deepEqual(args!.where, { tenantId: scope.tenantId, projectId: scope.projectId, status: 'active' });
  return [{ id: 'm1', userId: 'u1', name: 'Amina', email: null }, { id: 'm2', userId: null, name: 'Karim', email: 'karim@example.test' }];
 });
 mock.method(prisma.projectMembership, 'findMany', async (args: any) => {
  assert.equal(args!.where!.tenantId, scope.tenantId); assert.equal(args!.where!.projectId, scope.projectId);
  return [{ userId: 'u1', memberId: 'm1', role: 'member', user }, { userId: 'u1', memberId: 'm1', role: 'admin', user }];
 });
 mock.method(prisma.due, 'findMany', async () => [{ memberId: 'm1', amount: 2500, paidAmount: 100, waivedAmount: 400, penaltyDue: 100, penaltyPaid: 100 }]);
 mock.method(prisma.project, 'findFirstOrThrow', async () => ({ name: 'Project A' }));
}
const campaign = { id: 'campaign-a', projectId: scope.projectId, audience: 'all', createdBy: { name: 'Admin' }, title: 'Hello', body: 'Body', push: false, email: false, recipientCount: 2 };
test('members with multiple roles appear once, and email-only members are retained', async () => {
 try { audienceFixture(); const people = await loadPeople(scope); assert.equal(people.length, 2); assert.equal(people[0]!.due, 2000); assert.equal(people[0]!.staff, true); assert.equal(people[1]!.userId, null); assert.equal(people[1]!.email, 'karim@example.test'); } finally { mock.restoreAll(); }
});
test('foreign or removed members fail closed at preview', async () => {
 try { audienceFixture(); await assert.rejects(previewCampaign(scope, { ...draft, audience: 'pick', recipient_ids: ['foreign-member'] }), /no longer available/); } finally { mock.restoreAll(); }
});
test('idempotent retries return the original campaign without creating or sending again', async () => {
 try {
  mock.method(prisma.notificationCampaign, 'findFirst', async () => campaign);
  mock.method(prisma.notificationDelivery, 'groupBy', async () => []);
  mock.method(prisma.notificationCampaign, 'create', async () => { assert.fail('Must not create twice'); });
  assert.equal((await createCampaign(scope, draft, 'same-request', 'same-token')).id, campaign.id);
 } finally { mock.restoreAll(); }
});
test('sending with changed reach requires review and creates no campaign', async () => {
 try {
  audienceFixture(); mock.method(prisma.notificationCampaign, 'findFirst', async () => null);
  mock.method(prisma.notificationCampaign, 'create', async () => { assert.fail('Must not send a stale review'); });
  await assert.rejects(createCampaign(scope, draft, 'request', 'stale-token'), /Review again/);
 } finally { mock.restoreAll(); }
});
test('create snapshots personalized deliveries, keeps project scope, and queues only chosen channels', async () => {
 try {
  audienceFixture(); const preview = await previewCampaign(scope, draft); let created = false;
  mock.method(prisma.notificationCampaign, 'findFirst', async () => created ? campaign : null);
  mock.method(prisma.notificationDelivery, 'groupBy', async () => []);
  mock.method(prisma.notificationCampaign, 'create', async (args: any) => {
   const data = args!.data; assert.equal(data.projectId, scope.projectId); assert.equal(data.tenantId, scope.tenantId);
   const rows = (data.deliveries!.create as Array<{ channel: string; title: string; body: string; status: string }>);
   assert.deepEqual(rows.map(r => [r.channel, r.status]), [['inbox', 'pending'], ['inbox', 'skipped']]);
   assert.equal(rows[0]!.title, 'Hello Amina'); assert.equal(rows[0]!.body, 'Balance ৳2,000'); created = true; return campaign;
  });
  await createCampaign(scope, draft, 'request', preview.preview_token); assert.equal(created, true);
 } finally { mock.restoreAll(); }
});
test('retry touches only failed deliveries in the scoped campaign', async () => {
 try {
  mock.method(prisma.notificationCampaign, 'findFirst', async (args: any) => { assert.equal(args!.where!.projectId, scope.projectId); assert.equal(args!.where!.tenantId, scope.tenantId); return campaign; });
  mock.method(prisma.notificationDelivery, 'groupBy', async () => []);
  mock.method(prisma.notificationDelivery, 'updateMany', async (args: any) => { assert.deepEqual(args!.where, { campaignId: campaign.id, status: 'failed' }); return { count: 1 }; });
  await retryCampaign(scope, campaign.id);
 } finally { mock.restoreAll(); }
});
test('campaign endpoints reject accountants and ordinary members', () => {
 const gate = requireRoles('owner', 'admin');
 for (const role of ['accountant', 'member', 'auditor']) {
  gate({ auth: { roles: [role] } } as never, {} as never, error => assert.equal((error as { statusCode: number }).statusCode, 403));
 }
 for (const role of ['owner', 'admin']) gate({ auth: { roles: [role] } } as never, {} as never, error => assert.equal(error, undefined));
});
test('worker claims each inbox row once and creates the notification with its project and destination', async () => {
 try {
  const row = { id: 'delivery', userId: 'u1', memberId: 'm1', channel: 'inbox', title: 'Hello', body: 'Body', campaign: { ...campaign, tenantId: scope.tenantId, createdById: scope.userId, destination: 'pay' } };
  mock.method(prisma.notificationDelivery, 'findMany', async () => [row]);
  mock.method(prisma.notificationDelivery, 'updateMany', async (args: any) => ({ count: (args!.where as { id?: string }).id ? 1 : 0 }));
  mock.method(prisma.project, 'findFirst', async () => ({ id: scope.projectId }));
  mock.method(prisma.projectMembership, 'findFirst', async () => ({ user }));
  mock.method(prisma.member, 'findFirst', async () => ({ id: 'm1' }));
  let notifications = 0;
  mock.method(prisma, '$transaction', async (callback: unknown) => (callback as (tx: unknown) => Promise<unknown>)({ notification: { upsert: async ({ create }: { create: { projectId: string; destination: string; recipientUserId: string } }) => { assert.equal(create.projectId, scope.projectId); assert.equal(create.destination, 'pay'); assert.equal(create.recipientUserId, 'u1'); notifications++; } }, notificationDelivery: { update: async () => ({}) } }));
  await processCampaignQueue(); assert.equal(notifications, 1);
 } finally { mock.restoreAll(); }
});
test('worker skips access revoked after a campaign was queued', async () => {
 try {
  mock.method(prisma.notificationDelivery, 'findMany', async () => [{ id: 'delivery', memberId: null, userId: 'u1', channel: 'push', campaign: { tenantId: scope.tenantId, projectId: scope.projectId } }]);
  mock.method(prisma.notificationDelivery, 'updateMany', async () => ({ count: 1 }));
  mock.method(prisma.project, 'findFirst', async () => ({ id: scope.projectId }));
  mock.method(prisma.projectMembership, 'findFirst', async () => null);
  let skipped = false;
  mock.method(prisma.notificationDelivery, 'update', async (args: any) => { assert.equal(args!.data.status, 'skipped'); skipped = true; return {}; });
  await processCampaignQueue(); assert.equal(skipped, true);
 } finally { mock.restoreAll(); }
});

test('FCM receives the correct tenant, project and destination and acceptance is recorded', async () => {
 try {
  const row = { id: 'push', userId: 'u1', memberId: 'm1', channel: 'push', title: 'Hello Amina', body: 'Balance ৳2,000', campaign: { ...campaign, tenantId: scope.tenantId, createdById: scope.userId, destination: 'dues' } };
  mock.method(prisma.notificationDelivery, 'findMany', async () => [row]);
  mock.method(prisma.notificationDelivery, 'updateMany', async () => ({ count: 1 }));
  mock.method(prisma.project, 'findFirst', async () => ({ id: scope.projectId }));
  mock.method(prisma.projectMembership, 'findFirst', async () => ({ user }));
  mock.method(prisma.member, 'findFirst', async () => ({ id: 'm1' }));
  let sent = false;
  mock.method(prisma.notificationDelivery, 'update', async (args: any) => { assert.equal(args.data.status, 'sent'); sent = true; return {}; });
  const service = createCampaignService(prisma, {
   sendPush: async input => { assert.equal(input.data!.project_id, scope.projectId); assert.equal(input.data!.tenant_id, scope.tenantId); assert.equal(input.data!.destination, 'dues'); assert.equal(input.title, 'Hello Amina'); return { sent_count: 1, failed_count: 0, invalid_tokens: [], skipped: false }; },
   sendEmail: async () => assert.fail('Email was not selected'),
  });
  await service.processCampaignQueue(); assert.equal(sent, true);
 } finally { mock.restoreAll(); }
});
test('email uses the current recipient address and a project-scoped app link; disabled SMTP is a failure', async () => {
 try {
  const row = { id: 'email', userId: null, memberId: 'm2', channel: 'email', title: 'Hello Karim', body: 'Message', campaign: { ...campaign, tenantId: scope.tenantId, createdById: scope.userId, destination: 'pay' } };
  mock.method(prisma.notificationDelivery, 'findMany', async () => [row]);
  mock.method(prisma.notificationDelivery, 'updateMany', async () => ({ count: 1 }));
  mock.method(prisma.project, 'findFirst', async () => ({ id: scope.projectId }));
  mock.method(prisma.member, 'findFirst', async () => ({ id: 'm2', email: 'current@example.test' }));
  let failed = false;
  mock.method(prisma.notificationDelivery, 'update', async (args: any) => { assert.equal(args.data.status, 'failed'); failed = true; return {}; });
  const service = createCampaignService(prisma, {
   sendPush: async () => assert.fail('Push was not selected'),
   sendEmail: async input => { assert.equal(input.to, 'current@example.test'); assert.match(input.text, /fundnesta:\/\/notification\?project_id=project-a&tenant_id=tenant-a&destination=pay/); return false; },
  });
  const original = console.error; console.error = () => {};
  try { await service.processCampaignQueue(); } finally { console.error = original; }
  assert.equal(failed, true);
 } finally { mock.restoreAll(); }
});
test('a delivery already claimed by another worker is not sent twice', async () => {
 try {
  mock.method(prisma.notificationDelivery, 'findMany', async () => [{ id: 'claimed' }]);
  mock.method(prisma.notificationDelivery, 'updateMany', async () => ({ count: 0 }));
  const service = createCampaignService(prisma, { sendPush: async () => assert.fail('Already claimed'), sendEmail: async () => assert.fail('Already claimed') });
  await service.processCampaignQueue();
 } finally { mock.restoreAll(); }
});


test('notification images are validated within the current project and are included in the reviewed draft', async () => {
 try {
  audienceFixture();
  mock.method(prisma.upload, 'findFirst', async (args: any) => {
   assert.deepEqual(args.where, { id: 'photo', tenantId: scope.tenantId, projectId: scope.projectId, purpose: 'notification_image', deletedAt: null });
   return { id: 'photo', mimeType: 'image/jpeg', size: 500 };
  });
  const preview = await previewCampaign(scope, { ...draft, image_file_id: 'photo' });
  assert.equal(preview.image_file_id, 'photo');
  mock.method(prisma.notificationCampaign, 'findFirst', async () => null);
  await assert.rejects(createCampaign(scope, draft, 'changed-image', preview.preview_token), /Review again/);
  for (const image of [null, {mimeType:'application/pdf',size:100}, {mimeType:'image/jpeg',size:2_000_000}]) {
   mock.method(prisma.upload, 'findFirst', async () => image);
   await assert.rejects(previewCampaign(scope, { ...draft, image_file_id: 'photo' }), /notification image/);
  }
 } finally { mock.restoreAll(); }
});

test('only scoped campaign recipients and admins can read an image; deleted uploads fail closed', async () => {
 try {
  const bytes = Buffer.from('image'); let reads = 0, recipient: object | null = null;
  const service = createCampaignService(prisma, undefined, { readObject: async key => { assert.equal(key, 'private/photo'); reads++; return {buffer:bytes}; } });
  mock.method(prisma.notificationCampaign, 'findFirst', async (args: any) => { assert.deepEqual(args.where, {id:campaign.id,tenantId:scope.tenantId,projectId:scope.projectId}); return {...campaign,imageFileId:'photo'}; });
  mock.method(prisma.notificationDelivery, 'findFirst', async (args: any) => { assert.deepEqual(args.where,{campaignId:campaign.id,userId:scope.userId}); return recipient; });
  mock.method(prisma.upload, 'findFirst', async () => ({mimeType:'image/jpeg',size:500,fileName:'photo.jpg',storageKey:'private/photo'}));
  await assert.rejects(service.campaignImage({...scope,roles:['member']},campaign.id), /not found/); assert.equal(reads,0);
  recipient={id:'delivery'};
  assert.equal((await service.campaignImage({...scope,roles:['member']},campaign.id)).buffer,bytes);
  recipient=null;
  assert.equal((await service.campaignImage({...scope,roles:['admin']},campaign.id)).buffer,bytes);
  mock.method(prisma.upload, 'findFirst', async () => null);
  await assert.rejects(service.campaignImage({...scope,roles:['admin']},campaign.id), /notification image/);
 } finally { mock.restoreAll(); }
});

test('email delivery attaches private image bytes and push taps carry only the scoped app image path', async () => {
 try {
  const base={...campaign,tenantId:scope.tenantId,createdById:scope.userId,destination:'dues',imageFileId:'photo'};
  mock.method(prisma.notificationDelivery, 'findMany', async () => ['push','email'].map(channel=>({id:channel,userId:'u1',memberId:'m1',channel,title:'Hello',body:'Message',campaign:base})));
  mock.method(prisma.notificationDelivery, 'updateMany', async () => ({count:1}));
  mock.method(prisma.notificationDelivery, 'update', async (args: any) => { assert.equal(args.data.status,'sent'); return {}; });
  mock.method(prisma.project, 'findFirst', async () => ({id:scope.projectId,name:'Project A'}));
  mock.method(prisma.projectMembership, 'findFirst', async () => ({user}));
  mock.method(prisma.member, 'findFirst', async () => ({id:'m1'}));
  mock.method(prisma.upload, 'findFirst', async () => ({mimeType:'image/jpeg',size:500,fileName:'photo.jpg',storageKey:'private/photo'}));
  let pushes=0,emails=0; const bytes=Buffer.from('private image');
  const service=createCampaignService(prisma,{
   sendPush:async input=>{assert.equal(input.data!.image_url,`/v1/notifications/campaigns/${campaign.id}/image`);assert.equal(input.imageUrl,undefined);pushes++;return{sent_count:1,failed_count:0,invalid_tokens:[],skipped:false};},
   sendEmail:async input=>{assert.deepEqual(input.attachments,[{filename:'photo.jpg',content:bytes,contentType:'image/jpeg'}]);emails++;return true;},
  },{readObject:async()=>({buffer:bytes})});
  await service.processCampaignQueue();assert.equal(pushes,1);assert.equal(emails,1);
 } finally { mock.restoreAll(); }
});
