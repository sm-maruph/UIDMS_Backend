import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readConfig} from '../src/config.js';
import {createDatabase,p} from '../src/core/db.js';
import {saveAssignment} from '../src/modules/directory/approvers.js';
import {createTicket,decide,listTickets} from '../src/modules/requests/service.js';
import {loadTicket,details} from '../src/modules/requests/repository.js';
import {saveWorkflow} from '../src/modules/admin/workflows.js';
import {canReview} from '../src/modules/requests/policy.js';
import {userColumns,publicUser} from '../src/modules/auth/service.js';

test('SQL scoped assignments route exact IDs, reconcile pending steps and preserve roles and decisions',{
 skip:process.env.UIDMS_SQL_APPROVER_SMOKE!=='true',timeout:30000,
},async()=>{
 const config=readConfig();assert.equal(config.NODE_ENV,'development');assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('Approver fixture rollback'),suffix=randomBytes(5).toString('hex');
 const code='approver-test-'+suffix;
 try{
  await db.connect();
  await assert.rejects(db.transaction(async query=>{
   const scoped={query,transaction:work=>work(query)};
   const org={};for(const name of ['branch','department','second-department'])org[name]=(await query('INSERT dbo.Lookups(Kind,Name) OUTPUT inserted.Id VALUES(@kind,@name)',{kind:p.str(name==='branch'?'branch':'department',30),name:p.text('Approver '+name+' '+suffix,160)})).recordset[0].Id;
   const headOffice=(await query("SELECT TOP(1) Id FROM dbo.Lookups WHERE Kind='branch' AND Name='Head Office' AND Active=1")).recordset[0].Id;
   const actors={};
   for(const [key,role,branch] of [['submitter','User',org.branch],['office-submitter','User',headOffice],['first','User',headOffice],['second','User',headOffice],['legacy','Branch manager',org.branch],['IT','IT',org.branch],['CITO','CITO',org.branch],['admin','Super Admin',org.branch]])actors[key]=(await query('INSERT dbo.Users(EmployeeId,Name,Role,BranchId,DepartmentId,IsDemo) OUTPUT inserted.* VALUES(@employee,@name,@role,@branch,@department,0)',{employee:p.text('AP_'+suffix+'_'+key,40),name:p.text('Approver fixture '+key,160),role:p.text(role,40),branch:p.id(branch),department:p.id(org.department)})).recordset[0];
   const req=key=>({user:actors[key],id:randomUUID(),ip:'127.0.0.1'});
   const mapping=scope=>query('SELECT * FROM dbo.OrganizationApprovers WHERE ScopeId=@scope',{scope:p.id(scope)}).then(result=>result.recordset[0]);
   const assign=async(scope,key,actor='IT')=>saveAssignment(scoped,req(actor),scope,{employeeId:actors[key].EmployeeId,version:(await mapping(scope))?.Version.toString('hex')||null});
   const steps=id=>query('SELECT * FROM dbo.RequestSteps WHERE RequestId=@id ORDER BY Position',{id:p.id(id)}).then(result=>result.recordset);
   const current=id=>loadTicket(query,id,actors.IT);
   const approve=async(id,key)=>decide(scoped,req(key),id,{version:(await current(id)).Version.toString('hex'),decision:'approve'});
   const list=async(key,number)=>listTickets(scoped,actors[key],{scope:'approvals',sort:'newest',page:1,pageSize:100,search:number});
   const system=(await query('SELECT TOP(1) s.Id,sr.Id AS RoleId FROM dbo.Systems s LEFT JOIN dbo.SystemRoles sr ON sr.SystemId=s.Id AND sr.Active=1 WHERE s.Active=1 ORDER BY s.Name')).recordset[0];
   await query('INSERT dbo.RequestTypes(Code,Name,IncludesHr,InitiatorRoles) VALUES(@code,@name,0,@roles)',{code:p.str(code,50),name:p.text('Approver fixture '+suffix,100),roles:p.json(['User'])});
   await saveWorkflow(scoped,req('admin'),code,{roles:['Manager','CITO'],applyToOpenRequests:false});
   const payload=key=>({typeCode:code,branchId:actors[key].BranchId,departmentId:org.department,justification:'Controlled approver routing verification.',details:{},people:[{employeeId:actors[key].EmployeeId,name:actors[key].Name,branchId:actors[key].BranchId,departmentId:org.department,details:{}}],items:[{employeeId:actors[key].EmployeeId,systemId:system.Id,systemRoleId:system.RoleId,operation:'grant'}],consent:true});

   await assign(org.branch,'first');await assign(org.department,'second','admin');await assign(org['second-department'],'second');
   const unchanged=(await query('SELECT Id,Role,BranchId,DepartmentId FROM dbo.Users WHERE Id=@id',{id:p.id(actors.first.Id)})).recordset[0];
   assert.equal(unchanged.Role,'User');assert.equal(unchanged.BranchId,headOffice);
   const capability=(await query(`SELECT ${userColumns} FROM dbo.Users u WHERE u.Id=@id`,{id:p.id(actors.first.Id)})).recordset[0];assert.equal(publicUser(capability).canApproveRequests,true);
   const branchRequest=await createTicket(scoped,req('submitter'),payload('submitter'));
   assert.equal((await steps(branchRequest.id))[0].AssignedUserId,actors.first.Id);
   assert.equal((await list('first',branchRequest.ticketNumber)).total,1);assert.equal((await list('legacy',branchRequest.ticketNumber)).total,0);
   const reviewDetail=await details(query,await loadTicket(query,branchRequest.id,actors.first),actors.first);
   assert.equal(reviewDetail.workflowSteps[0].assignedName,actors.first.Name);assert.equal(reviewDetail.queryParticipants[0].id,actors.submitter.Id);
   const before=(await current(branchRequest.id)).Version.toString('hex');
   const change=await assign(org.branch,'second');assert.equal(change.updatedRequests,1);
   assert.equal((await steps(branchRequest.id))[0].AssignedUserId,actors.second.Id);
   assert.notEqual((await current(branchRequest.id)).Version.toString('hex'),before);
   assert.equal((await list('first',branchRequest.ticketNumber)).total,0);assert.equal((await list('second',branchRequest.ticketNumber)).total,1);
   await assert.rejects(approve(branchRequest.id,'first'),error=>['REQUEST_NOT_FOUND','NOT_ASSIGNED'].includes(error.code));
   await assert.rejects(saveAssignment(scoped,req('IT'),org.branch,{employeeId:actors.first.EmployeeId,version:null}),error=>error.code==='STALE_ASSIGNMENT');
   await approve(branchRequest.id,'second');const approved=(await steps(branchRequest.id))[0];
   await assign(org.branch,'first');assert.deepEqual((await steps(branchRequest.id))[0],approved);
   await saveWorkflow(scoped,req('admin'),code,{roles:['Manager','CITO'],applyToOpenRequests:true});assert.deepEqual((await steps(branchRequest.id))[0],approved);
   await approve(branchRequest.id,'CITO');const finalVersion=(await current(branchRequest.id)).Version;
   await assign(org.branch,'second');assert.deepEqual((await current(branchRequest.id)).Version,finalVersion);

   const officeRequest=await createTicket(scoped,req('office-submitter'),payload('office-submitter'));
   const officeStep=(await steps(officeRequest.id))[0];assert.equal(officeStep.Role,'Department head');assert.equal(officeStep.AssignedUserId,actors.second.Id);
   assert.equal(canReview(await current(officeRequest.id),officeStep,actors.second),true);
   await assert.rejects(loadTicket(query,officeRequest.id,actors.first),error=>error.code==='REQUEST_NOT_FOUND');
   await assign(org.department,'first');assert.equal((await steps(officeRequest.id))[0].AssignedUserId,actors.first.Id);
   assert.equal((await mapping(org['second-department'])).UserId,actors.second.Id);
   await approve(officeRequest.id,'first');
   await assert.rejects(assign(org.department,'second','submitter'),error=>error.status===403);
   throw rollback;
  }),error=>error===rollback);
  assert.equal((await db.query('SELECT Code FROM dbo.RequestTypes WHERE Code=@code',{code:p.str(code,50)})).recordset.length,0);
 }finally{await db.close();}
});
