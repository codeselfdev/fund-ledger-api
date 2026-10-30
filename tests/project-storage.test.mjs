import assert from 'node:assert/strict';
import { test, after } from 'node:test';
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/test';process.env.JWT_SECRET='isolated-storage';process.env.UPLOAD_STORAGE='r2';process.env.R2_ENDPOINT='https://test.invalid';process.env.R2_BUCKET='safety';process.env.R2_ACCESS_KEY_ID='test';process.env.R2_SECRET_ACCESS_KEY='test';
const { S3Client }=await import('@aws-sdk/client-s3');
const original=S3Client.prototype.send;let calls=[],response={Contents:[]},failure=null;
S3Client.prototype.send=async function(command,options){calls.push({name:command.constructor.name,input:command.input,options});if(failure)throw failure;return response;};
const {projectObjectKeys,purgeObject}=await import('../dist/core/storage/object-storage.service.js');
after(()=>{S3Client.prototype.send=original;});
test('R2 project listing uses the exact tenant/project prefix and bounded pages',async()=>{
 response={Contents:[{Key:'tenant/project/a.pdf'},{Key:'tenant/project/nested/b.pdf'},{Key:'tenant/project-other/c.pdf'},{Key:'tenant/other/d.pdf'}]};
 assert.deepEqual(await projectObjectKeys('tenant','project',25),['tenant/project/a.pdf','tenant/project/nested/b.pdf']);
 const c=calls.at(-1);assert.equal(c.name,'ListObjectsV2Command');assert.equal(c.input.Prefix,'tenant/project/');assert.equal(c.input.MaxKeys,25);assert.equal(c.input.Bucket,'safety');assert.ok(c.options.abortSignal);
 for(const id of ['../project','project/child','','%2f','project\\other'])await assert.rejects(projectObjectKeys('tenant',id),/Invalid/);
});
test('R2 purge confirms the delete and propagates provider failures for durable retry',async()=>{
 response={};await purgeObject('tenant/project/proof.pdf');assert.equal(calls.at(-1).name,'DeleteObjectCommand');assert.equal(calls.at(-1).input.Key,'tenant/project/proof.pdf');
 failure=Error('R2 permission denied');await assert.rejects(purgeObject('tenant/project/proof.pdf'),/permission denied/);failure=null;
});
