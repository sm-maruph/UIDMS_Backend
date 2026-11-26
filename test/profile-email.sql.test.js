import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import request from 'supertest';
import {readConfig} from '../src/config.js';import {createDatabase,p} from '../src/core/db.js';import {createApp} from '../src/app.js';

test('SQL self profile saves company email, preserves it on designation edits and rejects self access grants',{
 skip:process.env.UIDMS_SQL_PROFILE_EMAIL_SMOKE!=='true',timeout:45000
},async()=>{
 const config={...readConfig(),AUTH_MODE:'ad',MFA_REQUIRED:false,COOKIE_SECURE:false};assert.equal(config.NODE_ENV,'development');assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('Profile email rollback'),suffix=randomBytes(5).toString('hex');
 try{await db.connect();await assert.rejects(db.transaction(async connectionQuery=>{
  let pending=Promise.resolve();const query=(sql,params)=>{const result=pending.then(()=>connectionQuery(sql,params));pending=result.catch(()=>{});return result;};
  try{
  const ids={};for(const kind of ['branch','department'])ids[kind]=(await query('INSERT dbo.Lookups(Kind,Name) OUTPUT inserted.Id VALUES(@kind,@name)',{kind:p.str(kind,20),name:p.text('Email profile '+kind+' '+suffix,150)})).recordset[0].Id;
  const actor=(await query("INSERT dbo.Users(EmployeeId,Name,Role,BranchId,DepartmentId) OUTPUT inserted.* VALUES(@employee,N'Profile email fixture','User',@branch,@department)",{employee:p.text('PE_'+suffix,40),branch:p.id(ids.branch),department:p.id(ids.department)})).recordset[0];
  const app=createApp({db:{query,transaction:work=>work(query)},config,directory:{authenticate:async()=>({employeeId:actor.EmployeeId,systemId:'ad:fixture:'+randomBytes(16).toString('hex')})}});
  const login=await request(app).post('/api/auth/login').set('Origin',config.origins[0]).send({employeeId:actor.EmployeeId,password:'Fixture-password-only',provider:'ad'});assert.equal(login.status,200,JSON.stringify(login.body));
  const cookie=login.headers['set-cookie'][0].split(';')[0],csrf=login.body.csrfToken;
  const get=()=>request(app).get('/api/profile').set('Cookie',cookie);
  const patch=body=>request(app).patch('/api/profile').set('Cookie',cookie).set('Origin',config.origins[0]).set('X-CSRF-Token',csrf).send(body);
  const initial=await get();assert.equal(initial.status,200);assert.equal(initial.body.canEditAccess,false);
  const saved=await patch({version:initial.body.user.version,designationId:null,email:'Profile.Fixture@COMBANKBD.COM'});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.user.email,'profile.fixture@combankbd.com');
  const latest=await get();assert.equal(latest.body.user.email,'profile.fixture@combankbd.com');assert.equal(latest.body.user.role,'User');
  assert.equal((await patch({version:latest.body.user.version,designationId:null,email:'personal@gmail.com'})).status,400);
  assert.equal((await patch({version:latest.body.user.version,designationId:null,access:[]})).status,403);
  const preserved=await patch({version:latest.body.user.version,designationId:null});assert.equal(preserved.status,200);assert.equal(preserved.body.user.email,'profile.fixture@combankbd.com');
  const stored=(await query('SELECT Email FROM dbo.Users WHERE Id=@id',{id:p.id(actor.Id)})).recordset[0];assert.equal(stored.Email,'profile.fixture@combankbd.com');
  throw rollback;
  }finally{await pending;}
 }),error=>error===rollback);}finally{await db.close();}
});
