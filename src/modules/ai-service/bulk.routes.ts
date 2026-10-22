import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/async-handler.js';
import { ok } from '../../core/http/response.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { requireRoles } from '../../core/security/auth.middleware.js';
import { financialTransaction } from '../accounting/transaction.js';
import { lockSetup } from '../business-setup/service.js';
import { bulkCatalog, bulkRequest, previewBulk, executeBulk } from './bulk.service.js';
const router=Router();
router.use(requireRoles('owner','admin','accountant'));
router.get('/catalog',asyncHandler(async(req,res)=>ok(res,await financialTransaction(db=>bulkCatalog(db,requireProjectContext(req)),15000))));
router.post('/preview',asyncHandler(async(req,res)=>{
 const auth=requireProjectContext(req),body=bulkRequest.parse(req.body);
 const result=await financialTransaction(async db=>{await lockSetup(db,auth);return previewBulk(db,auth,body);},15000);
 return ok(res,result);
}));
const action=bulkRequest.extend({targets:z.record(z.unknown()),request_key:z.string().uuid(),verified_source_records:z.literal(true),source_file_ids:z.array(z.string().min(1).max(200)).max(3).default([])}).strict();
router.post('/actions',asyncHandler(async(req,res)=>{
 const auth=requireProjectContext(req),body=action.parse(req.body);
 return ok(res,await financialTransaction(db=>executeBulk(db,auth,{operation:body.operation,fields:body.fields},body.targets,body.request_key,body.source_file_ids),25000));
}));
export {router as bulkAssistantRouter};
