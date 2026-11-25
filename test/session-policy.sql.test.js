import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import request from 'supertest';
import {readConfig} from '../src/config.js';import {createDatabase,p} from '../src/core/db.js';import {createApp} from '../src/app.js';

test('SQL login lasts thirty minutes; deletion needs ten minutes left; continuing cannot extend the total',{skip:process.env.UIDMS_SQL_SESSION_POLICY_SMOKE!=='true',timeout:45000},async()=>{
 const config={...readConfig(),SESSION_MAX_MINUTES:30,SESSION_IDLE_MINUTES:30,AUTH_MODE:'ad',MFA_REQUIRED:false,COOKIE_SECURE:false};
 assert.equal(config.NODE_ENV,'development');assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('Session policy fixture rollback'),suffix=randomBytes(5).toString('hex');
 try{await db.connect();await assert.rejects(db.transaction(async connectionQuery=>{
  let pending=Promise.resolve();const query=(sql,params)=>{const result=pending.then(()=>connectionQuery(sql,params));pending=result.catch(()=>{});return result;};
  try{
   const scoped={query,transaction:work=>work(query)},ids={};
   for(const kind of ['branch','department','designation'])ids[kind]=(await query('INSERT dbo.Lookups(Kind,Name) OUTPUT inserted.Id VALUES(@kind,@name)',{kind:p.str(kind,20),name:p.text('Session policy '+kind+' '+suffix,150)})).recordset[0].Id;
   const actor=(await query("INSERT dbo.Users(EmployeeId,Name,Role,BranchId,DepartmentId) OUTPUT inserted.* VALUES(@employee,N'Session policy fixture','Admin',@branch,@department)",{employee:p.text('SP_'+suffix,40),branch:p.id(ids.branch),department:p.id(ids.department)})).recordset[0];
   const app=createApp({db:scoped,config,directory:{authenticate:async()=>({employeeId:actor.EmployeeId,systemId:'ad:fixture:'+randomBytes(16).toString('hex')})}});
   const login=await request(app).post('/api/auth/login').set('Origin',config.origins[0]).send({employeeId:actor.EmployeeId,password:'Fixture-password-only',provider:'ad'});assert.equal(login.status,200,JSON.stringify(login.body));assert.match(login.headers['set-cookie'][0],/Max-Age=1800/);
   const cookie=login.headers['set-cookie'][0].split(';')[0],csrf=login.body.csrfToken;
   const row=(await query('SELECT CreatedAt,ExpiresAt FROM dbo.Sessions WHERE UserId=@id',{id:p.id(actor.Id)})).recordset[0];assert.equal(+row.ExpiresAt-+row.CreatedAt,1800000);
   const review=()=>request(app).get('/api/admin/deletions/designation/'+ids.designation).set('Cookie',cookie);
   assert.equal((await review()).status,200);
   const age=minutes=>query(`DECLARE @started datetime2(3)=DATEADD(minute,-@age,SYSUTCDATETIME());
    UPDATE dbo.Sessions SET CreatedAt=@started,LastSeenAt=SYSUTCDATETIME(),ExpiresAt=DATEADD(minute,30,@started) WHERE UserId=@id;
    UPDATE dbo.AuditSessions SET StartedAt=@started,LastSeenAt=SYSUTCDATETIME(),ExpiresAt=DATEADD(minute,30,@started) WHERE UserId=@id;`,{age:p.int(minutes),id:p.id(actor.Id)});
   await age(15);assert.equal((await review()).status,200,'a fifteen-minute-old sign-in may still delete');
   await age(21);const denied=await review();assert.equal(denied.status,403);assert.match(denied.body.error.message,/at least 10 minutes/);
   const before=(await query('SELECT ExpiresAt FROM dbo.Sessions WHERE UserId=@id',{id:p.id(actor.Id)})).recordset[0].ExpiresAt;
   const continued=await request(app).post('/api/auth/continue').set('Origin',config.origins[0]).set('Cookie',cookie).set('X-CSRF-Token',csrf).send({reason:'continue'});assert.equal(continued.status,200);assert.equal(+new Date(continued.body.session.absoluteExpiresAt),+before);assert.equal((await review()).status,403);
   await age(31);assert.equal((await request(app).get('/api/auth/status').set('Cookie',cookie)).status,401);
   throw rollback;
  }finally{await pending;}
 }),error=>error===rollback);}finally{await db.close();}
});
