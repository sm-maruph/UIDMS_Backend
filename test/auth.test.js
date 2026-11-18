import test from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import {randomUUID} from 'node:crypto';
import {createAuth} from '../src/modules/auth/service.js';
import {seal,digest} from '../src/core/crypto.js';
import {SqlRateLimitStore} from '../src/core/rate-limit-store.js';
import {testConfig,user,actorId} from './helpers.js';

test('MFA verification creates session only for a valid code and does not allow code replay',async()=>{
 const secret=new OTPAuth.Secret({size:20});const totp=new OTPAuth.TOTP({issuer:'CBC UIDMS',label:'TEST1',algorithm:'SHA1',digits:6,period:30,secret});
 const row={UserId:actorId,TokenHash:digest('c'.repeat(43)),EmployeeId:'TEST1',Active:true,MfaSecret:seal(secret.base32,testConfig.DATA_ENCRYPTION_KEY,`mfa:${actorId}`),MfaLastCounter:null,LockedUntil:null};
 const calls=[];
 const db={transaction:async work=>work(async(text,params)=>{
  calls.push({text,params});
  if(text.includes('FROM dbo.AuthChallenges c WITH'))return {recordset:[row]};
  if(text.startsWith('UPDATE dbo.Users SET MfaSecret')){row.MfaLastCounter=params.counter.value;return {recordset:[]};}
  if(text.startsWith('SELECT u.Id'))return {recordset:[user]};
  return {recordset:[]};
 })};
 const auth=createAuth(db,testConfig);const req={body:{challenge:'c'.repeat(43),code:totp.generate()},ip:'127.0.0.1',id:randomUUID(),get:()=>''};
 let response;let cookie;
 const res={cookie:(name,value,options)=>{cookie={name,value,options};},json:value=>{response=value;}};
 await auth.verifyMfa(req,res);assert.equal(response.user.employeeId,'TEST1');assert.equal(cookie.options.httpOnly,true);assert.equal(cookie.options.sameSite,'strict');assert.equal(cookie.value.length,43);
 const insertion=calls.find(call=>call.text.startsWith('INSERT dbo.Sessions'));assert.ok(insertion);assert.notEqual(insertion.params.token.value,cookie.value);assert.equal(insertion.params.token.value,digest(cookie.value));
 await assert.rejects(auth.verifyMfa(req,res),error=>error.code==='MFA_INVALID');
 assert.ok(calls.some(call=>call.text.includes('MfaFailedAttempts=MfaFailedAttempts+1')));
});

test('shared rate limiter hashes client keys and increments under a database transaction',async()=>{
 const calls=[];const reset=new Date(Date.now()+60000);
 const db={transaction:async work=>work(async(text,params)=>{calls.push({text,params});return {recordset:[{TotalHits:4,ResetAt:reset}]};})};
 const store=new SqlRateLimitStore(db,'auth');store.init({windowMs:60000});
 const result=await store.increment('192.0.2.1');assert.equal(result.totalHits,4);assert.equal(result.resetTime.getTime(),reset.getTime());assert.equal(calls[0].params.key.value,digest('192.0.2.1'));assert.match(calls[0].text,/UPDLOCK,HOLDLOCK/);assert.equal(calls[0].params.namespace.value,'auth');
});
