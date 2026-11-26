import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes,randomUUID} from 'node:crypto';import express from 'express';import request from 'supertest';
import {readConfig} from '../src/config.js';import {createDatabase,p} from '../src/core/db.js';import {createEmailDrafts,readEmailDrafts} from '../src/modules/fulfilment/system-email.js';import {fulfilmentRoutes} from '../src/modules/fulfilment/routes.js';import {errorHandler} from '../src/core/errors.js';

test('SQL processing groups use service override, general system groups and service fallback; rebuild preserves sent emails',{skip:process.env.UIDMS_SQL_EMAIL_GROUP_SMOKE!=='true',timeout:45000},async()=>{
 const config=readConfig();assert.equal(config.NODE_ENV,'development');assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('Email group fixture rollback'),suffix=randomBytes(5).toString('hex');
 try{await db.connect();await assert.rejects(db.transaction(async query=>{
  const lookup={};for(const kind of ['branch','department'])lookup[kind]=(await query('INSERT dbo.Lookups(Kind,Name) OUTPUT inserted.Id VALUES(@kind,@name)',{kind:p.str(kind,20),name:p.text('Draft '+kind+' '+suffix,150)})).recordset[0].Id;
  const users={};for(const [key,role] of [['owner','User'],['it','IT']])users[key]=(await query('INSERT dbo.Users(EmployeeId,Name,Role,BranchId,DepartmentId) OUTPUT inserted.* VALUES(@employee,@name,@role,@branch,@department)',{employee:p.text('DG_'+suffix+'_'+key,40),name:p.text('Draft '+key,160),role:p.text(role,40),branch:p.id(lookup.branch),department:p.id(lookup.department)})).recordset[0];
  const systems={};for(const name of ['A','B','C','D'])systems[name]=(await query('INSERT dbo.Systems(Name) OUTPUT inserted.Id VALUES(@name)',{name:p.text('Draft '+name+' '+suffix,150)})).recordset[0].Id;
  const templates={};for(const [name,category,isDefault,names] of [['general-ab','',false,['A','B']],['general-c','',false,['C']],['service-b','new-id',false,['B']],['service-default','new-id',true,[]]]){
   // Avoid colliding with a real existing service-default template. Its complete
   // configuration is restored by the surrounding rollback, like every fixture.
   if(isDefault)await query('UPDATE dbo.SystemEmailTemplates SET IsServiceDefault=0 WHERE Category=@category AND IsServiceDefault=1',{category:p.str(category,32)});
   templates[name]=(await query('INSERT dbo.SystemEmailTemplates(Name,Category,IsServiceDefault,Recipients,Subject,Body) OUTPUT inserted.Id VALUES(@name,@category,@default,@recipients,N\'{{ticketNumber}} - {{system}}\',N\'{{items}}\')',{name:p.text(name+' '+suffix,160),category:p.str(category,32),default:p.bit(isDefault),recipients:p.json({to:[name+'@example.com'],cc:[]})})).recordset[0].Id;
   for(const system of names)await query('INSERT dbo.SystemEmailTemplateSystems(Category,TemplateId,SystemId) VALUES(@category,@template,@system)',{category:p.str(category,32),template:p.id(templates[name]),system:p.id(systems[system])});
  }
  const ticket=(await query("INSERT dbo.Requests(TicketNumber,TypeCode,RequesterId,BranchId,DepartmentId,Status,CurrentPosition,Justification,Details,RequesterSnapshot,SubmittedIp) OUTPUT inserted.* VALUES(@number,'new-user',@user,@branch,@department,'IT processing',1,N'Approved multi-system request',N'{}',N'{}','127.0.0.1')",{number:p.text('DG-'+suffix,40),user:p.id(users.owner.Id),branch:p.id(lookup.branch),department:p.id(lookup.department)})).recordset[0];
  const person=(await query("INSERT dbo.RequestPeople(RequestId,EmployeeId,Name,UserId,BranchId,DepartmentId,Details) OUTPUT inserted.Id VALUES(@request,@employee,N'Draft beneficiary',@user,@branch,@department,N'{}')",{request:p.id(ticket.Id),employee:p.text(users.owner.EmployeeId,40),user:p.id(users.owner.Id),branch:p.id(lookup.branch),department:p.id(lookup.department)})).recordset[0].Id;
  for(const system of Object.values(systems))await query("INSERT dbo.RequestItems(RequestId,PersonId,SystemId,Operation) VALUES(@request,@person,@system,'grant')",{request:p.id(ticket.Id),person:p.id(person),system:p.id(system)});
  await createEmailDrafts(query,ticket);
  let drafts=await readEmailDrafts(query,ticket.Id,ticket);assert.equal(drafts.length,4);
  const byTo=Object.fromEntries(drafts.map(draft=>[draft.to[0],draft]));
  assert.deepEqual(byTo['general-ab@example.com'].systemIds,[systems.A]);assert.deepEqual(byTo['service-b@example.com'].systemIds,[systems.B]);assert.deepEqual(byTo['general-c@example.com'].systemIds,[systems.C]);assert.deepEqual(byTo['service-default@example.com'].systemIds,[systems.D]);
  for(const draft of drafts)assert.equal(draft.systems.length,1);
  await createEmailDrafts(query,ticket);assert.equal((await readEmailDrafts(query,ticket.Id,ticket)).length,4,'initialization is idempotent');
  const confirmed=byTo['general-ab@example.com'];
  await query('UPDATE dbo.RequestEmailDrafts SET SentAt=SYSUTCDATETIME(),SentBy=@it WHERE Id=@id',{it:p.id(users.it.Id),id:p.id(confirmed.id)});
  const sentBefore=(await query('SELECT * FROM dbo.RequestEmailDrafts WHERE Id=@id',{id:p.id(confirmed.id)})).recordset[0];
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=users.it;req.id=randomUUID();next();});app.use(fulfilmentRoutes({query,transaction:work=>work(query)},config));app.use(errorHandler);
  const response=await request(app).post(`/requests/${ticket.Id}/email-drafts/rebuild`).send({version:ticket.Version.toString('hex')});assert.equal(response.status,200,response.text);assert.equal(response.body.preservedSent,1);assert.equal(response.body.rebuilt,3);assert.equal(response.body.items.length,4);
  const sentAfter=(await query('SELECT * FROM dbo.RequestEmailDrafts WHERE Id=@id',{id:p.id(confirmed.id)})).recordset[0];assert.equal(sentBefore.Content,sentAfter.Content);assert.deepEqual(sentBefore.SentAt,sentAfter.SentAt);assert.equal(sentBefore.SentBy,sentAfter.SentBy);
  drafts=response.body.items;assert.equal(drafts.filter(draft=>draft.sentAt).length,1);assert.ok(drafts.filter(draft=>!draft.sentAt).every(draft=>!draft.systemIds.includes(systems.A)));
  const retired=byTo['general-c@example.com'];const stale=await request(app).post(`/requests/${ticket.Id}/email-drafts/${retired.id}/sent`).send({confirmedSent:true});assert.equal(stale.status,409);assert.equal(stale.body.error.code,'DRAFT_SUPERSEDED');
  assert.equal((await request(app).post(`/requests/${ticket.Id}/email-drafts/rebuild`).send({version:ticket.Version.toString('hex')})).status,409,'rebuild rejects a stale request version');
  // One obsolete unsent snapshot becomes a single old-style collapsed fallback,
  // demonstrating that the explicit rebuild repairs already-processing tickets.
  await query("UPDATE dbo.RequestEmailDrafts SET Content=JSON_MODIFY(Content,'$.superseded',CAST(1 AS bit)) WHERE RequestId=@request AND SentAt IS NULL",{request:p.id(ticket.Id)});
  const position=(await query('SELECT MAX(Position)+1 AS Position FROM dbo.RequestEmailDrafts WHERE RequestId=@request',{request:p.id(ticket.Id)})).recordset[0].Position;
  await query('INSERT dbo.RequestEmailDrafts(RequestId,Position,Content) VALUES(@request,@position,@content)',{request:p.id(ticket.Id),position:p.int(position),content:p.json({to:[],cc:[],name:'General processing',systems:Object.keys(systems).map(name=>'Draft '+name+' '+suffix),subject:'Legacy draft',body:'All systems grouped incorrectly'})});
  const current=(await query('SELECT Version FROM dbo.Requests WHERE Id=@id',{id:p.id(ticket.Id)})).recordset[0].Version;
  const repair=await request(app).post(`/requests/${ticket.Id}/email-drafts/rebuild`).send({version:current.toString('hex')});assert.equal(repair.status,200,repair.text);assert.equal(repair.body.items.length,4);assert.ok(repair.body.items.every(draft=>draft.name!=='General processing'));
  await query("UPDATE dbo.Requests SET Status='Completed' WHERE Id=@id",{id:p.id(ticket.Id)});const completed=(await query('SELECT Version FROM dbo.Requests WHERE Id=@id',{id:p.id(ticket.Id)})).recordset[0].Version;
  assert.equal((await request(app).post(`/requests/${ticket.Id}/email-drafts/rebuild`).send({version:completed.toString('hex')})).status,409);
  throw rollback;
 }),error=>error===rollback);}finally{await db.close();}
});
