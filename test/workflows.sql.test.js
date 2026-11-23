import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {readConfig} from '../src/config.js';
import {createDatabase,p} from '../src/core/db.js';
import {saveWorkflow} from '../src/modules/admin/workflows.js';
import {createTicket,decide,listTickets} from '../src/modules/requests/service.js';
import {loadTicket,details} from '../src/modules/requests/repository.js';
import {raiseQuery,queryRoutes} from '../src/modules/queries/routes.js';
import {fulfilmentRoutes} from '../src/modules/fulfilment/routes.js';
import {errorHandler} from '../src/core/errors.js';

test('SQL workflows drive approval, live pending-step changes, query resumption and processing to completion',{
 skip:process.env.UIDMS_SQL_WORKFLOW_SMOKE!=='true',timeout:30000,
},async()=>{
 const config=readConfig();assert.equal(config.NODE_ENV,'development');assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('Workflow fixture rollback');
 const suffix=randomBytes(5).toString('hex'),code='workflow-test-'+suffix;
 try{
  await db.connect();
  const originalReset=(await db.query("SELECT Role FROM dbo.WorkflowSteps WHERE TypeCode='reset' ORDER BY Position")).recordset;
  const originalNewUser=(await db.query("SELECT Role FROM dbo.WorkflowSteps WHERE TypeCode='new-user' ORDER BY Position")).recordset;
  await assert.rejects(db.transaction(async connectionQuery=>{
   let pending=Promise.resolve();const query=(sql,params)=>{const result=pending.then(()=>connectionQuery(sql,params));pending=result.catch(()=>{});return result;};
   try{
    const scoped={query,transaction:work=>work(query)};
    const org=[];for(const kind of ['branch','department'])org.push((await query('INSERT dbo.Lookups(Kind,Name) OUTPUT inserted.* VALUES(@kind,@name)',{kind:p.str(kind,30),name:p.text('Workflow '+kind+' '+suffix,160)})).recordset[0]);
    const branch=org.find(row=>row.Kind==='branch'),department=org.find(row=>row.Kind==='department');
    const system=(await query('SELECT TOP(1) s.Id,sr.Id AS RoleId FROM dbo.Systems s LEFT JOIN dbo.SystemRoles sr ON sr.SystemId=s.Id AND sr.Active=1 WHERE s.Active=1 ORDER BY s.Name')).recordset[0];
    const actors={};
    for(const Role of ['Super Admin','User','IT','HR','CITO','COO','Branch manager']){
     const user=(await query('INSERT dbo.Users(EmployeeId,Name,Email,Role,BranchId,DepartmentId,IsDemo) OUTPUT inserted.* VALUES(@employee,@name,NULL,@role,@branch,@department,0)',{employee:p.text('WF_'+suffix+'_'+Role.replace(' ',''),40),name:p.text('Workflow fixture '+Role,160),role:p.text(Role,40),branch:p.id(branch.Id),department:p.id(department.Id)})).recordset[0];
     actors[Role]={...user,AuthenticatedAt:new Date()};
    }
    await query('INSERT dbo.RequestTypes(Code,Name,IncludesHr,InitiatorRoles) VALUES(@code,@name,0,@roles)',{code:p.str(code,50),name:p.text('Workflow fixture '+suffix,100),roles:p.json(['User'])});
    const req=role=>({user:actors[role],ip:'127.0.0.1',id:randomUUID()});
    const update=roles=>saveWorkflow(scoped,req('Super Admin'),code,{roles,applyToOpenRequests:true});
    const payload=()=>({typeCode:code,branchId:branch.Id,departmentId:department.Id,justification:'Controlled workflow verification.',details:{},people:[{employeeId:actors.User.EmployeeId,name:actors.User.Name,branchId:branch.Id,departmentId:department.Id,details:{}}],items:[{employeeId:actors.User.EmployeeId,systemId:system.Id,systemRoleId:system.RoleId,operation:'grant'}],consent:true});
    const current=id=>loadTicket(query,id,actors.IT);
    const steps=id=>query('SELECT * FROM dbo.RequestSteps WHERE RequestId=@id ORDER BY Position',{id:p.id(id)}).then(result=>result.recordset);
    const approve=async(id,role)=>decide(scoped,req(role),id,{version:(await current(id)).Version.toString('hex'),decision:'approve',remark:'Fixture approval'});
    const appFor=(role,routes)=>{const app=express();app.use(express.json());app.use((request,res,next)=>{Object.assign(request,{user:actors[role],id:randomUUID()});next();});app.use(routes);app.use(errorHandler);return app;};
    const processing=appFor('IT',fulfilmentRoutes(scoped,config));

    await update(['CITO']);
    const first=await createTicket(scoped,req('User'),payload());assert.deepEqual((await steps(first.id)).map(step=>step.Role),['CITO']);
    const firstDetail=await details(query,await current(first.id),actors.IT);assert.deepEqual(firstDetail.workflowSteps.map(step=>step.role),['CITO']);
    await approve(first.id,'CITO');assert.equal((await current(first.id)).Status,'Approved');
    const drafts=(await request(processing).get(`/requests/${first.id}/email-drafts`)).body.items;assert.ok(drafts.length);
    for(const draft of drafts)assert.equal((await request(processing).post(`/requests/${first.id}/email-drafts/${draft.id}/sent`).send({confirmedSent:true,email:{to:['fixture@combankbd.com'],cc:draft.cc,subject:draft.subject,body:draft.body}})).status,204);
    assert.equal((await request(processing).post(`/requests/${first.id}/processing`).send({version:(await current(first.id)).Version.toString('hex'),reference:'Fixture processing'})).status,204);
    assert.equal((await current(first.id)).Status,'HO processing');
    assert.equal((await request(processing).post(`/requests/${first.id}/complete`).send({version:(await current(first.id)).Version.toString('hex'),notes:'Fixture provisioning confirmed.',confirmedProvisioned:true,credentials:[{employeeId:actors.User.EmployeeId,systemId:system.Id,username:'fixture-user',password:'Fixture-only passphrase'}]})).status,204);
    assert.equal((await current(first.id)).Status,'Completed');

    await update(['CITO','COO']);
    const active=await createTicket(scoped,req('User'),payload());await approve(active.id,'CITO');
    const originalDecision=(await steps(active.id))[0],oldVersion=(await current(active.id)).Version.toString('hex');
    const changed=await update(['CITO','HR','COO']);assert.equal(changed.updatedRequests,1);
    const changedSteps=await steps(active.id);assert.deepEqual(changedSteps.map(step=>step.Role),['CITO','HR','COO']);assert.deepEqual(changedSteps[0],originalDecision);
    await assert.rejects(decide(scoped,req('COO'),active.id,{version:oldVersion,decision:'approve'}),error=>error.code==='STALE_VERSION');
    await assert.rejects(approve(active.id,'COO'),error=>error.code==='NOT_ASSIGNED');
    await approve(active.id,'HR');await approve(active.id,'COO');assert.equal((await current(active.id)).Status,'Approved');
    assert.equal((await current(first.id)).Status,'Completed');

    await update(['CITO','COO']);
    const paused=await createTicket(scoped,req('User'),payload());await approve(paused.id,'CITO');
    const raised=await raiseQuery(scoped,{...req('COO'),body:{recipientId:actors.User.Id,message:'Confirm fixture access.',version:(await current(paused.id)).Version.toString('hex')}},paused.id);
    await update(['CITO']);assert.equal((await current(paused.id)).Status,'Query');
    const reply=appFor('User',queryRoutes(scoped));
    assert.equal((await request(reply).post(`/${raised.id}/reply`).send({message:'Fixture access confirmed.',version:(await current(paused.id)).Version.toString('hex')})).status,204);
    assert.equal((await current(paused.id)).Status,'Approved');assert.deepEqual((await steps(paused.id)).map(step=>step.Role),['CITO']);
    assert.ok((await query('SELECT Id FROM dbo.RequestEmailDrafts WHERE RequestId=@id',{id:p.id(paused.id)})).recordset.length);

    await update(['Manager','CITO']);const scopedRequest=await createTicket(scoped,req('User'),payload());const assigned=(await steps(scopedRequest.id))[0];
    assert.ok(assigned.Role==='Branch manager'?assigned.BranchId===branch.Id:assigned.Role==='Department head'&&assigned.DepartmentId===department.Id);
    await saveWorkflow(scoped,req('Super Admin'),code,{roles:['COO'],applyToOpenRequests:false});assert.equal((await steps(scopedRequest.id))[0].Role,assigned.Role);
    const future=await createTicket(scoped,req('User'),payload());assert.deepEqual((await steps(future.id)).map(step=>step.Role),['COO']);

    await saveWorkflow(scoped,req('Super Admin'),'reset',{roles:['COO','CITO'],applyToOpenRequests:false});
    const resetBody=payload();resetBody.typeCode='reset';resetBody.justification='';resetBody.items[0].operation='reset';
    const reset=await createTicket(scoped,req('User'),resetBody);assert.deepEqual((await steps(reset.id)).map(step=>step.Role),['COO','CITO']);

    await saveWorkflow(scoped,req('Super Admin'),'new-user',{roles:['CITO'],applyToOpenRequests:false});
    const newUserBody=payload();newUserBody.typeCode='new-user';
    const newUser=await createTicket(scoped,req('HR'),newUserBody);await approve(newUser.id,'CITO');
    const newDrafts=(await request(processing).get(`/requests/${newUser.id}/email-drafts`)).body.items;
    for(const draft of newDrafts)assert.equal((await request(processing).post(`/requests/${newUser.id}/email-drafts/${draft.id}/sent`).send({confirmedSent:true,email:{to:['fixture@combankbd.com'],cc:draft.cc,subject:draft.subject,body:draft.body}})).status,204);
    assert.equal((await request(processing).post(`/requests/${newUser.id}/complete`).send({version:(await current(newUser.id)).Version.toString('hex'),notes:'Fixture new-user provisioning.',confirmedProvisioned:true,credentials:[{employeeId:actors.User.EmployeeId,systemId:system.Id,username:'fixture-new-user',password:'Fixture-only passphrase'}]})).status,204);
    const delivery=(await query('SELECT RecipientId FROM dbo.CredentialDeliveries WHERE RequestId=@id',{id:p.id(newUser.id)})).recordset[0];assert.equal(delivery.RecipientId,actors['Branch manager'].Id);
    const filter={scope:'visible',sort:'newest',page:1,pageSize:100,search:newUser.ticketNumber};
    const custodianList=await listTickets(scoped,actors['Branch manager'],filter);assert.equal(custodianList.items.length,1);assert.equal(custodianList.items[0].deliveryForMe,true);
    const reviewed=await listTickets(scoped,actors.CITO,{...filter,search:first.ticketNumber});assert.equal(reviewed.items[0].reviewedByMe,true);
    throw rollback;
   }finally{await pending;}
  }),error=>error===rollback);
  assert.deepEqual((await db.query("SELECT Role FROM dbo.WorkflowSteps WHERE TypeCode='reset' ORDER BY Position")).recordset,originalReset);
  assert.deepEqual((await db.query("SELECT Role FROM dbo.WorkflowSteps WHERE TypeCode='new-user' ORDER BY Position")).recordset,originalNewUser);
  assert.equal((await db.query('SELECT COUNT(*) AS Total FROM dbo.RequestTypes WHERE Code=@code',{code:p.str(code,50)})).recordset[0].Total,0);
 }finally{await db.close();}
});
