import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import * as OTPAuth from 'otpauth';
import {readConfig} from '../src/config.js';
import {createDatabase,p} from '../src/core/db.js';
import {createApp} from '../src/app.js';
import {digest} from '../src/core/crypto.js';

// Rollback-only SQL/HTTP test with an injected directory verifier; no real AD passwords used.
test('AD-only SQL sign-in automatically matches an existing Super Admin and preserves its business records',{
 skip:process.env.UIDMS_SQL_AD_ONLY_SMOKE!=='true',
 timeout:20000,
},async()=>{
 const config=readConfig();assert.equal(config.AUTH_MODE,'ad');assert.equal(config.NODE_ENV,'development');
 assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('AD-only verification rollback');let server,original,retainedAdministrator;
 try{
  await db.connect();retainedAdministrator=(await db.query("SELECT TOP(1) * FROM dbo.Users WHERE Role='Super Admin' AND Active=1 ORDER BY EmployeeId")).recordset[0];assert.ok(retainedAdministrator);
  const counts=(await db.query('SELECT (SELECT COUNT(*) FROM dbo.Users) AS Users,(SELECT COUNT(*) FROM dbo.Requests) AS Requests,(SELECT COUNT(*) FROM dbo.AccessGrants WHERE RevokedAt IS NULL) AS Grants')).recordset[0];
  await assert.rejects(db.transaction(async connectionQuery=>{
   // All middleware shares this rollback connection, including post-response limiter decrements.
   let pending=Promise.resolve();
   const query=(sql,params)=>{const result=pending.then(()=>connectionQuery(sql,params));pending=result.catch(()=>{});return result;};
   try{
   // A pre-existing fixture avoids resetting a live administrator's MFA or immutable AD pin.
   const fixtureEmployee='ADONLY_'+randomBytes(8).toString('hex').toUpperCase();
   original=(await query("INSERT dbo.Users(EmployeeId,Name,Email,Role,BranchId,DepartmentId,PasswordHash,IsDemo) OUTPUT inserted.* VALUES(@employee,N'Existing administrator fixture',@email,N'Super Admin',@branch,@department,'legacy fixture hash',1)",{employee:p.text(fixtureEmployee,40),email:p.text(fixtureEmployee.toLowerCase()+'@uidms.invalid',254),branch:p.id(retainedAdministrator.BranchId),department:p.id(retainedAdministrator.DepartmentId)})).recordset[0];
   await query('INSERT dbo.DirectoryIdentities(SystemId,UserId) VALUES(@system,@user)',{system:p.text(fixtureEmployee,160),user:p.id(original.Id)});
   const identity={systemId:'ad:adonlytest:'+randomBytes(16).toString('hex'),employeeId:original.EmployeeId};
   const directory={authenticate:async(account,password)=>{assert.equal(account,original.EmployeeId);assert.equal(password,'Directory fixture password');return identity;}};
   // Use in-memory rate counters so post-response limiter writes cannot overlap the rollback connection.
   server=createApp({db:{query,transaction:work=>work(query)},config:{...config,NODE_ENV:'test',MFA_REQUIRED:true},directory}).listen(0,'127.0.0.1');await once(server,'listening');
   const base=`http://127.0.0.1:${server.address().port}`;
   const post=async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers:{Origin:config.origins[0],'Content-Type':'application/json'},body:JSON.stringify(body)});return {response,data:await response.json()};};
   const blocked=await post('/api/auth/login',{employeeId:original.EmployeeId,password:'1234',provider:'local'});assert.equal(blocked.response.status,503);
   const login=await post('/api/auth/login',{employeeId:original.EmployeeId,password:'Directory fixture password'});assert.equal(login.response.status,200,JSON.stringify(login.data));assert.ok(login.data.challenge);
   const setup=await post('/api/auth/mfa/enroll',{challenge:login.data.challenge});assert.equal(setup.response.status,200);
   const code=new OTPAuth.TOTP({issuer:'CBC UIDMS',label:original.EmployeeId,algorithm:'SHA1',digits:6,period:30,secret:OTPAuth.Secret.fromBase32(setup.data.secret)}).generate();
   const verified=await post('/api/auth/mfa/verify',{challenge:login.data.challenge,code});assert.equal(verified.response.status,200,JSON.stringify(verified.data));assert.equal(verified.data.user.role,'Super Admin');assert.equal(verified.data.user.id,original.Id);assert.equal(verified.data.user.employeeId,original.EmployeeId);assert.equal(verified.data.provider,'ad');
   const cookie=verified.response.headers.get('set-cookie').split(';')[0];
   const session=await fetch(base+'/api/auth/session',{headers:{Cookie:cookie}});assert.equal(session.status,200);assert.equal((await session.json()).user.role,original.Role);
   const current=(await query('SELECT Role,IsDemo,PasswordHash FROM dbo.Users WHERE Id=@id',{id:p.id(original.Id)})).recordset[0];assert.equal(current.Role,original.Role);assert.equal(current.IsDemo,false);assert.equal(current.PasswordHash,null);
   const link=(await query('SELECT SystemId FROM dbo.DirectoryIdentities WHERE UserId=@id',{id:p.id(original.Id)})).recordset[0];assert.equal(link.SystemId,identity.systemId);
   const beforeRollback=(await query('SELECT (SELECT COUNT(*) FROM dbo.Users) AS Users,(SELECT COUNT(*) FROM dbo.Requests) AS Requests,(SELECT COUNT(*) FROM dbo.AccessGrants WHERE RevokedAt IS NULL) AS Grants')).recordset[0];assert.deepEqual(beforeRollback,{...counts,Users:counts.Users+1});
   const raw='l'.repeat(43);await query("INSERT dbo.Sessions(TokenHash,UserId,CsrfHash,ExpiresAt,Ip,AuthProvider) VALUES(@hash,@user,@csrf,DATEADD(hour,1,SYSUTCDATETIME()),'127.0.0.1','local')",{hash:p.str(digest(raw),64),user:p.id(original.Id),csrf:p.str(digest('c'.repeat(43)),64)});
   const local=await fetch(base+'/api/auth/session',{headers:{Cookie:'uidms_dev='+raw}});assert.equal(local.status,401);assert.equal((await local.json()).error.code,'AUTH_PROVIDER_DISABLED');
   throw rollback;
   }finally{await pending;}
  }),error=>error===rollback);
  const after=(await db.query('SELECT Role,PasswordHash,IsDemo,MfaSecret,Version FROM dbo.Users WHERE Id=@id',{id:p.id(retainedAdministrator.Id)})).recordset[0];assert.equal(after.Role,retainedAdministrator.Role);assert.equal(after.PasswordHash,retainedAdministrator.PasswordHash);assert.equal(after.IsDemo,retainedAdministrator.IsDemo);assert.equal(after.MfaSecret,retainedAdministrator.MfaSecret);assert.deepEqual(after.Version,retainedAdministrator.Version);
  const removed=(await db.query('SELECT Id FROM dbo.Users WHERE Id=@id',{id:p.id(original.Id)})).recordset;assert.equal(removed.length,0);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});
