import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import * as OTPAuth from 'otpauth';
import {createApp} from '../src/app.js';
import {seal,digest} from '../src/core/crypto.js';
import {testConfig,actorId} from './helpers.js';

function fixture(overrides={}){
 const secret=new OTPAuth.Secret({size:20});
 const totp=new OTPAuth.TOTP({algorithm:'SHA1',digits:6,period:30,secret});
 const row={UserId:actorId,TokenHash:digest('c'.repeat(43)),EmployeeId:'TEST1',Active:true,MfaSecret:seal(secret.base32,testConfig.DATA_ENCRYPTION_KEY,`mfa:${actorId}`),MfaLastCounter:null,MfaFailedAttempts:0,Attempts:0,LockedUntil:null,...overrides};
 const calls=[];
 const query=async(sql,params)=>{calls.push({sql,params});return {recordset:sql.includes('FROM dbo.AuthChallenges c WITH')?(overrides.missing?[]:[row]):[]};};
 const app=createApp({db:{query,transaction:work=>work(query)},config:testConfig});
 let wrong=0;while(totp.validate({token:String(wrong).padStart(6,'0'),window:1})!==null)wrong++;
 return {app,calls,valid:totp.generate(),wrong:String(wrong).padStart(6,'0')};
}
const verify=(app,code)=>request(app).post('/api/auth/mfa/verify').set('Origin',testConfig.origins[0]).send({challenge:'c'.repeat(43),code});

test('an incorrect or stale MFA code explains how to retry and still records failure without issuing a session',async()=>{
 const {app,calls,wrong}=fixture();const response=await verify(app,wrong);
 assert.equal(response.status,401);assert.equal(response.body.error.code,'MFA_INVALID');assert.match(response.body.error.message,/incorrect or has expired/);assert.match(response.body.error.message,/latest six-digit code for CBC UIDMS/);
 assert.equal(response.headers['set-cookie'],undefined);assert.ok(calls.some(call=>call.sql.includes('MfaFailedAttempts=MfaFailedAttempts+1')));assert.equal(calls.some(call=>call.sql.startsWith('INSERT dbo.Sessions')),false);
});

test('a used code tells the employee to wait for the next authenticator code',async()=>{
 const {app,valid}=fixture({MfaLastCounter:Math.floor(Date.now()/30000)+1});
 const response=await verify(app,valid);assert.equal(response.status,401);assert.equal(response.body.error.code,'MFA_CODE_USED');assert.match(response.body.error.message,/Wait for a new code/);
});

test('expired attempts, locked verification and exhausted challenges have actionable messages',async()=>{
 for(const [options,code,message] of [
  [{missing:true},'CHALLENGE_INVALID',/sign in again/],
  [{LockedUntil:new Date(Date.now()+900000)},'MFA_LOCKED',/Wait 15 minutes/],
  [{Attempts:5},'MFA_ATTEMPTS_EXCEEDED',/Too many incorrect codes/],
 ]){
  const {app,wrong,calls}=fixture(options);const response=await verify(app,wrong);
  assert.equal(response.status,401);assert.equal(response.body.error.code,code);assert.match(response.body.error.message,message);assert.equal(response.headers['set-cookie'],undefined);
  assert.equal(calls.some(call=>call.sql.includes('MfaFailedAttempts=MfaFailedAttempts+1')),false);
 }
});

test('the failure that triggers an MFA lock explains the wait immediately',async()=>{
 const {app,wrong,calls}=fixture({Attempts:4,MfaFailedAttempts:4});const response=await verify(app,wrong);
 assert.equal(response.status,401);assert.equal(response.body.error.code,'MFA_LOCKED');assert.match(response.body.error.message,/Wait 15 minutes/);assert.ok(calls.some(call=>call.sql.includes('MfaFailedAttempts=MfaFailedAttempts+1')));
});

test('entering a code before enrollment explains that the QR must be scanned first',async()=>{
 const {app,wrong}=fixture({MfaSecret:null});const response=await verify(app,wrong);
 assert.equal(response.status,400);assert.equal(response.body.error.code,'MFA_ENROLLMENT_REQUIRED');assert.match(response.body.error.message,/Show QR code/);
});
