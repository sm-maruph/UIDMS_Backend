import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {auditRoutes,redactAudit} from '../src/modules/audit/routes.js';
import {auditFailures} from '../src/modules/audit/middleware.js';
import {errorHandler,HttpError} from '../src/core/errors.js';
import {testConfig,user,otherId} from './helpers.js';
const appFor=(actor,query)=>{const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=actor;req.auditSessionId=otherId;req.id=otherId;next();});app.use(auditRoutes({query,transaction:work=>work(query)},testConfig));app.use(errorHandler);return app;};
test('audit list and session details are limited to administrators before querying records',async()=>{
 for(const Role of ['User','IT','CITO','HR','Branch manager','Department head']){
  let count=0;const app=appFor({...user,Role},async()=>{count++;return {recordset:[]};});
  assert.equal((await request(app).get('/audit')).status,403);assert.equal((await request(app).get('/audit/1/session')).status,403);assert.equal(count,0);
 }
});
test('audit search stays in typed parameters, Dhaka dates are inclusive, and pagination is bounded',async()=>{
 const calls=[];const app=appFor({...user,Role:'Admin'},async(sql,params)=>{calls.push({sql,params});return {recordsets:[[{Total:0,People:0,SignIns:0}],[]]};});
 const text="x'; DROP TABLE dbo.Users;--";const result=await request(app).get('/audit').query({search:text,from:'2026-11-23',to:'2026-11-23',category:'configuration'});assert.equal(result.status,200);
 const call=calls.find(call=>call.sql.startsWith('SELECT COUNT(*)'));
 assert.equal(call.params.search.value,text);assert.equal(call.sql.includes(text),false);assert.equal(call.params.from.value.toISOString(),'2026-11-22T18:00:00.000Z');assert.equal(call.params.to.value.toISOString(),'2026-11-23T18:00:00.000Z');
 for(const query of [{pageSize:101},{from:'2026-11-24',to:'2026-11-23'},{category:"x' OR 1=1"}])assert.equal((await request(app).get('/audit').query(query)).status,400);
 assert.equal((await request(app).get('/audit/9223372036854775808/session')).status,400);
});
test('sensitive nested audit metadata is redacted without mutating stored metadata',()=>{
 const stored={roles:['IT'],nested:{password:'password-value',csrfToken:'csrf-value',safe:'visible'},signatureBase64:'png',secretKey:'secret'};
 const safe=redactAudit(stored);assert.equal(safe.nested.password,'[Redacted]');assert.equal(safe.nested.csrfToken,'[Redacted]');assert.equal(safe.signatureBase64,'[Redacted]');assert.equal(safe.nested.safe,'visible');assert.equal(stored.nested.password,'password-value');
});
test('navigation records use the authenticated actor/session and reject arbitrary or credential fields',async()=>{
 const calls=[];const app=appFor(user,async(sql,params)=>{calls.push({sql,params});return {recordset:[]};});
 assert.equal((await request(app).post('/activity').send({page:'Overview'})).status,204);
 const recorded=calls.find(call=>call.sql.startsWith('INSERT dbo.AuditEvents'));assert.equal(recorded.params.actor.value,user.Id);assert.equal(recorded.params.auditSession.value,otherId);assert.equal(recorded.params.event.value,'page.viewed');
 for(const body of [{page:'Overview',ip:'spoofed'},{page:'Overview',password:'secret'},{page:'arbitrary path?token=secret'}])assert.equal((await request(app).post('/activity').send(body)).status,400);
});
test('failed authenticated actions record safe server context without passwords or payloads',async()=>{
 const calls=[];let forwarded;
 const req={user,auditSessionId:otherId,id:otherId,ip:'192.0.2.8',method:'POST',baseUrl:'/api',route:{path:'/requests'},body:{password:'never-record-me'}};
 const failure=new HttpError(409,'STALE_VERSION','Reload before trying again.');await auditFailures({query:async(sql,params)=>calls.push({sql,params})})(failure,req,{},error=>{forwarded=error;});
 assert.equal(forwarded,failure);const data=JSON.parse(calls[0].params.metadata.value);assert.equal(data.code,'STALE_VERSION');assert.equal(data.route,'/api/requests');assert.equal(JSON.stringify(calls).includes('never-record-me'),false);
});
