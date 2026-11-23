import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {hydrateAuthority,hasRole,canManageAccount,canRecordAccess} from '../src/modules/auth/authorization.js';
import {createDelegation,delegationSchema,delegationRoutes} from '../src/modules/directory/delegations.js';
import {errorHandler} from '../src/core/errors.js';
import {user,actorId,otherId,branchId,departmentId} from './helpers.js';

test('Admin manages existing accounts but only Super Admin may create or promote administrators',()=>{
 for(const actor of ['Admin','Platform Admin','Super Admin'])for(const role of ['User','IT','CITO','COO','HR','Branch manager','Department head'])assert.equal(canManageAccount({...user,Role:actor},'User',role),true);
 for(const role of ['Admin','Platform Admin','Super Admin']){
  assert.equal(canManageAccount({...user,Role:'Admin'},'User',role),false);assert.equal(canManageAccount({...user,Role:'Admin'},role,'User'),true);assert.equal(canManageAccount({...user,Role:'Super Admin'},'User',role),true);
 }
 assert.equal(canManageAccount({...user,Role:'Admin'},'Admin','Admin'),true);assert.equal(canManageAccount({...user,Role:'Admin'},'Admin','Super Admin'),false);
 for(const role of ['User','IT','CITO','HR','Branch manager','Department head'])assert.equal(canManageAccount({...user,Role:role},'User','CITO'),false);
});
test('effective acting roles retain identity and base role, and scope assignments are independent',()=>{
 const acting=hydrateAuthority({...user,EffectiveRolesJson:'[{"Role":"User"},{"Role":"IT"}]',ManagedScopesJson:JSON.stringify([{ScopeId:departmentId,Role:'Department head',Acting:true}])});
 assert.equal(acting.Id,actorId);assert.equal(acting.BaseRole,'User');assert.equal(acting.Role,'IT');assert.equal(hasRole(acting,'IT'),true);assert.equal(hasRole(acting,'Department head'),true);assert.equal(acting.CanApproveRequests,true);
 const ended=hydrateAuthority({...user,EffectiveRolesJson:'[{"Role":"User"}]',ManagedScopesJson:'[]'});assert.equal(hasRole(ended,'IT'),false);assert.equal(ended.Role,'User');
 const absent=hydrateAuthority({...user,Role:'IT',EffectiveRolesJson:'[{"Role":"User"}]',ManagedScopesJson:'[]'});assert.equal(absent.BaseRole,'IT');assert.equal(absent.Role,'User');assert.equal(canRecordAccess(absent),false);
 for(const role of ['User','Branch manager','Department head','CITO','HR'])assert.equal(canRecordAccess({...user,Role:role}),false);
 for(const role of ['IT','Admin','Super Admin'])assert.equal(canRecordAccess({...user,Role:role}),true);
});
function fixture({actor=user,principal={...user},scopeKind='branch',targetBranch=branchId,targetDepartment=departmentId,overlap=false}={}){
 const calls=[];
 const query=async(sql,params)=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT Id,Role,Active'))return {recordset:[principal]};
  if(sql.startsWith('SELECT a.UserId'))return {recordset:[{UserId:principal.Id,Kind:scopeKind}]};
  if(sql.startsWith('SELECT Id,Active'))return {recordset:[{Id:otherId,Active:true,BranchId:targetBranch,DepartmentId:targetDepartment}]};
  if(sql.startsWith('SELECT Id FROM dbo.RoleDelegations'))return {recordset:overlap?[{Id:otherId}]:[]};
  if(sql.startsWith('INSERT dbo.RoleDelegations'))return {recordset:[{Id:otherId}]};
  return {recordset:[]};
 };
 return {db:{query,transaction:work=>work(query)},req:{user:actor,ip:'127.0.0.1'},calls};
}
const body=(role='Branch manager')=>({principalId:actorId,employeeId:'BD12345',role,scopeId:['IT','CITO'].includes(role)?null:branchId,startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString()});
test('permanent manager/head may appoint their own scoped cover but cannot delegate another person’s responsibility',async()=>{
 const own=fixture();assert.equal((await createDelegation(own.db,own.req,body())).id,otherId);assert.ok(own.calls.some(call=>call.params?.event?.value==='role.acting_assigned'));
 const another=fixture({actor:{...user,Id:otherId}});await assert.rejects(createDelegation(another.db,another.req,body()),error=>error.code==='DELEGATION_FORBIDDEN');
 const outside=fixture({targetBranch:departmentId});await assert.rejects(createDelegation(outside.db,outside.req,body()),error=>error.code==='ACTING_USER_OUT_OF_SCOPE');
 const overlap=fixture({overlap:true});await assert.rejects(createDelegation(overlap.db,overlap.req,body()),error=>error.code==='ACTING_PERIOD_OVERLAP');
 for(const f of [another,outside,overlap])assert.equal(f.calls.some(call=>call.sql.startsWith('INSERT dbo.RoleDelegations')),false);
});
test('IT/CITO appoint their own cover; Admin/Super Admin can appoint both; ordinary IT cannot appoint CITO cover',async()=>{
 for(const role of ['IT','CITO'])for(const actorRole of [role,'Admin','Super Admin']){
  const f=fixture({principal:{...user,Role:role},actor:{...user,Role:actorRole}});assert.ok((await createDelegation(f.db,f.req,body(role))).id);
 }
 const forbidden=fixture({principal:{...user,Role:'CITO'},actor:{...user,Id:otherId,Role:'IT'}});await assert.rejects(createDelegation(forbidden.db,forbidden.req,body('CITO')),error=>error.code==='DELEGATION_FORBIDDEN');
 const acting=fixture({principal:{...user,Role:'IT'},actor:{...user,Id:otherId,Role:'IT',BaseRole:'User',EffectiveRoles:['IT','User']}});await assert.rejects(createDelegation(acting.db,acting.req,body('IT')),error=>error.code==='DELEGATION_FORBIDDEN');
});
test('acting periods and payloads reject invalid dates, empty scope and role escalation',async()=>{
 assert.equal(delegationSchema.safeParse({...body(),role:'Super Admin'}).success,false);assert.equal(delegationSchema.safeParse({...body(),extra:'Admin'}).success,false);
 for(const extra of [{endsAt:new Date(Date.now()-3600000).toISOString()},{endsAt:new Date(Date.now()+400*86400000).toISOString()}]){const f=fixture();await assert.rejects(createDelegation(f.db,f.req,{...body(),...extra}),error=>error.code==='INVALID_ACTING_PERIOD');assert.equal(f.calls.length,0);}
 const f=fixture();const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={...user,AuthenticatedAt:new Date(Date.now()-11*60000)};next();});app.use(delegationRoutes(f.db));app.use(errorHandler);assert.equal((await request(app).post('/acting-assignments').send(body())).status,403);assert.equal(f.calls.length,0);
});
