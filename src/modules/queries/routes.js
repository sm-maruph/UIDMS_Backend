import {Router} from 'express';
import {p} from '../../core/db.js';
import {z,id,text,parse,uuidParam,pageSchema} from '../../core/validation.js';
import {requireCondition} from '../../core/errors.js';
import {loadTicket,currentStep} from '../requests/repository.js';
import {assertReview,assertVersion} from '../requests/policy.js';
import {version} from '../requests/schemas.js';
import {audit,notify} from '../audit/service.js';

export function queryRoutes(db){
 const router=Router();
 router.get('/',async(req,res)=>{
  const filter=parse(pageSchema.extend({scope:z.enum(['query','response','all']).default('all')}).strict(),req.query);
  const scope={query:'q.RecipientId=@user',response:'q.AuthorId=@user',all:'(q.AuthorId=@user OR q.RecipientId=@user)'}[filter.scope];
  const result=await db.query(`SELECT COUNT(*) AS Total FROM dbo.Queries q JOIN dbo.Requests r ON r.Id=q.RequestId WHERE ${scope} AND r.DeletedAt IS NULL;
   SELECT q.Id,q.RequestId,r.TicketNumber,q.AuthorId,a.Name AS AuthorName,a.Role AS AuthorRole,a.EmployeeId AS AuthorEmployeeId,q.RecipientId,b.Name AS RecipientName,b.EmployeeId AS RecipientEmployeeId,q.Message,q.CreatedAt,q.ResolvedAt,qr.Message AS Response,qr.CreatedAt AS ResponseAt,r.Version FROM dbo.Queries q JOIN dbo.Requests r ON r.Id=q.RequestId JOIN dbo.Users a ON a.Id=q.AuthorId JOIN dbo.Users b ON b.Id=q.RecipientId LEFT JOIN dbo.QueryResponses qr ON qr.QueryId=q.Id WHERE ${scope} AND r.DeletedAt IS NULL ORDER BY q.CreatedAt DESC,q.Id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`,{user:p.id(req.user.Id),offset:p.int((filter.page-1)*filter.pageSize),size:p.int(filter.pageSize)});
  res.json({items:result.recordsets[1].map(row=>({...row,Version:row.Version.toString('hex')})),total:result.recordsets[0][0].Total,page:filter.page,pageSize:filter.pageSize});
 });
 router.post('/:id/reply',async(req,res)=>{
  const queryId=uuidParam(req);const body=parse(z.object({message:text(4000),version}).strict(),req.body);
  await db.transaction(async query=>{
   const row=(await query('SELECT * FROM dbo.Queries WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id AND RecipientId=@user AND ResolvedAt IS NULL',{id:p.id(queryId),user:p.id(req.user.Id)})).recordset[0];
   requireCondition(row,404,'QUERY_NOT_FOUND');
   const ticket=await loadTicket(query,row.RequestId,req.user,{lock:true});assertVersion(ticket,body.version);requireCondition(ticket.Status==='Query',409,'QUERY_CLOSED');
   await query('INSERT dbo.QueryResponses(QueryId,AuthorId,Message) VALUES(@id,@user,@message); UPDATE dbo.Queries SET ResolvedAt=SYSUTCDATETIME() WHERE Id=@id; UPDATE dbo.Requests SET Status=@status,UpdatedAt=SYSUTCDATETIME() WHERE Id=@request',{id:p.id(queryId),user:p.id(req.user.Id),message:p.text(body.message),status:p.str(row.ReturnStatus,30),request:p.id(ticket.Id)});
   await audit(query,req,'query.replied',queryId,{requestId:ticket.Id});await notify(query,row.AuthorId,ticket.Id,`${ticket.TicketNumber}: query response received.`);
  });res.status(204).end();
 });
 return router;
}
export async function raiseQuery(db,req,requestId){
 const body=parse(z.object({recipientId:id,message:text(350),version}).strict(),req.body);
 return db.transaction(async query=>{
  const ticket=await loadTicket(query,requestId,req.user,{lock:true});assertVersion(ticket,body.version);
  const step=await currentStep(query,ticket);assertReview(ticket,step,req.user);
  const recipient=(await query(`SELECT u.Id FROM dbo.Users u WHERE u.Id=@recipient AND u.Active=1 AND u.Id<>@actor AND (u.Id=@requester OR u.Id=@subject OR EXISTS(SELECT 1 FROM dbo.RequestSteps s WHERE s.RequestId=@request AND s.Position<@position AND (s.ActorId=u.Id OR (s.Role=u.Role AND (s.BranchId IS NULL OR s.BranchId=u.BranchId) AND (s.DepartmentId IS NULL OR s.DepartmentId=u.DepartmentId)))) OR (u.Role='HR' AND EXISTS(SELECT 1 FROM dbo.RequestSteps s WHERE s.RequestId=@request AND s.Role='HR')))`,{recipient:p.id(body.recipientId),actor:p.id(req.user.Id),requester:p.id(ticket.RequesterId),subject:p.id(ticket.SubjectUserId),request:p.id(ticket.Id),position:p.int(ticket.CurrentPosition)})).recordset[0];
  requireCondition(recipient,400,'INVALID_QUERY_RECIPIENT','Choose the requester or an eligible participant in this workflow.');
  const row=(await query('INSERT dbo.Queries(RequestId,AuthorId,RecipientId,Message,ReturnStatus) OUTPUT inserted.Id VALUES(@request,@actor,@recipient,@message,@status)',{request:p.id(ticket.Id),actor:p.id(req.user.Id),recipient:p.id(body.recipientId),message:p.text(body.message,350),status:p.str(ticket.Status,30)})).recordset[0];
  await query("UPDATE dbo.Requests SET Status='Query',UpdatedAt=SYSUTCDATETIME() WHERE Id=@id",{id:p.id(ticket.Id)});
  await audit(query,req,'query.raised',row.Id,{requestId:ticket.Id,recipientId:body.recipientId});await notify(query,body.recipientId,ticket.Id,`${ticket.TicketNumber}: a query needs your response.`);
  return {id:row.Id};
 });
}
