import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,randomBytes} from 'node:crypto';
import {readConfig} from '../src/config.js';import {createDatabase,p} from '../src/core/db.js';import {deletionPlan,performDeletion} from '../src/modules/admin/deletions.js';

test('SQL duplicate-branch merge preserves employees, requests, decisions, queries and grants and moves pending scopes atomically',{skip:process.env.UIDMS_SQL_MERGE_SMOKE!=='true',timeout:45000},async()=>{
 const config=readConfig();assert.equal(config.NODE_ENV,'development');assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('Organization merge fixture rollback'),suffix=randomBytes(5).toString('hex');
 try{await db.connect();await assert.rejects(db.transaction(async query=>{
  const scoped={query,transaction:async work=>{await query('SAVE TRANSACTION MergeAttempt');try{return await work(query);}catch(error){await query('ROLLBACK TRANSACTION MergeAttempt');throw error;}}},lookup={};
  for(const [key,kind] of [['old','branch'],['canonical','branch'],['department','department']])lookup[key]=(await query('INSERT dbo.Lookups(Kind,Name) OUTPUT inserted.Id VALUES(@kind,@name)',{kind:p.str(kind,20),name:p.text('Merge '+key+' '+suffix,150)})).recordset[0].Id;
  const makeUser=async(name,role='User',branch=lookup.old)=>(await query('INSERT dbo.Users(EmployeeId,Name,Role,BranchId,DepartmentId) OUTPUT inserted.* VALUES(@employee,@name,@role,@branch,@department)',{employee:p.text('MG_'+suffix+'_'+name,40),name:p.text('Merge '+name,160),role:p.text(role,40),branch:p.id(branch),department:p.id(lookup.department)})).recordset[0];
  const admin=await makeUser('admin','Super Admin'),owner=await makeUser('owner'),reviewer=await makeUser('reviewer','Branch manager'),targetManager=await makeUser('canonical','Branch manager',lookup.canonical);
  const req={user:admin,id:randomUUID(),ip:'127.0.0.1'};
  await query('INSERT dbo.OrganizationApprovers(ScopeId,UserId) VALUES(@source,@reviewer),(@target,@canonical),(@department,@reviewer)',{source:p.id(lookup.old),reviewer:p.id(reviewer.Id),target:p.id(lookup.canonical),canonical:p.id(targetManager.Id),department:p.id(lookup.department)});
  const makeRequest=async(status='Pending')=>(await query("INSERT dbo.Requests(TicketNumber,TypeCode,RequesterId,BranchId,DepartmentId,Justification,Details,RequesterSnapshot,SubmittedIp,Status,CurrentPosition) OUTPUT inserted.* VALUES(@ticket,'reset',@owner,@branch,@department,N'Original justification',N'{\"form\":\"original\"}',N'{\"branch\":\"Corporate Office\"}','127.0.0.1',@status,2)",{ticket:p.text('MERGE-'+randomBytes(7).toString('hex'),40),owner:p.id(owner.Id),branch:p.id(lookup.old),department:p.id(lookup.department),status:p.str(status,30)})).recordset[0];
  const live=await makeRequest('Query'),closed=await makeRequest('Completed');
  await query("INSERT dbo.RequestSteps(RequestId,Position,Role,BranchId,AssignedUserId,Status,ActorId,Remark,DecidedAt) VALUES(@id,1,'Branch manager',@branch,@reviewer,'Approved',@reviewer,N'Original recommendation',SYSUTCDATETIME()),(@id,2,'Branch manager',@branch,@reviewer,'Waiting',NULL,NULL,NULL)",{id:p.id(live.Id),branch:p.id(lookup.old),reviewer:p.id(reviewer.Id)});
  await query('INSERT dbo.RequestPeople(RequestId,EmployeeId,Name,UserId,BranchId,DepartmentId,Details) VALUES(@request,@employee,@name,@user,@branch,@department,N\'{}\')',{request:p.id(live.Id),employee:p.text(owner.EmployeeId,40),name:p.text(owner.Name,160),user:p.id(owner.Id),branch:p.id(lookup.old),department:p.id(lookup.department)});
  const question=(await query("INSERT dbo.Queries(RequestId,AuthorId,RecipientId,Message,ReturnStatus) OUTPUT inserted.Id VALUES(@id,@reviewer,@owner,N'Original question','In review')",{id:p.id(live.Id),reviewer:p.id(reviewer.Id),owner:p.id(owner.Id)})).recordset[0].Id;
  const system=(await query('SELECT TOP(1) Id FROM dbo.Systems WHERE Active=1 ORDER BY Id')).recordset[0].Id;
  const grant=(await query('INSERT dbo.AccessGrants(UserId,SystemId,SourceRequestId) OUTPUT inserted.Id VALUES(@user,@system,@request)',{user:p.id(owner.Id),system:p.id(system),request:p.id(closed.Id)})).recordset[0].Id;
  const plan=await deletionPlan(query,'branch',lookup.old),body={reviewToken:plan.reviewToken,confirmName:plan.target.Name,employees:'move',requests:'keep',deleteOtherRequests:false,replacementId:lookup.canonical,mergePending:true};
  assert.ok(plan.requests.some(row=>row.Id===live.Id&&row.ScopeDependency));
  await assert.rejects(performDeletion(scoped,req,'branch',lookup.old,{...body,mergePending:false}),error=>error.code==='DELETE_LIVE_DEPENDENCIES');
  await query('UPDATE dbo.RequestSteps SET AssignedUserId=@owner WHERE RequestId=@id AND Position=2',{owner:p.id(owner.Id),id:p.id(live.Id)});
  const invalid=await deletionPlan(query,'branch',lookup.old);
  await assert.rejects(performDeletion(scoped,req,'branch',lookup.old,{...body,reviewToken:invalid.reviewToken}),error=>error.code==='MERGE_APPROVER_REQUIRED');
  assert.equal((await query('SELECT BranchId FROM dbo.Users WHERE Id=@id',{id:p.id(owner.Id)})).recordset[0].BranchId,lookup.old,'a rejected merge must roll back employee moves');
  await query('UPDATE dbo.RequestSteps SET AssignedUserId=@reviewer WHERE RequestId=@id AND Position=2',{reviewer:p.id(reviewer.Id),id:p.id(live.Id)});
  const acting=(await query("INSERT dbo.RoleDelegations(PrincipalId,ActingUserId,Role,ScopeId,StartsAt,EndsAt,CreatedBy) OUTPUT inserted.Id VALUES(@principal,@acting,'Branch manager',@scope,DATEADD(hour,1,SYSUTCDATETIME()),DATEADD(hour,2,SYSUTCDATETIME()),@acting)",{principal:p.id(reviewer.Id),acting:p.id(admin.Id),scope:p.id(lookup.old)})).recordset[0].Id;
  const covered=await deletionPlan(query,'branch',lookup.old);
  await assert.rejects(performDeletion(scoped,req,'branch',lookup.old,{...body,reviewToken:covered.reviewToken}),error=>error.code==='MERGE_ACTING_APPOINTMENTS');
  assert.equal((await query('SELECT BranchId FROM dbo.Users WHERE Id=@id',{id:p.id(owner.Id)})).recordset[0].BranchId,lookup.old);
  await query('UPDATE dbo.RoleDelegations SET RevokedAt=SYSUTCDATETIME(),RevokedBy=@actor WHERE Id=@id',{actor:p.id(admin.Id),id:p.id(acting)});
  const fresh=await deletionPlan(query,'branch',lookup.old);const result=await performDeletion(scoped,req,'branch',lookup.old,{...body,reviewToken:fresh.reviewToken});
  assert.equal(result.users,0);assert.equal(result.requests,0);assert.equal(result.mergedRequests,1);
  const after=(await query('SELECT * FROM dbo.Requests WHERE Id=@id',{id:p.id(live.Id)})).recordset[0];assert.equal(after.BranchId,lookup.canonical);assert.equal(after.DeletedAt,null);assert.equal(after.Status,'Query');assert.equal(after.CurrentPosition,2);assert.equal(after.Details,live.Details);assert.equal(after.RequesterSnapshot,live.RequesterSnapshot);
  const steps=(await query('SELECT * FROM dbo.RequestSteps WHERE RequestId=@id ORDER BY Position',{id:p.id(live.Id)})).recordset;assert.equal(steps[0].BranchId,lookup.old);assert.equal(steps[0].Remark,'Original recommendation');assert.equal(steps[0].ActorId,reviewer.Id);assert.equal(steps[1].BranchId,lookup.canonical);assert.equal(steps[1].AssignedUserId,reviewer.Id);assert.equal(steps[1].Status,'Waiting');
  assert.equal((await query('SELECT BranchId FROM dbo.RequestPeople WHERE RequestId=@id',{id:p.id(live.Id)})).recordset[0].BranchId,lookup.canonical);
  assert.equal((await query('SELECT BranchId FROM dbo.Requests WHERE Id=@id',{id:p.id(closed.Id)})).recordset[0].BranchId,lookup.old);
  assert.equal((await query('SELECT Message FROM dbo.Queries WHERE Id=@id',{id:p.id(question)})).recordset[0].Message,'Original question');
  assert.equal((await query('SELECT RevokedAt FROM dbo.AccessGrants WHERE Id=@id',{id:p.id(grant)})).recordset[0].RevokedAt,null);
  assert.equal((await query('SELECT COUNT(*) AS Total FROM dbo.Users WHERE Id IN (@a,@b,@c) AND Active=1 AND DeletedAt IS NULL AND BranchId=@branch',{a:p.id(admin.Id),b:p.id(owner.Id),c:p.id(reviewer.Id),branch:p.id(lookup.canonical)})).recordset[0].Total,3);
  assert.equal((await query('SELECT UserId FROM dbo.OrganizationApprovers WHERE ScopeId=@id',{id:p.id(lookup.department)})).recordset[0].UserId,reviewer.Id,'IT/other department head assignments must remain');
  assert.equal((await query('SELECT UserId FROM dbo.OrganizationApprovers WHERE ScopeId=@id',{id:p.id(lookup.canonical)})).recordset[0].UserId,targetManager.Id);
  assert.ok((await query('SELECT DeletedAt FROM dbo.Lookups WHERE Id=@id',{id:p.id(lookup.old)})).recordset[0].DeletedAt);
  assert.ok((await query('SELECT COUNT(*) AS Total FROM dbo.RequestRevisions WHERE RequestId=@id',{id:p.id(live.Id)})).recordset[0].Total>0);
  throw rollback;
 }),error=>error===rollback);}finally{await db.close();}
});
