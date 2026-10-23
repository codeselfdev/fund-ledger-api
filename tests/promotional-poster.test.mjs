import test from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, { DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/no_database', JWT_SECRET: 'synthetic-poster-upload-test', UPLOAD_STORAGE: 'local', INTERNAL_API_KEY: 'synthetic-poster-internal-api-key'  });
const { uploadPromotionalPoster } = await import('../dist/modules/internal/promotional-poster.service.js');
function png() { const b = Buffer.alloc(45); Buffer.from([137,80,78,71,13,10,26,10]).copy(b); b.writeUInt32BE(13,8); b.write('IHDR',12); b.writeUInt32BE(600,16); b.writeUInt32BE(900,20); b.write('IEND',37); return b; }
test('poster upload validates image bytes, uses a random public key and audits the admin', async () => {
  const writes = [], audits = [], storage = { publicObjectUrl: key => 'https://cdn.example.test/' + key, storeObject: async input => writes.push(input) }, db = { internalAudit: { create: async input => audits.push(input) } };
  const result = await uploadPromotionalPoster('admin@example.test', png(), storage, db);
  assert.match(result.image_url, /^https:\/\/cdn.example.test\/platform\/promotions\/[\w-]+\.png$/);
  assert.equal(writes[0].contentType, 'image/png'); assert.equal(audits[0].data.actor, 'admin@example.test');
  for (const buffer of [Buffer.alloc(1_000_000), Buffer.from('<svg>bad</svg>')]) await assert.rejects(uploadPromotionalPoster('admin', buffer, storage, db), /poster|image/i);
  await assert.rejects(uploadPromotionalPoster('admin', png(), { ...storage, publicObjectUrl: () => null }, db), /public HTTPS R2 storage/);
  assert.equal(writes.length, 1);
});

test('poster upload HTTP endpoint checks internal credentials and accepts one bounded multipart image', async () => {
  const { createApp } = await import('../dist/app.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const url = `http://127.0.0.1:${server.address().port}/v1/internal/notifications/poster`;
  const headers = { 'x-internal-api-key': process.env.INTERNAL_API_KEY, 'x-internal-actor': 'synthetic-admin' };
  const form = bytes => { const value = new FormData(); value.append('file', new Blob([bytes], { type: 'image/png' }), 'poster.png'); return value; };
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers, body: form(png()) })).status, 503, 'Valid multipart reaches the storage configuration check, with no live storage writes');
    assert.equal((await fetch(url, { method: 'POST', headers, body: form(Buffer.alloc(1_000_000)) })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers, body: form(Buffer.from('<svg>invalid</svg>')) })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
