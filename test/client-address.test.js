import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {rateLimit} from 'express-rate-limit';
import {clientAddress,normalizeClientAddress} from '../src/core/client-address.js';
import {errorHandler} from '../src/core/errors.js';
import {createApp} from '../src/app.js';
import {testConfig} from './helpers.js';

test('IIS source ports are removed without truncating bare IPv6 addresses',()=>{
 for(const [input,expected] of [['192.168.23.61:52212','192.168.23.61'],['192.168.23.61','192.168.23.61'],['[2001:db8::1234]:52212','2001:db8::1234'],['[::1]','::1'],['2001:db8::443','2001:db8::443'],['::ffff:192.168.23.61','::ffff:192.168.23.61']])assert.equal(normalizeClientAddress(input),expected);
 for(const input of [undefined,'','invalid','192.168.23.61:0','192.168.23.61:65536','999.1.1.1:1234','192.168.23.61:12junk','[192.168.23.61]:443','[::1]:65536'])assert.equal(normalizeClientAddress(input),null);
});

test('forwarded addresses are used only through the configured Express trust boundary',async()=>{
 for(const trust of [false,'loopback']){
  const app=express();app.set('trust proxy',trust);app.use(clientAddress);app.get('/',(req,res)=>res.json({ip:req.ip}));app.use(errorHandler);
  const response=await request(app).get('/').set('X-Forwarded-For','192.168.23.61:52212');
  assert.equal(response.status,200);
  if(trust)assert.equal(response.body.ip,'192.168.23.61');else assert.ok(['127.0.0.1','::ffff:127.0.0.1'].includes(response.body.ip));
  const malformed=await request(app).get('/').set('X-Forwarded-For','invalid:123');assert.equal(malformed.status,trust?400:200);
  if(trust){
   assert.equal(malformed.body.error.code,'INVALID_CLIENT_IP');
   const spoof=await request(app).get('/').set('X-Forwarded-For','203.0.113.100, 192.168.23.61:52212');assert.equal(spoof.body.ip,'192.168.23.61');
  }
 }
});

test('normalizing addresses retains the rate limiter IPv6 subnet grouping',async()=>{
 const app=express();app.set('trust proxy','loopback');app.use(clientAddress);app.use(rateLimit({limit:1,windowMs:60000}));app.get('/',(req,res)=>res.json({ok:true}));
 assert.equal((await request(app).get('/').set('X-Forwarded-For','[2001:db8:abcd:1200::1]:52212')).status,200);
 assert.equal((await request(app).get('/').set('X-Forwarded-For','[2001:db8:abcd:12ff::2]:52213')).status,429);
 assert.equal((await request(app).get('/').set('X-Forwarded-For','[2001:db8:abcd:1300::1]:52214')).status,200);
});

test('actual API and credential quotas cannot be bypassed by changing IIS source ports',async()=>{
 const db={query:async()=>({recordset:[]}),transaction:work=>work(db.query)};
 const app=createApp({db,config:{...testConfig,TRUST_PROXY:'127.0.0.1,::1'}});
 for(let i=0;i<180;i++)assert.equal((await request(app).get('/api/auth/options').set('X-Forwarded-For',`192.168.23.61:${52000+i}`)).status,200);
 const blocked=await request(app).get('/api/auth/options').set('X-Forwarded-For','192.168.23.61:53000');assert.equal(blocked.status,429);assert.equal(blocked.body.error.code,'RATE_LIMITED');
 assert.equal((await request(app).get('/api/auth/options').set('X-Forwarded-For','192.168.23.62:53000')).status,200);
 for(let i=0;i<30;i++){
  const response=await request(app).post('/api/auth/login').set('Origin',testConfig.origins[0]).set('X-Forwarded-For',`192.168.23.62:${52000+i}`).send({employeeId:'UNKNOWN',password:'wrong'});assert.equal(response.status,401);
 }
 const failed=await request(app).post('/api/auth/login').set('Origin',testConfig.origins[0]).set('X-Forwarded-For','192.168.23.62:54000').send({employeeId:'UNKNOWN',password:'wrong'});assert.equal(failed.status,429);assert.equal(failed.body.error.code,'AUTH_RATE_LIMITED');
 assert.equal((await request(app).get('/api/auth/options').set('X-Forwarded-For','192.168.23.62:54001')).status,200);
});
