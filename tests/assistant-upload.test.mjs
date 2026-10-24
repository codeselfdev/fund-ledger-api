import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { assistantUpload, assistantUploadError, validateAssistantImage } from '../dist/modules/assistant/assistant-upload.js';
import { errorHandler } from '../dist/core/http/error-handler.js';
let server, url;
function png(bytes = 45, width = 600) {
 const buffer = Buffer.alloc(bytes); Buffer.from([137,80,78,71,13,10,26,10]).copy(buffer);
 buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12); buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(900, 20); buffer.write('IEND', 37);
 return buffer;
}
function form(sizes = [149000, 307000, 232000], reply = false, fieldsFirst = true) {
 const body = new FormData();
 const fields = () => { body.append('message', 'Add these 3 expenses'); body.append('request_key', '123e4567-e89b-42d3-a456-426614174000'); if (reply) body.append('reply_to_request_key', 'a5b53bf6-22fc-4cab-922a-d32ddd376a57'); };
 if (fieldsFirst) fields();
 for (let i = 0; i < sizes.length; i++) body.append('files', new Blob([png(sizes[i])], { type: 'image/png' }), `receipt-${i}.png`);
 if (!fieldsFirst) fields();
 return body;
}
async function upload(body) { const response = await fetch(url, { method: 'POST', body }); return { status: response.status, payload: await response.json() }; }
before(async () => {
 const app = express();
 app.post('/upload', assistantUpload, (req, res, next) => {
  try { const images = req.files.map(file => ({ type: validateAssistantImage(file.buffer), size: file.size })); res.json({ images, fields: req.body }); } catch (error) { next(error); }
 });
 app.use(assistantUploadError, errorHandler);
 server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); url = `http://127.0.0.1:${server.address().port}/upload`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });
test('the reported three small receipts upload together with the question and request key', async () => {
 const result = await upload(form()); assert.equal(result.status, 200, JSON.stringify(result.payload));
 assert.deepEqual(result.payload.images.map(image => image.size), [149000,307000,232000]); assert.equal(result.payload.fields.message, 'Add these 3 expenses');
});
test('one, two and three images also accept the optional reply context field', async () => {
 for (let count = 1; count <= 3; count++) { const result = await upload(form(Array(count).fill(232000), true)); assert.equal(result.status, 200, JSON.stringify(result.payload)); assert.equal(result.payload.images.length, count); assert.equal(result.payload.fields.reply_to_request_key, 'a5b53bf6-22fc-4cab-922a-d32ddd376a57'); }
});
test('multipart field order does not change acceptance at the full supported capacity', async () => {
 const result = await upload(form([149000,307000,232000], true, false)); assert.equal(result.status, 200, JSON.stringify(result.payload)); assert.equal(result.payload.images.length, 3);
});
test('the one MB limit applies to each image rather than the combined request', async () => {
 const result = await upload(form([600000,600000,600000])); assert.equal(result.status, 200, JSON.stringify(result.payload)); assert.equal(result.payload.images.length, 3);
});
test('a file one byte below one MB is accepted', async () => { const result = await upload(form([999999])); assert.equal(result.status, 200, JSON.stringify(result.payload)); });
test('a file at or above one MB reports the actual size error', async () => {
 for (const bytes of [1000000,1000001]) { const result = await upload(form([bytes])); assert.equal(result.status, 413); assert.equal(result.payload.error.code, 'IMAGE_TOO_LARGE'); assert.match(result.payload.error.message, /below 1 MB/); }
});
test('a fourth image is rejected with a count error instead of a misleading size error', async () => {
 const result = await upload(form([149000,149000,149000,149000])); assert.equal(result.status, 400); assert.match(result.payload.error.message, /up to 3/); assert.doesNotMatch(result.payload.error.message, /below 1 MB/);
});
test('extra text fields and oversized field values remain bounded with useful errors', async () => {
 const body = form([1000], true); body.append('unexpected', 'value'); const extra = await upload(body); assert.equal(extra.status, 400); assert.match(extra.payload.error.message, /request fields/i);
 const large = form([1000]); large.set('message', 'x'.repeat(10001)); const result = await upload(large); assert.equal(result.status, 400); assert.match(result.payload.error.message, /2,000/);
});
test('unexpected upload fields and invalid image bytes or dimensions remain rejected', async () => {
 const wrong = new FormData(); wrong.append('photo', new Blob([png()]), 'receipt.png'); assert.equal((await upload(wrong)).status, 400);
 for (const bytes of [Buffer.from('invalid image'), png(45,1601)]) { const body = form([]); body.append('files', new Blob([bytes], { type: 'image/png' }), 'receipt.png'); const result = await upload(body); assert.equal(result.status, 400); assert.equal(result.payload.error.code, 'INVALID_IMAGE'); }
});
