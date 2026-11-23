import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {readConfig} from '../src/config.js';
import {createDatabase,p} from '../src/core/db.js';
import {createApp} from '../src/app.js';
import {saveAssignment} from '../src/modules/directory/approvers.js';
import {createDelegation,revokeDelegation,delegationRoutes} from '../src/modules/directory/delegations.js';
import {createTicket,decide,listTickets} from '../src/modules/requests/service.js';
import {loadTicket,currentStep} from '../src/modules/requests/repository.js';
import {saveWorkflow} from '../src/modules/admin/workflows.js';
import {directoryRoutes} from '../src/modules/directory/routes.js';
import {hydrateAuthority,hasRole} from '../src/modules/auth/authorization.js';
import {userColumns,publicUser} from '../src/modules/auth/service.js';
import {errorHandler} from '../src/core/errors.js';

test('SQL role model enforces scoped leave cover, exact time boundaries, Admin restrictions and live AD-session authority',{
 skip:process.env.UIDMS_SQL_ROLE_SMOKE!=='true',timeout:45000,
},async()=>{
 const config=readConfig();assert.equal(config.NODE_ENV,'development');assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('Role model fixture rollback'),suffix=randomBytes(5).toString('hex'),code='role-test-'+suffix;
 try{
  await db.connect();
  await assert.rejects(db.transaction(async connectionQuery=>{
   let pending=Promise.resolve();const query=(sql,params)=>{const result=pending.then(()=>connectionQuery(sql,params));pending=result.catch(()=>{});return result;};
   try{
    const scoped={query,transaction:work=>work(query)},org={};
    for(const name of ['branch','other-branch','department','other-department'])org[name]=(await query('INSERT dbo.Lookups(Kind,Name) OUTPUT inserted.Id VALUES(@kind,@name)',{kind:p.str(name.includes('branch')?'branch':'department',30),name:p.text('Role fixture '+name+' '+suffix,150)})).recordset[0].Id;
    const headOffice=(await query("SELECT TOP(1) Id FROM dbo.Lookups WHERE Kind='branch' AND Name='Head Office' AND Active=1")).recordset[0].Id;
    const actors={};
    for(const [key,Role,BranchId,DepartmentId] of [
     ['staff','User',org.branch,org.department],['manager','User',org.branch,org.department],['branch-cover','User',org.branch,org.department],
     ['head','User',headOffice,org.department],['head-cover','User',headOffice,org.department],['office-staff','User',headOffice,org.department],
     ['outsider','User',org['other-branch'],org['other-department']],['IT','IT',org.branch,org.department],['CITO','CITO',org.branch,org.department],
     ['it-cover','User',org.branch,org.department],['cito-cover','User',org.branch,org.department],['Admin','Admin',org.branch,org.department],['Super Admin','Super Admin',org.branch,org.department],
    ])actors[key]=(await query('INSERT dbo.Users(EmployeeId,Name,Role,BranchId,DepartmentId,IsDemo) OUTPUT inserted.* VALUES(@employee,@name,@role,@branch,@department,0)',{employee:p.text('RM_'+suffix+'_'+key.replace(' ',''),40),name:p.text('Role fixture '+key,160),role:p.text(Role,40),branch:p.id(BranchId),department:p.id(DepartmentId)})).recordset[0];
    const raw=async key=>(await query(`SELECT ${userColumns} FROM dbo.Users u WHERE u.Id=@id`,{id:p.id(actors[key].Id)})).recordset[0];
    const req=async key=>({user:{...hydrateAuthority(await raw(key)),AuthenticatedAt:new Date()},id:randomUUID(),ip:'127.0.0.1'});
    const mapping=async scope=>(await query('SELECT Version FROM dbo.OrganizationApprovers WHERE ScopeId=@scope',{scope:p.id(scope)})).recordset[0];
    const assign=async(scope,key,actor='Admin')=>saveAssignment(scoped,await req(actor),scope,{employeeId:actors[key].EmployeeId,version:(await mapping(scope))?.Version.toString('hex')||null});
    const current=id=>loadTicket(query,id,actors.Admin);
    const approve=async(id,key)=>decide(scoped,await req(key),id,{decision:'approve',version:(await current(id)).Version.toString('hex')});
    const list=async(key,id,scope='approvals')=>listTickets(scoped,(await req(key)).user,{scope,sort:'newest',page:1,pageSize:100,search:id});
    const delegation=async id=>(await query('SELECT * FROM dbo.RoleDelegations WHERE Id=@id',{id:p.id(id)})).recordset[0];
    const appoint=async(principal,acting,role,scopeId,actor=principal,offset=-60000)=>createDelegation(scoped,await req(actor),{principalId:actors[principal].Id,employeeId:actors[acting].EmployeeId,role,scopeId,startsAt:new Date(Date.now()+offset).toISOString(),endsAt:new Date(Date.now()+offset+3600000).toISOString()});
    const end=async(id,key)=>revokeDelegation(scoped,await req(key),id,(await delegation(id)).Version.toString('hex'));
    const step=id=>current(id).then(ticket=>currentStep(query,ticket));
    const fixtureApp=async(key,routes)=>{const actor=await req(key),app=express();app.use(express.json());app.use((req,res,next)=>{Object.assign(req,{user:actor.user,id:actor.id});next();});app.use(routes);app.use(errorHandler);return app;};
    await assign(org.branch,'manager');await assign(org.department,'head');await assign(org['other-department'],'head');
    const head=publicUser(await raw('head'));assert.equal(head.baseRole,'User');assert.equal(head.role,'Department head');assert.equal(head.managedScopes.length,2);
    assert.equal((await query('SELECT COUNT(*) AS Total FROM dbo.OrganizationApprovers WHERE ScopeId=@scope',{scope:p.id(org.branch)})).recordset[0].Total,1);
    await query('INSERT dbo.RequestTypes(Code,Name,IncludesHr,InitiatorRoles) VALUES(@code,@name,0,@roles)',{code:p.str(code,50),name:p.text('Role fixture '+suffix,100),roles:p.json(['User'])});
    await saveWorkflow(scoped,await req('Admin'),code,{roles:['Manager','IT','CITO'],applyToOpenRequests:false});
    const system=(await query('SELECT TOP(1) s.Id,sr.Id AS RoleId FROM dbo.Systems s LEFT JOIN dbo.SystemRoles sr ON sr.SystemId=s.Id AND sr.Active=1 WHERE s.Active=1 ORDER BY s.Name')).recordset[0];
    const payload=key=>({typeCode:code,branchId:actors[key].BranchId,departmentId:actors[key].DepartmentId,justification:'Controlled role and leave-cover verification.',details:{},people:[{employeeId:actors[key].EmployeeId,name:actors[key].Name,branchId:actors[key].BranchId,departmentId:actors[key].DepartmentId,details:{}}],items:[{employeeId:actors[key].EmployeeId,systemId:system.Id,systemRoleId:system.RoleId,operation:'grant'}],consent:true});
    const ticket=await createTicket(scoped,await req('staff'),payload('staff'));
    assert.equal((await list('manager',ticket.ticketNumber)).total,1);
    const cover=await appoint('manager','branch-cover','Branch manager',org.branch);
    assert.equal((await list('manager',ticket.ticketNumber)).total,0);assert.equal((await list('branch-cover',ticket.ticketNumber)).total,1);assert.equal((await list('outsider',ticket.ticketNumber,'visible')).total,0);
    assert.ok((await step(ticket.id)).EligibleReviewerIds.includes(actors['branch-cover'].Id));assert.equal((await step(ticket.id)).EligibleReviewerIds.includes(actors.manager.Id),false);
    await assert.rejects(appoint('manager','staff','Branch manager',org.branch,'branch-cover'),error=>error.code==='DELEGATION_FORBIDDEN');
    await assert.rejects(appoint('manager','outsider','Branch manager',org.branch),error=>error.code==='ACTING_USER_OUT_OF_SCOPE');
    await assert.rejects(appoint('manager','staff','Branch manager',org.branch),error=>error.code==='ACTING_PERIOD_OVERLAP');
    await approve(ticket.id,'branch-cover');const completedManager=(await query('SELECT * FROM dbo.RequestSteps WHERE RequestId=@id AND Position=1',{id:p.id(ticket.id)})).recordset[0];assert.equal(completedManager.ActorId,actors['branch-cover'].Id);
    await end(cover.id,'manager');assert.deepEqual((await query('SELECT * FROM dbo.RequestSteps WHERE RequestId=@id AND Position=1',{id:p.id(ticket.id)})).recordset[0],completedManager);

    const office=await createTicket(scoped,await req('office-staff'),payload('office-staff'));
    const scheduled=await appoint('head','head-cover','Department head',org.department,'head',7200000);
    assert.ok((await step(office.id)).EligibleReviewerIds.includes(actors.head.Id));assert.equal(publicUser(await raw('head-cover')).role,'User');
    await end(scheduled.id,'head');
    const headCover=await appoint('head','head-cover','Department head',org.department);assert.ok((await step(office.id)).EligibleReviewerIds.includes(actors['head-cover'].Id));
    assert.equal(publicUser(await raw('head-cover')).role,'Department head');
    await query('UPDATE dbo.RoleDelegations SET StartsAt=DATEADD(hour,-2,SYSUTCDATETIME()),EndsAt=DATEADD(hour,-1,SYSUTCDATETIME()) WHERE Id=@id',{id:p.id(headCover.id)});
    assert.ok((await step(office.id)).EligibleReviewerIds.includes(actors.head.Id));assert.equal(publicUser(await raw('head-cover')).role,'User');
    const choices=(await query('SELECT ScopeId FROM dbo.uidms_ManagedScopes(@id)',{id:p.id(actors.head.Id)})).recordset;assert.equal(choices.length,2);

    const itCover=await appoint('IT','it-cover','IT',null),citoCover=await appoint('CITO','cito-cover','CITO',null);
    assert.equal(publicUser(await raw('it-cover')).role,'IT');assert.equal(publicUser(await raw('IT')).role,'User');assert.equal(publicUser(await raw('IT')).baseRole,'IT');
    assert.ok((await step(ticket.id)).EligibleReviewerIds.includes(actors['it-cover'].Id));assert.equal((await step(ticket.id)).EligibleReviewerIds.includes(actors.IT.Id),false);
    await approve(ticket.id,'it-cover');assert.ok((await step(ticket.id)).EligibleReviewerIds.includes(actors['cito-cover'].Id));await approve(ticket.id,'cito-cover');assert.equal((await current(ticket.id)).Status,'Approved');
    const process=await fixtureApp('it-cover',(await import('../src/modules/fulfilment/routes.js')).fulfilmentRoutes(scoped,config));assert.equal((await request(process).get('/requests/'+ticket.id+'/email-drafts')).status,200);
    await assert.rejects(appoint('CITO','staff','CITO',null,'it-cover'),error=>error.code==='DELEGATION_FORBIDDEN');

    const adId='ad:fixture:'+randomBytes(16).toString('hex');
    const app=createApp({db:scoped,config:{...config,AUTH_MODE:'ad',MFA_REQUIRED:false,COOKIE_SECURE:false},directory:{authenticate:async()=>({employeeId:actors['it-cover'].EmployeeId,systemId:adId})}});
    const login=await request(app).post('/api/auth/login').set('Origin',config.origins[0]).send({employeeId:actors['it-cover'].EmployeeId,password:'FixtureOnlyPassword',provider:'ad'});assert.equal(login.status,200,JSON.stringify(login.body));assert.equal(login.body.user.role,'IT');assert.equal(login.body.user.baseRole,'User');
    const cookie=login.headers['set-cookie'][0].split(';')[0];
    const profile=await request(app).get('/api/profile').set('Cookie',cookie);assert.equal(profile.body.canEditAccess,true);
    await query('UPDATE dbo.RoleDelegations SET StartsAt=DATEADD(hour,-2,SYSUTCDATETIME()),EndsAt=DATEADD(hour,-1,SYSUTCDATETIME()) WHERE Id=@id',{id:p.id(itCover.id)});
    const expired=await request(app).get('/api/profile').set('Cookie',cookie);assert.equal(expired.status,200);assert.equal(expired.body.user.role,'User');assert.equal(expired.body.canEditAccess,false);assert.equal(hasRole((await req('IT')).user,'IT'),true);
    const forbiddenAccess=await request(app).patch('/api/profile').set('Cookie',cookie).set('Origin',config.origins[0]).set('X-CSRF-Token',login.body.csrfToken).send({version:expired.body.user.version,designationId:null,access:[]});assert.equal(forbiddenAccess.status,403);

    await end(citoCover.id,'Admin');const adminCover=await appoint('CITO','cito-cover','CITO',null,'Admin');assert.ok(adminCover.id);await end(adminCover.id,'Super Admin');
    const adminApp=await fixtureApp('Admin',directoryRoutes(scoped,config));
    const userBody=key=>({name:actors[key].Name,email:null,role:'CITO',branchId:actors[key].BranchId,departmentId:actors[key].DepartmentId,active:true,version:actors[key].Version.toString('hex')});
    const changed=await request(adminApp).patch('/users/'+actors.outsider.Id).send(userBody('outsider'));assert.equal(changed.status,204);assert.equal((await raw('outsider')).Role,'CITO');
    const protectedUser=await raw('outsider');const denied=await request(adminApp).patch('/users/'+actors.outsider.Id).send({...userBody('outsider'),role:'Admin',version:protectedUser.Version.toString('hex')});assert.equal(denied.status,403);assert.equal((await raw('outsider')).Role,'CITO');
    const createAdmin=await request(adminApp).post('/users').send({...userBody('staff'),employeeId:'NEW_'+suffix,role:'Admin',version:undefined,active:undefined});assert.equal(createAdmin.status,403);
    const superApp=await fixtureApp('Super Admin',directoryRoutes(scoped,config));const promoted=await request(superApp).patch('/users/'+actors.outsider.Id).send({...userBody('outsider'),role:'Admin',version:protectedUser.Version.toString('hex')});assert.equal(promoted.status,204);assert.equal((await raw('outsider')).Role,'Admin');
    const existingAdmin=await raw('outsider');const editedAdmin=await request(adminApp).patch('/users/'+actors.outsider.Id).send({...userBody('outsider'),name:'Existing administrator edited',role:'Admin',version:existingAdmin.Version.toString('hex')});assert.equal(editedAdmin.status,204);
    const notPromoted=await raw('outsider');assert.equal((await request(adminApp).patch('/users/'+actors.outsider.Id).send({...userBody('outsider'),role:'Super Admin',version:notPromoted.Version.toString('hex')})).status,403);
    const replacedCito=await appoint('CITO','cito-cover','CITO',null,'Admin');
    const cito=await raw('CITO');const roleChanged=await request(adminApp).patch('/users/'+actors.CITO.Id).send({...userBody('CITO'),role:'User',version:cito.Version.toString('hex')});assert.equal(roleChanged.status,204);assert.ok((await delegation(replacedCito.id)).RevokedAt);assert.equal(publicUser(await raw('cito-cover')).role,'User');
    const replacedHead=await appoint('head','head-cover','Department head',org.department,'Admin');await assign(org.department,'branch-cover');assert.ok((await delegation(replacedHead.id)).RevokedAt);assert.ok((await step(office.id)).EligibleReviewerIds.includes(actors['branch-cover'].Id));
    assert.equal((await query('SELECT UserId FROM dbo.OrganizationApprovers WHERE ScopeId=@scope',{scope:p.id(org['other-department'])})).recordset[0].UserId,actors.head.Id);
    throw rollback;
   }finally{await pending;}
  }),error=>error===rollback);
  assert.equal((await db.query('SELECT Code FROM dbo.RequestTypes WHERE Code=@code',{code:p.str(code,50)})).recordset.length,0);
 }finally{await db.close();}
});
