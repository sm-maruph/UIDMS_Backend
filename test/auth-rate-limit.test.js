import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {rateLimit} from 'express-rate-limit';
import {authRateLimitOptions} from '../src/core/auth-rate-limit.js';
import {createApp} from '../src/app.js';
import {testConfig} from './helpers.js';

function fixture(){
 const app=express();app.use(express.json());
 app.use('/auth',rateLimit({...authRateLimitOptions(null,testConfig),limit:2}));
 app.get('/auth/options',(req,res)=>res.json({localLogin:true}));
 app.get('/auth/session',(req,res)=>res.status(401).json({error:'session absent'}));
 app.post('/auth/logout',(req,res)=>res.status(204).end());
 app.post(['/auth/login','/auth/mfa/verify','/auth/mfa/enroll'],(req,res)=>res.status(req.body.status||401).json({status:'fixture'}));
 return app;
}

test('setup reads, missing sessions and sign-outs cannot consume the credential failure allowance',async()=>{
 const app=fixture();
 for(let i=0;i<5;i++){
  assert.equal((await request(app).get('/auth/options')).status,200);
  assert.equal((await request(app).get('/auth/session')).status,401);
  assert.equal((await request(app).post('/auth/logout').send({})).status,204);
 }
 assert.equal((await request(app).post('/auth/login').send({})).status,401);
 assert.equal((await request(app).post('/auth/login').send({})).status,401);
 assert.equal((await request(app).post('/auth/login').send({})).status,429);
 assert.equal((await request(app).get('/auth/options')).status,200);
 assert.equal((await request(app).post('/auth/logout').send({})).status,204);
});

test('successful sign-ins and directory outages do not exhaust the bad-credential quota',async()=>{
 const app=fixture();
 for(const status of [200,200,200,503,503,503])assert.equal((await request(app).post('/auth/login').send({status})).status,status);
 assert.equal((await request(app).post('/auth/login').send({})).status,401);
 assert.equal((await request(app).post('/auth/login').send({})).status,401);
 const blocked=await request(app).post('/auth/login').send({});assert.equal(blocked.status,429);
 assert.equal(blocked.body.error.code,'AUTH_RATE_LIMITED');assert.ok(blocked.body.error.retryAfterSeconds>0);assert.equal(blocked.headers['retry-after'],String(blocked.body.error.retryAfterSeconds));
});

test('case-insensitive credential routes and MFA failures share the protected quota',async()=>{
 const app=fixture();
 assert.equal((await request(app).post('/auth/LOGIN/').send({})).status,401);
 assert.equal((await request(app).post('/auth/mfa/verify').send({})).status,401);
 assert.equal((await request(app).post('/auth/mfa/enroll').send({})).status,429);
});

test('actual API setup requests do not block login and retry metadata is exposed through CORS',async()=>{
 const db={query:async()=>({recordset:[]}),transaction:work=>work(db.query)};
 const app=createApp({db,config:testConfig});
 for(let i=0;i<35;i++)assert.equal((await request(app).get('/api/auth/options')).status,200);
 const response=await request(app).post('/api/auth/login').set('Origin',testConfig.origins[0]).send({employeeId:'UNKNOWN',password:'wrong'});
 assert.equal(response.status,401);
 assert.match(response.headers['access-control-expose-headers'],/Retry-After/);
});
