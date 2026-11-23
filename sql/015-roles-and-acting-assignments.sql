/* One manager per branch, one head per department, dated acting authority and Admin. */
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
IF NOT EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=11) THROW 51018,'Apply migration 014 before roles and acting assignments.',1;
IF EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=12) RETURN;
BEGIN TRANSACTION;
IF NOT EXISTS(SELECT 1 FROM dbo.PortalRoles WHERE Name=N'Admin') INSERT dbo.PortalRoles(Name) VALUES(N'Admin');
UPDATE dbo.Users SET Role=N'Admin',UpdatedAt=SYSUTCDATETIME() WHERE Role=N'Platform Admin';
CREATE TABLE dbo.RoleDelegations(
 Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
 PrincipalId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id),
 ActingUserId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id),
 Role nvarchar(40) NOT NULL REFERENCES dbo.PortalRoles(Name),
 ScopeId uniqueidentifier NULL REFERENCES dbo.Lookups(Id),
 StartsAt datetime2(3) NOT NULL,EndsAt datetime2(3) NOT NULL,
 CreatedBy uniqueidentifier NOT NULL REFERENCES dbo.Users(Id),
 CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 RevokedAt datetime2(3) NULL,RevokedBy uniqueidentifier NULL REFERENCES dbo.Users(Id),
 Version rowversion NOT NULL,
 CONSTRAINT CK_Delegation_Person CHECK(PrincipalId<>ActingUserId),
 CONSTRAINT CK_Delegation_Period CHECK(EndsAt>StartsAt),
 CONSTRAINT CK_Delegation_Role CHECK((Role IN (N'Branch manager',N'Department head') AND ScopeId IS NOT NULL) OR (Role IN ('IT','CITO') AND ScopeId IS NULL))
);
CREATE INDEX IX_Delegations_Principal ON dbo.RoleDelegations(PrincipalId,Role,ScopeId,StartsAt,EndsAt) INCLUDE(ActingUserId,RevokedAt);
CREATE INDEX IX_Delegations_Acting ON dbo.RoleDelegations(ActingUserId,StartsAt,EndsAt) INCLUDE(PrincipalId,Role,ScopeId,RevokedAt);
EXEC(N'CREATE OR ALTER FUNCTION dbo.uidms_EffectiveRoles(@user uniqueidentifier)
RETURNS TABLE AS RETURN (
 SELECT u.Role FROM dbo.Users u WHERE u.Id=@user AND u.Active=1 AND NOT EXISTS(
  SELECT 1 FROM dbo.RoleDelegations d WHERE d.PrincipalId=u.Id AND d.Role=u.Role AND d.ScopeId IS NULL AND d.RevokedAt IS NULL AND d.StartsAt<=SYSUTCDATETIME() AND d.EndsAt>SYSUTCDATETIME() AND EXISTS(SELECT 1 FROM dbo.Users acting WHERE acting.Id=d.ActingUserId AND acting.Active=1))
 UNION SELECT N''User'' FROM dbo.Users u WHERE u.Id=@user AND u.Active=1
 UNION SELECT d.Role FROM dbo.RoleDelegations d JOIN dbo.Users principal ON principal.Id=d.PrincipalId AND principal.Active=1 AND principal.Role=d.Role
 JOIN dbo.Users acting ON acting.Id=d.ActingUserId AND acting.Active=1
 WHERE d.ActingUserId=@user AND d.ScopeId IS NULL AND d.RevokedAt IS NULL AND d.StartsAt<=SYSUTCDATETIME() AND d.EndsAt>SYSUTCDATETIME()
)');
EXEC(N'CREATE OR ALTER FUNCTION dbo.uidms_ManagedScopes(@user uniqueidentifier)
RETURNS TABLE AS RETURN (
 SELECT m.ScopeId,CASE WHEN l.Kind=''branch'' THEN N''Branch manager'' ELSE N''Department head'' END AS Role,CAST(0 AS bit) AS Acting
 FROM dbo.OrganizationApprovers m JOIN dbo.Lookups l ON l.Id=m.ScopeId AND l.Active=1 WHERE m.UserId=@user
 UNION SELECT d.ScopeId,d.Role,CAST(1 AS bit) FROM dbo.RoleDelegations d JOIN dbo.Users principal ON principal.Id=d.PrincipalId AND principal.Active=1
 JOIN dbo.Users acting ON acting.Id=d.ActingUserId AND acting.Active=1 AND ((d.Role=N''Branch manager'' AND acting.BranchId=d.ScopeId) OR (d.Role=N''Department head'' AND acting.DepartmentId=d.ScopeId))
 JOIN dbo.OrganizationApprovers m ON m.ScopeId=d.ScopeId AND m.UserId=d.PrincipalId
 JOIN dbo.Lookups l ON l.Id=d.ScopeId AND l.Active=1 AND ((l.Kind=''branch'' AND d.Role=N''Branch manager'') OR (l.Kind=''department'' AND d.Role=N''Department head''))
 WHERE d.ActingUserId=@user AND d.ScopeId IS NOT NULL AND d.RevokedAt IS NULL AND d.StartsAt<=SYSUTCDATETIME() AND d.EndsAt>SYSUTCDATETIME()
)');
EXEC(N'CREATE OR ALTER FUNCTION dbo.uidms_StepReviewers(@request uniqueidentifier,@position int)
RETURNS TABLE AS RETURN (
 WITH step AS(SELECT s.*,r.RequesterId,r.SubjectUserId FROM dbo.RequestSteps s JOIN dbo.Requests r ON r.Id=s.RequestId WHERE s.RequestId=@request AND s.Position=@position),
 principals AS(
 SELECT s.AssignedUserId AS UserId FROM step s WHERE s.AssignedUserId IS NOT NULL
 UNION SELECT u.Id FROM step s JOIN dbo.Users u ON u.Role=s.Role AND (s.BranchId IS NULL OR s.BranchId=u.BranchId) AND (s.DepartmentId IS NULL OR s.DepartmentId=u.DepartmentId)
 WHERE s.AssignedUserId IS NULL
 ), delegations AS(
 SELECT d.PrincipalId,d.ActingUserId FROM step s JOIN principals p ON 1=1
 JOIN dbo.RoleDelegations d ON d.PrincipalId=p.UserId AND d.Role=s.Role AND d.RevokedAt IS NULL AND d.StartsAt<=SYSUTCDATETIME() AND d.EndsAt>SYSUTCDATETIME()
 JOIN dbo.Users principal ON principal.Id=p.UserId AND principal.Active=1
 JOIN dbo.Users acting ON acting.Id=d.ActingUserId AND acting.Active=1
 AND (d.ScopeId IS NULL OR (d.Role=N''Branch manager'' AND acting.BranchId=d.ScopeId) OR (d.Role=N''Department head'' AND acting.DepartmentId=d.ScopeId))
 WHERE ((d.ScopeId IS NULL AND s.Role IN (''IT'',''CITO'') AND principal.Role=s.Role)
 OR (d.ScopeId=COALESCE(s.BranchId,s.DepartmentId) AND EXISTS(SELECT 1 FROM dbo.OrganizationApprovers m WHERE m.ScopeId=d.ScopeId AND m.UserId=d.PrincipalId)))
 ), candidates AS(
 SELECT p.UserId FROM principals p JOIN dbo.Users u ON u.Id=p.UserId AND u.Active=1 WHERE NOT EXISTS(SELECT 1 FROM delegations d WHERE d.PrincipalId=p.UserId)
 UNION SELECT d.ActingUserId FROM delegations d
 )
 SELECT c.UserId FROM candidates c CROSS JOIN step s WHERE c.UserId<>s.RequesterId AND (s.SubjectUserId IS NULL OR c.UserId<>s.SubjectUserId)
)');
INSERT dbo.SchemaVersions(Version) VALUES(12);
COMMIT;
GO

