import {routingNameSql} from '../directory/organization-names.js';
import {p} from '../../core/db.js';
import {z} from '../../core/validation.js';
import {HttpError,requireCondition} from '../../core/errors.js';
import {audit} from '../audit/service.js';
import {resolveManager} from '../directory/approvers.js';
import {managerRole} from '../requests/policy.js';
import {approvalPlan,mergeApprovalChains} from '../requests/system-workflows.js';
import {createEmailDrafts} from '../fulfilment/system-email.js';

const role=z.enum(['Manager','HR','IT','CITO','COO']);
export const workflowUpdate=z.object({
 roles:z.array(role).min(1).max(5).refine(value=>new Set(value).size===value.length,'Each approval role can appear only once.'),
 expectedRoles:z.array(role).max(5).optional(),
 applyToOpenRequests:z.boolean().default(false),
}).strict();

export function remainingWorkflow(existing,configured,manager){
 const completed=existing.filter(step=>step.Status==='Approved');
 const done=new Set(completed.map(step=>step.Role));
 const offset=Math.max(0,...completed.map(step=>step.Position));
 return configured.map(step=>step.Role==='Manager'?manager:step.Role).filter(role=>!done.has(role)).map((Role,index)=>({Role,Position:offset+index+1}));
}

async function updateOpenRequests(query,req,code){
 const tickets=(await query(`SELECT r.*,rt.Name AS Action,b.Name AS TargetBranch,d.Name AS TargetDepartment,u.Email AS RequesterEmail,${routingNameSql('b')} AS RoutingBranch,${routingNameSql('d')} AS RoutingDepartment
  FROM dbo.Requests r WITH(UPDLOCK,HOLDLOCK)
  JOIN dbo.Lookups b ON b.Id=COALESCE(r.DestinationBranchId,r.BranchId)
  JOIN dbo.Lookups d ON d.Id=COALESCE(r.DestinationDepartmentId,r.DepartmentId)
  JOIN dbo.Users u ON u.Id=r.RequesterId
  JOIN dbo.RequestTypes rt ON rt.Code=r.TypeCode
  WHERE r.TypeCode=@code AND r.DeletedAt IS NULL AND r.Status IN ('Employee review','Pending','In review','Query') ORDER BY r.Id`,{code:p.str(code,50)})).recordset;
 const plans=[],issues=[];
 for(const ticket of tickets){
  const params={id:p.id(ticket.Id)};
  const existing=(await query('SELECT * FROM dbo.RequestSteps WITH(UPDLOCK,HOLDLOCK) WHERE RequestId=@id ORDER BY Position',params)).recordset;
  requireCondition(existing.every(step=>['Waiting','Approved'].includes(step.Status)),409,'WORKFLOW_STATE_CONFLICT','A request changed during workflow editing. Reload and retry.');
  const items=(await query('SELECT SystemId FROM dbo.RequestItems WHERE RequestId=@id',params)).recordset;
  const configured=await approvalPlan(query,{typeCode:code,items:items.map(item=>({systemId:item.SystemId}))});
  const pending=remainingWorkflow(existing,configured,managerRole(ticket.RoutingBranch||ticket.TargetBranch,ticket.RoutingDepartment||ticket.TargetDepartment));
  const completed=existing.filter(step=>step.Status==='Approved');
  for(const step of pending){
   if(!['Branch manager','Department head'].includes(step.Role))continue;
   try{step.AssignedUserId=await resolveManager(query,step.Role,ticket.DestinationBranchId||ticket.BranchId,ticket.DestinationDepartmentId||ticket.DepartmentId);}
   catch(error){
    if(!['APPROVER_REQUIRED','APPROVER_INACTIVE'].includes(error.code))throw error;
    issues.push({ticketNumber:ticket.TicketNumber,scopeId:step.Role==='Branch manager'?(ticket.DestinationBranchId||ticket.BranchId):(ticket.DestinationDepartmentId||ticket.DepartmentId),scopeKind:step.Role==='Branch manager'?'branch':'department',scopeName:step.Role==='Branch manager'?ticket.TargetBranch:ticket.TargetDepartment,branch:ticket.TargetBranch,department:ticket.TargetDepartment,role:step.Role,reason:error.code});
   }
  }
  plans.push({ticket,existing,pending,completed});
 }
 if(issues.length){
  const scopes=new Map();
  for(const issue of issues){const key=issue.scopeId+':'+issue.role;const group=scopes.get(key)||{...issue,tickets:[],requestCount:0};if(group.tickets.length<10)group.tickets.push(issue.ticketNumber);group.requestCount++;scopes.set(key,group);}
  const error=new HttpError(409,'WORKFLOW_ASSIGNMENTS_INCOMPLETE',`${issues.length} ongoing request${issues.length===1?' needs':'s need'} an assigned manager or department head. Review the exact scopes below; no workflow changes were saved.`);
  error.details={requestCount:issues.length,scopeCount:scopes.size,assignments:[...scopes.values()].slice(0,100)};throw error;
 }
 for(const {ticket,existing,pending,completed} of plans){
  const params={id:p.id(ticket.Id)};
  const returnStatus=pending.length?(completed.length?'In review':'Pending'):'Approved';
  const status=['Query','Employee review'].includes(ticket.Status)?ticket.Status:returnStatus;
  await query("DELETE dbo.RequestSteps WHERE RequestId=@id AND Status='Waiting'",params);
  for(const step of pending)await query('INSERT dbo.RequestSteps(RequestId,Position,Role,BranchId,DepartmentId,AssignedUserId) VALUES(@request,@position,@role,@branch,@department,@assignee)',{
   request:p.id(ticket.Id),position:p.int(step.Position),role:p.text(step.Role,40),
   assignee:p.id(step.AssignedUserId||null),
   branch:p.id(step.Role==='Branch manager'?(ticket.DestinationBranchId||ticket.BranchId):null),
   department:p.id(step.Role==='Department head'?(ticket.DestinationDepartmentId||ticket.DepartmentId):null),
  });
  const position=pending[0]?.Position||Math.max(1,...completed.map(step=>step.Position));
  await query('UPDATE dbo.Requests SET Status=@status,CurrentPosition=@position,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id',{...params,status:p.str(status,30),position:p.int(position)});
  if(ticket.Status==='Query')await query('UPDATE dbo.Queries SET ReturnStatus=@status WHERE RequestId=@id AND ResolvedAt IS NULL',{...params,status:p.str(returnStatus,30)});
  if(status==='Approved')await createEmailDrafts(query,ticket);
  await audit(query,req,'request.workflow_updated',ticket.Id,{previous:existing.map(step=>({role:step.Role,status:step.Status,position:step.Position})),roles:[...completed,...pending].map(step=>step.Role),status});
 }
 return tickets.length;
}

export async function saveWorkflow(db,req,code,body){
 return db.transaction(async query=>{
  const params={code:p.str(code,50)};
  const type=(await query('SELECT * FROM dbo.RequestTypes WITH(UPDLOCK,HOLDLOCK) WHERE Code=@code',params)).recordset[0];
  requireCondition(type,404,'TYPE_NOT_FOUND');
  const previous=(await query('SELECT Role FROM dbo.WorkflowSteps WHERE TypeCode=@code ORDER BY Position',params)).recordset.map(step=>step.Role);
  requireCondition(!body.expectedRoles||JSON.stringify(body.expectedRoles)===JSON.stringify(previous),409,'STALE_WORKFLOW','This workflow changed. Reload the saved workflow before editing again.');
  const overrides=(await query('SELECT Steps FROM dbo.SystemApprovalOverrides WHERE TypeCode=@code',params)).recordset;
  // Existing system-specific overrides remain explicit. Reject contradictory orders.
  mergeApprovalChains([body.roles,...overrides.map(row=>JSON.parse(row.Steps))]);
  await query('DELETE dbo.WorkflowSteps WHERE TypeCode=@code',params);
  for(const [index,role] of body.roles.entries())await query('INSERT dbo.WorkflowSteps(TypeCode,Position,Role) VALUES(@code,@position,@role)',{...params,position:p.int(index+1),role:p.text(role,40)});
  await query('UPDATE dbo.RequestTypes SET IncludesHr=@hr WHERE Code=@code',{...params,hr:p.bit(body.roles.includes('HR'))});
  const updatedRequests=body.applyToOpenRequests?await updateOpenRequests(query,req,code):0;
  await audit(query,req,'workflow.updated',code,{previous,roles:body.roles,applyToOpenRequests:body.applyToOpenRequests,updatedRequests});
  return {updatedRequests};
 });
}
