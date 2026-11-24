import {p} from '../../core/db.js';

const emitEnded=`INSERT dbo.AuditEvents(ActorId,Event,EntityId,Ip,CreatedAt,Metadata,AuditSessionId,ActorRole,CorrelationId)
 SELECT UserId,'auth.session_ended',CONVERT(nvarchar(80),Id),LastIp,EndedAt,
 (SELECT EndReason AS reason,CAST(1 AS bit) AS serverGenerated FOR JSON PATH,WITHOUT_ARRAY_WRAPPER),Id,Role,NEWID() FROM @closed;`;
export async function finalizeAuditSessions(query,config,userId=null){
 await query(`DECLARE @closed TABLE(Id uniqueidentifier,UserId uniqueidentifier,LastIp varchar(64),EndedAt datetime2(3),EndReason varchar(40),Role nvarchar(40));
 UPDATE a SET EndedAt=ending.At,EndReason=ending.Reason
 OUTPUT inserted.Id,inserted.UserId,inserted.LastIp,inserted.EndedAt,inserted.EndReason,inserted.Role INTO @closed
 FROM dbo.AuditSessions a LEFT JOIN dbo.Sessions s ON s.AuditSessionId=a.Id JOIN dbo.Users u ON u.Id=a.UserId
 CROSS APPLY(SELECT TOP(1) candidate.At,candidate.Reason FROM(VALUES
  (s.RevokedAt,'revoked'),(a.ExpiresAt,'expired'),(DATEADD(minute,COALESCE(a.IdleMinutes,@idle),a.LastSeenAt),'idle_timeout'),
  (CASE WHEN u.Active=0 THEN SYSUTCDATETIME() END,'account_disabled')
 ) candidate(At,Reason) WHERE candidate.At IS NOT NULL AND candidate.At<=SYSUTCDATETIME() ORDER BY candidate.At,candidate.Reason) ending
 WHERE a.EndedAt IS NULL AND (@user IS NULL OR a.UserId=@user);
 ${emitEnded}`,{idle:p.int(config.SESSION_IDLE_MINUTES),user:p.id(userId)});
}
export async function closeAuditSessions(query,{userId=null,sessionId=null,reason='revoked',recordEvent=true}={}){
 await query(`DECLARE @closed TABLE(Id uniqueidentifier,UserId uniqueidentifier,LastIp varchar(64),EndedAt datetime2(3),EndReason varchar(40),Role nvarchar(40));
 UPDATE dbo.AuditSessions SET EndedAt=SYSUTCDATETIME(),EndReason=@reason
 OUTPUT inserted.Id,inserted.UserId,inserted.LastIp,inserted.EndedAt,inserted.EndReason,inserted.Role INTO @closed
 WHERE EndedAt IS NULL AND ((@session IS NOT NULL AND Id=@session) OR (@session IS NULL AND @user IS NOT NULL AND UserId=@user));
 ${recordEvent?emitEnded:''}`,{session:p.id(sessionId),user:p.id(userId),reason:p.str(reason,40)});
}
