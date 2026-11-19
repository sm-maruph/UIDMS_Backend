import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {directoryRoutes} from '../src/modules/directory/routes.js';
import {errorHandler} from '../src/core/errors.js';
import {verifyPassword} from '../src/core/crypto.js';
import {testConfig,user,branchId,departmentId,otherId} from './helpers.js';

function fixture({enabled=true,remote=false,role='Super Admin',mock=true}={}){
 const calls=[];
 const db={transaction:async work=>work(async(sql,params)=>{
  calls.push({sql,params});
  return {recordset:sql.startsWith('SELECT Id FROM dbo.Lookups')?[{Id:params.id.value}]:sql.startsWith('INSERT dbo.Users')?[{Id:otherId}]:[]};
 })};
 const app=express();app.use(express.json());app.use((req,res,next)=>{
  req.user={...user,Role:role};req.id=otherId;
  if(remote)Object.defineProperty(req.socket,'remoteAddress',{value:'192.0.2.1'});
  next();
 });
 app.use(directoryRoutes(db,{...testConfig,NODE_ENV:'development',MOCK_LOGIN_ENABLED:enabled}));app.use(errorHandler);
 return {app,calls,body:{employeeId:'MOCK002',name:'Additional Mock User',email:'mock002@combankbd.com',role:'User',branchId,departmentId,mock}};
}

test('admin-created mock account uses a salted password hash and no activation token',async()=>{
 const {app,calls,body}=fixture();const response=await request(app).post('/users').send(body);
 assert.equal(response.status,201);assert.deepEqual(response.body,{id:otherId,mock:true});
 const insertion=calls.find(call=>call.sql.startsWith('INSERT dbo.Users'));
 assert.equal(insertion.params.demo.value,true);assert.notEqual(insertion.params.password.value,'1234');
 assert.equal(await verifyPassword('1234',insertion.params.password.value),true);
 assert.equal(calls.some(call=>call.sql.includes('INSERT dbo.AuthChallenges')),false);
 assert.ok(calls.some(call=>call.params?.event?.value==='mock.user_created'));
});

test('mock account creation rejects disabled mode, remote clients and non-admins before writing',async()=>{
 for(const options of [{enabled:false},{remote:true},{role:'User'}]){
  const {app,calls,body}=fixture(options);const response=await request(app).post('/users').send(body);
  assert.equal(response.status,403);assert.equal(calls.length,0);
 }
});

test('ordinary account creation keeps activation rather than a shared password',async()=>{
 const {app,calls,body}=fixture({mock:false});const response=await request(app).post('/users').send(body);
 assert.equal(response.status,201);assert.ok(response.body.activationToken);assert.equal(response.body.mock,undefined);
 const insertion=calls.find(call=>call.sql.startsWith('INSERT dbo.Users'));
 assert.equal(insertion.params.demo.value,false);assert.equal(insertion.params.password.value,null);
 assert.ok(calls.some(call=>call.sql.includes('INSERT dbo.AuthChallenges')));
});
