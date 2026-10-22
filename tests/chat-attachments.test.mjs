import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = await mkdtemp(join(tmpdir(), 'nesta-image-retention-'));
Object.assign(process.env, { DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test', JWT_SECRET: 'image-retention-test', UPLOAD_STORAGE: 'local', UPLOAD_LOCAL_DIR: root });
const { prisma } = await import('../dist/core/prisma/client.js');
const { retainChatAttachments } = await import('../dist/modules/ai-service/chat-attachments.js');
const { readObject } = await import('../dist/core/storage/object-storage.service.js');
const buffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64');
const file = { originalname: 'receipt.png', buffer, size: buffer.length };
let rows, failure, queue;
beforeEach(async () => {
  rows = []; failure = false; queue = Promise.resolve();
  await rm(root, { recursive: true, force: true });
  prisma.assistantAttachment.findMany = async ({ where }) => rows.filter(row => row.tenantId === where.tenantId && row.replyId === where.replyId).map(({ id, fileName, mimeType, size }) => ({ id, fileName, mimeType, size }));
  prisma.assistantAttachment.createMany = async ({ data }) => { if (failure) throw Error('Database unavailable'); rows.push(...data.map((row, i) => ({ ...row, id: `image-${i}` }))); };
  prisma.$queryRaw = async () => [];
  prisma.$transaction = fn => { const result = queue.then(() => fn(prisma)); queue = result.catch(() => {}); return result; };
});
after(async () => { await prisma.$disconnect(); await rm(root, { recursive: true, force: true }); });
const storedFiles = async () => { try { return (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };

test('simultaneous retries retain one private image set and clean up unused objects', async () => {
  const [first, second] = await Promise.all([retainChatAttachments('tenant', 'reply', [file]), retainChatAttachments('tenant', 'reply', [file])]);
  assert.deepEqual(first, second); assert.equal(rows.length, 1); assert.equal((await storedFiles()).length, 1);
  assert.deepEqual((await readObject(rows[0].storageKey)).buffer, buffer);
  assert.equal(first[0].storageKey, undefined); assert.equal(first[0].contentHash, undefined);
});
test('database failures remove uploaded objects, and a later retry can save the image', async () => {
  failure = true; await assert.rejects(retainChatAttachments('tenant', 'reply', [file]), /Database unavailable/);
  assert.equal((await storedFiles()).length, 0);
  failure = false; assert.equal((await retainChatAttachments('tenant', 'reply', [file])).length, 1);
  assert.equal((await storedFiles()).length, 1);
});
test('text-only questions do not store files', async () => {
  assert.deepEqual(await retainChatAttachments('tenant', 'reply', []), []); assert.equal((await storedFiles()).length, 0);
});
