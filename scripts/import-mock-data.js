import {randomUUID} from 'node:crypto';
import {readConfig} from '../src/config.js';
import {createDatabase,p} from '../src/core/db.js';
import {hashPassword,digest} from '../src/core/crypto.js';
import {mockModeEnabled} from '../src/modules/auth/mock-policy.js';
import {audit} from '../src/modules/audit/service.js';
import {mockUsers,sourceRequests,ticketPeople,ticketItems,typeCodes,approvalPlan} from './mock-data/source.js';

const config=readConfig();
if(!mockModeEnabled(config)||!['localhost','127.0.0.1','::1'].includes(config.DB_SERVER))throw new Error('Import requires local development with MOCK_LOGIN_ENABLED=true.');
const apply=process.argv.includes('--apply');
const sources=mockUsers();
console.log(JSON.stringify({mode:apply?'apply':'preview',sourceUsers:9,totalUsersIncludingBeneficiaries:sources.length,requests:sourceRequests.length,extraUser:'MOCK001'}));
if(!apply){console.log('Preview only. Use npm run db:seed-mock -- --apply to import.');process.exit(0);}
const db=createDatabase(config);
const hashes=new Map();
// Per-account random salts even though these local fixtures share a test password.
for(const user of sources)hashes.set(user.employeeId,await hashPassword('1234'));
try{
 await db.connect();
 const result=await db.transaction(async query=>{
  if(!(await query("SELECT COL_LENGTH('dbo.Users','IsDemo') AS Flag,OBJECT_ID('dbo.DemoImports') AS Provenance")).recordset[0].Provenance)throw new Error('Apply SQL migration 011 first.');
  const counts={createdUsers:0,createdRequests:0,skippedUsers:0,skippedRequests:0,queries:0,responses:0,grants:0,unspecifiedSystemRequests:[]};
  const actor={id:randomUUID(),ip:'local-mock-import'};
  const users=new Map(),lookups=new Map(),systems=new Map(),roleIds=new Map();
  async function imported(kind,key,source){
   const row=(await query('SELECT EntityId,SourceHash FROM dbo.DemoImports WHERE EntityType=@kind AND SourceKey=@key',{kind:p.str(kind,30),key:p.text(key,100)})).recordset[0];
   if(row&&row.SourceHash!==digest(JSON.stringify(source)))throw new Error(`Source changed for ${kind} ${key}; refusing to overwrite existing imported data.`);
   return row?.EntityId;
  }
  async function lookup(kind,name){
   name=name||'Operations';const key=`${kind}:${name}`;if(lookups.has(key))return lookups.get(key);
   let row=(await query('SELECT Id FROM dbo.Lookups WHERE Kind=@kind AND Name=@name',{kind:p.str(kind,20),name:p.text(name,150)})).recordset[0];
   if(!row)row=(await query('INSERT dbo.Lookups(Kind,Name) OUTPUT inserted.Id VALUES(@kind,@name)',{kind:p.str(kind,20),name:p.text(name,150)})).recordset[0];
   lookups.set(key,row.Id);return row.Id;
  }
  async function system(name){
   if(systems.has(name))return systems.get(name);
   let row=(await query('SELECT Id FROM dbo.Systems WHERE Name=@name',{name:p.text(name,150)})).recordset[0];
   if(!row)row=(await query('INSERT dbo.Systems(Name) OUTPUT inserted.Id VALUES(@name)',{name:p.text(name,150)})).recordset[0];
   systems.set(name,row.Id);return row.Id;
  }
  async function systemRole(systemId,name,create=false){
   if(!name)return null;const key=`${systemId}:${name}`;
   if(roleIds.has(key))return roleIds.get(key);
   let row=(await query('SELECT Id FROM dbo.SystemRoles WHERE SystemId=@system AND Name=@name',{system:p.id(systemId),name:p.text(name,150)})).recordset[0];
   if(!row&&create)row=(await query('INSERT dbo.SystemRoles(SystemId,Name) OUTPUT inserted.Id VALUES(@system,@name)',{system:p.id(systemId),name:p.text(name,150)})).recordset[0];
   if(row)roleIds.set(key,row.Id);return row?.Id||null;
  }
  async function grant(userId,systemName,roleName,username){
   const systemId=await system(systemName),roleId=await systemRole(systemId,roleName,true);
   const exists=(await query('SELECT Id FROM dbo.AccessGrants WHERE UserId=@user AND SystemId=@system AND (SystemRoleId=@role OR (@role IS NULL AND SystemRoleId IS NULL)) AND RevokedAt IS NULL',{user:p.id(userId),system:p.id(systemId),role:p.id(roleId)})).recordset.length;
   if(!exists){await query('INSERT dbo.AccessGrants(UserId,SystemId,SystemRoleId,Username) VALUES(@user,@system,@role,@username)',{user:p.id(userId),system:p.id(systemId),role:p.id(roleId),username:p.text(username,150)});counts.grants++;}
  }
  for(const source of sources){
   const old=await imported('user',source.employeeId,source);
   if(old){users.set(source.employeeId,{...source,id:old,branchId:await lookup('branch',source.branch),departmentId:await lookup('department',source.department)});counts.skippedUsers++;continue;}
   if((await query('SELECT Id FROM dbo.Users WHERE EmployeeId=@employee OR Email=@email',{employee:p.text(source.employeeId,40),email:p.text(source.email,254)})).recordset.length)throw new Error(`Account collision for ${source.employeeId}; existing accounts were not modified.`);
   const branchId=await lookup('branch',source.branch),departmentId=await lookup('department',source.department),designationId=await lookup('designation',source.designation||'Officer');
   const row=(await query('INSERT dbo.Users(EmployeeId,Name,Email,Role,BranchId,DepartmentId,DesignationId,PasswordHash,IsDemo) OUTPUT inserted.Id VALUES(@employee,@name,@email,@role,@branch,@department,@designation,@password,1)',{employee:p.text(source.employeeId,40),name:p.text(source.name,160),email:p.text(source.email,254),role:p.text(source.role,40),branch:p.id(branchId),department:p.id(departmentId),designation:p.id(designationId),password:p.str(hashes.get(source.employeeId),300)})).recordset[0];
   const mapped={...source,id:row.Id,branchId,departmentId};users.set(source.employeeId,mapped);
   if(source.systemId)await query('INSERT dbo.DirectoryIdentities(SystemId,UserId) VALUES(@system,@user)',{system:p.text(source.systemId,160),user:p.id(row.Id)});
   const roleSystems=new Set(Object.keys(source.access?.systemRoles||{}));
   for(const [systemName,names] of Object.entries(source.access?.systemRoles||{}))for(const name of names.length?names:[null])await grant(row.Id,systemName,name,source.systemId);
   for(const systemName of new Set([...(source.access?.enabledSystems||[]),...(source.access?.otherAccess||[])]))if(!roleSystems.has(systemName))await grant(row.Id,systemName,null,source.systemId);
   await query('INSERT dbo.DemoImports(EntityType,SourceKey,EntityId,SourceHash,OriginalJson) VALUES(\'user\',@key,@id,@hash,@json)',{key:p.text(source.employeeId,100),id:p.id(row.Id),hash:p.str(digest(JSON.stringify(source)),64),json:p.json(source)});
   await audit(query,actor,'mock.user_imported',row.Id,{employeeId:source.employeeId,role:source.role});
   counts.createdUsers++;

  }
  const actorUser=(event,fallbackRole)=>users.get(event?.employeeId)||[...users.values()].find(user=>user.name===(event?.by||event?.responseBy))||[...users.values()].find(user=>user.role===(event?.role||fallbackRole));
  console.log(JSON.stringify({usersPrepared:users.size}));
  for(const ticket of sourceRequests){
   if(await imported('request',ticket.id,ticket)){counts.skippedRequests++;continue;}
   if((await query('SELECT Id FROM dbo.Requests WHERE TicketNumber=@number',{number:p.text(ticket.id,40)})).recordset.length)throw new Error(`Ticket collision for ${ticket.id}; existing tickets were not modified.`);
   const requester=users.get(ticket.requesterId);if(!requester)throw new Error(`Missing requester for ${ticket.id}`);
   const people=ticketPeople(ticket,requester),plan=approvalPlan(ticket),requestId=randomUUID(),type=typeCodes[ticket.action];
   if(!type)throw new Error(`Unsupported source request type ${ticket.action}`);
   const data={...Object.fromEntries(Object.entries(ticket).filter(([key])=>key.endsWith('Details')||key==='transferChange'||key==='submittedForm')),mockSource:ticket};
   await query('INSERT dbo.Requests(Id,TicketNumber,TypeCode,RequesterId,BranchId,DepartmentId,Status,CurrentPosition,Justification,Details,RequesterSnapshot,SubmittedIp,CreatedAt,UpdatedAt) VALUES(@id,@number,@type,@requester,@branch,@department,@status,@position,@justification,@details,@snapshot,@ip,@at,@at)',{id:p.id(requestId),number:p.text(ticket.id,40),type:p.str(type,50),requester:p.id(requester.id),branch:p.id(await lookup('branch',ticket.branch||requester.branch)),department:p.id(await lookup('department',people[0]?.department||requester.department)),status:p.str(ticket.state,30),position:p.int(plan.position),justification:p.text(ticket.justification||''),details:p.json(data),snapshot:p.json(ticket.requesterProfile||requester),ip:p.str('local-mock-import',64),at:p.date(new Date(ticket.createdAt))});
   const peopleIds=new Map();
   for(const person of people){const personId=randomUUID();peopleIds.set(person.employeeId,personId);await query('INSERT dbo.RequestPeople(Id,RequestId,EmployeeId,Name,UserId,BranchId,DepartmentId,Details) VALUES(@id,@request,@employee,@name,@user,@branch,@department,@details)',{id:p.id(personId),request:p.id(requestId),employee:p.text(person.employeeId,40),name:p.text(person.name,160),user:p.id(users.get(person.employeeId)?.id),branch:p.id(await lookup('branch',person.branch)),department:p.id(await lookup('department',person.department)),details:p.json(person)});}
   const itemKeys=new Set();
   if(!ticketItems(ticket,people).length)counts.unspecifiedSystemRequests.push(ticket.id);
   for(const item of ticketItems(ticket,people)){
    const systemId=await system(item.system),roleId=await systemRole(systemId,item.role);const personId=peopleIds.get(item.employeeId);const key=`${personId}:${systemId}:${roleId}`;if(itemKeys.has(key))continue;itemKeys.add(key);
    await query('INSERT dbo.RequestItems(RequestId,PersonId,SystemId,SystemRoleId,Operation,Reason) VALUES(@request,@person,@system,@role,@operation,@reason)',{request:p.id(requestId),person:p.id(personId),system:p.id(systemId),role:p.id(roleId),operation:p.str(type==='reset'?'reset':type.endsWith('-deactivate')?'revoke':type==='upgrade'?'update':'grant',20),reason:p.text(item.role?`Original mock role: ${item.role}`:ticket.justification||'',2000)});
   }
   for(const [index,role] of plan.roles.entries()){
    const event=(ticket.approvalHistory||[]).find(event=>event.role===role||event.stage===role),reviewer=event?actorUser(event,role):null;
    await query('INSERT dbo.RequestSteps(RequestId,Position,Role,BranchId,DepartmentId,Status,ActorId,Remark,DecidedAt) VALUES(@request,@position,@role,@branch,@department,@status,@actor,@remark,@at)',{request:p.id(requestId),position:p.int(index+1),role:p.text(role,40),branch:p.id(role==='Branch manager'?requester.branchId:null),department:p.id(role==='Department head'?requester.departmentId:null),status:p.str(event?.status==='Rejected'?'Rejected':event?'Approved':'Waiting',15),actor:p.id(reviewer?.id),remark:p.text(event?.remark,2000),at:p.date(event?.at?new Date(event.at):null)});
   }
   const history=ticket.queryHistory||[];
   for(const [index,event] of history.entries()){
    const author=actorUser(event);if(!author)throw new Error(`Unknown query author ${ticket.id}`);
    for(const employeeId of event.targetIds||[]){
     const recipient=users.get(employeeId);if(!recipient)throw new Error(`Unknown query recipient ${employeeId}`);
     const response=(event.responses||[]).find(reply=>reply.employeeId===employeeId);
     const pending=ticket.state==='Query'&&index===history.length-1&&(ticket.queryTargetIds||[]).includes(employeeId)&&!response;
     const queryId=randomUUID(),resolved=response?.responseAt||history[index+1]?.at||event.at;
     await query('INSERT dbo.Queries(Id,RequestId,AuthorId,RecipientId,Message,ReturnStatus,CreatedAt,ResolvedAt) VALUES(@id,@request,@author,@recipient,@message,@status,@at,@resolved)',{id:p.id(queryId),request:p.id(requestId),author:p.id(author.id),recipient:p.id(recipient.id),message:p.text(event.message,350),status:p.str('In review',30),at:p.date(new Date(event.at)),resolved:p.date(pending?null:new Date(resolved))});counts.queries++;
     if(response){await query('INSERT dbo.QueryResponses(QueryId,AuthorId,Message,CreatedAt) VALUES(@query,@author,@message,@at)',{query:p.id(queryId),author:p.id(recipient.id),message:p.text(response.response,4000),at:p.date(new Date(response.responseAt))});counts.responses++;}
    }
   }
   for(const [index,check] of (ticket.hrClearance?.checks||[]).entries()){
    const person=people[index],hr=actorUser(ticket.hrClearance,'HR');if(!person||!hr)continue;
    await query('INSERT dbo.HrClearances(PersonId,ActorId,Police,ReferenceCheck,Recommendation,UpdatedAt) VALUES(@person,@actor,@police,@reference,@recommendation,@at)',{person:p.id(peopleIds.get(person.employeeId)),actor:p.id(hr.id),police:p.str(check.police,30),reference:p.str(check.reference,20),recommendation:p.text(check.recommendation||'',2000),at:p.date(new Date(ticket.hrClearance.at||ticket.createdAt))});
   }
   await query('INSERT dbo.DemoImports(EntityType,SourceKey,EntityId,SourceHash,OriginalJson) VALUES(\'request\',@key,@id,@hash,@json)',{key:p.text(ticket.id,100),id:p.id(requestId),hash:p.str(digest(JSON.stringify(ticket)),64),json:p.json(ticket)});
   await audit(query,actor,'mock.request_imported',requestId,{ticketNumber:ticket.id,sourceState:ticket.state});
   for(const remark of ticket.remarks||[])await audit(query,{...actor,user:{Id:actorUser(remark)?.id}},'mock.historical_remark',requestId,{at:remark.at,message:remark.message});
   counts.createdRequests++;
   if(counts.createdRequests%10===0)console.log(JSON.stringify({requestsPrepared:counts.createdRequests}));
  }
  await audit(query,actor,'mock.import_completed',null,counts);
  return counts;
 });
 console.log(JSON.stringify({import:'completed',...result}));
}finally{await db.close();}
