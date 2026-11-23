/* Assign branch managers and department heads without changing portal roles. */
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
IF NOT EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=10)
 THROW 51017,'Apply migration 013 before organization approver assignments.',1;
IF EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=11) RETURN;
BEGIN TRANSACTION;
CREATE TABLE dbo.OrganizationApprovers(
 ScopeId uniqueidentifier NOT NULL PRIMARY KEY REFERENCES dbo.Lookups(Id),
 UserId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id),
 UpdatedBy uniqueidentifier NULL REFERENCES dbo.Users(Id),
 CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 UpdatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 Version rowversion NOT NULL
);
CREATE INDEX IX_OrganizationApprovers_User ON dbo.OrganizationApprovers(UserId);
ALTER TABLE dbo.RequestSteps ADD AssignedUserId uniqueidentifier NULL REFERENCES dbo.Users(Id);
EXEC(N'CREATE INDEX IX_RequestSteps_Assignee ON dbo.RequestSteps(AssignedUserId,RequestId)');
INSERT dbo.OrganizationApprovers(ScopeId,UserId)
 SELECT candidate.ScopeId,MIN(CONVERT(char(36),candidate.Id)) FROM (
 SELECT u.Id,CASE WHEN u.Role=N'Branch manager' THEN u.BranchId ELSE u.DepartmentId END AS ScopeId
 FROM dbo.Users u WHERE u.Active=1 AND u.Role IN (N'Branch manager',N'Department head')
 ) candidate WHERE candidate.ScopeId IS NOT NULL GROUP BY candidate.ScopeId HAVING COUNT(*)=1;
EXEC(N'UPDATE s SET AssignedUserId=a.UserId FROM dbo.RequestSteps s
 JOIN dbo.Requests r ON r.Id=s.RequestId
 JOIN dbo.OrganizationApprovers a ON a.ScopeId=CASE WHEN s.Role=N''Branch manager'' THEN s.BranchId WHEN s.Role=N''Department head'' THEN s.DepartmentId END
 WHERE s.Status=''Waiting'' AND r.DeletedAt IS NULL AND r.Status IN (''Employee review'',''Pending'',''In review'',''Query'')');
INSERT dbo.SchemaVersions(Version) VALUES(11);
COMMIT;
GO
