import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {profileRoutes} from '../src/modules/directory/profile.js';
import {errorHandler} from '../src/core/errors.js';
import {testConfig,user,actorId,otherId,branchId} from './helpers.js';

const systemId='66666666-6666-4666-8666-666666666666';
const roleId='77777777-7777-4777-8777-777777777777';
const designationId='88888888-8888-4888-8888-888888888888';
function setup({demo=true,enabled=true,remote=false,existing=[],choices=[{Id:systemId,RoleId:roleId}],designation=true,role='User'}={}){
 const calls=[];const current={...user,Role:role,IsDemo:demo,DesignationId:null};
 const query=async(sql,params)=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT Id,DesignationId,IsDemo,Version'))return {recordset:[current]};
  if(sql.startsWith('SELECT u.Id'))return {recordset:[current]};
  if(sql.startsWith('SELECT Id FROM dbo.Lookups'))return {recordset:designation?[{Id:designationId}]:[]};
  if(sql.startsWith('SELECT g.Id'))return {recordset:existing};
  if(sql.startsWith('SELECT s.Id'))return {recordset:choices};
  if(sql.startsWith('UPDATE dbo.Users SET DesignationId'))return {recordset:[{...current,DesignationId:params.designation.value,Version:Buffer.from('0000000000000002','hex')}]};
  return {recordset:[]};
 };
 const db={query,transaction:work=>work(query)};
 const app=express();app.use(express.json());app.use((req,res,next)=>{
  req.user=current;req.id=otherId;
  if(remote)Object.defineProperty(req.socket,'remoteAddress',{value:'192.0.2.1'});
  next();
 });app.use(profileRoutes(db,{...testConfig,NODE_ENV:'development',MOCK_LOGIN_ENABLED:enabled}));app.use(errorHandler);
 return {app,calls,body:{designationId,version:'0000000000000001'}};
}

test('profile designation is saved for the authenticated user and leaves role, organization and signature intact',async()=>{
 const {app,calls,body}=setup({demo:false});const response=await request(app).patch('/profile').send(body);
 assert.equal(response.status,200);assert.equal(response.body.user.designationId,designationId);assert.equal(response.body.user.version,'0000000000000002');
 const update=calls.find(call=>call.sql.startsWith('UPDATE dbo.Users'));
 assert.equal(update.params.id.value,actorId);assert.equal(update.params.hasSignature.value,false);
 assert.doesNotMatch(update.sql,/SET Role=|SET BranchId=|SET DepartmentId=/);
 assert.ok(calls.some(call=>call.params?.event?.value==='profile.updated'));
 assert.equal(calls.some(call=>call.sql.startsWith('UPDATE dbo.Sessions')),false);
});

test('profile updates reject arbitrary fields, invalid designations and stale versions before writing',async()=>{
 for(const extra of [{role:'Super Admin'},{userId:otherId},{branchId},{version:'0000000000000000'}]){
  const {app,calls,body}=setup();const response=await request(app).patch('/profile').send({...body,...extra});
  assert.equal(response.status,extra.version?409:400);assert.equal(calls.some(call=>/^(INSERT|UPDATE)/.test(call.sql)),false);
 }
 const {app,calls,body}=setup({designation:false});assert.equal((await request(app).patch('/profile').send(body)).status,400);
 assert.equal(calls.some(call=>/^(INSERT|UPDATE)/.test(call.sql)),false);
});

test('ordinary users cannot directly change access even in local mock mode',async()=>{
 for(const config of [{demo:false},{enabled:false},{remote:true}]){
  const {app,calls,body}=setup(config);const response=await request(app).patch('/profile').send({...body,access:[]});
  assert.equal(response.status,403);assert.equal(response.body.error.code,'ACCESS_APPROVAL_REQUIRED');assert.equal(calls.some(call=>/^(INSERT|UPDATE)/.test(call.sql)),false);
 }
});

test('authorized IT access editing preserves unchanged grants and revokes only removed assignments',async()=>{
 const existing=[{Id:otherId,SystemId:systemId,SystemRoleId:roleId,Username:'original.user',SourceRequestId:branchId},{Id:designationId,SystemId:branchId,SystemRoleId:null,Username:null}];
 const {app,calls,body}=setup({existing,role:'IT'});
 const response=await request(app).patch('/profile').send({...body,access:[{systemId,systemRoleId:roleId,username:'original.user'},{systemId:actorId,systemRoleId:null,username:'new.user'}]});
 // Reject the new system until it is in the active catalogue; no earlier grant was revoked.
 assert.equal(response.status,400);assert.equal(calls.some(call=>/^(INSERT|UPDATE)/.test(call.sql)),false);
 const valid=setup({role:'IT',existing,choices:[{Id:systemId,RoleId:roleId},{Id:actorId,RoleId:null}]});
 const saved=await request(valid.app).patch('/profile').send({...valid.body,access:[{systemId,systemRoleId:roleId,username:'original.user'},{systemId:actorId,systemRoleId:null,username:'new.user'}]});
 assert.equal(saved.status,200);
 const revoked=valid.calls.filter(call=>call.sql.startsWith('UPDATE dbo.AccessGrants SET RevokedAt'));
 assert.equal(revoked.length,1);assert.equal(revoked[0].params.grant.value,designationId);assert.equal(revoked[0].params.id.value,actorId);
 const added=valid.calls.filter(call=>call.sql.startsWith('INSERT dbo.AccessGrants'));
 assert.equal(added.length,1);assert.equal(added[0].params.system.value,actorId);assert.equal(added[0].params.id.value,actorId);
 assert.equal(valid.calls.some(call=>call.sql.startsWith('UPDATE dbo.AccessGrants SET Username')),false);
 assert.ok(valid.calls.some(call=>call.params?.event?.value==='profile.access_updated'));
});

test('mock access rejects duplicate entries, cross-system roles and malformed signatures',async()=>{
 const entry={systemId,systemRoleId:roleId};
 for(const changes of [{access:[entry,entry]},{access:[{...entry,systemRoleId:otherId}]},{access:[{systemId}]},{signatureBase64:Buffer.from('not a PNG').toString('base64')}]){
  const {app,calls,body}=setup({role:'IT'});const response=await request(app).patch('/profile').send({...body,...changes});
  assert.equal(response.status,400);assert.equal(calls.some(call=>/^(INSERT|UPDATE)/.test(call.sql)),false);
 }
});

test('profile read exposes own access and restricts direct editing by role',async()=>{
 for(const role of ['User','Branch manager','Department head','CITO','IT','Admin','Super Admin']){
  const {app}=setup({role,existing:[{Id:otherId,SystemId:systemId,SystemRoleId:roleId}]});const response=await request(app).get('/profile');
  assert.equal(response.status,200);assert.equal(response.body.user.id,actorId);assert.equal(response.body.access.length,1);assert.equal(response.body.canEditAccess,['IT','Admin','Super Admin'].includes(role));
 }
});
