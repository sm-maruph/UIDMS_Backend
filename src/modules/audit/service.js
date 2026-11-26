import {p} from '../../core/db.js';
export async function audit(query,req,event,entityId=null,metadata={}){
 await query('INSERT dbo.AuditEvents(ActorId,Event,EntityId,Ip,CorrelationId,Metadata,AuditSessionId,ActorRole) VALUES(@actor,@event,@entity,@ip,@correlation,@metadata,@auditSession,@actorRole)',{
  actor:p.id(req.user?.Id),event:p.str(event),entity:p.text(entityId,80),ip:p.str(req.ip||'local',64),correlation:p.id(req.id),metadata:p.json(metadata),auditSession:p.id(req.auditSessionId),actorRole:p.text(req.user?.Role,40)
 });
}
export async function notify(query,userId,requestId,message){await query(`INSERT dbo.Notifications(UserId,RequestId,Message) VALUES(@user,@request,@message);
 INSERT dbo.EmailOutbox(Recipient,Subject,Body)
 SELECT u.Email,N'UIDMS request update',
  (SELECT N'uidms-notification-v1' AS format,@user AS recipientUserId,r.Id AS requestId,
   r.TicketNumber AS reference,r.TypeCode AS typeCode,rt.Name AS requestType,requester.Name AS requesterName,
   requester.EmployeeId AS requesterEmployeeId,r.Status AS status,@message AS action,
   (SELECT STRING_AGG(op.Operation,', ') FROM (SELECT DISTINCT Operation FROM dbo.RequestItems WHERE RequestId=r.Id) op) AS actionType,
   b.Name AS branch,d.Name AS department FOR JSON PATH,WITHOUT_ARRAY_WRAPPER)
 FROM dbo.Users u JOIN dbo.Requests r ON r.Id=@request
 JOIN dbo.RequestTypes rt ON rt.Code=r.TypeCode JOIN dbo.Users requester ON requester.Id=r.RequesterId
 LEFT JOIN dbo.Lookups b ON b.Id=r.BranchId LEFT JOIN dbo.Lookups d ON d.Id=r.DepartmentId
 WHERE u.Id=@user AND u.Active=1 AND u.Email IS NOT NULL AND u.Email<>N'' AND r.DeletedAt IS NULL`,{user:p.id(userId),request:p.id(requestId),message:p.text(message,300)});}
