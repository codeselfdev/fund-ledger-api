import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import express from 'express';
import { prisma } from '../dist/core/prisma/client.js';
import { noticesRouter } from '../dist/modules/community/notices.routes.js';

const future = new Date(Date.now() + 86400000);
let rows, images, audits, server, url;
function reset() {
  rows = [
    { id: 'active', tenantId: 'tenant', projectId: 'project', title: 'Active notice', body: 'Details', expiresAt: future, deletedAt: null, imageFileId: null, createdById: 'admin', createdAt: new Date(), updatedAt: new Date() },
    { id: 'expired', tenantId: 'tenant', projectId: 'project', title: 'Expired notice', body: 'Old details', expiresAt: new Date(0), deletedAt: null, imageFileId: 'photo', createdById: 'admin', createdAt: new Date(), updatedAt: new Date() },
    { id: 'foreign', tenantId: 'other', projectId: 'other', title: 'Private notice', body: 'Private', expiresAt: future, deletedAt: null, imageFileId: null, createdById: 'other', createdAt: new Date(), updatedAt: new Date() },
  ];
  images = [{ id: 'photo', tenantId: 'tenant', projectId: 'project', purpose: 'notice_image', mimeType: 'image/jpeg', size: 50000 }]; audits=[];
}
function match(row, where) { return Object.entries(where ?? {}).every(([key, value]) => value && typeof value === 'object' && 'gt' in value ? row[key] > value.gt : row[key] === value); }
function patch(row, data) { for (const [key,value] of Object.entries(data)) if (value !== undefined) row[key]=value; row.updatedAt=new Date(); return row; }
before(async () => {
  // The real router/validators/role guards run against isolated in-memory data.
  prisma.projectNotice.findMany = async ({where}) => rows.filter(row => match(row,where));
  prisma.projectNotice.findFirst = async ({where}) => rows.find(row => match(row,where)) ?? null;
  prisma.projectNotice.findUniqueOrThrow = async ({where}) => { const row=rows.find(row=>match(row,where)); if(!row)throw Error('missing'); return row; };
  prisma.projectNotice.create = async ({data}) => { const row={id:'created',deletedAt:null,createdAt:new Date(),updatedAt:new Date(),...data}; rows.push(row); return row; };
  prisma.projectNotice.update = async ({where,data}) => patch(rows.find(row=>match(row,where)),data);
  prisma.projectNotice.updateMany = async ({where,data}) => { const matches=rows.filter(row=>match(row,where)); matches.forEach(row=>patch(row,data)); return {count:matches.length}; };
  prisma.upload.findFirst = async ({where}) => images.find(row=>match(row,where)) ?? null;
  prisma.projectMembership.findMany = async () => [];
  prisma.notification.updateMany = async () => ({count:0});
  prisma.activity.create = async ({data}) => { audits.push(data); return data; };
  prisma.$queryRaw = async () => [];
  prisma.$transaction = async callback => callback(prisma);
  const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{ req.auth={tenantId:'tenant',projectId:'project',userId:'admin',memberId:'member',roles:[req.header('x-test-role') ?? 'admin']}; next(); });
  app.use('/notices',noticesRouter);
  app.use((error,_req,res,_next)=>res.status(error.statusCode ?? 500).json({error:error.message}));
  server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve)); url=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{ await new Promise(resolve=>server.close(resolve)); await prisma.$disconnect(); });
async function request(path='',method='GET',body,role='admin') {
  const res=await fetch(url+'/notices'+path,{method,headers:{'Content-Type':'application/json','x-test-role':role},body:body?JSON.stringify(body):undefined});
  return {status:res.status,body:await res.json()};
}
test('members see only active notices in their own project',async()=>{reset(); const res=await request('','GET',undefined,'member');assert.equal(res.status,200);assert.deepEqual(res.body.data.map(row=>row.id),['active']); });
test('only management can read notice history',async()=>{reset();assert.equal((await request('?scope=all','GET',undefined,'member')).status,403); const res=await request('?scope=all');assert.deepEqual(res.body.data.map(row=>row.id),['active','expired']); });
test('members cannot create, edit, or delete notices',async()=>{reset();for(const [method,path,body] of [['POST','',{title:'Notice',body:'Details',expires_at:future.toISOString()}],['PATCH','/active',{body:'Changed'}],['DELETE','/active',undefined]])assert.equal((await request(path,method,body,'member')).status,403);assert.equal(rows[0].body,'Details'); });
test('cross-project edits and deletes are rejected',async()=>{reset();assert.equal((await request('/foreign','PATCH',{body:'Changed'})).status,404);assert.equal((await request('/foreign','DELETE')).status,404);assert.equal(rows[2].body,'Private'); });
test('expiry is required and past expiry is rejected',async()=>{reset();assert.equal((await request('','POST',{title:'Notice',body:'Details'})).status,400);assert.equal((await request('','POST',{title:'Notice',body:'Details',expires_at:new Date(0).toISOString()})).status,400); });
test('notice images must belong to this project and remain below 2 MB',async()=>{reset();const fields={title:'Notice',body:'Details',expires_at:future.toISOString(),image_file_id:'photo'};images[0].projectId='other';assert.equal((await request('','POST',fields)).status,400);images[0].projectId='project';images[0].size=2000000;assert.equal((await request('','POST',fields)).status,400);images[0].size=1999999;assert.equal((await request('','POST',fields)).status,201); });
test('admins can edit an expired notice without changing expiry or remove an image',async()=>{reset();const res=await request('/expired','PATCH',{body:'Updated',image_file_id:null});assert.equal(res.status,200);assert.equal(res.body.data.status,'expired');assert.equal(res.body.data.image_file_id,null);assert.equal(res.body.data.body,'Updated');assert.equal(audits[0].action,'notice.updated'); });
test('deletion hides a notice but keeps admin history, and prevents further edits',async()=>{reset();assert.equal((await request('/active','DELETE')).status,200);assert.deepEqual((await request()).body.data,[]);assert.equal((await request('?scope=all')).body.data.find(row=>row.id==='active').status,'deleted');assert.equal((await request('/active','PATCH',{title:'Revive'})).status,400);assert.equal((await request('/expired/image','GET',undefined,'member')).status,404); });
