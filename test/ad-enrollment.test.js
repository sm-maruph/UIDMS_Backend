import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {testConfig,branchId,departmentId} from './helpers.js';
import {enrollmentProfileSchema} from '../src/modules/auth/directory-onboarding.js';

test('enrollment accepts optional email and rejects employee ID, role, access or identity overrides',()=>{
 const body={onboardingToken:'a'.repeat(43),name:'New Employee',branchId,departmentId};
 for(const email of [undefined,'',null])assert.equal(enrollmentProfileSchema.parse({...body,email}).email,null);
 assert.equal(enrollmentProfileSchema.parse({...body,email:'Employee@EXAMPLE.COM'}).email,'employee@example.com');
 for(const extra of [{employeeId:'BD06653'},{role:'Super Admin'},{access:[]},{systemId:'ad:other'}])assert.equal(enrollmentProfileSchema.safeParse({...body,...extra}).success,false);
});

test('expired or forged enrollment proofs cannot read organizations or create a profile',async()=>{
 const calls=[];const query=async sql=>{calls.push(sql);return {recordset:[]};};
 const app=createApp({db:{query,transaction:work=>work(query)},config:{...testConfig,AUTH_MODE:'ad',LDAP_ENABLED:true}});
 for(const path of ['options','complete']){
  const body={onboardingToken:'a'.repeat(43),...(path==='complete'?{name:'New Employee',branchId,departmentId}: {})};
  const response=await request(app).post('/api/auth/onboarding/'+path).set('Origin',testConfig.origins[0]).send(body);
  assert.equal(response.status,401);assert.equal(response.body.error.code,'ENROLLMENT_EXPIRED');assert.equal(response.headers['set-cookie'],undefined);
 }
 assert.equal(calls.some(sql=>sql.includes('INSERT dbo.Users')||sql.includes('FROM dbo.Lookups')),false);
});
