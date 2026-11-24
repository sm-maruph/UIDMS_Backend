/* Durable, non-credential session identifiers for audit timelines. */
USE CBC_UIDMS;
GO
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET NUMERIC_ROUNDABORT OFF;
IF NOT EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=12) THROW 51019,'Apply migration 015 before session audit tracking.',1;
IF EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=13) RETURN;
BEGIN TRANSACTION;
CREATE TABLE dbo.AuditSessions(
 Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
 UserId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id),
 EmployeeId nvarchar(40) NOT NULL,Name nvarchar(160) NOT NULL,
 Role nvarchar(40) NULL,AuthProvider varchar(10) NOT NULL,
 StartedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 LastSeenAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 ExpiresAt datetime2(3) NOT NULL,IdleMinutes int NULL,
 Ip varchar(64) NOT NULL,LastIp varchar(64) NOT NULL,UserAgent nvarchar(300) NULL,
 EndedAt datetime2(3) NULL,EndReason varchar(40) NULL,
 Source varchar(12) NOT NULL DEFAULT 'tracked' CHECK(Source IN ('tracked','migrated')),
 CHECK(IdleMinutes IS NULL OR IdleMinutes>0),CHECK(EndedAt IS NULL OR EndedAt>=StartedAt)
);
CREATE INDEX IX_AuditSessions_User ON dbo.AuditSessions(UserId,StartedAt DESC);
CREATE INDEX IX_AuditSessions_Open ON dbo.AuditSessions(ExpiresAt,LastSeenAt) INCLUDE(UserId,IdleMinutes) WHERE EndedAt IS NULL;
ALTER TABLE dbo.Sessions ADD AuditSessionId uniqueidentifier NULL;
ALTER TABLE dbo.AuditEvents ADD AuditSessionId uniqueidentifier NULL,ActorRole nvarchar(40) NULL;
CREATE TABLE #ExistingAuditSessions(TokenHash char(64) COLLATE DATABASE_DEFAULT PRIMARY KEY,AuditId uniqueidentifier NOT NULL);
INSERT #ExistingAuditSessions SELECT TokenHash,NEWID() FROM dbo.Sessions;
INSERT dbo.AuditSessions(Id,UserId,EmployeeId,Name,AuthProvider,StartedAt,LastSeenAt,ExpiresAt,Ip,LastIp,UserAgent,EndedAt,EndReason,Source)
 SELECT x.AuditId,s.UserId,u.EmployeeId,u.Name,s.AuthProvider,s.CreatedAt,s.LastSeenAt,s.ExpiresAt,s.Ip,s.Ip,s.UserAgent,s.RevokedAt,CASE WHEN s.RevokedAt IS NOT NULL THEN 'revoked' END,'migrated'
 FROM #ExistingAuditSessions x JOIN dbo.Sessions s ON s.TokenHash=x.TokenHash JOIN dbo.Users u ON u.Id=s.UserId;
EXEC(N'UPDATE s SET AuditSessionId=x.AuditId FROM dbo.Sessions s JOIN #ExistingAuditSessions x ON x.TokenHash=s.TokenHash');
EXEC(N'ALTER TABLE dbo.Sessions ADD CONSTRAINT FK_Session_AuditSession FOREIGN KEY(AuditSessionId) REFERENCES dbo.AuditSessions(Id)');
EXEC(N'ALTER TABLE dbo.AuditEvents ADD CONSTRAINT FK_AuditEvent_Session FOREIGN KEY(AuditSessionId) REFERENCES dbo.AuditSessions(Id)');
EXEC(N'CREATE UNIQUE INDEX UX_Sessions_AuditSession ON dbo.Sessions(AuditSessionId) WHERE AuditSessionId IS NOT NULL');
EXEC(N'CREATE INDEX IX_AuditEvents_Session ON dbo.AuditEvents(AuditSessionId,CreatedAt,Id) INCLUDE(Event,ActorId,EntityId,Ip,ActorRole)');
CREATE INDEX IX_AuditEvents_Actor ON dbo.AuditEvents(ActorId,Id) INCLUDE(Event,CreatedAt,CorrelationId);
DROP TABLE #ExistingAuditSessions;
INSERT dbo.SchemaVersions(Version) VALUES(13);
COMMIT;
GO
