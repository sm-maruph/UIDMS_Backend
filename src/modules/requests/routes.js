import {currentTransferAccess,transferCatalogue,transferReview,saveEmployeeTransferAccess,saveItTransferAccess} from './transfer-access.js';
import {notifyAttention} from '../notifications/attention.js';
import {Router} from 'express';
import {p} from '../../core/db.js';
import {parse,z,text,uuidParam,id,formJson} from '../../core/validation.js';
import {requireCondition} from '../../core/errors.js';
import {createTicket,listTickets,decide,replaceTicket} from './service.js';
import {createRequest,listRequests,editRequest,decision,version} from './schemas.js';
import {loadTicket,details,currentStep} from './repository.js';
import {assertVersion,assertReview,validateJustification} from './policy.js';
import {hasRole} from '../auth/authorization.js';
import {audit} from '../audit/service.js';
import {raiseQuery} from '../queries/routes.js';
import {requestDocument,documentHtml} from './document.js';
import {documentPdf} from './document-pdf.js';

// Exported request shape is deliberately separate from a server-managed ticket.
export function requestRoutes(db){
 const router=Router();
 router.get('/',async(req,res)=>res.json(await listTickets(db,req.user,parse(listRequests,req.query))));
 router.post('/',async(req,res)=>res.status(201).json(await createTicket(db,req,parse(createRequest,req.body))));
 router.put('/:id',async(req,res)=>{await replaceTicket(db,req,uuidParam(req),parse(createRequest.safeExtend({version}),req.body));res.status(204).end();});
 router.get('/:id',async(req,res)=>{const ticket=await loadTicket(db.query,uuidParam(req),req.user);res.json(await details(db.query,ticket,req.user));});
 router.get('/:id/document',async(req,res)=>{
  requireCondition(hasRole(req.user,'CITO','IT','Admin','Super Admin'),403,'FORBIDDEN','Only CITO, IT, Admin and Super Admin may generate request documents.');
  const {format}=parse(z.object({format:z.enum(['html','pdf']).default('pdf')}).strict(),req.query);
  const requestId=uuidParam(req);
  const report=await db.transaction(async query=>{const ticket=await loadTicket(query,requestId,req.user);const data=await details(query,ticket,req.user);return requestDocument(data,req.user);});
  const filename=String(report.ticket).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80)+'-request';
  const file=format==='html'?documentHtml(report):await documentPdf(report);
  await audit(db.query,req,'request.document_generated',requestId,{format,ticketNumber:report.ticket});
  if(format==='html')return res.type('html').send(file);
  res.attachment(filename+'.pdf').type('application/pdf').send(file);
 });
 router.patch('/:id',async(req,res)=>{
  const requestId=uuidParam(req),body=parse(editRequest,req.body);
  await db.transaction(async query=>{
   const ticket=await loadTicket(query,requestId,req.user,{lock:true});assertVersion(ticket,body.version);
   validateJustification(ticket.TypeCode,body.justification);
   requireCondition(ticket.TypeCode!=='movement',403,'REQUEST_NOT_EDITABLE','Use the transfer review process to change destination access.');
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
   const ticket=await loadTicket(query,requestId,req.user,{lock:true});assertVersion(ticket,body.version);assertReview(ticket,await currentStep(query,ticket),req.user);requireCondition(hasRole(req.user,'HR')&&ticket.TypeCode==='new-user',403,'HR_ONLY');
   const people=(await query('SELECT Id FROM dbo.RequestPeople WHERE RequestId=@id',{id:p.id(requestId)})).recordset;
   requireCondition(body.checks.length===people.length&&new Set(body.checks.map(check=>check.personId)).size===people.length&&body.checks.every(check=>people.some(person=>person.Id===check.personId)),400,'HR_PEOPLE_MISMATCH');
   for(const check of body.checks)await query('UPDATE dbo.HrClearances SET ActorId=@actor,Police=@police,ReferenceCheck=@reference,Recommendation=@recommendation,UpdatedAt=SYSUTCDATETIME() WHERE PersonId=@person; IF @@ROWCOUNT=0 INSERT dbo.HrClearances(PersonId,ActorId,Police,ReferenceCheck,Recommendation) VALUES(@person,@actor,@police,@reference,@recommendation)',{actor:p.id(req.user.Id),police:p.str(check.police,30),reference:p.str(check.reference,20),recommendation:p.text(check.recommendation,2000),person:p.id(check.personId)});
   await query('UPDATE dbo.Requests SET UpdatedAt=SYSUTCDATETIME() WHERE Id=@id',{id:p.id(requestId)});await audit(query,req,'hr.clearance_updated',requestId,{checks:body.checks});
  });res.status(204).end();
 });
 const transferItems=z.array(z.object({systemId:id,systemRoleId:id.nullable().optional(),reason:text(2000)}).strict()).max(300);
 router.get('/:id/transfer-access',async(req,res)=>{
  const ticket=await loadTicket(db.query,uuidParam(req),req.user);requireCondition(ticket.TypeCode==='movement',400,'TRANSFER_ONLY');
  const inventory=await currentTransferAccess(db.query,ticket.SubjectUserId),catalogue=await transferCatalogue(db.query);
  res.json({current:inventory.rows,inventoryVersion:inventory.inventoryVersion,systems:catalogue,review:await transferReview(db.query,ticket,inventory)});
 });
 router.post('/:id/employee-review',async(req,res)=>{
  const requestId=uuidParam(req),body=parse(z.object({version,justification:text(4000),details:formJson.optional(),items:transferItems,confirmedCurrentAccess:z.literal(true),inventoryVersion:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),req.body);
  await db.transaction(async query=>{
   const ticket=await loadTicket(query,requestId,req.user,{lock:true});assertVersion(ticket,body.version);
   requireCondition(ticket.TypeCode==='movement'&&ticket.Status==='Employee review'&&ticket.SubjectUserId===req.user.Id,403,'EMPLOYEE_REVIEW_FORBIDDEN');
   const details=await saveEmployeeTransferAccess(query,req,ticket,body);
   await query("UPDATE dbo.Requests SET Status='Pending',Justification=@justification,Details=@details,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id",{justification:p.text(body.justification),details:p.json(details),id:p.id(requestId)});
   await audit(query,req,'movement.employee_reviewed',requestId);await notifyAttention(query,requestId);
  });res.status(204).end();
 });
 router.post('/:id/it-access-review',async(req,res)=>{
  const requestId=uuidParam(req),body=parse(z.object({version,items:transferItems,notes:text(2000,10)}).strict(),req.body);
  await db.transaction(async query=>{
   const ticket=await loadTicket(query,requestId,req.user,{lock:true});assertVersion(ticket,body.version);
   requireCondition(ticket.TypeCode==='movement'&&hasRole(req.user,'IT'),403,'IT_REVIEW_ONLY');
   const step=await currentStep(query,ticket);assertReview(ticket,step,req.user);requireCondition(step.Role==='IT',403,'IT_REVIEW_ONLY');
   await saveItTransferAccess(query,req,ticket,body);
  });res.status(204).end();
 });
 return router;
}
