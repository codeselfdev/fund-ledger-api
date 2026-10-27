import {Router} from 'express';
import {z} from 'zod';
import {prisma} from '../../core/prisma/client.js';
import {requireRoles} from '../../core/security/auth.middleware.js';
import {requireProjectContext} from '../../core/security/auth.context.js';
import {asyncHandler} from '../../core/http/async-handler.js';
import {badRequest,conflict,forbidden} from '../../core/http/api-error.js';
import {created,ok} from '../../core/http/response.js';
import {validateBody} from '../../core/validation/validate.js';
import {json} from '../billing/billing.policy.js';
import {audit,financialTransaction,scope} from './construction.service.js';
import {controls,approvedVersion,validateBoq,submitVersion,decideVersion,progressSnapshot,submitMeasurement,decideMeasurement,importBoqRows} from './construction.control.service.js';
import {activateValuation,valuationSnapshot} from './construction.valuation.js';
import {settingsSchema,scheduleSchema,boqVersionSchema,decisionSchema,measureSchema,completionSchema,importSchema,activationSchema} from './construction.control.policy.js';
import {compareBoq,priceBoq} from './construction.control.engine.js';
export const controlRouter=Router();
const owner=(a:ReturnType<typeof requireProjectContext>)=>(a.builtinRoles??a.roles).some(r=>r==='owner'||r==='admin');
export const canConfigureControl=owner;
const clean=<T extends {requestHash:string;requestKey:string}>(row:T)=>({...row,...('quantity' in row?{quantity:Number(row.quantity)}:{}),requestHash:undefined,requestKey:undefined});
controlRouter.get('/control',asyncHandler(async(req,res)=>{
 const a=requireProjectContext(req);
 const data=await financialTransaction(async tx=>{
  const [settings,versions,progress,valuation,heads,boq,items,tasks,packages,phases]=await Promise.all([controls(tx,a),tx.constructionControlVersion.findMany({where:scope(a),orderBy:{revision:'desc'}}),progressSnapshot(tx,a),valuationSnapshot(tx,a),tx.constructionCostHead.findMany({where:{...scope(a),status:'approved'}}),tx.constructionBoq.findMany({where:scope(a)}),tx.inventoryItem.findMany({where:{...scope(a),isActive:true}}),tx.constructionTask.findMany({where:scope(a)}),tx.constructionWorkPackage.findMany({where:scope(a)}),tx.constructionPhase.findMany({where:scope(a)})]);
  const baseline=versions.find(v=>v.kind==='boq'&&v.status==='approved');
  const defaultLines=boq.filter(b=>b.isActive).map(b=>({id:b.id,cost_head_id:b.costHeadId,name:b.name,unit:b.unit,quantity:Number(b.quantity),rate:b.rate,rate_mode:'manual',resources:[],task_id:heads.find(h=>h.id===b.costHeadId)?.taskId??undefined}));
  return {settings,can_configure:owner(a),can_review:a.roles.some(r=>['owner','admin','approver'].includes(r))||a.menuPermissions?.construction_control?.write===true,versions:versions.map(clean),progress,valuation,heads,items,tasks,packages,phases:phases.map(p=>({id:p.id,name:p.name})),boq_draft:baseline?(baseline.payload as unknown as {lines:unknown[]}).lines:defaultLines};
 },20000);return ok(res,data);
}));
controlRouter.put('/control/settings',validateBody(settingsSchema),asyncHandler(async(req,res)=>{
 const a=requireProjectContext(req);if(!owner(a))throw forbidden('An organization owner or administrator configures optional site controls.');const b=settingsSchema.parse(req.body);if(b.config.procurement&&!b.config.receipt_checks)throw badRequest('Procurement awards require checked delivery processing.');
 if(b.config.progress&&!b.config.advanced_boq)throw badRequest('Enable approved BOQ baselines when tracking verified progress.');
 const result=await financialTransaction(async tx=>{
  const old=await tx.constructionControlSetting.findFirst({where:scope(a)});if((old?.revision??0)!==b.revision)throw conflict('Setup changed. Reload before saving.');
  const row=old?await tx.constructionControlSetting.update({where:{projectId:a.projectId},data:{config:json(b.config),revision:{increment:1}}}):await tx.constructionControlSetting.create({data:{...scope(a),config:json(b.config)}});await audit(tx,a,'control.configured','construction_control_settings',a.projectId,{before:old,after:row});return row;
 });return ok(res,result);
}));
controlRouter.post('/control/schedule',requireRoles('accountant'),validateBody(scheduleSchema),asyncHandler(async(req,res)=>created(res,clean(await financialTransaction(tx=>submitVersion(tx,requireProjectContext(req),'schedule',req.body))))));
controlRouter.post('/control/boq',requireRoles('accountant'),validateBody(boqVersionSchema),asyncHandler(async(req,res)=>created(res,clean(await financialTransaction(tx=>submitVersion(tx,requireProjectContext(req),'boq',req.body),20000)))));
controlRouter.post('/control/boq/preview',requireRoles('accountant'),validateBody(boqVersionSchema.pick({lines:true})),asyncHandler(async(req,res)=>ok(res,await financialTransaction(tx=>validateBoq(tx,requireProjectContext(req),req.body.lines),20000))));
controlRouter.post('/control/boq/import-preview',requireRoles('accountant'),validateBody(importSchema),asyncHandler(async(req,res)=>ok(res,await financialTransaction(tx=>importBoqRows(tx,requireProjectContext(req),req.body.rows),20000))));
controlRouter.post('/control/versions/:id/decision',requireRoles('approver'),validateBody(decisionSchema),asyncHandler(async(req,res)=>ok(res,clean(await financialTransaction(tx=>decideVersion(tx,requireProjectContext(req),req.params.id,decisionSchema.parse(req.body)),20000)))));
controlRouter.post('/control/measurements',requireRoles('accountant'),validateBody(measureSchema),asyncHandler(async(req,res)=>created(res,clean(await financialTransaction(tx=>submitMeasurement(tx,requireProjectContext(req),'measurement',req.body),15000)))));
controlRouter.post('/control/completions',requireRoles('accountant'),validateBody(completionSchema),asyncHandler(async(req,res)=>created(res,clean(await financialTransaction(tx=>submitMeasurement(tx,requireProjectContext(req),'completion',req.body),15000)))));
controlRouter.post('/control/measurements/:id/decision',requireRoles('approver'),validateBody(decisionSchema),asyncHandler(async(req,res)=>ok(res,clean(await financialTransaction(tx=>decideMeasurement(tx,requireProjectContext(req),req.params.id,decisionSchema.parse(req.body)),15000)))));
controlRouter.post('/control/valuation/activate',validateBody(activationSchema),asyncHandler(async(req,res)=>{
 const a=requireProjectContext(req);if(!owner(a))throw forbidden('Only an owner or administrator can activate material valuation.');const b=activationSchema.parse(req.body);
 await financialTransaction(async tx=>{await activateValuation(tx,a,b);await audit(tx,a,'valuation.activated','construction_project',a.projectId,b);},20000);return ok(res,{method:b.method});
}));
