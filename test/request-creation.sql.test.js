import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readConfig} from '../src/config.js';
import {createDatabase} from '../src/core/db.js';
import {createApp} from '../src/app.js';

// Explicit opt-in against the local mock database. Every table mutation rolls back.
// SQL Server sequence values are not transactional and can have gaps after this test.
test('local SQL request POST persists the ticket and approval routing atomically',{
 skip:process.env.UIDMS_SQL_REQUEST_SMOKE!=='true',
},async()=>{
 const config=readConfig();
 assert.equal(config.NODE_ENV,'development');assert.equal(config.MOCK_LOGIN_ENABLED,true);
 assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('Request smoke verification rollback');
 let server,verified=0;
 try{
  await db.connect();
  const before=(await db.query('SELECT COUNT(*) AS Total FROM dbo.Requests')).recordset[0].Total;
  await assert.rejects(db.transaction(async query=>{
   const user=(await query("SELECT * FROM dbo.Users WHERE EmployeeId=N'BNGL6191' AND IsDemo=1 AND Active=1")).recordset[0];
   assert.ok(user,'Import the local mock dataset before running this check.');
   const system=(await query("SELECT TOP(1) s.Id,sr.Id AS RoleId FROM dbo.Systems s JOIN dbo.SystemRoles sr ON sr.SystemId=s.Id WHERE s.Name=N'ICBS' AND s.Active=1 AND sr.Active=1 ORDER BY sr.Name")).recordset[0];
   assert.ok(system);
   // Keep HTTP authentication, CSRF, validation and service queries on the same rollback transaction.
   const scoped={query,transaction:work=>work(query)};
   server=createApp({db:scoped,config}).listen(0,'127.0.0.1');await once(server,'listening');
   const base=`http://127.0.0.1:${server.address().port}`;
   const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:config.origins[0],'Content-Type':'application/json'},body:JSON.stringify({employeeId:user.EmployeeId,password:'1234'})});
   const session=await login.json();assert.equal(login.status,200,JSON.stringify(session));
   const cookie=login.headers.get('set-cookie').split(';')[0];
   for(const typeCode of ['upgrade','new-id','reset']){
    const payload={typeCode,branchId:user.BranchId,departmentId:user.DepartmentId,justification:typeCode==='reset'?'':'Local SQL request creation verification.',details:{},
     people:[{employeeId:user.EmployeeId,name:user.Name,branchId:user.BranchId,departmentId:user.DepartmentId}],
     items:[{employeeId:user.EmployeeId,systemId:system.Id,systemRoleId:system.RoleId,operation:typeCode==='reset'?'reset':typeCode==='upgrade'?'update':'grant'}],consent:true};
    const response=await fetch(base+'/api/requests',{method:'POST',headers:{Origin:config.origins[0],'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrfToken},body:JSON.stringify(payload)});
    const created=await response.json();assert.equal(response.status,201,`${typeCode}: ${JSON.stringify(created)}`);
    const detail=await fetch(base+'/api/requests/'+created.id,{headers:{Cookie:cookie}});
    const ticket=await detail.json();assert.equal(detail.status,200,JSON.stringify(ticket));assert.equal(ticket.state,'Pending');
    assert.equal(ticket.items.length,1);assert.equal(ticket.people.length,1);
    assert.deepEqual(ticket.approvalHistory.map(step=>step.role),typeCode==='reset'?['CITO']:['Branch manager','IT','CITO','COO']);
    verified++;
   }
   throw rollback;
  }),error=>error===rollback);
  assert.equal(verified,3);
  assert.equal((await db.query('SELECT COUNT(*) AS Total FROM dbo.Requests')).recordset[0].Total,before,'Smoke requests must not remain in the database.');
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  await db.close();
 }
});
