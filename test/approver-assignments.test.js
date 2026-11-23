import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {approverRoutes,saveAssignment,resolveManager,assignmentSchema} from '../src/modules/directory/approvers.js';
import {canReview,visibility} from '../src/modules/requests/policy.js';
import {errorHandler} from '../src/core/errors.js';
import {user,actorId,otherId,branchId,departmentId} from './helpers.js';

function fixture({role='IT',kind='branch',previous=null,active=true}={}){
 const calls=[];
 const query=async(sql,params)=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT Id,Kind'))return {recordset:[{Id:branchId,Kind:kind}]};
  if(sql.startsWith('SELECT UserId,Version'))return {recordset:previous?[previous]:[]};
  if(sql.startsWith('SELECT Id FROM dbo.Users WITH'))return {recordset:active?[{Id:otherId}]:[]};
  if(sql.startsWith('DECLARE @affected'))return {recordset:[{UpdatedRequests:2}]};
  return {recordset:[]};
 };
 const req={user:{...user,Role:role},ip:'127.0.0.1'};
 const db={query,transaction:work=>work(query)};
 return {calls,query,req,db};
}
test('IT and Super Admin assign existing system IDs without editing portal roles',async()=>{
 for(const role of ['IT','Super Admin'])for(const kind of ['branch','department']){
  const f=fixture({role,kind});assert.equal((await saveAssignment(f.db,f.req,branchId,{employeeId:'BD00001',version:null})).updatedRequests,2);
  const insert=f.calls.find(call=>call.sql.startsWith('INSERT dbo.OrganizationApprovers'));
  assert.equal(insert.params.user.value,otherId);assert.equal(insert.params.scope.value,branchId);
  assert.equal(insert.params.role.value,kind==='branch'?'Branch manager':'Department head');
  assert.equal(f.calls.some(call=>/UPDATE dbo.Users/.test(call.sql)),false);
  const reconcile=f.calls.find(call=>call.sql.startsWith('DECLARE @affected')).sql;
  assert.match(reconcile,/s.Status='Waiting'/);assert.match(reconcile,/r.Status IN \('Employee review','Pending','In review','Query'\)/);
  assert.ok(f.calls.some(call=>call.params?.event?.value==='organization.approver_assigned'));
 }
});
test('assignment endpoints reject unauthorized roles and old sessions before database access',async()=>{
 for(const role of ['User','Branch manager','Department head','HR','CITO','COO','Platform Admin','IT','Super Admin']){
  const f=fixture({role});const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={...f.req.user,AuthenticatedAt:new Date(Date.now()-11*60000)};next();});app.use(approverRoutes(f.db));app.use(errorHandler);
  assert.equal((await request(app).put('/approver-assignments/'+branchId).send({employeeId:'BD00001',version:null})).status,403);assert.equal(f.calls.length,0);
  if(!['IT','Admin','Platform Admin','Super Admin'].includes(role))await assert.rejects(saveAssignment(f.db,f.req,branchId,{employeeId:'BD00001',version:null}),error=>error.status===403);
 }
});
test('stale versions, absent users and invalid assignment payloads cannot write',async()=>{
 const stale=fixture({previous:{UserId:actorId,Version:Buffer.from('0000000000000001','hex')}});
 await assert.rejects(saveAssignment(stale.db,stale.req,branchId,{employeeId:'BD00001',version:null}),error=>error.code==='STALE_ASSIGNMENT');
 const missing=fixture({active:false});await assert.rejects(saveAssignment(missing.db,missing.req,branchId,{employeeId:'BD00001',version:null}),error=>error.code==='ASSIGNEE_NOT_FOUND');
 for(const f of [stale,missing])assert.equal(f.calls.some(call=>/^(INSERT|UPDATE|DECLARE)/.test(call.sql)),false);
 for(const payload of [{employeeId:"x'; DROP TABLE Users;--",version:null},{employeeId:'BD00001',version:null,role:'Super Admin'},{employeeId:'BD00001'}])assert.equal(assignmentSchema.safeParse(payload).success,false);
});
test('explicit scoped assignee overrides base role and profile location, with no self approval',()=>{
 const ticket={Status:'Pending',RequesterId:otherId};const step={Role:'Branch manager',BranchId:branchId,AssignedUserId:actorId};
 assert.equal(canReview(ticket,step,{...user,Role:'User',BranchId:departmentId}),true);
 assert.equal(canReview(ticket,step,{...user,Id:departmentId,Role:'Branch manager'}),false);
 assert.equal(canReview({...ticket,RequesterId:actorId},step,user),false);
 assert.equal(canReview({...ticket,SubjectUserId:actorId},step,user),false);
 assert.equal(canReview({...ticket,Status:'Completed'},step,user),false);
 assert.equal(canReview(ticket,{...step,Status:'Approved'},user),false);
 assert.match(visibility,/uidms_StepReviewers/);
});
test('manager resolution pins explicit assignments and rejects inactive or ambiguous approvers',async()=>{
 assert.equal(await resolveManager(async()=>({recordset:[{UserId:actorId,Active:true}]}),'Department head',branchId,departmentId),actorId);
 await assert.rejects(resolveManager(async()=>({recordset:[{UserId:actorId,Active:false}]}),'Branch manager',branchId,departmentId),error=>error.code==='APPROVER_INACTIVE');
 for(const count of [0,2])await assert.rejects(resolveManager(async sql=>({recordset:sql.startsWith('SELECT a.UserId')?[]:Array.from({length:count},()=>({Id:actorId}))}),'Branch manager',branchId,departmentId),error=>error.code==='APPROVER_REQUIRED');
});
