import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateCreation,createTicket,decide} from '../src/modules/requests/service.js';
import {parse} from '../src/core/validation.js';
import {createRequest,version} from '../src/modules/requests/schemas.js';
import {workflowRoles} from '../src/modules/requests/policy.js';
import {user,actorId,otherId,branchId,departmentId,requestId} from './helpers.js';

const systemId='66666666-6666-4666-8666-666666666666';
const roleId='77777777-7777-4777-8777-777777777777';
const body=()=>({typeCode:'upgrade',branchId,departmentId,justification:'Business access upgrade required.',details:{upgradeDetails:{systems:['ICBS']}},people:[{employeeId:user.EmployeeId,name:user.Name,branchId,departmentId,details:{}}],items:[{employeeId:user.EmployeeId,systemId,systemRoleId:roleId,operation:'update'}],consent:true});
function fixture(){
 const calls=[];
 const query=async(text,params)=>{
  calls.push({text,params});
  if(text.startsWith('SELECT * FROM dbo.RequestTypes'))return {recordset:[{Code:'upgrade',InitiatorRoles:'["User"]'}]};
  if(text.startsWith('SELECT Id,Kind,Name FROM dbo.Lookups'))return {recordset:[{Id:branchId,Kind:'branch',Name:'Dhanmondi Branch'},{Id:departmentId,Kind:'department',Name:'Operations'}]};
  if(text.startsWith('SELECT Id,EmployeeId,Name'))return {recordset:[{...user}]};
  if(text.startsWith('SELECT s.Id'))return {recordset:[{Id:systemId,Name:'ICBS',RoleId:roleId}]};
  if(text.startsWith('SELECT * FROM dbo.WorkflowSteps'))return {recordset:['Manager','IT','CITO','COO'].map((Role,index)=>({Role,Position:index+1}))};
  if(text.startsWith('SELECT NEXT VALUE'))return {recordset:[{Value:123}]};
  return {recordset:[]};
 };
 return {query,calls};
}
test('creation resolves manager scope and persists only backend-derived actor/routing',async()=>{
 const {query,calls}=fixture();const req={user,ip:'192.0.2.1',id:randomUUID()};const result=await createTicket({transaction:work=>work(query)},req,body());
 assert.match(result.ticketNumber,/^UID-\d{4}-0000123$/);
 const ticket=calls.find(call=>call.text.startsWith('INSERT dbo.Requests'));assert.equal(ticket.params.requester.value,actorId);assert.equal(ticket.params.status.value,'Pending');
 const steps=calls.filter(call=>call.text.startsWith('INSERT dbo.RequestSteps'));assert.deepEqual(steps.map(step=>step.params.role.value),['Branch manager','IT','CITO','COO']);assert.equal(steps[0].params.branch.value,branchId);assert.equal(steps[1].params.branch.value,null);
 assert.ok(calls.some(call=>call.text.startsWith('INSERT dbo.AuditEvents')));
});
test('creation rejects role/system mismatch and an unspecified role on a role-bearing system',async()=>{
 for(const systemRoleId of [otherId,null]){const value=body();value.items[0].systemRoleId=systemRoleId;await assert.rejects(validateCreation(fixture().query,value,user),error=>['INVALID_SYSTEM_ROLE','SYSTEM_ROLE_REQUIRED'].includes(error.code));}
});
test('users cannot route their existing identity through a fabricated branch or request another identity',async()=>{
 const value=body();value.people[0].branchId=otherId;await assert.rejects(validateCreation(fixture().query,value,user),error=>error.code==='INVALID_ORGANIZATION');
 const query=async(text,params)=>text.startsWith('SELECT Id,EmployeeId,Name')?{recordset:[{...user,Id:otherId}]}:fixture().query(text,params);
 await assert.rejects(validateCreation(query,body(),user),error=>error.code==='EMPLOYEE_OUT_OF_SCOPE');
});
test('HR cannot approve a new-user request with incomplete clearance',async()=>{
 const reviewer={...user,Role:'HR'};const ticket={Id:requestId,RequesterId:otherId,SubjectUserId:null,Status:'In review',TypeCode:'new-user',CurrentPosition:2,Version:Buffer.from('0000000000000001','hex')};
 const query=async text=>{
  if(text.startsWith('SELECT r.*'))return {recordset:[ticket]};
  if(text.startsWith('SELECT * FROM dbo.RequestSteps'))return {recordset:[{Role:'HR'}]};
  if(text.startsWith('SELECT COUNT(*) AS Count'))return {recordset:[{Count:1}]};
  throw new Error('An incomplete HR review must not write approval state.');
 };
 await assert.rejects(decide({transaction:work=>work(query)},{user:reviewer},requestId,{version:'0000000000000001',decision:'approve'}),error=>error.code==='HR_CLEARANCE_INCOMPLETE');
});
test('reset without justification gets only CITO approval even with old workflow templates',async()=>{
 const value=body();value.typeCode='reset';delete value.justification;value.items[0].operation='reset';
 const parsed=parse(createRequest,value);assert.equal(parsed.justification,'');
 assert.equal(parse(createRequest.safeExtend({version}),{...value,version:'0000000000000001'}).justification,'');
 const {query,calls}=fixture();
 const result=await createTicket({transaction:work=>work(query)},{user,ip:'192.0.2.1',id:randomUUID()},parsed);
 assert.ok(result.id);
 const steps=calls.filter(call=>call.text.startsWith('INSERT dbo.RequestSteps'));
 assert.deepEqual(steps.map(step=>step.params.role.value),['CITO']);
 assert.equal(steps[0].params.branch.value,null);
 assert.deepEqual(workflowRoles('reset'),['CITO']);
 assert.throws(()=>parse(createRequest,{...value,typeCode:'upgrade'}));
});
test('CITO approval completes reset approval and sends it to processing without COO',async()=>{
 const calls=[];
 const ticket={Id:requestId,RequesterId:otherId,Status:'Pending',TypeCode:'reset',CurrentPosition:1,Version:Buffer.from('0000000000000001','hex')};
 const query=async(text,params)=>{
  calls.push({text,params});
  if(text.startsWith('SELECT r.*'))return {recordset:[ticket]};
  if(text.startsWith('SELECT * FROM dbo.RequestSteps'))return {recordset:[{Role:'CITO'}]};
  return {recordset:[]};
 };
 const result=await decide({transaction:work=>work(query)},{user:{...user,Role:'CITO'},ip:'192.0.2.1',id:randomUUID()},requestId,{version:'0000000000000001',decision:'approve'});
 assert.equal(result.status,'Approved');
 assert.equal(calls.find(call=>call.text.startsWith('UPDATE dbo.Requests SET Status')).params.status.value,'Approved');
});
test('drive request types cannot select systems from the other drive request',async()=>{
 for(const [typeCode,name,allowed] of [['idrive','IDrive',true],['idrive','S Drive',true],['idrive','N Drive',false],['n-drive','N Drive',true],['n-drive','S Drive',false]]){
  const value=body();value.typeCode=typeCode;value.items[0].systemRoleId=null;
  const base=fixture();
  const query=(text,params)=>text.startsWith('SELECT s.Id')?Promise.resolve({recordset:[{Id:systemId,Name:name,RoleId:null}]}):base.query(text,params);
  if(allowed)await validateCreation(query,value,user);
  else await assert.rejects(validateCreation(query,value,user),error=>error.code==='INVALID_DRIVE_SELECTION');
 }
});
