import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {adminRoutes} from '../src/modules/admin/routes.js';
import {workflowUpdate,saveWorkflow,remainingWorkflow} from '../src/modules/admin/workflows.js';
import {newUserCustodian} from '../src/modules/fulfilment/custodian.js';
import {errorHandler} from '../src/core/errors.js';
import {testConfig,user,actorId,otherId,branchId,departmentId,requestId} from './helpers.js';

test('workflow updates allow chosen role subsets and order, but reject duplicates and lifecycle roles',()=>{
 for(const roles of [['CITO'],['COO','IT','CITO'],['Manager','COO'],['HR']])assert.equal(workflowUpdate.safeParse({roles}).success,true);
 for(const roles of [[],['CITO','CITO'],['User'],['Processing'],['Completed'],['Super Admin']])assert.equal(workflowUpdate.safeParse({roles}).success,false);
});

test('reconciliation preserves completed decisions and appends only remaining configured roles',()=>{
 const completed={Position:1,Role:'Branch manager',Status:'Approved',ActorId:otherId,Remark:'Recommended',DecidedAt:new Date()};
 const existing=[completed,{Position:2,Role:'IT',Status:'Waiting'},{Position:3,Role:'COO',Status:'Waiting'}];
 assert.deepEqual(remainingWorkflow(existing,[{Role:'COO'},{Role:'Manager'},{Role:'HR'}],'Branch manager'),[{Role:'COO',Position:2},{Role:'HR',Position:3}]);
 assert.equal(existing[0],completed);assert.equal(existing[0].Remark,'Recommended');
});

function fixture({tickets=[],steps=[],rules=[]}={}){
 const calls=[];let configured=['CITO','COO'];let pendingSteps=steps;
 const query=async(sql,params)=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT * FROM dbo.RequestTypes'))return {recordset:[{Code:'reset'}]};
  if(sql.startsWith('SELECT Role FROM dbo.WorkflowSteps'))return {recordset:configured.map(Role=>({Role}))};
  if(sql.startsWith('SELECT Role,Position FROM dbo.WorkflowSteps'))return {recordset:configured.map((Role,index)=>({Role,Position:index+1}))};
  if(sql.startsWith('SELECT Steps FROM dbo.SystemApprovalOverrides'))return {recordset:rules.map(roles=>({Steps:JSON.stringify(roles)}))};
  if(sql.startsWith('DELETE dbo.WorkflowSteps'))configured=[];
  if(sql.startsWith('INSERT dbo.WorkflowSteps'))configured.push(params.role.value);
  if(sql.startsWith('SELECT r.*,rt.Name'))return {recordset:tickets};
  if(sql.startsWith('SELECT * FROM dbo.RequestSteps WITH'))return {recordset:pendingSteps};
  if(sql.startsWith('SELECT SystemId FROM dbo.RequestItems'))return {recordset:[{SystemId:branchId}]};
  if(sql.startsWith('DELETE dbo.RequestSteps'))pendingSteps=pendingSteps.filter(step=>step.Status!=='Waiting');
  if(sql.startsWith('INSERT dbo.RequestSteps'))pendingSteps.push({Role:params.role.value,Position:params.position.value,Status:'Waiting'});
  return {recordset:[]};
 };
 const db={query,transaction:work=>work(query)};
 const req={user:{...user,Role:'Super Admin'},ip:'127.0.0.1'};
 const app=express();app.use(express.json());app.use((request,res,next)=>{request.user=req.user;next();});app.use(adminRoutes(db,testConfig));app.use(errorHandler);
 return {db,req,app,calls,getSteps:()=>pendingSteps};
}

test('admin save changes the stored chain, applies pending steps, and leaves approved records untouched',async()=>{
 const approved={Position:1,Role:'CITO',Status:'Approved',ActorId:otherId,Remark:'Reviewed',DecidedAt:'2026-11-22'};
 const f=fixture({tickets:[{Id:requestId,Status:'In review',TypeCode:'reset',TargetBranch:'Dhanmondi Branch',TargetDepartment:'Operations',BranchId:branchId,DepartmentId:departmentId}],steps:[approved,{Position:2,Role:'COO',Status:'Waiting'}]});
 const response=await request(f.app).put('/workflows/reset').send({roles:['HR','CITO'],expectedRoles:['CITO','COO'],applyToOpenRequests:true});assert.equal(response.status,200);assert.equal(response.body.updatedRequests,1);
 assert.equal(f.getSteps()[0],approved);assert.deepEqual(f.getSteps().map(step=>step.Role),['CITO','HR']);
 const update=f.calls.find(call=>call.sql.startsWith('UPDATE dbo.Requests'));assert.equal(update.params.status.value,'In review');assert.equal(update.params.position.value,2);
 assert.ok(f.calls.some(call=>call.params?.event?.value==='request.workflow_updated'));
});

test('open queries remain paused and their return status follows the updated remaining steps',async()=>{
 const f=fixture({tickets:[{Id:requestId,Status:'Query',TypeCode:'reset',TargetBranch:'Head Office',TargetDepartment:'IT',BranchId:branchId,DepartmentId:departmentId}],steps:[{Position:1,Role:'CITO',Status:'Approved'},{Position:2,Role:'COO',Status:'Waiting'}]});
 const result=await saveWorkflow(f.db,f.req,'reset',{roles:['CITO'],applyToOpenRequests:true});assert.equal(result.updatedRequests,1);
 assert.equal(f.calls.find(call=>call.sql.startsWith('UPDATE dbo.Requests')).params.status.value,'Query');
 assert.equal(f.calls.find(call=>call.sql.startsWith('UPDATE dbo.Queries')).params.status.value,'Approved');
 assert.deepEqual(f.getSteps().map(step=>step.Role),['CITO']);
});

test('new-requests-only saves do not touch existing requests; stale/conflicting saves do not write',async()=>{
 const f=fixture();await saveWorkflow(f.db,f.req,'reset',{roles:['COO','CITO']});assert.equal(f.calls.some(call=>call.sql.startsWith('SELECT r.*')),false);
 for(const options of [{expectedRoles:['IT']},{rules:[['COO','CITO']]}]){
  const stale=fixture(options);await assert.rejects(saveWorkflow(stale.db,stale.req,'reset',{roles:['CITO','COO'],expectedRoles:options.expectedRoles}),error=>['STALE_WORKFLOW','CONFLICTING_APPROVAL_CHAINS'].includes(error.code));
  assert.equal(stale.calls.some(call=>/^(DELETE|INSERT|UPDATE)/.test(call.sql)),false);
 }
});

test('only recently authenticated administrators can edit workflows',async()=>{
 for(const patch of [{Role:'IT'},{Role:'CITO'},{AuthenticatedAt:new Date(Date.now()-11*60000)}]){
  const f=fixture();Object.assign(f.req.user,patch);
  assert.equal((await request(f.app).put('/workflows/reset').send({roles:['CITO']})).status,403);assert.equal(f.calls.length,0);
 }
});

test('new-user credential custody stays with the manager when manager approval is omitted',async()=>{
 const ticket={Id:requestId,BranchId:branchId,DepartmentId:departmentId};
 assert.equal(await newUserCustodian(async()=>({recordset:[{ActorId:otherId}]}),ticket),otherId);
 for(const [Branch,expectedRole] of [['Dhanmondi Branch','Branch manager'],['Head Office','Department head']]){
  const calls=[];
  const query=async(sql,params)=>{calls.push({sql,params});return {recordset:sql.startsWith('SELECT TOP')?[]:sql.startsWith('SELECT b.Name')?[{Branch,Department:'Operations'}]:sql.startsWith('SELECT a.UserId')?[]:[{Id:actorId}]};};
  assert.equal(await newUserCustodian(query,ticket),actorId);assert.equal(calls.at(-1).params.role.value,expectedRole);
 }
 await assert.rejects(newUserCustodian(async sql=>({recordset:sql.startsWith('SELECT TOP')?[]:sql.startsWith('SELECT b.Name')?[{Branch:'Main',Department:'Operations'}]:sql.startsWith('SELECT a.UserId')?[]:[{Id:actorId},{Id:otherId}]}),ticket),error=>error.code==='APPROVER_REQUIRED');
});
