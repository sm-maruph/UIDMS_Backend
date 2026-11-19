import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import * as OTPAuth from 'otpauth';
import {readConfig} from '../src/config.js';
import {createDatabase,p} from '../src/core/db.js';
import {createApp} from '../src/app.js';
import {linkDirectoryIdentity} from '../src/modules/auth/directory-link.js';

// Verifies SQL/session/MFA integration with an injected AD verifier. It never contacts AD.
test('local SQL hybrid authentication preserves AD provenance through MFA and safely converts a reviewed mock link',{
 skip:process.env.UIDMS_SQL_HYBRID_SMOKE!=='true',
},async()=>{
 const local=readConfig();assert.equal(local.NODE_ENV,'development');assert.equal(local.MOCK_LOGIN_ENABLED,true);
 assert.ok(['localhost','127.0.0.1','::1'].includes(local.DB_SERVER));
 const config={...local,AUTH_MODE:'hybrid',LDAP_ENABLED:true,MFA_REQUIRED:true};
 const db=createDatabase(local),rollback=new Error('Hybrid verification rollback');let server,original;
 try{
  await db.connect();
  original=(await db.query("SELECT Id,IsDemo,PasswordHash FROM dbo.Users WHERE EmployeeId=N'MOCK001' AND Active=1")).recordset[0];assert.equal(original?.IsDemo,true,'Use the unconverted local mock dataset.');
  await assert.rejects(db.transaction(async query=>{
   const scoped={query,transaction:work=>work(query)};
   const identity={systemId:'ad:smoke:'+randomBytes(16).toString('hex'),employeeId:'MOCK001'};
   const directory={authenticate:async(account,password)=>{assert.equal(account,'MOCK001');assert.equal(password,'Domain test password');return identity;}};
   server=createApp({db:scoped,config,directory}).listen(0,'127.0.0.1');await once(server,'listening');
   const base=`http://127.0.0.1:${server.address().port}`;
   const post=async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers:{Origin:config.origins[0],'Content-Type':'application/json'},body:JSON.stringify(body)});return {response,data:await response.json()};};
   const localSession=await post('/api/auth/login',{employeeId:'MOCK001',password:'1234',provider:'local'});assert.equal(localSession.response.status,200);
   const linked=await linkDirectoryIdentity(scoped,identity,'MOCK001',{id:randomUUID(),ip:'hybrid-sql-test'},{convertMock:true});assert.equal(linked.convertedMock,true);
   const login=await post('/api/auth/login',{employeeId:'MOCK001',password:'Domain test password',provider:'ad'});assert.equal(login.response.status,200,JSON.stringify(login.data));assert.ok(login.data.challenge);assert.equal(login.data.user,undefined);
   const challenge=(await query('SELECT AuthProvider FROM dbo.AuthChallenges WHERE UserId=@id',{id:p.id(original.Id)})).recordset[0];assert.equal(challenge.AuthProvider,'ad');
   const setup=await post('/api/auth/mfa/enroll',{challenge:login.data.challenge});assert.equal(setup.response.status,200);
   const code=new OTPAuth.TOTP({issuer:'CBC UIDMS',label:'MOCK001',algorithm:'SHA1',digits:6,period:30,secret:OTPAuth.Secret.fromBase32(setup.data.secret)}).generate();
   const verified=await post('/api/auth/mfa/verify',{challenge:login.data.challenge,code});assert.equal(verified.response.status,200,JSON.stringify(verified.data));assert.equal(verified.data.provider,'ad');
   const cookie=verified.response.headers.get('set-cookie').split(';')[0];
   const session=await fetch(base+'/api/auth/session',{headers:{Cookie:cookie}});assert.equal(session.status,200);assert.equal((await session.json()).provider,'ad');
   const failedLocal=await post('/api/auth/login',{employeeId:'MOCK001',password:'1234',provider:'local'});assert.equal(failedLocal.response.status,401);
   config.AUTH_MODE='local';
   const disabled=await fetch(base+'/api/auth/session',{headers:{Cookie:cookie}});assert.equal(disabled.status,401);assert.equal((await disabled.json()).error.code,'AUTH_PROVIDER_DISABLED');
   throw rollback;
  }),error=>error===rollback);
  const after=(await db.query('SELECT IsDemo,PasswordHash FROM dbo.Users WHERE Id=@id',{id:p.id(original.Id)})).recordset[0];assert.equal(after.IsDemo,original.IsDemo);assert.equal(after.PasswordHash,original.PasswordHash);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});
