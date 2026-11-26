import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import express from 'express';import request from 'supertest';
import {readConfig} from '../src/config.js';import {createDatabase,p} from '../src/core/db.js';import {notifyAttention} from '../src/modules/notifications/attention.js';import {notificationRoutes} from '../src/modules/notifications/routes.js';import {errorHandler} from '../src/core/errors.js';
import {deliverNotificationBatch} from '../src/modules/mail/notification-worker.js';

test('SQL notification routing, acting cover, archive, pagination and user isolation',{skip:process.env.UIDMS_SQL_NOTIFICATIONS_SMOKE!=='true',timeout:60000},async()=>{
 const config=readConfig();assert.equal(config.NODE_ENV,'development');assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('Notification test rollback'),suffix=randomBytes(5).toString('hex');
 try{await db.connect();await assert.rejects(db.transaction(async query=>{
  const lookup={};for(const kind of ['branch','department'])lookup[kind]=(await query('INSERT dbo.Lookups(Kind,Name) OUTPUT inserted.Id VALUES(@kind,@name)',{kind:p.str(kind,20),name:p.text('Notify '+kind+' '+suffix,150)})).recordset[0].Id;
  const actors={};for(const [name,role] of [['owner','User'],['manager','Branch manager'],['acting','User'],['cito','CITO'],['it','IT']])actors[name]=(await query('INSERT dbo.Users(EmployeeId,Name,Role,BranchId,DepartmentId) OUTPUT inserted.* VALUES(@employee,@name,@role,@branch,@department)',{employee:p.text('NT_'+suffix+'_'+name,40),name:p.text('Notify '+name,160),role:p.text(role,40),branch:p.id(lookup.branch),department:p.id(lookup.department)})).recordset[0];
  await query('INSERT dbo.OrganizationApprovers(ScopeId,UserId) VALUES(@scope,@user)',{scope:p.id(lookup.branch),user:p.id(actors.manager.Id)});
  const ticket=(await query("INSERT dbo.Requests(TicketNumber,TypeCode,RequesterId,BranchId,DepartmentId,Status,CurrentPosition,Justification,Details,RequesterSnapshot,SubmittedIp) OUTPUT inserted.Id VALUES(@ticket,'reset',@user,@branch,@department,'Pending',1,N'Notification test',N'{}',N'{}','127.0.0.1')",{ticket:p.text('NT-'+suffix,40),user:p.id(actors.owner.Id),branch:p.id(lookup.branch),department:p.id(lookup.department)})).recordset[0].Id;
  await query("INSERT dbo.RequestSteps(RequestId,Position,Role,BranchId,AssignedUserId) VALUES(@id,1,'Branch manager',@branch,@manager),(@id,2,'CITO',NULL,@cito)",{id:p.id(ticket),branch:p.id(lookup.branch),manager:p.id(actors.manager.Id),cito:p.id(actors.cito.Id)});
  const notifications=async user=>(await query('SELECT * FROM dbo.Notifications WHERE UserId=@user AND RequestId=@id ORDER BY Id',{user:p.id(user.Id),id:p.id(ticket)})).recordset;
  await query('UPDATE dbo.Users SET Email=@email WHERE Id=@id',{id:p.id(actors.manager.Id),email:p.text('fixture-manager@combankbd.com',254)});
  await notifyAttention(query,ticket);assert.match((await notifications(actors.manager))[0].Message,/recommendation required/);assert.equal((await notifications(actors.cito)).length,0);assert.equal((await notifications(actors.owner)).length,0);
  const queued=(await query("SELECT Body FROM dbo.EmailOutbox WHERE JSON_VALUE(CASE WHEN ISJSON(Body)=1 THEN Body ELSE N'{}' END,'$.requestId')=CONVERT(nvarchar(36),@id)",{id:p.id(ticket)})).recordset;
  assert.equal(queued.length,1);const email=JSON.parse(queued[0].Body);assert.equal(email.format,'uidms-notification-v1');assert.equal(email.recipientUserId.toLowerCase(),actors.manager.Id);assert.equal(email.requesterName,actors.owner.Name);assert.match(email.action,/recommendation required/);
  // Execute the real lease/update SQL inside this rollback transaction. Gmail is
  // mocked; the extra fixture predicate prevents claiming unrelated queued mail.
  const sent=[];const workerDb={query,transaction:work=>work((sql,params={})=>query(sql.replace('ORDER BY Id)',"AND JSON_VALUE(CASE WHEN ISJSON(Body)=1 THEN Body ELSE N'{}' END,'$.requestId')=CONVERT(nvarchar(36),@fixture) ORDER BY Id)"),{...params,fixture:p.id(ticket)}))};
  const delivered=await deliverNotificationBatch(workerDb,{...config,GMAIL_NOTIFICATIONS_ENABLED:true},{status:async()=>({configured:true,connected:true,testedAt:new Date().toISOString()}),send:async mail=>{sent.push(mail);return {messageId:'fixture-only-no-network'};}},{limit:1,log:()=>{}});
  assert.equal(delivered,1);assert.deepEqual(sent[0].to,['fixture-manager@combankbd.com']);assert.match(sent[0].html,/Requester name/);assert.match(sent[0].html,/recommendation required/);
  await query("INSERT dbo.RoleDelegations(PrincipalId,ActingUserId,Role,ScopeId,StartsAt,EndsAt,CreatedBy) VALUES(@manager,@acting,'Branch manager',@scope,DATEADD(hour,-1,SYSUTCDATETIME()),DATEADD(hour,1,SYSUTCDATETIME()),@manager)",{manager:p.id(actors.manager.Id),acting:p.id(actors.acting.Id),scope:p.id(lookup.branch)});
  await notifyAttention(query,ticket);assert.equal((await notifications(actors.manager)).length,1);assert.equal((await notifications(actors.acting)).length,1,'only the acting manager is currently eligible');
  await query("UPDATE dbo.RequestSteps SET Status='Approved' WHERE RequestId=@id AND Position=1; UPDATE dbo.Requests SET Status='In review',CurrentPosition=2 WHERE Id=@id",{id:p.id(ticket)});
  await notifyAttention(query,ticket);assert.match((await notifications(actors.cito))[0].Message,/approval required/);
  await query("UPDATE dbo.Requests SET Status='Approved' WHERE Id=@id",{id:p.id(ticket)});await notifyAttention(query,ticket);assert.match((await notifications(actors.it))[0].Message,/processing required/);
  for(let i=0;i<17;i++)await query("INSERT dbo.Notifications(UserId,RequestId,Message,CreatedAt) VALUES(@user,@id,@message,CASE WHEN @old=1 THEN DATEADD(month,-2,SYSUTCDATETIME()) ELSE SYSUTCDATETIME() END)",{user:p.id(actors.acting.Id),id:p.id(ticket),message:p.text('Page '+i,300),old:p.bit(i===0)});
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=actors.acting;next();});app.use(notificationRoutes({query}));app.use(errorHandler);
  const first=await request(app).get('/notifications?pageSize=8');assert.equal(first.status,200,first.text);assert.equal(first.body.total,17);assert.equal(first.body.items.length,8);assert.equal(first.body.archivedTotal,1);assert.equal(first.body.unread,17);
  const second=await request(app).get('/notifications?pageSize=8&page=2');assert.equal(second.body.items.length,8);assert.ok(second.body.items.every(row=>!first.body.items.some(other=>other.Id===row.Id)));
  const third=await request(app).get('/notifications?pageSize=8&page=3');assert.equal(third.body.items.length,1);
  const archived=await request(app).get('/notifications?scope=archived');assert.equal(archived.body.total,1);assert.equal(archived.body.items[0].Message,'Page 0');
  const init=await request(app).get('/notifications/feed');assert.equal(init.body.items.length,0);
  await query("INSERT dbo.Notifications(UserId,RequestId,Message) VALUES(@user,@id,N'Live query')",{user:p.id(actors.acting.Id),id:p.id(ticket)});
  const feed=await request(app).get('/notifications/feed').query({after:init.body.cursor});assert.equal(feed.body.items.length,1);assert.equal(feed.body.items[0].Message,'Live query');
  const ownId=feed.body.items[0].Id;await request(app).post(`/notifications/${ownId}/read`).send({});assert.ok((await notifications(actors.acting)).find(row=>String(row.Id)===ownId).ReadAt);
  const foreign=(await notifications(actors.cito))[0];await request(app).post(`/notifications/${foreign.Id}/read`).send({});assert.equal((await notifications(actors.cito))[0].ReadAt,null);
  await query('UPDATE dbo.Requests SET DeletedAt=SYSUTCDATETIME() WHERE Id=@id',{id:p.id(ticket)});assert.equal((await request(app).get('/notifications')).body.total,0);
  throw rollback;
 }),error=>error===rollback);}finally{await db.close();}
});
