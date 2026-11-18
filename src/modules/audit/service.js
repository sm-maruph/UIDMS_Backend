import {p} from '../../core/db.js';
export async function audit(query,req,event,entityId=null,metadata={}){
 await query('INSERT dbo.AuditEvents(ActorId,Event,EntityId,Ip,CorrelationId,Metadata) VALUES(@actor,@event,@entity,@ip,@correlation,@metadata)',{
  actor:p.id(req.user?.Id),event:p.str(event),entity:p.text(entityId,80),ip:p.str(req.ip||'local',64),correlation:p.id(req.id),metadata:p.json(metadata)
 });
}
export async function notify(query,userId,requestId,message){await query("INSERT dbo.Notifications(UserId,RequestId,Message) VALUES(@user,@request,@message); INSERT dbo.EmailOutbox(Recipient,Subject,Body) SELECT Email,N'UIDMS request update',@message FROM dbo.Users WHERE Id=@user AND Active=1",{user:p.id(userId),request:p.id(requestId),message:p.text(message,300)});}
