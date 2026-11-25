import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {deletionRoutes,deletionPlan,performDeletion,deletionSession} from '../src/modules/admin/deletions.js';
import {errorHandler} from '../src/core/errors.js';
import {user,otherId} from './helpers.js';

test('deletion requires Admin authority and at least ten minutes remaining',async()=>{
 for(const Role of ['User','IT','CITO','COO','HR','Branch manager','Department head','Admin','Super Admin']){
  let calls=0;const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={...user,Role};req.sessionWindow={expiresAt:new Date(Date.now()+(['Admin','Super Admin'].includes(Role)?9:30)*60000).toISOString()};next();});app.use(deletionRoutes({query:async()=>{calls++;return{recordset:[]};},transaction:async()=>{calls++;}}));app.use(errorHandler);
  for(const method of ['get','delete']){const response=await request(app)[method]('/admin/deletions/user/'+otherId).send({});assert.equal(response.status,403);}
  assert.equal(calls,0);
 }
});

test('deletion accepts twenty-minute-old sign-in with ten minutes left, but rejects the last ten minutes',t=>{
 const now=Date.now();t.mock.method(Date,'now',()=>now);
 for(const [remaining,allowed] of [[30,true],[15,true],[10,true],[9.99,false],[0,false]]){
  let next=false;const req={user:{...user,AuthenticatedAt:new Date(now-20*60000)},sessionWindow:{expiresAt:new Date(now+remaining*60000).toISOString()}};
  if(allowed){deletionSession(req,{},()=>{next=true;});assert.equal(next,true);}else assert.throws(()=>deletionSession(req,{},()=>{}),error=>error.code==='REAUTHENTICATION_REQUIRED');
 }
});

test('last active Super Admin cannot be removed even by another administrator',async()=>{
 const target={Id:otherId,Name:'Only Super Admin',Role:'Super Admin',Active:true,Version:Buffer.alloc(8)};let writes=0;
 const query=async(sql)=>{
  if(sql.startsWith('SELECT Id,Name,EmployeeId'))return{recordset:[target]};
  if(sql.startsWith('SELECT Id FROM dbo.Users WITH'))return{recordset:[{Id:otherId}]};
  if(sql.startsWith('SELECT\n (SELECT COUNT'))return{recordset:[{}]};
  if(!sql.startsWith('SELECT'))writes++;
  return{recordset:[]};
 };
 const plan=await deletionPlan(query,'user',otherId);
 await assert.rejects(performDeletion({transaction:work=>work(query)},{user:{...user,Role:'Admin'}},'user',otherId,{reviewToken:plan.reviewToken,confirmName:target.Name,requests:'keep'}),error=>error.code==='LAST_SUPER_ADMIN');
 assert.equal(writes,0);
});

test('deletion rejects unknown kinds, invalid IDs and client-supplied cascade lists',async()=>{
 let calls=0;const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={...user,Role:'Admin',AuthenticatedAt:new Date()};req.sessionWindow={expiresAt:new Date(Date.now()+30*60000).toISOString()};next();});app.use(deletionRoutes({transaction:async()=>{calls++;}}));app.use(errorHandler);
 for(const route of ['tables/'+otherId,"user/';DROP TABLE Users;--"]){assert.equal((await request(app).get('/admin/deletions/'+route)).status,400);}
 assert.equal((await request(app).delete('/admin/deletions/user/'+otherId).send({reviewToken:'a'.repeat(64),confirmName:'Someone',requestIds:[otherId]})).status,400);
 assert.equal(calls,0);
});
