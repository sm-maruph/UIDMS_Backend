/* Run in SSMS as the database administrator. Review preview, then set @ApplyChanges=1.
   Keeps other existing departments; merges only case/spacing duplicates, not guessed aliases.
   ReferenceCode values are report-only; existing UIDMS GUID IDs are preserved.
   Requires migrations 014 and 015. No schema version or login/password changes.
*/
USE CBC_UIDMS;
GO
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET NUMERIC_ROUNDABORT OFF;
DECLARE @ApplyChanges bit=0; -- 0: preview and ROLLBACK; 1: apply and COMMIT.
BEGIN TRY
 BEGIN TRANSACTION;
 DECLARE @LockCount int;
 SELECT @LockCount=COUNT(*) FROM dbo.Lookups WITH(TABLOCKX,HOLDLOCK);
 CREATE TABLE #Wanted(ReferenceCode int NOT NULL UNIQUE,Name nvarchar(150) COLLATE DATABASE_DEFAULT NOT NULL,NameKey nvarchar(150) COLLATE Latin1_General_100_CI_AS NULL);
 INSERT #Wanted(ReferenceCode,Name) VALUES
 (2019,N'Admin'),
 (4025,N'AML & CFT'),
 (4021,N'Auditor'),
 (7,N'Branch Operation'),
 (4026,N'Call Center'),
 (18,N'Card Center'),
 (2,N'Central Clearing'),
 (4031,N'Centralized Payment Processing'),
 (4032,N'CEO''S Office'),
 (3,N'Compliance'),
 (4033,N'COO''S OFFICE'),
 (4,N'Corporate Banking'),
 (4043,N'Corporate Management'),
 (4034,N'Corporate Remittance'),
 (5,N'Credit Administration'),
 (6,N'CRR'),
 (4035,N'Custodian Services'),
 (1,N'Customer Service'),
 (4036,N'Dhaka Offshore Banking Unit'),
 (8,N'Digital Banking'),
 (4044,N'Digital Banking and card center'),
 (9,N'Finance & Accounts'),
 (4028,N'Head Office All Department'),
 (10,N'HR'),
 (11,N'ICC'),
 (12,N'Integrated Risk Management'),
 (3020,N'ISB'),
 (13,N'IT Department'),
 (4037,N'Legal and Recovery Department'),
 (4024,N'Liability Marketing'),
 (4027,N'Marketing and Brand Building'),
 (14,N'Operations and Logistics'),
 (4038,N'Personal Banking'),
 (4022,N'Priority'),
 (4039,N'Procurement and Logistic'),
 (4023,N'RCU & SME'),
 (4040,N'Retail Credit Unit'),
 (4041,N'Security and Safety'),
 (4042,N'SME Financing Unit'),
 (4029,N'Sustainability and Woman Banking'),
 (15,N'Trade Finance'),
 (16,N'Treasury Back Office'),
 (17,N'Treasury Front Office');
 CREATE TABLE #Departments(Id uniqueidentifier PRIMARY KEY,Name nvarchar(150) COLLATE DATABASE_DEFAULT,Active bit,NameKey nvarchar(150) COLLATE Latin1_General_100_CI_AS);
 INSERT #Departments SELECT Id,Name,Active,Name FROM dbo.Lookups WHERE Kind='department';
 UPDATE #Departments SET NameKey=LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(REPLACE(NameKey,NCHAR(160),N' '),CHAR(9),N' '),CHAR(13),N' '),CHAR(10),N' ')));
 WHILE EXISTS(SELECT 1 FROM #Departments WHERE CHARINDEX(N'  ',NameKey)>0)
  UPDATE #Departments SET NameKey=REPLACE(NameKey,N'  ',N' ');
 UPDATE #Wanted SET NameKey=Name;
 IF EXISTS(SELECT 1 FROM #Departments WHERE NameKey=N'') THROW 51130,'A department has an empty name. Correct it before merging departments.',1;
 CREATE TABLE #Plan(Id uniqueidentifier PRIMARY KEY,KeepId uniqueidentifier,OldName nvarchar(150),FinalName nvarchar(150) COLLATE DATABASE_DEFAULT,Active bit);
 INSERT #Plan
 SELECT b.Id,FIRST_VALUE(b.Id) OVER(PARTITION BY b.NameKey ORDER BY
   CASE WHEN b.Name COLLATE Latin1_General_100_BIN2=w.Name COLLATE Latin1_General_100_BIN2 THEN 0 ELSE 1 END,b.Active DESC,CONVERT(char(36),b.Id)),
   b.Name,COALESCE(w.Name,b.NameKey),b.Active
 FROM #Departments b LEFT JOIN #Wanted w ON w.NameKey=b.NameKey;
 /* Never silently choose a department head when duplicate scopes disagree. */
 IF EXISTS(SELECT p.KeepId FROM #Plan p JOIN dbo.OrganizationApprovers a WITH(UPDLOCK,HOLDLOCK) ON a.ScopeId=p.Id
   GROUP BY p.KeepId HAVING COUNT(DISTINCT CONVERT(char(36),a.UserId))>1)
 BEGIN
  SELECT p.FinalName AS Department,p.OldName,a.UserId,u.EmployeeId,u.Name AS DepartmentHead
  FROM #Plan p JOIN dbo.OrganizationApprovers a ON a.ScopeId=p.Id JOIN dbo.Users u ON u.Id=a.UserId
  WHERE p.KeepId IN(SELECT p2.KeepId FROM #Plan p2 JOIN dbo.OrganizationApprovers a2 ON a2.ScopeId=p2.Id GROUP BY p2.KeepId HAVING COUNT(DISTINCT CONVERT(char(36),a2.UserId))>1);
  THROW 51131,'Duplicate departments have different department heads. Resolve the reported assignments first. No changes saved.',1;
 END;
 /* Reject newly overlapping leave cover for different people after merging scopes. */
 IF EXISTS(SELECT 1 FROM dbo.RoleDelegations a WITH(UPDLOCK,HOLDLOCK) JOIN #Plan pa ON pa.Id=a.ScopeId
   JOIN dbo.RoleDelegations b WITH(UPDLOCK,HOLDLOCK) ON b.PrincipalId=a.PrincipalId AND b.Role=a.Role AND b.ScopeId<>a.ScopeId
    AND b.ActingUserId<>a.ActingUserId AND b.StartsAt<a.EndsAt AND a.StartsAt<b.EndsAt
   JOIN #Plan pb ON pb.Id=b.ScopeId AND pb.KeepId=pa.KeepId
   WHERE a.RevokedAt IS NULL AND b.RevokedAt IS NULL AND a.EndsAt>SYSUTCDATETIME() AND b.EndsAt>SYSUTCDATETIME())
  THROW 51132,'Duplicate departments have conflicting acting appointments. Resolve leave cover first. No changes saved.',1;
 /* Retain the sole agreed department head even if only a duplicate has an assignment. */
 INSERT dbo.OrganizationApprovers(ScopeId,UserId,UpdatedBy,CreatedAt,UpdatedAt)
 SELECT p.KeepId,a.UserId,a.UpdatedBy,a.CreatedAt,a.UpdatedAt
 FROM #Plan p JOIN dbo.OrganizationApprovers a ON a.ScopeId=p.Id
 WHERE p.Id<>p.KeepId AND NOT EXISTS(SELECT 1 FROM dbo.OrganizationApprovers k WHERE k.ScopeId=p.KeepId)
 AND p.Id=(SELECT TOP(1) p2.Id FROM #Plan p2 JOIN dbo.OrganizationApprovers a2 ON a2.ScopeId=p2.Id WHERE p2.KeepId=p.KeepId ORDER BY CONVERT(char(36),p2.Id));
 DELETE a FROM dbo.OrganizationApprovers a JOIN #Plan p ON p.Id=a.ScopeId WHERE p.Id<>p.KeepId;
 /* Remap every declared FK, including users, request/destination departments,
    request people/steps and acting scopes. Unexpected constraints abort atomically. */
 DECLARE @Schema sysname,@Table sysname,@Column sysname,@Sql nvarchar(max);
 DECLARE DepartmentReferences CURSOR LOCAL FAST_FORWARD FOR
 SELECT OBJECT_SCHEMA_NAME(f.parent_object_id),OBJECT_NAME(f.parent_object_id),c.name
 FROM sys.foreign_key_columns f JOIN sys.columns c ON c.object_id=f.parent_object_id AND c.column_id=f.parent_column_id
 WHERE f.referenced_object_id=OBJECT_ID(N'dbo.Lookups') AND f.parent_object_id<>OBJECT_ID(N'dbo.OrganizationApprovers');
 OPEN DepartmentReferences;
 FETCH NEXT FROM DepartmentReferences INTO @Schema,@Table,@Column;
 WHILE @@FETCH_STATUS=0
 BEGIN
  SET @Sql=N'UPDATE r SET '+QUOTENAME(@Column)+N'=p.KeepId FROM '+QUOTENAME(@Schema)+N'.'+QUOTENAME(@Table)+N' r JOIN #Plan p ON p.Id=r.'+QUOTENAME(@Column)+N' WHERE p.Id<>p.KeepId;';
  EXEC sys.sp_executesql @Sql;
  FETCH NEXT FROM DepartmentReferences INTO @Schema,@Table,@Column;
 END;
 CLOSE DepartmentReferences;
 DEALLOCATE DepartmentReferences;
 DELETE l FROM dbo.Lookups l JOIN #Plan p ON p.Id=l.Id WHERE p.Id<>p.KeepId;
 UPDATE l SET Name=p.FinalName,Active=CASE WHEN EXISTS(SELECT 1 FROM #Wanted w WHERE w.Name=p.FinalName) THEN 1
   ELSE (SELECT MAX(CONVERT(int,p2.Active)) FROM #Plan p2 WHERE p2.KeepId=p.Id) END
 FROM dbo.Lookups l JOIN #Plan p ON p.Id=l.Id AND p.KeepId=p.Id
 WHERE l.Name COLLATE Latin1_General_100_BIN2<>p.FinalName COLLATE Latin1_General_100_BIN2 OR l.Active=0;
 INSERT dbo.Lookups(Kind,Name,Active)
 SELECT 'department',w.Name,1 FROM #Wanted w WHERE NOT EXISTS(SELECT 1 FROM dbo.Lookups l WHERE l.Kind='department' AND l.Name=w.Name);
 DECLARE @NewCount int=@@ROWCOUNT;
 IF (SELECT COUNT(*) FROM #Wanted w JOIN dbo.Lookups l ON l.Kind='department' AND l.Name=w.Name AND l.Active=1)<>43
  THROW 51133,'Department verification failed. No changes saved.',1;
 DECLARE @Audit nvarchar(max)=(SELECT @NewCount AS added,JSON_QUERY((SELECT Id AS oldId,KeepId AS retainedId,OldName,FinalName FROM #Plan WHERE Id<>KeepId FOR JSON PATH)) AS merged FOR JSON PATH,WITHOUT_ARRAY_WRAPPER);
 INSERT dbo.AuditEvents(ActorId,Event,EntityId,Ip,CorrelationId,Metadata)
 VALUES(NULL,'organization.departments_synchronized',N'department',N'local-sql',NEWID(),@Audit);
 SELECT CASE WHEN @ApplyChanges=1 THEN 'APPLY' ELSE 'PREVIEW ONLY - WILL ROLLBACK' END AS Mode,@NewCount AS Added,(SELECT COUNT(*) FROM #Plan WHERE Id<>KeepId) AS DuplicatesMerged;
 SELECT OldName,FinalName,Id AS OldId,KeepId AS RetainedId FROM #Plan WHERE Id<>KeepId ORDER BY FinalName;
 SELECT w.ReferenceCode,l.Id AS UidmsId,l.Name,l.Active FROM dbo.Lookups l JOIN #Wanted w ON w.Name=l.Name WHERE l.Kind='department' ORDER BY l.Name;
 IF @ApplyChanges=1 COMMIT TRANSACTION; ELSE ROLLBACK TRANSACTION;
 DROP TABLE IF EXISTS #Plan; DROP TABLE IF EXISTS #Departments; DROP TABLE IF EXISTS #Wanted;
END TRY
BEGIN CATCH
 IF CURSOR_STATUS('local','DepartmentReferences')>=0 CLOSE DepartmentReferences;
 IF CURSOR_STATUS('local','DepartmentReferences')>=-1 DEALLOCATE DepartmentReferences;
 IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
 THROW;
END CATCH;
GO
