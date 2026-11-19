import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import * as OTPAuth from 'otpauth';
import {readConfig} from '../src/config.js';
import {createDatabase,p} from '../src/core/db.js';
import {createApp} from '../src/app.js';
import {digest} from '../src/core/crypto.js';
import {HttpError} from '../src/core/errors.js';
import {notify} from '../src/modules/audit/service.js';

test('verified new AD employees enroll once as Users, complete MFA, and may omit email',{
 skip:process.env.UIDMS_SQL_ENROLLMENT_SMOKE!=='true',timeout:25000,
},async()=>{
 const config=readConfig();assert.equal(config.AUTH_MODE,'ad');assert.equal(config.NODE_ENV,'development');
 assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('Enrollment verification rollback');let server;
 try{
  await db.connect();
  const before=(await db.query('SELECT (SELECT COUNT(*) FROM dbo.Users) AS Users,(SELECT COUNT(*) FROM dbo.Requests) AS Requests,(SELECT COUNT(*) FROM dbo.AccessGrants) AS Grants,(SELECT COUNT(*) FROM dbo.AdEnrollmentChallenges) AS Enrollments')).recordset[0];
  const org=(await db.query("SELECT Id,Kind FROM dbo.Lookups WHERE Active=1 AND Kind IN ('branch','department')")).recordset;
  const branchId=org.find(row=>row.Kind==='branch').Id,departmentId=org.find(row=>row.Kind==='department').Id;
  const takenEmail=(await db.query('SELECT TOP(1) Email FROM dbo.Users WHERE Email IS NOT NULL')).recordset[0].Email;
  await assert.rejects(db.transaction(async connectionQuery=>{
   let pending=Promise.resolve();
   const query=(sql,params)=>{const result=pending.then(()=>connectionQuery(sql,params));pending=result.catch(()=>{});return result;};
   try{
    const identities=new Map();
    const directory={authenticate:async(account,password)=>{if(password!=='Fixture AD password')throw new HttpError(401,'INVALID_CREDENTIALS');return identities.get(account);}};
    server=createApp({db:{query,transaction:work=>work(query)},config:{...config,NODE_ENV:'test'},directory}).listen(0,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${server.address().port}`;
    const post=async(path,body)=>{const response=await fetch(base+'/api'+path,{method:'POST',headers:{Origin:config.origins[0],'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,headers:response.headers,data:await response.json()};};
    for(let i=0;i<2;i++){
     const employeeId='ENR_'+randomBytes(8).toString('hex').toUpperCase();
     const identity={employeeId,systemId:'ad:enrollmenttest:'+randomBytes(16).toString('hex'),name:'Directory Employee',email:''};identities.set(employeeId,identity);
     const bad=await post('/auth/login',{employeeId,password:'wrong'});assert.equal(bad.status,401);
     const login=await post('/auth/login',{employeeId,password:'Fixture AD password'});assert.equal(login.status,200,JSON.stringify(login.data));assert.equal(login.data.onboardingRequired,true);assert.equal(login.data.profile.employeeId,employeeId);assert.equal(login.headers.get('set-cookie'),null);
     const {onboardingToken}=login.data;
     const stored=(await query('SELECT TokenHash FROM dbo.AdEnrollmentChallenges WHERE EmployeeId=@employee',{employee:p.text(employeeId,40)})).recordset[0];assert.equal(stored.TokenHash,digest(onboardingToken));assert.notEqual(stored.TokenHash,onboardingToken);
     const options=await post('/auth/onboarding/options',{onboardingToken});assert.equal(options.status,200);assert.ok(options.data.organizations.length>=2);
     const profile={onboardingToken,name:"New Employee O'Brien",branchId,departmentId,email:''};
     assert.equal((await post('/auth/onboarding/complete',{...profile,role:'Super Admin'})).status,400);
     assert.equal((await post('/auth/onboarding/complete',{...profile,employeeId:'BD06653'})).status,400);
     assert.equal((await post('/auth/onboarding/complete',{...profile,departmentId:branchId})).status,400);
     assert.equal((await post('/auth/onboarding/complete',{...profile,email:takenEmail})).status,409);
     const complete=await post('/auth/onboarding/complete',profile);assert.equal(complete.status,201,JSON.stringify(complete.data));assert.equal(complete.data.mfaEnrollmentRequired,true);assert.equal(complete.data.user,undefined);assert.equal(complete.headers.get('set-cookie'),null);
     const user=(await query('SELECT * FROM dbo.Users WHERE EmployeeId=@employee',{employee:p.text(employeeId,40)})).recordset[0];assert.equal(user.Role,'User');assert.equal(user.Name,profile.name);assert.equal(user.Email,null);assert.equal(user.PasswordHash,null);assert.equal(user.IsDemo,false);assert.equal(user.BranchId,branchId);assert.equal(user.DepartmentId,departmentId);
     const link=(await query('SELECT SystemId FROM dbo.DirectoryIdentities WHERE UserId=@user',{user:p.id(user.Id)})).recordset[0];assert.equal(link.SystemId,identity.systemId);
     assert.equal((await post('/auth/onboarding/complete',profile)).status,401);
     assert.equal((await post('/auth/onboarding/options',{onboardingToken})).status,401);
     // In-app notifications work even before the new employee receives an email address.
     await notify(query,user.Id,null,'Enrollment fixture notification');
     const notices=(await query('SELECT COUNT(*) AS Total FROM dbo.Notifications WHERE UserId=@user',{user:p.id(user.Id)})).recordset[0];assert.equal(notices.Total,1);
     const setup=await post('/auth/mfa/enroll',{challenge:complete.data.challenge});assert.equal(setup.status,200);
     const uri=new URL(setup.data.otpauthUrl);assert.equal(uri.protocol,'otpauth:');assert.equal(uri.searchParams.get('secret'),setup.data.secret);assert.equal(uri.searchParams.get('period'),'30');
     const code=new OTPAuth.TOTP({algorithm:'SHA1',digits:6,period:30,secret:OTPAuth.Secret.fromBase32(setup.data.secret)}).generate();
     const wrong=code.slice(0,5)+(Number(code[5])+1)%10;
     const rejected=await post('/auth/mfa/verify',{challenge:complete.data.challenge,code:wrong});assert.equal(rejected.status,401);assert.equal(rejected.data.error.code,'MFA_INVALID');assert.match(rejected.data.error.message,/latest six-digit code/);
     const failed=(await query('SELECT MfaFailedAttempts FROM dbo.Users WHERE Id=@user',{user:p.id(user.Id)})).recordset[0];assert.equal(failed.MfaFailedAttempts,1);
     const verified=await post('/auth/mfa/verify',{challenge:complete.data.challenge,code});assert.equal(verified.status,200,JSON.stringify(verified.data));assert.equal(verified.data.user.role,'User');assert.equal(verified.data.user.employeeId,employeeId);assert.equal(verified.data.provider,'ad');
     const cookie=verified.headers.get('set-cookie').split(';')[0];
     const admin=await fetch(base+'/api/users',{method:'POST',headers:{Cookie:cookie,Origin:config.origins[0],'X-CSRF-Token':verified.data.csrfToken,'Content-Type':'application/json'},body:'{}'});assert.equal(admin.status,403);
     const again=await post('/auth/login',{employeeId,password:'Fixture AD password'});assert.equal(again.status,200);assert.ok(again.data.challenge);assert.equal(again.data.onboardingRequired,undefined);assert.equal(again.data.mfaEnrollmentRequired,false);
    }
    const expiredId='ENR_'+randomBytes(8).toString('hex').toUpperCase();identities.set(expiredId,{employeeId:expiredId,systemId:'ad:enrollmenttest:'+randomBytes(16).toString('hex')});
    const expired=await post('/auth/login',{employeeId:expiredId,password:'Fixture AD password'});
    await query('UPDATE dbo.AdEnrollmentChallenges SET ExpiresAt=DATEADD(minute,-1,SYSUTCDATETIME()) WHERE EmployeeId=@employee',{employee:p.text(expiredId,40)});
    assert.equal((await post('/auth/onboarding/options',{onboardingToken:expired.data.onboardingToken})).status,401);
    const counts=(await query('SELECT (SELECT COUNT(*) FROM dbo.Users) AS Users,(SELECT COUNT(*) FROM dbo.AccessGrants) AS Grants')).recordset[0];assert.equal(counts.Users,before.Users+2);assert.equal(counts.Grants,before.Grants);
    throw rollback;
   }finally{await pending;}
  }),error=>error===rollback);
  const after=(await db.query('SELECT (SELECT COUNT(*) FROM dbo.Users) AS Users,(SELECT COUNT(*) FROM dbo.Requests) AS Requests,(SELECT COUNT(*) FROM dbo.AccessGrants) AS Grants,(SELECT COUNT(*) FROM dbo.AdEnrollmentChallenges) AS Enrollments')).recordset[0];assert.deepEqual(after,before);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});
