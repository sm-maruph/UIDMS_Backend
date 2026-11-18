import {Router} from 'express';
import {p} from '../../core/db.js';
import {parse,z,text,uuidParam,id,formJson} from '../../core/validation.js';
import {requireCondition} from '../../core/errors.js';
import {createTicket,listTickets,decide,replaceTicket} from './service.js';
import {createRequest,listRequests,editRequest,decision,version} from './schemas.js';
import {loadTicket,details,currentStep} from './repository.js';
import {assertVersion,assertReview,validateJustification} from './policy.js';
import {audit} from '../audit/service.js';
import {raiseQuery} from '../queries/routes.js';

// Exported request shape is deliberately separate from a server-managed ticket.
export function requestRoutes(db){
 const router=Router();
 router.get('/',async(req,res)=>res.json(await listTickets(db,req.user,parse(listRequests,req.query))));
 router.post('/',async(req,res)=>res.status(201).json(await createTicket(db,req,parse(createRequest,req.body))));
 router.put('/:id',async(req,res)=>{await replaceTicket(db,req,uuidParam(req),parse(createRequest.safeExtend({version}),req.body));res.status(204).end();});
 router.get('/:id',async(req,res)=>{const ticket=await loadTicket(db.query,uuidParam(req),req.user);res.json(await details(db.query,ticket,req.user));});
 router.patch('/:id',async(req,res)=>{
  const requestId=uuidParam(req),body=parse(editRequest,req.body);
  await db.transaction(async query=>{
   const ticket=await loadTicket(query,requestId,req.user,{lock:true});assertVersion(ticket,body.version);
   validateJustification(ticket.TypeCode,body.justification);
   requireCondition(ticket.RequesterId===req.user.Id&&ticket.Status==='Pending',403,'REQUEST_NOT_EDITABLE');
   const approved=(await query("SELECT 1 AS Found FROM dbo.RequestSteps WHERE RequestId=@id AND Status<>'Waiting' UNION ALL SELECT 1 FROM dbo.Queries WHERE RequestId=@id",{id:p.id(requestId)})).recordset.length;
   requireCondition(!approved,409,'REVIEW_ALREADY_STARTED');
   await query('INSERT dbo.RequestRevisions(RequestId,ActorId,Snapshot) VALUES(@id,@actor,@snapshot); UPDATE dbo.Requests SET Justification=@justification,Details=@details,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id',{id:p.id(requestId),actor:p.id(req.user.Id),snapshot:p.json({details:JSON.parse(ticket.Details),justification:ticket.Justification}),justification:p.text(body.justification),details:p.json(body.details)});
   await audit(query,req,'request.edited',requestId);
  });res.status(204).end();
 });
 router.delete('/:id',async(req,res)=>{
  const requestId=uuidParam(req),body=parse(z.object({version}).strict(),req.body);
  await db.transaction(async query=>{
   const ticket=await loadTicket(query,requestId,req.user,{lock:true});assertVersion(ticket,body.version);
   requireCondition(ticket.RequesterId===req.user.Id&&ticket.Status==='Pending',403,'REQUEST_NOT_DELETABLE');
   const started=(await query("SELECT 1 AS Found FROM dbo.RequestSteps WHERE RequestId=@id AND Status<>'Waiting' UNION ALL SELECT 1 FROM dbo.Queries WHERE RequestId=@id",{id:p.id(requestId)})).recordset.length;requireCondition(!started,409,'REVIEW_ALREADY_STARTED');
   await query("UPDATE dbo.Requests SET Status='Cancelled',DeletedAt=SYSUTCDATETIME(),UpdatedAt=SYSUTCDATETIME() WHERE Id=@id",{id:p.id(requestId)});
   await audit(query,req,'request.cancelled',requestId,{ticketNumber:ticket.TicketNumber});
  });res.status(204).end();
 });
 router.post('/:id/decisions',async(req,res)=>res.json(await decide(db,req,uuidParam(req),parse(decision,req.body))));
 router.post('/:id/queries',async(req,res)=>res.status(201).json(await raiseQuery(db,req,uuidParam(req))));
 router.put('/:id/hr-clearance',async(req,res)=>{
  const requestId=uuidParam(req),body=parse(z.object({version,checks:z.array(z.object({personId:id,police:z.enum(['Completed','Pending','Special recommendation']),reference:z.enum(['Both checked','One checked','Pending']),recommendation:text(2000,0).optional()}).strict().refine(check=>check.police!=='Special recommendation'||check.recommendation?.length,'Recommendation required')).min(1).max(100)}).strict(),req.body);
  await db.transaction(async query=>{
   const ticket=await loadTicket(query,requestId,req.user,{lock:true});assertVersion(ticket,body.version);assertReview(ticket,await currentStep(query,ticket),req.user);requireCondition(req.user.Role==='HR'&&ticket.TypeCode==='new-user',403,'HR_ONLY');
   const people=(await query('SELECT Id FROM dbo.RequestPeople WHERE RequestId=@id',{id:p.id(requestId)})).recordset;
   requireCondition(body.checks.length===people.length&&new Set(body.checks.map(check=>check.personId)).size===people.length&&body.checks.every(check=>people.some(person=>person.Id===check.personId)),400,'HR_PEOPLE_MISMATCH');
   for(const check of body.checks)await query('UPDATE dbo.HrClearances SET ActorId=@actor,Police=@police,ReferenceCheck=@reference,Recommendation=@recommendation,UpdatedAt=SYSUTCDATETIME() WHERE PersonId=@person; IF @@ROWCOUNT=0 INSERT dbo.HrClearances(PersonId,ActorId,Police,ReferenceCheck,Recommendation) VALUES(@person,@actor,@police,@reference,@recommendation)',{actor:p.id(req.user.Id),police:p.str(check.police,30),reference:p.str(check.reference,20),recommendation:p.text(check.recommendation,2000),person:p.id(check.personId)});
   await query('UPDATE dbo.Requests SET UpdatedAt=SYSUTCDATETIME() WHERE Id=@id',{id:p.id(requestId)});await audit(query,req,'hr.clearance_updated',requestId,{checks:body.checks});
  });res.status(204).end();
 });
 router.post('/:id/employee-review',async(req,res)=>{
  const requestId=uuidParam(req);const body=parse(z.object({version,justification:text(4000),details:formJson,items:z.array(z.object({systemId:id,systemRoleId:id.nullable().optional(),reason:text(2000)}).strict()).min(1).max(100)}).strict(),req.body);
  await db.transaction(async query=>{
   const ticket=await loadTicket(query,requestId,req.user,{lock:true});assertVersion(ticket,body.version);
   requireCondition(ticket.TypeCode==='movement'&&ticket.Status==='Employee review'&&ticket.SubjectUserId===req.user.Id,403,'EMPLOYEE_REVIEW_FORBIDDEN');
   const systems=(await query('SELECT s.Id,sr.Id AS RoleId FROM dbo.Systems s LEFT JOIN dbo.SystemRoles sr ON sr.SystemId=s.Id AND sr.Active=1 WHERE s.Active=1 AND s.TransferManaged=1')).recordset;
   requireCondition(new Set(body.items.map(item=>`${item.systemId}:${item.systemRoleId||''}`)).size===body.items.length,400,'DUPLICATE_REQUEST_ITEM');
   requireCondition(body.items.every(item=>systems.some(system=>system.Id===item.systemId&&(!item.systemRoleId||system.RoleId===item.systemRoleId))),400,'INVALID_SYSTEM_ROLE');
   const person=(await query('SELECT Id FROM dbo.RequestPeople WHERE RequestId=@id',{id:p.id(requestId)})).recordset[0];
   await query('DELETE dbo.RequestItems WHERE RequestId=@id; INSERT dbo.RequestRevisions(RequestId,ActorId,Snapshot) VALUES(@id,@actor,@snapshot)',{id:p.id(requestId),actor:p.id(req.user.Id),snapshot:p.json({details:JSON.parse(ticket.Details),justification:ticket.Justification})});
   for(const item of body.items)await query("INSERT dbo.RequestItems(RequestId,PersonId,SystemId,SystemRoleId,Operation,Reason) VALUES(@request,@person,@system,@role,'update',@reason)",{request:p.id(requestId),person:p.id(person.Id),system:p.id(item.systemId),role:p.id(item.systemRoleId),reason:p.text(item.reason,2000)});
   await query("UPDATE dbo.Requests SET Status='Pending',Justification=@justification,Details=@details,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id",{justification:p.text(body.justification),details:p.json(body.details),id:p.id(requestId)});await audit(query,req,'movement.employee_reviewed',requestId);
  });res.status(204).end();
 });
 return router;
}
