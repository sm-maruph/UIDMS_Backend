import {p} from '../../core/db.js';
export async function audit(query,req,event,entityId=null,metadata={}){
 await query('INSERT dbo.AuditEvents(ActorId,Event,EntityId,Ip,CorrelationId,Metadata,AuditSessionId,ActorRole) VALUES(@actor,@event,@entity,@ip,@correlation,@metadata,@auditSession,@actorRole)',{
  actor:p.id(req.user?.Id),event:p.str(event),entity:p.text(entityId,80),ip:p.str(req.ip||'local',64),correlation:p.id(req.id),metadata:p.json(metadata),auditSession:p.id(req.auditSessionId),actorRole:p.text(req.user?.Role,40)
 });
}
export async function notify(query,userId,requestId,message){await query("INSERT dbo.Notifications(UserId,RequestId,Message) VALUES(@user,@request,@message); INSERT dbo.EmailOutbox(Recipient,Subject,Body) SELECT Email,N'UIDMS request update',@message FROM dbo.Users WHERE Id=@user AND Active=1 AND Email IS NOT NULL AND Email<>N''",{user:p.id(userId),request:p.id(requestId),message:p.text(message,300)});}
