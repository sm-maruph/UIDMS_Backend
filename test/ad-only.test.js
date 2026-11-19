import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {testConfig,user,actorId} from './helpers.js';
import {HttpError} from '../src/core/errors.js';

function fixture({registered=true,active=true,demo=true,oldLink='TEST1',mfa=false,directoryError,verifiedId='TEST1'}={}){
 const calls=[];const profile={...user,Role:'Super Admin',IsDemo:demo,Active:active,PasswordHash:'old-local-password-hash'};
 const query=async(sql,params)=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT u.* FROM dbo.DirectoryIdentities'))return {recordset:[]};
  if(sql.startsWith('SELECT * FROM dbo.Users WITH'))return {recordset:registered&&params.employee.value===profile.EmployeeId?[profile]:[]};
  if(sql.startsWith('SELECT SystemId,UserId FROM dbo.DirectoryIdentities'))return {recordset:oldLink?[{SystemId:oldLink,UserId:actorId}]:[]};
  if(sql.startsWith('UPDATE dbo.Users SET IsDemo=0'))return {recordset:[{Version:Buffer.from('0000000000000002','hex')}]};
  return {recordset:[]};
 };
 const db={query,transaction:work=>work(query)};
 const directory={authenticate:async()=>{if(directoryError)throw directoryError;return {systemId:'ad:test:'+Buffer.alloc(16,7).toString('hex'),employeeId:verifiedId};}};
 const app=createApp({db,config:{...testConfig,AUTH_MODE:'ad',LDAP_ENABLED:true,MOCK_LOGIN_ENABLED:true,MFA_REQUIRED:mfa},directory});
 return {app,calls};
}
const login=(app,body={})=>request(app).post('/api/auth/login').set('Origin',testConfig.origins[0]).send({employeeId:'TYPED_ALIAS',password:'AD test password',...body});

test('AD-only defaults to AD and matches the verified ID to the existing role without changing access',async()=>{
 const {app,calls}=fixture();const response=await login(app);
 assert.equal(response.status,200);assert.equal(response.body.provider,'ad');assert.equal(response.body.user.id,actorId);assert.equal(response.body.user.role,'Super Admin');assert.equal(response.body.user.isDemo,false);
 const match=calls.find(call=>call.sql.startsWith('SELECT * FROM dbo.Users WITH'));assert.equal(match.params.employee.value,'TEST1');
 assert.ok(calls.some(call=>call.sql.startsWith('UPDATE dbo.DirectoryIdentities')));
 assert.ok(calls.some(call=>call.sql.includes('IsDemo=0,PasswordHash=NULL')));
 assert.equal(calls.some(call=>call.sql.includes('SET Role=')||call.sql.includes('INSERT dbo.Users')||call.sql.includes('UPDATE dbo.AccessGrants')),false);
});

test('AD-only never assigns a profile from a typed ID before successful AD verification',async()=>{
 const {app,calls}=fixture({directoryError:new HttpError(401,'INVALID_CREDENTIALS')});assert.equal((await login(app,{employeeId:'TEST1'})).status,401);
 assert.equal(calls.some(call=>call.sql.includes('FROM dbo.Users')||call.sql.includes('INSERT dbo.DirectoryIdentities')),false);
 const missing=fixture({registered:false});const result=await login(missing.app,{employeeId:'TEST1'});assert.equal(result.status,200);assert.equal(result.body.onboardingRequired,true);assert.equal(result.body.profile.employeeId,'TEST1');assert.match(result.body.onboardingToken,/^[\w-]{43}$/);assert.equal(result.headers['set-cookie'],undefined);
 assert.equal(missing.calls.some(call=>call.sql.startsWith('INSERT dbo.Users')),false);
});

test('inactive profiles and conflicting previously pinned AD identities cannot be claimed',async()=>{
 const inactive=fixture({active:false});assert.equal((await login(inactive.app)).status,401);
 assert.equal(inactive.calls.some(call=>call.sql.startsWith('UPDATE dbo.DirectoryIdentities')),false);
 const conflict=fixture({oldLink:'ad:test:'+Buffer.alloc(16,8).toString('hex')});const result=await login(conflict.app);assert.equal(result.status,403);assert.equal(result.body.error.code,'AD_IDENTITY_CONFLICT');
 assert.equal(conflict.calls.some(call=>call.sql.startsWith('UPDATE dbo.DirectoryIdentities')),false);
});

test('AD-only rejects local sign-in and hides mock directory while retaining MFA',async()=>{
 const {app,calls}=fixture({mfa:true});const options=await request(app).get('/api/auth/options');assert.deepEqual(options.body,{mockLogin:false,localLogin:false,adLogin:true});
 assert.equal((await request(app).get('/api/auth/mock-directory')).status,404);
 assert.equal((await login(app,{provider:'local',employeeId:'TEST1',password:'1234'})).status,503);
 assert.equal(calls.length,0);
 const result=await login(app);assert.equal(result.status,200);assert.ok(result.body.challenge);assert.equal(result.body.user,undefined);
 const challenge=calls.find(call=>call.sql.includes('INSERT dbo.AuthChallenges'));assert.equal(challenge.params.provider.value,'ad');
 assert.equal(calls.some(call=>call.sql.startsWith('INSERT dbo.Sessions')),false);
});
