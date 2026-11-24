import {routingNameSql} from '../directory/organization-names.js';
import {randomUUID} from 'node:crypto';
import {p} from '../../core/db.js';
import {requireCondition} from '../../core/errors.js';
import {audit,notify} from '../audit/service.js';
import {hasRole,isAdministrator,effectiveRoles} from '../auth/authorization.js';
import {publicUser} from '../auth/service.js';
import {managerRole,assertVersion,assertReview,visibility,actorParams,scopedVisibility,reviewAssignment,canReview,validateJustification} from './policy.js';
import {loadTicket,currentStep,ticketSummary} from './repository.js';
import {resolveManager} from '../directory/approvers.js';
import {approvalPlan} from './system-workflows.js';
import {retiredRequestType} from './catalog.js';
import {createEmailDrafts} from '../fulfilment/system-email.js';

export async function validateCreation(query,body,user){
 validateJustification(body.typeCode,body.justification);
 const type=(await query('SELECT * FROM dbo.RequestTypes WITH(UPDLOCK,HOLDLOCK) WHERE Code=@type AND Active=1',{type:p.str(body.typeCode,50)})).recordset[0];
 requireCondition(type&&(isAdministrator(user)||effectiveRoles(user).some(role=>JSON.parse(type.InitiatorRoles).includes(role))),403,'REQUEST_TYPE_FORBIDDEN');
 const lookups=(await query(`SELECT Id,Kind,Name,${routingNameSql('l')} AS RoutingName FROM dbo.Lookups l WHERE Active=1`)).recordset;
 const validLookup=(id,kind)=>lookups.some(row=>row.Id===id&&row.Kind===kind);
 for(const [id,kind] of [[body.branchId,'branch'],[body.departmentId,'department'],[body.destinationBranchId,'branch'],[body.destinationDepartmentId,'department']])if(id)requireCondition(validLookup(id,kind),400,'INVALID_ORGANIZATION');
 const operations=new Set(body.items.map(item=>item.operation));
 const expected=['employee-deactivate','system-deactivate'].includes(body.typeCode)?'revoke':body.typeCode==='reset'?'reset':null;
 requireCondition(expected?[...operations].every(operation=>operation===expected):![...operations].some(operation=>['revoke','reset'].includes(operation)),400,'INVALID_OPERATION');
 const people=new Map();
 for(const person of body.people){
  requireCondition(!people.has(person.employeeId),400,'DUPLICATE_EMPLOYEE');
  requireCondition(validLookup(person.branchId,'branch')&&validLookup(person.departmentId,'department'),400,'INVALID_ORGANIZATION');
  const existing=(await query('SELECT Id,EmployeeId,Name,BranchId,DepartmentId FROM dbo.Users WHERE EmployeeId=@employee AND Active=1',{employee:p.text(person.employeeId,40)})).recordset[0];
  if(body.typeCode!=='new-user')requireCondition(existing,400,'EMPLOYEE_NOT_FOUND');
  if(person.userId)requireCondition(person.userId===existing?.Id,400,'EMPLOYEE_MISMATCH');
  if(existing)requireCondition(person.name===existing.Name,400,'EMPLOYEE_MISMATCH');
  if(existing&&body.typeCode!=='movement')requireCondition(person.branchId===existing.BranchId&&person.departmentId===existing.DepartmentId,400,'ORGANIZATION_MISMATCH','Use the employee directory branch and department.');
  if(!hasRole(user,'IT','HR','Admin','Super Admin')&&body.typeCode!=='new-user')requireCondition(existing?.Id===user.Id||(user.ManagedScopes||[]).some(scope=>(scope.Role==='Branch manager'?existing?.BranchId:existing?.DepartmentId)===scope.ScopeId),403,'EMPLOYEE_OUT_OF_SCOPE');
  people.set(person.employeeId,{...person,userId:existing?.Id||null});
 }
 if(body.typeCode==='reset')requireCondition(people.size===1&&[...people.values()][0].userId===user.Id,403,'RESET_SELF_ONLY','Reset/unlock requests must be for your own account.');
 // Mixed organizational scopes would route approval to the wrong manager.
 const targetBranch=body.destinationBranchId||body.branchId,targetDepartment=body.destinationDepartmentId||body.departmentId;
 for(const person of people.values())requireCondition(person.branchId===targetBranch&&person.departmentId===targetDepartment,400,'MIXED_APPROVAL_SCOPE','Use one target branch and department per request.');
 const systems=(await query('SELECT s.Id,s.Name,sr.Id AS RoleId FROM dbo.Systems s LEFT JOIN dbo.SystemRoles sr ON sr.SystemId=s.Id AND sr.Active=1 WHERE s.Active=1')).recordset;
 const seen=new Set();
 for(const item of body.items){
  if(['idrive','n-drive'].includes(body.typeCode))requireCondition(systems.some(row=>row.Id===item.systemId&&(body.typeCode==='idrive'?['IDrive','S Drive']:['N Drive']).includes(row.Name)),400,'INVALID_DRIVE_SELECTION','Choose I/S Drive for an I/S Drive request, or N Drive for an N Drive request.');
  requireCondition(people.has(item.employeeId)&&systems.some(row=>row.Id===item.systemId&&(!item.systemRoleId||row.RoleId===item.systemRoleId)),400,'INVALID_SYSTEM_ROLE');
  const key=`${item.employeeId}:${item.systemId}:${item.systemRoleId||''}`;requireCondition(!seen.has(key),400,'DUPLICATE_REQUEST_ITEM');seen.add(key);
  if(['grant','update'].includes(item.operation)&&systems.some(row=>row.Id===item.systemId&&row.RoleId))requireCondition(item.systemRoleId,400,'SYSTEM_ROLE_REQUIRED');
 }
 requireCondition(body.typeCode==='movement'&&!body.items.length||[...people.keys()].every(employeeId=>body.items.some(item=>item.employeeId===employeeId)),400,'EMPLOYEE_ITEMS_REQUIRED');
 let subject=null;
 if(body.typeCode==='movement'){
  requireCondition(body.subjectUserId&&body.destinationBranchId&&body.destinationDepartmentId,400,'MOVEMENT_DESTINATION_REQUIRED');
  subject=(await query('SELECT * FROM dbo.Users WHERE Id=@id AND Active=1',{id:p.id(body.subjectUserId)})).recordset[0];
  requireCondition(subject&&subject.BranchId===body.branchId&&subject.DepartmentId===body.departmentId&&people.size===1&&[...people.values()][0].userId===subject.Id,400,'INVALID_MOVEMENT_SUBJECT');
  requireCondition(body.branchId!==body.destinationBranchId||body.departmentId!==body.destinationDepartmentId,400,'DESTINATION_UNCHANGED');
 }else requireCondition(!body.subjectUserId&&!body.destinationBranchId&&!body.destinationDepartmentId,400,'UNEXPECTED_MOVEMENT_FIELDS');
 const branchName=(lookups.find(row=>row.Id===targetBranch).RoutingName||lookups.find(row=>row.Id===targetBranch).Name),departmentName=(lookups.find(row=>row.Id===targetDepartment).RoutingName||lookups.find(row=>row.Id===targetDepartment).Name);
 const flow=await approvalPlan(query,body);
 const manager=managerRole(branchName,departmentName);
 const managerUserId=flow.some(step=>step.Role==='Manager')?await resolveManager(query,manager,targetBranch,targetDepartment):null;
 requireCondition(!managerUserId||managerUserId!==user.Id&&managerUserId!==subject?.Id,409,'SELF_APPROVAL_ROUTE','The assigned manager cannot approve their own request. Ask IT to assign another approver.');
 return {type,people,flow,targetBranch,targetDepartment,manager,managerUserId,subject};
}
export async function createTicket(db,req,body){return db.transaction(async query=>{
 requireCondition(!retiredRequestType(body.typeCode),400,'REQUEST_TYPE_RETIRED','This older request type is no longer used for new submissions. Refresh the portal and choose the current request form.');
 const plan=await validateCreation(query,body,req.user);
 const id=randomUUID();
 const sequence=(await query('SELECT NEXT VALUE FOR dbo.TicketSequence AS Value')).recordset[0].Value;
 const ticketNumber=`UID-${new Date().getUTCFullYear()}-${String(sequence).padStart(7,'0')}`;
 await query(`INSERT dbo.Requests(Id,TicketNumber,TypeCode,RequesterId,SubjectUserId,BranchId,DepartmentId,DestinationBranchId,DestinationDepartmentId,Status,Justification,Details,RequesterSnapshot,SubmittedIp) VALUES(@id,@number,@type,@requester,@subject,@branch,@department,@toBranch,@toDepartment,@status,@justification,@details,@snapshot,@ip)`,{id:p.id(id),number:p.text(ticketNumber,40),type:p.str(body.typeCode,50),requester:p.id(req.user.Id),subject:p.id(plan.subject?.Id),branch:p.id(body.branchId),department:p.id(body.departmentId),toBranch:p.id(body.destinationBranchId),toDepartment:p.id(body.destinationDepartmentId),status:p.str(plan.subject?'Employee review':'Pending',30),justification:p.text(body.justification),details:p.json(body.details),snapshot:p.json(publicUser(req.user)),ip:p.str(req.ip,64)});
 await query('UPDATE dbo.Requests SET SignatureSnapshot=(SELECT Signature FROM dbo.Users WHERE Id=@user) WHERE Id=@id',{user:p.id(req.user.Id),id:p.id(id)});
 for(const person of plan.people.values()){
  const personId=randomUUID();
  await query('INSERT dbo.RequestPeople(Id,RequestId,EmployeeId,Name,UserId,BranchId,DepartmentId,Details) VALUES(@id,@request,@employee,@name,@user,@branch,@department,@details)',{id:p.id(personId),request:p.id(id),employee:p.text(person.employeeId,40),name:p.text(person.name,160),user:p.id(person.userId),branch:p.id(person.branchId),department:p.id(person.departmentId),details:p.json(person.details)});
  for(const item of body.items.filter(item=>item.employeeId===person.employeeId))await query('INSERT dbo.RequestItems(RequestId,PersonId,SystemId,SystemRoleId,Operation,Reason) VALUES(@request,@person,@system,@role,@operation,@reason)',{request:p.id(id),person:p.id(personId),system:p.id(item.systemId),role:p.id(item.systemRoleId),operation:p.str(item.operation,20),reason:p.text(item.reason,2000)});
 }
 for(const step of plan.flow){const role=step.Role==='Manager'?plan.manager:step.Role;await query('INSERT dbo.RequestSteps(RequestId,Position,Role,BranchId,DepartmentId,AssignedUserId) VALUES(@request,@position,@role,@branch,@department,@assignee)',{request:p.id(id),position:p.int(step.Position),role:p.text(role,40),assignee:p.id(step.Role==='Manager'?plan.managerUserId:null),branch:p.id(role==='Branch manager'?plan.targetBranch:null),department:p.id(role==='Department head'?plan.targetDepartment:null)});}
 await audit(query,req,'request.created',id,{ticketNumber,typeCode:body.typeCode});
 if(plan.subject)await notify(query,plan.subject.Id,id,`${ticketNumber}: employee access review required.`);
 return {id,ticketNumber};
});}
export async function listTickets(db,user,filter){
 const sort={newest:'r.CreatedAt DESC,r.Id DESC',oldest:'r.CreatedAt ASC,r.Id ASC',ticket:'r.TicketNumber ASC,r.Id ASC'}[filter.sort];
 const scope=filter.scope==='mine'?'AND r.RequesterId=@actor':filter.scope==='approvals'?`AND r.Status IN ('Pending','In review') AND r.RequesterId<>@actor AND (r.SubjectUserId IS NULL OR r.SubjectUserId<>@actor) AND ${reviewAssignment('cs')}`:'';
 const where=`${visibility} ${scope} AND (@status IS NULL OR r.Status=@status) AND (@search=N'' OR CHARINDEX(@search,r.TicketNumber)>0 OR CHARINDEX(@search,u.Name)>0 OR CHARINDEX(@search,t.Name)>0)`;
 const from="FROM dbo.Requests r JOIN dbo.Users u ON u.Id=r.RequesterId JOIN dbo.RequestTypes t ON t.Code=r.TypeCode JOIN dbo.Lookups b ON b.Id=r.BranchId JOIN dbo.Lookups d ON d.Id=r.DepartmentId LEFT JOIN dbo.RequestSteps cs ON cs.RequestId=r.Id AND cs.Position=r.CurrentPosition AND cs.Status='Waiting'";
 const result=await db.query(`SELECT COUNT(*) AS Total ${from} WHERE ${where}; SELECT r.*,u.Name AS RequesterName,u.EmployeeId,t.Name AS Action,b.Name AS Branch,d.Name AS Department,cs.Role AS AssignedRole,cs.AssignedUserId,CAST(CASE WHEN r.Status IN ('Pending','In review') AND ${reviewAssignment('cs')} THEN 1 ELSE 0 END AS bit) AS ReviewableByMe,CAST(CASE WHEN ${scopedVisibility} THEN 1 ELSE 0 END AS bit) AS ScopeVisible,cs.BranchId AS StepBranchId,cs.DepartmentId AS StepDepartmentId,CAST(CASE WHEN EXISTS(SELECT 1 FROM dbo.RequestSteps history WHERE history.RequestId=r.Id AND history.ActorId=@actor AND history.Status IN ('Approved','Rejected')) THEN 1 ELSE 0 END AS bit) AS ReviewedByMe,CAST(CASE WHEN EXISTS(SELECT 1 FROM dbo.CredentialDeliveries delivery WHERE delivery.RequestId=r.Id AND delivery.RecipientId=@actor) THEN 1 ELSE 0 END AS bit) AS DeliveryForMe, (SELECT STRING_AGG(s.Name, N', ') FROM dbo.Systems s WHERE EXISTS(SELECT 1 FROM dbo.RequestItems i WHERE i.RequestId=r.Id AND i.SystemId=s.Id)) AS SystemNames ${from} WHERE ${where} ORDER BY ${sort} OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`,{...actorParams(user),status:p.str(filter.status,30),search:p.text(filter.search,100),offset:p.int((filter.page-1)*filter.pageSize),size:p.int(filter.pageSize)});
 const items=result.recordsets[1].map(row=>{
  const saved=JSON.parse(row.Details||'{}');
  const imported=row.SubmittedIp==='demo-import'&&saved.source==='demo-import';
  return {...ticketSummary(row),...(imported?{demoRecord:saved.demoRecord}:{}),...(row.TypeCode==='movement'?{transferChange:saved.transferChange}:{}),system:row.SystemNames||saved.demoRecord?.system||''};
 });
 return {items,total:result.recordsets[0][0].Total,page:filter.page,pageSize:filter.pageSize};
}
export async function replaceTicket(db,req,id,body){return db.transaction(async query=>{
 const ticket=await loadTicket(query,id,req.user,{lock:true});assertVersion(ticket,body.version);
 requireCondition(ticket.RequesterId===req.user.Id&&ticket.Status==='Pending',403,'REQUEST_NOT_EDITABLE');
 requireCondition(ticket.TypeCode===body.typeCode,400,'REQUEST_TYPE_IMMUTABLE');
 const started=(await query("SELECT 1 AS Found FROM dbo.RequestSteps WHERE RequestId=@id AND Status<>'Waiting' UNION ALL SELECT 1 FROM dbo.Queries WHERE RequestId=@id",{id:p.id(id)})).recordset.length;
 requireCondition(!started,409,'REVIEW_ALREADY_STARTED');
 const plan=await validateCreation(query,body,req.user);
 const oldPeople=(await query('SELECT * FROM dbo.RequestPeople WHERE RequestId=@id',{id:p.id(id)})).recordset;
 const oldItems=(await query('SELECT * FROM dbo.RequestItems WHERE RequestId=@id',{id:p.id(id)})).recordset;
 await query('INSERT dbo.RequestRevisions(RequestId,ActorId,Snapshot) VALUES(@id,@actor,@snapshot); DELETE dbo.RequestItems WHERE RequestId=@id; DELETE dbo.RequestPeople WHERE RequestId=@id; DELETE dbo.RequestSteps WHERE RequestId=@id',{id:p.id(id),actor:p.id(req.user.Id),snapshot:p.json({details:JSON.parse(ticket.Details),justification:ticket.Justification,people:oldPeople,items:oldItems})});
 for(const person of plan.people.values()){
  const personId=randomUUID();
  await query('INSERT dbo.RequestPeople(Id,RequestId,EmployeeId,Name,UserId,BranchId,DepartmentId,Details) VALUES(@id,@request,@employee,@name,@user,@branch,@department,@details)',{id:p.id(personId),request:p.id(id),employee:p.text(person.employeeId,40),name:p.text(person.name,160),user:p.id(person.userId),branch:p.id(person.branchId),department:p.id(person.departmentId),details:p.json(person.details)});
  for(const item of body.items.filter(item=>item.employeeId===person.employeeId))await query('INSERT dbo.RequestItems(RequestId,PersonId,SystemId,SystemRoleId,Operation,Reason) VALUES(@request,@person,@system,@role,@operation,@reason)',{request:p.id(id),person:p.id(personId),system:p.id(item.systemId),role:p.id(item.systemRoleId),operation:p.str(item.operation,20),reason:p.text(item.reason,2000)});
 }
 for(const step of plan.flow){const role=step.Role==='Manager'?plan.manager:step.Role;await query('INSERT dbo.RequestSteps(RequestId,Position,Role,BranchId,DepartmentId,AssignedUserId) VALUES(@request,@position,@role,@branch,@department,@assignee)',{request:p.id(id),position:p.int(step.Position),role:p.text(role,40),assignee:p.id(step.Role==='Manager'?plan.managerUserId:null),branch:p.id(role==='Branch manager'?plan.targetBranch:null),department:p.id(role==='Department head'?plan.targetDepartment:null)});}
 await query('UPDATE dbo.Requests SET BranchId=@branch,DepartmentId=@department,DestinationBranchId=@toBranch,DestinationDepartmentId=@toDepartment,Status=@status,CurrentPosition=1,Justification=@justification,Details=@details,ConsentAt=SYSUTCDATETIME(),SignatureSnapshot=(SELECT Signature FROM dbo.Users WHERE Id=@actor),UpdatedAt=SYSUTCDATETIME() WHERE Id=@id',{branch:p.id(body.branchId),department:p.id(body.departmentId),toBranch:p.id(body.destinationBranchId),toDepartment:p.id(body.destinationDepartmentId),status:p.str(plan.subject?'Employee review':'Pending',30),justification:p.text(body.justification),details:p.json(body.details),actor:p.id(req.user.Id),id:p.id(id)});
 await audit(query,req,'request.replaced',id);
});}
export async function decide(db,req,id,body){return db.transaction(async query=>{
 const ticket=await loadTicket(query,id,req.user,{lock:true});assertVersion(ticket,body.version);
 const step=await currentStep(query,ticket);assertReview(ticket,step,req.user);
 if(step.Role==='HR'&&ticket.TypeCode==='new-user'&&body.decision==='approve'){
  const invalid=(await query("SELECT COUNT(*) AS Count FROM dbo.RequestPeople p LEFT JOIN dbo.HrClearances h ON h.PersonId=p.Id WHERE p.RequestId=@id AND (h.PersonId IS NULL OR h.Police='Pending' OR h.ReferenceCheck<>'Both checked')",{id:p.id(id)})).recordset[0].Count;
  requireCondition(!invalid,409,'HR_CLEARANCE_INCOMPLETE');
 }
 const next=(await query('SELECT TOP(1) Position FROM dbo.RequestSteps WHERE RequestId=@id AND Position>@position ORDER BY Position',{id:p.id(id),position:p.int(ticket.CurrentPosition)})).recordset[0];
 const decisionLabel=body.decision==='reject'?'Rejected':next?'Recommended':'Approved';
 await query('UPDATE dbo.RequestSteps SET Status=@status,ActorId=@actor,Remark=@remark,DecidedAt=SYSUTCDATETIME() WHERE RequestId=@id AND Position=@position',{status:p.str(body.decision==='approve'?'Approved':'Rejected',15),actor:p.id(req.user.Id),remark:p.text(body.remark?.trim()||decisionLabel,2000),id:p.id(id),position:p.int(ticket.CurrentPosition)});
 const status=body.decision==='reject'?'Rejected':next?'In review':'Approved';
 await query('UPDATE dbo.Requests SET Status=@status,CurrentPosition=@position,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id',{status:p.str(status,30),position:p.int(next&&body.decision==='approve'?next.Position:ticket.CurrentPosition),id:p.id(id)});
 if(status==='Approved')await createEmailDrafts(query,ticket);
 await audit(query,req,`request.${body.decision}`,id,{position:ticket.CurrentPosition,role:step.Role,decisionLabel});
 await notify(query,ticket.RequesterId,id,`${ticket.TicketNumber}: ${decisionLabel}.`);
 return {status,decisionLabel};
});}
