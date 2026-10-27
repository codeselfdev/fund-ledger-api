import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { badRequest, conflict, notFound } from '../../core/http/api-error.js';
import { created, ok } from '../../core/http/response.js';
import { validateBody } from '../../core/validation/validate.js';
import { hash } from '../billing/billing.policy.js';
import { audit, financialTransaction, scope, sameRequest } from './construction.service.js';
import { locationCreate, packageCreate, taskCreate, structureUpdate, locationKinds } from './construction.structure.policy.js';
import { locationChain, resolveWorkContext } from './construction.structure.service.js';
export const structureRouter = Router();
const publicRow = <T extends {requestKey:string;requestHash:string}>(row:T) => ({...row,requestKey:undefined,requestHash:undefined});
structureRouter.get('/structure',asyncHandler(async(req,res)=>{
 const a=requireProjectContext(req);
 const data=await financialTransaction(async tx=>{
  const [phases,locations,work_packages,tasks]=await Promise.all([
   tx.constructionPhase.findMany({where:scope(a),select:{id:true,name:true},orderBy:{createdAt:'asc'}}),
   tx.constructionWorkLocation.findMany({where:scope(a),orderBy:{createdAt:'asc'}}),
   tx.constructionWorkPackage.findMany({where:scope(a),orderBy:{createdAt:'asc'}}),
   tx.constructionTask.findMany({where:scope(a),orderBy:{createdAt:'asc'}}),
  ]);
  return {phases:phases.map(p=>({id:p.id,name:p.name})),locations:locations.map(publicRow),work_packages:work_packages.map(publicRow),tasks:tasks.map(publicRow)};
 });return ok(res,data);
}));
for(const kind of ['locations','work-packages','tasks'] as const) {
 const schema = kind==='locations'?locationCreate:kind==='work-packages'?packageCreate:taskCreate;
 structureRouter.post(`/${kind}`,requireRoles('accountant'),validateBody(schema),asyncHandler(async(req,res)=>{
  const a=requireProjectContext(req);
  const row=await financialTransaction(async tx=>{
   // Parse each union branch explicitly, keeping request and parent fields type-safe.
   const find=(where:{tenantId:string;projectId:string;id?:string;requestKey?:string})=>kind==='locations'?tx.constructionWorkLocation.findFirst({where}):kind==='work-packages'?tx.constructionWorkPackage.findFirst({where}):tx.constructionTask.findFirst({where});
   const b=schema.parse(req.body);
   const old=await find({...scope(a),requestKey:b.request_key});
   if(old){if(old.createdById!==a.userId)throw conflict('Request key already used');sameRequest(old,b);return old;}
   const common={...scope(a),name:b.name,requestKey:b.request_key,requestHash:hash(b),createdById:a.userId};
   let row;
   if(kind==='locations'){
    const b=locationCreate.parse(req.body);
    if(b.parent_id){const chain=await locationChain(tx,a,b.parent_id);if(locationKinds.indexOf(chain[chain.length-1].kind as typeof locationKinds[number])>=locationKinds.indexOf(b.kind))throw badRequest('Use Building → Block → Floor → Zone order');}
    if(await tx.constructionWorkLocation.findFirst({where:{...scope(a),parentKey:b.parent_id??'',kind:b.kind,name:b.name}}))throw conflict('This location already exists under the selected parent');
    row=await tx.constructionWorkLocation.create({data:{...common,parentId:b.parent_id,parentKey:b.parent_id??'',kind:b.kind}});
   }else if(kind==='work-packages'){
    const b=packageCreate.parse(req.body);await resolveWorkContext(tx,a,{phase_id:b.phase_id,location_id:b.location_id??undefined});
    if(await tx.constructionWorkPackage.findFirst({where:{...scope(a),phaseId:b.phase_id,name:b.name}}))throw conflict('A work package with this name already exists in the phase');
    row=await tx.constructionWorkPackage.create({data:{...common,phaseId:b.phase_id,locationId:b.location_id,description:b.description}});
   }else{
    const b=taskCreate.parse(req.body);await resolveWorkContext(tx,a,{work_package_id:b.work_package_id});
    if(await tx.constructionTask.findFirst({where:{...scope(a),workPackageId:b.work_package_id,name:b.name}}))throw conflict('A task with this name already exists in the work package');
    row=await tx.constructionTask.create({data:{...common,workPackageId:b.work_package_id,description:b.description}});
   }
   await audit(tx,a,'structure.created',`construction_${kind}`,row.id,row);return row;
  });return created(res,publicRow(row));
 }));
 structureRouter.put(`/${kind}/:id`,requireRoles('accountant'),validateBody(structureUpdate),asyncHandler(async(req,res)=>{
  const a=requireProjectContext(req),b=structureUpdate.parse(req.body);
  const row=await financialTransaction(async tx=>{
   const find=(where:{tenantId:string;projectId:string;id?:string;requestKey?:string})=>kind==='locations'?tx.constructionWorkLocation.findFirst({where}):kind==='work-packages'?tx.constructionWorkPackage.findFirst({where}):tx.constructionTask.findFirst({where});
   const old=await find({...scope(a),id:req.params.id});
   if(!old)throw notFound('Construction structure record not found');
   if(old.revision!==b.revision)throw conflict('This record changed. Reload the structure before saving again.');
   if(kind==='locations'){
    const old=await tx.constructionWorkLocation.findFirstOrThrow({where:{...scope(a),id:req.params.id}});
    if(b.description)throw badRequest('Locations do not have a description');
    if(b.is_active&&old.parentId)await locationChain(tx,a,old.parentId);
    if(!b.is_active&&(await tx.constructionWorkLocation.count({where:{...scope(a),parentId:old.id,isActive:true}})||await tx.constructionWorkPackage.count({where:{...scope(a),locationId:old.id,isActive:true}})))throw conflict('Archive active child locations and work packages first');
    const duplicate=await tx.constructionWorkLocation.findFirst({where:{...scope(a),parentKey:old.parentKey,kind:old.kind,name:b.name}});
    if(duplicate&&duplicate.id!==old.id)throw conflict('This location name is already used');
    const saved=await tx.constructionWorkLocation.updateMany({where:{...scope(a),id:old.id,revision:b.revision},data:{name:b.name,isActive:b.is_active,revision:{increment:1}}});if(!saved.count)throw conflict('This record changed. Reload the structure.');
   }else if(kind==='work-packages'){
    const old=await tx.constructionWorkPackage.findFirstOrThrow({where:{...scope(a),id:req.params.id}});
    if(b.is_active)await resolveWorkContext(tx,a,{phase_id:old.phaseId,location_id:old.locationId??undefined});
    if(!b.is_active&&await tx.constructionTask.count({where:{...scope(a),workPackageId:old.id,isActive:true}}))throw conflict('Archive active tasks before their work package');
    const duplicate=await tx.constructionWorkPackage.findFirst({where:{...scope(a),phaseId:old.phaseId,name:b.name}});if(duplicate&&duplicate.id!==old.id)throw conflict('This work package name is already used');
    const saved=await tx.constructionWorkPackage.updateMany({where:{...scope(a),id:old.id,revision:b.revision},data:{name:b.name,description:b.description,isActive:b.is_active,revision:{increment:1}}});if(!saved.count)throw conflict('This record changed. Reload the structure.');
   }else{
    const old=await tx.constructionTask.findFirstOrThrow({where:{...scope(a),id:req.params.id}});
    if(b.is_active)await resolveWorkContext(tx,a,{work_package_id:old.workPackageId});
    const duplicate=await tx.constructionTask.findFirst({where:{...scope(a),workPackageId:old.workPackageId,name:b.name}});if(duplicate&&duplicate.id!==old.id)throw conflict('This task name is already used');
    const saved=await tx.constructionTask.updateMany({where:{...scope(a),id:old.id,revision:b.revision},data:{name:b.name,description:b.description,isActive:b.is_active,revision:{increment:1}}});if(!saved.count)throw conflict('This record changed. Reload the structure.');
   }
   const saved=await find({...scope(a),id:old.id});if(!saved)throw notFound('Construction structure record not found');
   await audit(tx,a,'structure.updated',`construction_${kind}`,old.id,{before:old,after:saved});return saved;
  });return ok(res,publicRow(row));
 }));
}
