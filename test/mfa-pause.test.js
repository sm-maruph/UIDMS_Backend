import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuth} from '../src/modules/auth/service.js';
import {mfaPausedForTesting,mfaRequiredForUser} from '../src/modules/auth/mfa-policy.js';
import {digest,seal} from '../src/core/crypto.js';
import {HttpError} from '../src/core/errors.js';
import {testConfig,user,branchId,departmentId} from './helpers.js';

const config={...testConfig,NODE_ENV:'development',AUTH_MODE:'ad',LDAP_ENABLED:true,MFA_REQUIRED:false};
const identity={employeeId:user.EmployeeId,systemId:'ad:test:'+'07'.repeat(16)};
const req={body:{employeeId:'TYPED_ALIAS',password:'AD password'},ip:'127.0.0.1',get:()=>''};
const enrolled=seal('JBSWY3DPEHPK3PXP',config.DATA_ENCRYPTION_KEY,`mfa:${user.Id}`);
function fixture({required=false,profile={...user,Role:'Super Admin',MfaSecret:enrolled},directoryError}={}){
 const calls=[];
 const query=async(sql,params)=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT u.* FROM dbo.DirectoryIdentities'))return {recordset:profile?[profile]:[]};
  if(sql.startsWith('SELECT * FROM dbo.AdEnrollmentChallenges'))return {recordset:[{...identity,EmployeeId:identity.employeeId,SystemId:identity.systemId,TokenHash:digest('e'.repeat(43))}]};
  if(sql.startsWith('SELECT Id FROM dbo.Lookups'))return {recordset:[{Id:branchId},{Id:departmentId}]};
  if(sql.startsWith('INSERT dbo.Users'))return {recordset:[{...user,MfaSecret:null,PasswordHash:null,IsDemo:false}]};
  return {recordset:[]};
 };
 const directory={authenticate:async()=>{if(directoryError)throw directoryError;return identity;}};
 const auth=createAuth({query,transaction:work=>work(query)},{...config,MFA_REQUIRED:required},{directory});
 const res={statusCode:200,status(value){this.statusCode=value;return this;},cookie(name,value,options){this.session={name,value,options};},json(value){this.body=value;}};
 return {auth,res,calls};
}

test('MFA pause applies only to explicit development false, and production always requires MFA',()=>{
 assert.equal(mfaPausedForTesting(config),true);
 assert.equal(mfaRequiredForUser(config,{MfaSecret:enrolled}),false);
 assert.equal(mfaRequiredForUser(config,{}),false);
 for(const NODE_ENV of ['test','production']){
  assert.equal(mfaPausedForTesting({...config,NODE_ENV}),false);
  assert.equal(mfaRequiredForUser({...config,NODE_ENV},{MfaSecret:enrolled}),true);
 }
 assert.equal(mfaRequiredForUser({...config,NODE_ENV:'production'},{}),true);
 assert.equal(mfaRequiredForUser({...config,MFA_REQUIRED:true},{}),true);
});

test('paused AD login retains role and secret and returns only the safe session response',async()=>{
 const {auth,res,calls}=fixture();await auth.login(req,res);
 assert.equal(res.body.user.role,'Super Admin');assert.equal(res.body.provider,'ad');
 assert.equal(res.body.challenge,undefined);assert.equal(res.body.raw,undefined);assert.equal(res.body.user.MfaSecret,undefined);
 assert.equal(res.session.options.httpOnly,true);assert.equal(res.session.options.sameSite,'strict');
 const session=calls.find(call=>call.sql.startsWith('INSERT dbo.Sessions'));
 assert.equal(session.params.token.value,digest(res.session.value));
 assert.equal(calls.some(call=>/AuthChallenges|SET MfaSecret|SET Role=|AccessGrants/.test(call.sql)),false);
 assert.ok(calls.some(call=>Object.values(call.params||{}).some(param=>typeof param.value==='string'&&param.value.includes('"mfaPausedForTesting":true'))));
});

test('resuming MFA uses the existing authenticator without replacing it or creating a session',async()=>{
 const {auth,res,calls}=fixture({required:true});await auth.login(req,res);
 assert.ok(res.body.challenge);assert.equal(res.body.mfaEnrollmentRequired,false);assert.equal(res.session,undefined);
 assert.equal(calls.some(call=>call.sql.startsWith('INSERT dbo.Sessions')||call.sql.includes('SET MfaSecret')),false);
});

test('pausing MFA still rejects invalid AD credentials, disabled profiles and locked profiles',async()=>{
 for(const options of [{directoryError:new HttpError(401,'INVALID_CREDENTIALS')},{profile:{...user,Active:false}},{profile:{...user,LockedUntil:new Date(Date.now()+60000)}}]){
  const {auth,res,calls}=fixture(options);
  await assert.rejects(auth.login(req,res),error=>error.status===401);
  assert.equal(res.session,undefined);assert.equal(calls.some(call=>call.sql.startsWith('INSERT dbo.Sessions')),false);
 }
});

test('new employee profile completion during the pause creates a User session without exposing its token',async()=>{
 const {auth,res,calls}=fixture({profile:null});
 await auth.completeOnboarding({...req,body:{onboardingToken:'e'.repeat(43),name:user.Name,email:null,branchId,departmentId}},res);
 assert.equal(res.statusCode,201);assert.equal(res.body.user.role,'User');assert.equal(res.body.provider,'ad');
 assert.equal(res.body.raw,undefined);assert.equal(res.body.challenge,undefined);assert.equal(res.body.csrf,undefined);
 assert.equal(res.body.csrfToken.length,43);assert.equal(res.session.options.httpOnly,true);
 const creation=calls.find(call=>call.sql.startsWith('INSERT dbo.Users'));
 assert.match(creation.sql,/N'User'/);assert.match(creation.sql,/NULL,0\)/);
 assert.equal(calls.some(call=>/AuthChallenges|AccessGrants|SET MfaSecret/.test(call.sql)),false);
});

test('profile completion requires first-time MFA setup again after resuming',async()=>{
 const {auth,res}=fixture({required:true,profile:null});
 await auth.completeOnboarding({...req,body:{onboardingToken:'e'.repeat(43),name:user.Name,email:null,branchId,departmentId}},res);
 assert.equal(res.statusCode,201);assert.ok(res.body.challenge);assert.equal(res.body.mfaEnrollmentRequired,true);assert.equal(res.session,undefined);
});
