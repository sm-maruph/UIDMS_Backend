import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {createAuth} from '../src/modules/auth/service.js';
import {hashPassword} from '../src/core/crypto.js';
import {HttpError} from '../src/core/errors.js';
import {testConfig,user,actorId,otherId} from './helpers.js';

const password='Local test passphrase 2026',passwordHash=await hashPassword(password);
const config={...testConfig,AUTH_MODE:'hybrid',LDAP_ENABLED:true};
function fixture({mapped=true,mfa=false,demo=false,ldapError,mode='hybrid'}={}){
 const calls=[],directoryCalls=[];const account={...user,IsDemo:demo,PasswordHash:passwordHash};
 const query=async(sql,params)=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT u.* FROM dbo.DirectoryIdentities'))return {recordset:mapped?[account]:[]};
  if(sql.startsWith('SELECT TOP(1) * FROM dbo.Users')||sql.startsWith('SELECT * FROM dbo.Users WITH'))return {recordset:[account]};
  return {recordset:[]};
 };
 const db={query,transaction:work=>work(query)};
 const directory={authenticate:async(...args)=>{directoryCalls.push(args);if(ldapError)throw ldapError;return {systemId:'ad:test:'+Buffer.alloc(16,1).toString('hex'),employeeId:account.EmployeeId};}};
 const current={...config,AUTH_MODE:mode,MFA_REQUIRED:mfa};
 return {app:createApp({db,config:current,directory}),db,directory,current,calls,directoryCalls};
}
const login=(app,provider,passwordValue=password)=>request(app).post('/api/auth/login').set('Origin',testConfig.origins[0]).send({employeeId:'TEST1',password:passwordValue,provider});

test('hybrid exposes both methods and explicit local login never contacts AD',async()=>{
 const {app,directoryCalls}=fixture();const options=await request(app).get('/api/auth/options');
 assert.equal(options.body.localLogin,true);assert.equal(options.body.adLogin,true);
 const response=await login(app,'local');assert.equal(response.status,200);assert.equal(response.body.provider,'local');assert.equal(directoryCalls.length,0);
});

test('AD login uses only the verified immutable link and ignores the local password hash',async()=>{
 const {app,calls,directoryCalls}=fixture();const response=await login(app,'ad','AD-only password');
 assert.equal(response.status,200);assert.equal(response.body.provider,'ad');assert.equal(response.body.user.id,actorId);assert.equal(directoryCalls.length,1);
 assert.equal(calls.some(call=>call.sql.includes('WHERE EmployeeId=@employee')),false);
 const session=calls.find(call=>call.sql.startsWith('INSERT dbo.Sessions'));assert.equal(session.params.provider.value,'ad');
});

test('AD failures and missing/manual links never fall back to local login or create profiles',async()=>{
 for(const options of [{ldapError:new HttpError(401,'INVALID_CREDENTIALS')},{ldapError:new HttpError(503,'DIRECTORY_UNAVAILABLE')},{mapped:false},{demo:true}]){
  const {app,calls}=fixture(options);const response=await login(app,'ad');
  assert.equal(response.status,options.ldapError?.status||(!options.mapped&&!options.demo?403:401));
  assert.equal(calls.some(call=>call.sql.startsWith('INSERT dbo.Sessions')||call.sql.startsWith('INSERT dbo.Users')),false);
  assert.equal(calls.some(call=>call.sql.includes('WHERE EmployeeId=@employee')),false);
 }
});

test('AD respects MFA and persists its provider on the challenge instead of creating a session',async()=>{
 const {app,calls}=fixture({mfa:true});const response=await login(app,'ad');assert.equal(response.status,200);assert.ok(response.body.challenge);assert.equal(response.body.user,undefined);
 const challenge=calls.find(call=>call.sql.includes('INSERT dbo.AuthChallenges'));assert.equal(challenge.params.provider.value,'ad');assert.equal(calls.some(call=>call.sql.startsWith('INSERT dbo.Sessions')),false);
});

test('disabled sign-in methods do not authenticate and invalid provider values fail validation',async()=>{
 for(const [mode,provider] of [['local','ad'],['ad','local']]){
  const {app,directoryCalls,calls}=fixture({mode});const response=await login(app,provider);assert.equal(response.status,503);assert.equal(directoryCalls.length,0);assert.equal(calls.length,0);
 }
 const {app}=fixture();assert.equal((await login(app,'auto')).status,400);
});

test('a session is rejected when its authentication provider is disabled',async()=>{
 const db={query:async()=>({recordsets:[[{TokenHash:'hash'}],[{...user,CsrfHash:'csrf',AuthProvider:'ad'}]]})};
 const auth=createAuth(db,{...testConfig,AUTH_MODE:'local',LDAP_ENABLED:false});
 await assert.rejects(auth.authenticate({cookies:{uidms_dev:'a'.repeat(43)},method:'GET'}, {},()=>{}),error=>error.code==='AUTH_PROVIDER_DISABLED');
});
