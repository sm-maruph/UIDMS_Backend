import {p} from '../../core/db.js';
import {requireCondition} from '../../core/errors.js';
import {audit} from '../audit/service.js';
import {sessionWindow,sessionLifetimeMinutes,sessionHardLimitHours} from './session-window.js';

export async function renewSession(db,req,config){
 return db.transaction(async query=>{
  const result=await query(`UPDATE s SET ExpiresAt=CASE
   WHEN DATEADD(minute,@minutes,SYSUTCDATETIME())<DATEADD(hour,@hours,s.CreatedAt)
    THEN DATEADD(minute,@minutes,SYSUTCDATETIME()) ELSE DATEADD(hour,@hours,s.CreatedAt) END,
   LastSeenAt=SYSUTCDATETIME()
   OUTPUT inserted.CreatedAt AS AuthenticatedAt,inserted.LastSeenAt AS SessionLastSeenAt,inserted.ExpiresAt AS SessionExpiresAt
   FROM dbo.Sessions s JOIN dbo.Users u ON u.Id=s.UserId
   WHERE s.TokenHash=@hash AND s.UserId=@user AND u.Active=1 AND s.RevokedAt IS NULL
    AND s.ExpiresAt>SYSUTCDATETIME() AND s.LastSeenAt>DATEADD(minute,-@idle,SYSUTCDATETIME())
    AND DATEADD(hour,@hours,s.CreatedAt)>SYSUTCDATETIME();
   UPDATE a SET ExpiresAt=s.ExpiresAt,LastSeenAt=s.LastSeenAt
   FROM dbo.AuditSessions a JOIN dbo.Sessions s ON s.AuditSessionId=a.Id
   WHERE s.TokenHash=@hash AND s.RevokedAt IS NULL AND a.EndedAt IS NULL`,{
    hash:p.str(req.sessionHash,64),user:p.id(req.user.Id),minutes:p.int(sessionLifetimeMinutes(config)),hours:p.int(sessionHardLimitHours(config)),idle:p.int(config.SESSION_IDLE_MINUTES)
   });
  const row=result.recordset?.[0];requireCondition(row,401,'SESSION_EXPIRED');
  await audit(query,req,'auth.session_continued',req.user.Id);
  return sessionWindow(row,config);
 });
}
