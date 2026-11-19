// Opt-in only. Never executes against CBC_UIDMS or an unrecognized database name.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {readConfig} from '../src/config.js';
import {createDatabase,p} from '../src/core/db.js';
import {createApp} from '../src/app.js';
import {hashPassword} from '../src/core/crypto.js';

test('SQL Server schema and full request/query/approval/delivery lifecycle',{skip:process.env.UIDMS_SQL_INTEGRATION!=='true'},async()=>{
 const config=readConfig();
 assert.match(config.DB_NAME,/^CBC_UIDMS_TEST_[A-Za-z0-9_]+$/,'Use a NEW, dedicated empty test database.');
 assert.notEqual(config.NODE_ENV,'production');
 const db=createDatabase(config);
 try{
  await db.connect();
  assert.equal((await db.query("SELECT COUNT(*) AS Count FROM sys.tables WHERE is_ms_shipped=0")).recordset[0].Count,0,'Test database must be empty; test never drops or truncates data.');
  for(const file of ['002-schema.sql','003-reference-data.sql','008-system-email-templates.sql','009-service-email-templates.sql','010-directory-identities.sql','011-mock-data-support.sql','012-hybrid-auth.sql']){
   const source=(await readFile(new URL(`../sql/${file}`,import.meta.url),'utf8')).replaceAll('USE CBC_UIDMS;',`USE [${config.DB_NAME}];`);
   for(const batch of source.split(/^GO\s*$/im))if(batch.trim())await db.query(batch);
  }
  const branch=(await db.query("SELECT Id FROM dbo.Lookups WHERE Kind='branch' AND Name='Dhanmondi Branch'")).recordset[0].Id;
  const department=(await db.query("SELECT Id FROM dbo.Lookups WHERE Kind='department' AND Name='Operations'")).recordset[0].Id;
  const system=(await db.query("SELECT Id FROM dbo.Systems WHERE Name='ICBS'")).recordset[0].Id;
  const systemRole=(await db.query("SELECT Id FROM dbo.SystemRoles WHERE SystemId=@system AND Name='Inquiry'",{system:p.id(system)})).recordset[0].Id;
  const password='Integration-only passphrase 2026!';const hash=await hashPassword(password);
  const users={};
  for(const role of ['User','Branch manager','IT','CITO','COO']){
   const id=randomUUID();const employee=`TEST_${role.replaceAll(' ','_')}`;
   await db.query('INSERT dbo.Users(Id,EmployeeId,Name,Email,Role,BranchId,DepartmentId,PasswordHash) VALUES(@id,@employee,@name,@email,@role,@branch,@department,@hash)',{id:p.id(id),employee:p.text(employee,40),name:p.text(employee,160),email:p.text(`${employee}@combankbd.com`,254),role:p.text(role,40),branch:p.id(branch),department:p.id(department),hash:p.str(hash,300)});
   users[role]={id,employee};
  }
  const app=createApp({db,config:{...config,MFA_REQUIRED:false,COOKIE_SECURE:false,NODE_ENV:'test'}});
  const origin=config.origins[0];
  for(const fixture of Object.values(users)){
   const response=await request(app).post('/api/auth/login').set('Origin',origin).send({employeeId:fixture.employee,password});assert.equal(response.status,200,JSON.stringify(response.body));
   fixture.cookie=response.headers['set-cookie'][0].split(';')[0];fixture.csrf=response.body.csrfToken;
  }
  const as=(role,method,url,body)=>{const fixture=users[role];let req=request(app)[method](url).set('Cookie',fixture.cookie);if(method!=='get')req=req.set('Origin',origin).set('X-CSRF-Token',fixture.csrf).send(body);return req;};
  const created=await as('User','post','/api/requests',{typeCode:'upgrade',branchId:branch,departmentId:department,justification:'Integration test access upgrade',details:{upgradeDetails:{systems:['ICBS']}},people:[{employeeId:users.User.employee,name:users.User.employee,branchId:branch,departmentId:department}],items:[{employeeId:users.User.employee,systemId:system,systemRoleId:systemRole,operation:'update'}],consent:true});
  assert.equal(created.status,201,JSON.stringify(created.body));const requestId=created.body.id;
  const detail=()=>as('User','get',`/api/requests/${requestId}`);
  let ticket=await detail();assert.equal(ticket.status,200);assert.equal(ticket.body.state,'Pending');
  const raised=await as('Branch manager','post',`/api/requests/${requestId}/queries`,{recipientId:users.User.id,message:'Please confirm your business purpose.',version:ticket.body.version});assert.equal(raised.status,201,JSON.stringify(raised.body));
  ticket=await detail();assert.equal(ticket.body.state,'Query');
  const replied=await as('User','post',`/api/queries/${raised.body.id}/reply`,{message:'Required for daily operations.',version:ticket.body.version});assert.equal(replied.status,204,JSON.stringify(replied.body));
  for(const role of ['Branch manager','IT','CITO','COO']){
   ticket=await detail();
   const approved=await as(role,'post',`/api/requests/${requestId}/decisions`,{decision:'approve',version:ticket.body.version});assert.equal(approved.status,200,JSON.stringify(approved.body));
  }
  ticket=await detail();assert.equal(ticket.body.state,'Approved');
  const completed=await as('IT','post',`/api/requests/${requestId}/complete`,{version:ticket.body.version,notes:'Provisioning verified in integration fixture.',confirmedProvisioned:true,credentials:[{employeeId:users.User.employee,systemId:system,username:'test.integration',password:'Temporary test delivery only!'}]});assert.equal(completed.status,204,JSON.stringify(completed.body));
  ticket=await detail();assert.equal(ticket.body.state,'Completed');
  const deliveries=await as('User','get','/api/deliveries');assert.equal(deliveries.body.items.length,1);
  const deliveryId=deliveries.body.items[0].Id;
  assert.equal((await as('IT','post',`/api/deliveries/${deliveryId}/consume`,{})).status,404);
  const consumed=await as('User','post',`/api/deliveries/${deliveryId}/consume`,{});assert.equal(consumed.status,200);assert.equal(consumed.body.credentials[0].username,'test.integration');
  assert.equal((await as('User','post',`/api/deliveries/${deliveryId}/consume`,{})).status,404);
  const grants=await as('User','get',`/api/users/${users.User.id}/access`);assert.equal(grants.body.access.length,1);
  const dashboard=await as('CITO','get','/api/dashboard');assert.equal(dashboard.body.completed,1);assert.equal(dashboard.body.active,0);
  const audit=(await db.query('SELECT COUNT(*) AS Count FROM dbo.AuditEvents')).recordset[0].Count;assert.ok(audit>=10);
  await assert.rejects(db.query("UPDATE dbo.AuditEvents SET Event='tampered'"));
 }finally{await db.close();}
});
