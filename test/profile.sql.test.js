import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readConfig} from '../src/config.js';
import {createDatabase,p} from '../src/core/db.js';
import {createApp} from '../src/app.js';

test('local SQL profile editing saves designation, signature and access without replacing retained grants',{
 skip:process.env.UIDMS_SQL_PROFILE_SMOKE!=='true',
},async()=>{
 const config=readConfig();assert.equal(config.NODE_ENV,'development');assert.equal(config.MOCK_LOGIN_ENABLED,true);
 assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('Profile verification rollback');
 const signature='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
 let server,original;
 try{
  await db.connect();
  original=(await db.query("SELECT Id,Version,DesignationId FROM dbo.Users WHERE EmployeeId=N'BNGL6191' AND IsDemo=1 AND Active=1")).recordset[0];assert.ok(original);
  await assert.rejects(db.transaction(async query=>{
   server=createApp({db:{query,transaction:work=>work(query)},config}).listen(0,'127.0.0.1');await once(server,'listening');
   const base=`http://127.0.0.1:${server.address().port}`;
   const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:config.origins[0],'Content-Type':'application/json'},body:JSON.stringify({employeeId:'BNGL6191',password:'1234'})});
   const session=await login.json();assert.equal(login.status,200,JSON.stringify(session));
   const cookie=login.headers.get('set-cookie').split(';')[0];
   const get=async()=>{const result=await fetch(base+'/api/profile',{headers:{Cookie:cookie}});assert.equal(result.status,200);return result.json();};
   const patch=body=>fetch(base+'/api/profile',{method:'PATCH',headers:{Origin:config.origins[0],'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrfToken},body:JSON.stringify(body)});
   const profile=await get();assert.equal(profile.canEditAccess,true);
   const designation=(await query("SELECT TOP(1) Id FROM dbo.Lookups WHERE Kind='designation' AND Active=1 AND (@old IS NULL OR Id<>@old) ORDER BY Name",{old:p.id(original.DesignationId)})).recordset[0];assert.ok(designation);
   const candidate=(await query(`SELECT TOP(1) s.Id AS SystemId,sr.Id AS SystemRoleId FROM dbo.Systems s LEFT JOIN dbo.SystemRoles sr ON sr.SystemId=s.Id AND sr.Active=1 WHERE s.Active=1 AND NOT EXISTS(SELECT 1 FROM dbo.AccessGrants g WHERE g.UserId=@id AND g.SystemId=s.Id AND (g.SystemRoleId=sr.Id OR (g.SystemRoleId IS NULL AND sr.Id IS NULL)) AND g.RevokedAt IS NULL) ORDER BY s.Name,sr.Name`,{id:p.id(original.Id)})).recordset[0];assert.ok(candidate);
   const entries=profile.access.map(row=>({systemId:row.SystemId,systemRoleId:row.SystemRoleId,username:row.Username||''}));
   const response=await patch({version:profile.user.version,designationId:designation.Id,access:[...entries,{systemId:candidate.SystemId,systemRoleId:candidate.SystemRoleId,username:'profile.smoke'}],signatureBase64:signature});
   const saved=await response.json();assert.equal(response.status,200,JSON.stringify(saved));assert.notEqual(saved.user.version,profile.user.version);
   const latest=await get();assert.equal(latest.user.designationId,designation.Id);assert.equal(latest.access.length,profile.access.length+1);
   for(const grant of profile.access){const retained=latest.access.find(row=>row.Id===grant.Id);assert.ok(retained);assert.equal(retained.GrantedAt,grant.GrantedAt);assert.equal(retained.SourceRequestId,grant.SourceRequestId);}
   const image=await fetch(base+'/api/profile/signature',{headers:{Cookie:cookie}});assert.equal(image.status,200);assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'),signature);
   assert.equal((await patch({version:profile.user.version,designationId:null})).status,409);
   const restore=await patch({version:latest.user.version,designationId:original.DesignationId,access:entries});assert.equal(restore.status,200);
   assert.equal((await get()).access.length,profile.access.length);
   throw rollback;
  }),error=>error===rollback);
  const after=(await db.query('SELECT Version,DesignationId FROM dbo.Users WHERE Id=@id',{id:p.id(original.Id)})).recordset[0];
  assert.deepEqual(after.Version,original.Version);assert.equal(after.DesignationId,original.DesignationId);
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));await db.close();
 }
});
