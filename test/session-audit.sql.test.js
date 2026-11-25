import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import request from 'supertest';
import {readConfig} from '../src/config.js';
import {createDatabase,p} from '../src/core/db.js';
import {createApp} from '../src/app.js';
import {audit} from '../src/modules/audit/service.js';
import {saveWorkflow} from '../src/modules/admin/workflows.js';

test('SQL audit links login, navigation, actions and logout; survives token cleanup; separates sessions and identifies expiry',{
 skip:process.env.UIDMS_SQL_AUDIT_SMOKE!=='true',timeout:45000,
},async()=>{
 const config={...readConfig(),SESSION_MAX_MINUTES:480,SESSION_IDLE_MINUTES:15};assert.equal(config.NODE_ENV,'development');assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('Session audit fixture rollback'),suffix=randomBytes(5).toString('hex');
 try{
  await db.connect();
  await assert.rejects(db.transaction(async connectionQuery=>{
   let pending=Promise.resolve();const query=(sql,params)=>{const result=pending.then(()=>connectionQuery(sql,params));pending=result.catch(()=>{});return result;};
   try{
    const scoped={query,transaction:work=>work(query)},actors={};
    const org=[];for(const kind of ['branch','department'])org.push((await query('INSERT dbo.Lookups(Kind,Name) OUTPUT inserted.Id VALUES(@kind,@name)',{kind:p.str(kind,20),name:p.text('Audit fixture '+kind+' '+suffix,150)})).recordset[0].Id);
    for(const role of ['User','Admin'])actors[role]=(await query('INSERT dbo.Users(EmployeeId,Name,Role,BranchId,DepartmentId,IsDemo) OUTPUT inserted.* VALUES(@employee,@name,@role,@branch,@department,0)',{employee:p.text('AU_'+suffix+'_'+role,40),name:p.text('Audit fixture '+role,160),role:p.text(role,40),branch:p.id(org[0]),department:p.id(org[1])})).recordset[0];
    const identities=new Map(Object.values(actors).map(actor=>[actor.EmployeeId,{employeeId:actor.EmployeeId,systemId:'ad:fixture:'+randomBytes(16).toString('hex')}]))
    const app=createApp({db:scoped,config:{...config,AUTH_MODE:'ad',MFA_REQUIRED:false,COOKIE_SECURE:false,TRUST_PROXY:'127.0.0.1,::1'},directory:{authenticate:async employee=>identities.get(employee)}});
    const login=async role=>{const response=await request(app).post('/api/auth/login').set('Origin',config.origins[0]).set('X-Forwarded-For','192.0.2.31:52345').send({employeeId:actors[role].EmployeeId,password:'Fixture-password-only',provider:'ad'});assert.equal(response.status,200,JSON.stringify(response.body));return {cookie:response.headers['set-cookie'][0].split(';')[0],csrf:response.body.csrfToken};};
    let user=await login('User');const admin=await login('Admin');
    const as=(session,method,url,body,ip='192.0.2.31:53000')=>{let result=request(app)[method](url).set('Cookie',session.cookie).set('X-Forwarded-For',ip);if(method!=='get')result=result.set('Origin',config.origins[0]).set('X-CSRF-Token',session.csrf).send(body);return result;};
    const sessionFor=async role=>(await query('SELECT TOP(1) * FROM dbo.AuditSessions WHERE UserId=@user ORDER BY StartedAt DESC',{user:p.id(actors[role].Id)})).recordset[0];
    const first=await sessionFor('User');assert.equal(first.Ip,'192.0.2.31');assert.equal(first.Source,'tracked');
    const ageSession=async()=>query('UPDATE dbo.Sessions SET LastSeenAt=DATEADD(minute,-2,SYSUTCDATETIME()) WHERE AuditSessionId=@id',{id:p.id(first.Id)});
    const tokenRow=async()=>(await query('SELECT CreatedAt,LastSeenAt,ExpiresAt FROM dbo.Sessions WHERE AuditSessionId=@id',{id:p.id(first.Id)})).recordset[0];
    await ageSession();const before=await tokenRow();
    const status=await as(user,'get','/api/auth/status');assert.equal(status.status,200);assert.ok(status.body.session.expiresAt);assert.equal(+(await tokenRow()).LastSeenAt,+before.LastSeenAt,'background polling must not renew inactivity');
    assert.equal((await as({...user,csrf:'invalid'},'post','/api/auth/continue',{})).status,403);assert.equal(+(await tokenRow()).LastSeenAt,+before.LastSeenAt,'invalid CSRF must not renew inactivity');
    const renewed=await as(user,'post','/api/auth/continue',{reason:'continue'});assert.equal(renewed.status,200,JSON.stringify(renewed.body));const after=await tokenRow();assert.ok(+after.LastSeenAt>+before.LastSeenAt);assert.equal(+after.CreatedAt,+before.CreatedAt);assert.equal(+after.ExpiresAt,+before.ExpiresAt,'absolute duration must not be extended');
    const restored=await as(user,'get','/api/auth/session'),restoredAgain=await as(user,'get','/api/auth/session');assert.equal(restored.body.csrfToken,user.csrf);assert.equal(restoredAgain.body.csrfToken,user.csrf,'another tab must not invalidate CSRF');
    assert.equal((await as(user,'post','/api/activity',{page:'Overview'})).status,204);assert.equal((await as(user,'post','/api/activity',{page:'My access'})).status,204);
    assert.equal((await as(user,'get','/api/audit')).status,403);
    await saveWorkflow(scoped,{user:actors.Admin,id:randomUUID(),ip:'127.0.0.1'},'reset',{roles:['CITO'],applyToOpenRequests:false});
    const system=(await query('SELECT TOP(1) Id FROM dbo.Systems WHERE Active=1 ORDER BY Name')).recordset[0].Id;
    const created=await as(user,'post','/api/requests',{typeCode:'reset',branchId:org[0],departmentId:org[1],details:{},people:[{employeeId:actors.User.EmployeeId,name:actors.User.Name,branchId:org[0],departmentId:org[1]}],items:[{employeeId:actors.User.EmployeeId,systemId:system,operation:'reset'}],consent:true});assert.equal(created.status,201,JSON.stringify(created.body));
    await audit(query,{user:actors.User,auditSessionId:first.Id,id:randomUUID(),ip:'192.0.2.31'},'fixture.redaction',null,{nested:{password:'do-not-return-password',csrfToken:'do-not-return-token'},safe:'Recorded detail'});
    const logout=await as(user,'post','/api/auth/logout',{},'[2001:db8::21]:54001');assert.equal(logout.status,204);
    const closed=await sessionFor('User');assert.equal(closed.EndReason,'logout');assert.ok(closed.EndedAt);assert.equal(closed.LastIp,'2001:db8::21');
    const loginEvent=(await query("SELECT CONVERT(varchar(20),Id) AS Id FROM dbo.AuditEvents WHERE AuditSessionId=@session AND Event='auth.login'",{session:p.id(first.Id)})).recordset[0].Id;
    const details=await as(admin,'get',`/api/audit/${loginEvent}/session?pageSize=100`);assert.equal(details.status,200,JSON.stringify(details.body));assert.equal(details.body.session.Id,first.Id);assert.equal(details.body.session.EndReason,'logout');
    const events=details.body.items;for(const event of ['auth.login','page.viewed','request.created','auth.logout','action.failed'])assert.ok(events.some(row=>row.Event===event),event);
    assert.equal(events.every(row=>row.ActorId===actors.User.Id),true);assert.equal(JSON.stringify(details.body).includes('do-not-return-password'),false);assert.equal(JSON.stringify(details.body).includes('do-not-return-token'),false);assert.equal(JSON.stringify(details.body).includes('Fixture-password-only'),false);assert.equal('TokenHash' in details.body.session,false);
    const page1=await as(admin,'get',`/api/audit/${loginEvent}/session?pageSize=2&page=1`),page2=await as(admin,'get',`/api/audit/${loginEvent}/session?pageSize=2&page=2`);assert.equal(page1.body.items.length,2);assert.equal(page2.body.items.length,2);assert.equal(page1.body.items.some(a=>page2.body.items.some(b=>a.Id===b.Id)),false);
    await query('DELETE dbo.Sessions WHERE AuditSessionId=@session',{session:p.id(first.Id)});assert.equal((await as(admin,'get',`/api/audit/${loginEvent}/session`)).body.session.Id,first.Id);
    user=await login('User');const second=await sessionFor('User');user=await login('User');const third=await sessionFor('User');assert.notEqual(second.Id,third.Id);
    assert.equal((await query('SELECT EndReason FROM dbo.AuditSessions WHERE Id=@id',{id:p.id(second.Id)})).recordset[0].EndReason,'replaced');
    await query('UPDATE dbo.AuditSessions SET StartedAt=DATEADD(hour,-3,SYSUTCDATETIME()),LastSeenAt=DATEADD(hour,-2,SYSUTCDATETIME()) WHERE Id=@id; UPDATE dbo.Sessions SET LastSeenAt=DATEADD(hour,-2,SYSUTCDATETIME()) WHERE AuditSessionId=@id',{id:p.id(third.Id)});
    const list=await as(admin,'get','/api/audit?search='+encodeURIComponent(actors.User.EmployeeId));assert.equal(list.status,200,JSON.stringify(list.body));assert.ok(list.body.total>0);
    assert.equal((await query('SELECT EndReason FROM dbo.AuditSessions WHERE Id=@id',{id:p.id(third.Id)})).recordset[0].EndReason,'idle_timeout');
    assert.equal((await as(user,'get','/api/profile')).status,401);
    assert.equal((await as(user,'post','/api/auth/continue',{reason:'continue'})).status,401,'expired sessions cannot be renewed');
    const cutoff=(await query('SELECT DATEADD(hour,-2,AppliedAt) AS At FROM dbo.SchemaVersions WHERE Version=13')).recordset[0].At;
    const historic=[];
    for(const [index,Event] of ['auth.login','request.edited','auth.logout'].entries())historic.push((await query('INSERT dbo.AuditEvents(ActorId,Event,Ip,CreatedAt,CorrelationId,Metadata) OUTPUT CONVERT(varchar(20),inserted.Id) AS Id VALUES(@user,@event,@ip,@at,@correlation,N\'{}\')',{user:p.id(actors.User.Id),event:p.str(Event),ip:p.str('192.0.2.9',64),at:p.date(new Date(cutoff.getTime()+index*60000)),correlation:p.id(randomUUID())})).recordset[0].Id);
    const older=await as(admin,'get',`/api/audit/${historic[1]}/session`);assert.equal(older.status,200,JSON.stringify(older.body));assert.equal(older.body.session.Source,'inferred');assert.equal(older.body.session.EndReason,'logout');assert.deepEqual(older.body.items.map(row=>row.Id),historic);
    const afterLogout=(await query("INSERT dbo.AuditEvents(ActorId,Event,Ip,CreatedAt,CorrelationId,Metadata) OUTPUT CONVERT(varchar(20),inserted.Id) AS Id VALUES(@user,'auth.mfa_failed','192.0.2.9',@at,@correlation,N'{}')",{user:p.id(actors.User.Id),at:p.date(new Date(cutoff.getTime()+180000)),correlation:p.id(randomUUID())})).recordset[0].Id;
    const outside=await as(admin,'get',`/api/audit/${afterLogout}/session`);assert.equal(outside.status,200);assert.equal(outside.body.session,null);assert.deepEqual(outside.body.items.map(row=>row.Id),[afterLogout]);
    await assert.rejects(query('UPDATE dbo.AuditEvents SET Event=Event WHERE Id=@id',{id:{type:(await import('../src/core/db.js')).sql.BigInt,value:historic[0]}}));
    // The append-only trigger's THROW aborts the fixture transaction; its rollback is expected below.
    throw rollback;
   }finally{await pending;}
  }),error=>error===rollback);
 }finally{await db.close();}
});
