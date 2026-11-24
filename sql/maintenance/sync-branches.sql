/* Run in SSMS as the database administrator. Review preview, then set @ApplyChanges=1.
   Keeps other existing branches; merges only case/spacing duplicates, not guessed aliases.
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
 CREATE TABLE #Wanted(Name nvarchar(150) COLLATE DATABASE_DEFAULT NOT NULL,NameKey nvarchar(150) COLLATE Latin1_General_100_CI_AS NULL);
 INSERT #Wanted(Name) VALUES
 (N'Agrabad Branch'),(N'CEPZ Sub Branch'),(N'Corporate Branch'),
 (N'DEPZ Sub Branch'),(N'Dhanmondi Branch'),(N'Gulshan Branch'),
 (N'Head Office BD'),(N'Mirpur Branch'),(N'Motijheel Branch'),
 (N'Narayanganj Branch'),(N'Panthapath Branch'),(N'SME CDA Avenue'),
 (N'SME Jubilee Road'),(N'SME Old Dhaka'),(N'SME Pragati Sharani'),
 (N'SME Shantinagar'),(N'SME Tongi'),(N'Sylhet Branch'),
 (N'Tejgaon Branch'),(N'US Embassy Sub Branch'),(N'Uttara Branch');
 CREATE TABLE #Branches(Id uniqueidentifier PRIMARY KEY,Name nvarchar(150) COLLATE DATABASE_DEFAULT,Active bit,NameKey nvarchar(150) COLLATE Latin1_General_100_CI_AS);
 INSERT #Branches SELECT Id,Name,Active,Name FROM dbo.Lookups WHERE Kind='branch';
 UPDATE #Branches SET NameKey=LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(REPLACE(NameKey,NCHAR(160),N' '),CHAR(9),N' '),CHAR(13),N' '),CHAR(10),N' ')));
 WHILE EXISTS(SELECT 1 FROM #Branches WHERE CHARINDEX(N'  ',NameKey)>0)
  UPDATE #Branches SET NameKey=REPLACE(NameKey,N'  ',N' ');
 UPDATE #Wanted SET NameKey=Name;
 IF EXISTS(SELECT 1 FROM #Branches WHERE NameKey=N'') THROW 51120,'A branch has an empty name. Correct it before merging branches.',1;
 CREATE TABLE #Plan(Id uniqueidentifier PRIMARY KEY,KeepId uniqueidentifier,OldName nvarchar(150),FinalName nvarchar(150) COLLATE DATABASE_DEFAULT,Active bit);
 INSERT #Plan
 SELECT b.Id,FIRST_VALUE(b.Id) OVER(PARTITION BY b.NameKey ORDER BY
   CASE WHEN b.Name COLLATE Latin1_General_100_BIN2=w.Name COLLATE Latin1_General_100_BIN2 THEN 0 ELSE 1 END,b.Active DESC,CONVERT(char(36),b.Id)),
   b.Name,COALESCE(w.Name,b.NameKey),b.Active
 FROM #Branches b LEFT JOIN #Wanted w ON w.NameKey=b.NameKey;
 /* Never silently choose a manager when duplicate scopes disagree. */
 IF EXISTS(SELECT p.KeepId FROM #Plan p JOIN dbo.OrganizationApprovers a WITH(UPDLOCK,HOLDLOCK) ON a.ScopeId=p.Id
   GROUP BY p.KeepId HAVING COUNT(DISTINCT CONVERT(char(36),a.UserId))>1)
 BEGIN
  SELECT p.FinalName AS Branch,p.OldName,a.UserId,u.EmployeeId,u.Name AS Manager
  FROM #Plan p JOIN dbo.OrganizationApprovers a ON a.ScopeId=p.Id JOIN dbo.Users u ON u.Id=a.UserId
  WHERE p.KeepId IN(SELECT p2.KeepId FROM #Plan p2 JOIN dbo.OrganizationApprovers a2 ON a2.ScopeId=p2.Id GROUP BY p2.KeepId HAVING COUNT(DISTINCT CONVERT(char(36),a2.UserId))>1);
  THROW 51121,'Duplicate branches have different managers. Resolve the reported assignments first. No changes saved.',1;
 END;
 /* Reject newly overlapping leave cover for different people after merging scopes. */
 IF EXISTS(SELECT 1 FROM dbo.RoleDelegations a WITH(UPDLOCK,HOLDLOCK) JOIN #Plan pa ON pa.Id=a.ScopeId
   JOIN dbo.RoleDelegations b WITH(UPDLOCK,HOLDLOCK) ON b.PrincipalId=a.PrincipalId AND b.Role=a.Role AND b.ScopeId<>a.ScopeId
    AND b.ActingUserId<>a.ActingUserId AND b.StartsAt<a.EndsAt AND a.StartsAt<b.EndsAt
   JOIN #Plan pb ON pb.Id=b.ScopeId AND pb.KeepId=pa.KeepId
   WHERE a.RevokedAt IS NULL AND b.RevokedAt IS NULL AND a.EndsAt>SYSUTCDATETIME() AND b.EndsAt>SYSUTCDATETIME())
  THROW 51122,'Duplicate branches have conflicting acting appointments. Resolve leave cover first. No changes saved.',1;
 /* Retain the sole agreed manager even if only a duplicate has an assignment. */
 INSERT dbo.OrganizationApprovers(ScopeId,UserId,UpdatedBy,CreatedAt,UpdatedAt)
 SELECT p.KeepId,a.UserId,a.UpdatedBy,a.CreatedAt,a.UpdatedAt
 FROM #Plan p JOIN dbo.OrganizationApprovers a ON a.ScopeId=p.Id
 WHERE p.Id<>p.KeepId AND NOT EXISTS(SELECT 1 FROM dbo.OrganizationApprovers k WHERE k.ScopeId=p.KeepId)
 AND p.Id=(SELECT TOP(1) p2.Id FROM #Plan p2 JOIN dbo.OrganizationApprovers a2 ON a2.ScopeId=p2.Id WHERE p2.KeepId=p.KeepId ORDER BY CONVERT(char(36),p2.Id));
 DELETE a FROM dbo.OrganizationApprovers a JOIN #Plan p ON p.Id=a.ScopeId WHERE p.Id<>p.KeepId;
 /* Remap every declared FK, including users, request/destination branches,
    request people/steps and acting scopes. Unexpected constraints abort atomically. */
 DECLARE @Schema sysname,@Table sysname,@Column sysname,@Sql nvarchar(max);
 DECLARE BranchReferences CURSOR LOCAL FAST_FORWARD FOR
 SELECT OBJECT_SCHEMA_NAME(f.parent_object_id),OBJECT_NAME(f.parent_object_id),c.name
 FROM sys.foreign_key_columns f JOIN sys.columns c ON c.object_id=f.parent_object_id AND c.column_id=f.parent_column_id
 WHERE f.referenced_object_id=OBJECT_ID(N'dbo.Lookups') AND f.parent_object_id<>OBJECT_ID(N'dbo.OrganizationApprovers');
 OPEN BranchReferences;
 FETCH NEXT FROM BranchReferences INTO @Schema,@Table,@Column;
 WHILE @@FETCH_STATUS=0
 BEGIN
  SET @Sql=N'UPDATE r SET '+QUOTENAME(@Column)+N'=p.KeepId FROM '+QUOTENAME(@Schema)+N'.'+QUOTENAME(@Table)+N' r JOIN #Plan p ON p.Id=r.'+QUOTENAME(@Column)+N' WHERE p.Id<>p.KeepId;';
  EXEC sys.sp_executesql @Sql;
  FETCH NEXT FROM BranchReferences INTO @Schema,@Table,@Column;
 END;
 CLOSE BranchReferences;
 DEALLOCATE BranchReferences;
 DELETE l FROM dbo.Lookups l JOIN #Plan p ON p.Id=l.Id WHERE p.Id<>p.KeepId;
 UPDATE l SET Name=p.FinalName,Active=CASE WHEN EXISTS(SELECT 1 FROM #Wanted w WHERE w.Name=p.FinalName) THEN 1
   ELSE (SELECT MAX(CONVERT(int,p2.Active)) FROM #Plan p2 WHERE p2.KeepId=p.Id) END
 FROM dbo.Lookups l JOIN #Plan p ON p.Id=l.Id AND p.KeepId=p.Id
 WHERE l.Name COLLATE Latin1_General_100_BIN2<>p.FinalName COLLATE Latin1_General_100_BIN2 OR l.Active=0;
 INSERT dbo.Lookups(Kind,Name,Active)
 SELECT 'branch',w.Name,1 FROM #Wanted w WHERE NOT EXISTS(SELECT 1 FROM dbo.Lookups l WHERE l.Kind='branch' AND l.Name=w.Name);
 DECLARE @NewCount int=@@ROWCOUNT;
 IF (SELECT COUNT(*) FROM #Wanted w JOIN dbo.Lookups l ON l.Kind='branch' AND l.Name=w.Name AND l.Active=1)<>21
  THROW 51123,'Branch verification failed. No changes saved.',1;
 DECLARE @Audit nvarchar(max)=(SELECT @NewCount AS added,JSON_QUERY((SELECT Id AS oldId,KeepId AS retainedId,OldName,FinalName FROM #Plan WHERE Id<>KeepId FOR JSON PATH)) AS merged FOR JSON PATH,WITHOUT_ARRAY_WRAPPER);
 INSERT dbo.AuditEvents(ActorId,Event,EntityId,Ip,CorrelationId,Metadata)
 VALUES(NULL,'organization.branches_synchronized',N'branch',N'local-sql',NEWID(),@Audit);
 SELECT CASE WHEN @ApplyChanges=1 THEN 'APPLY' ELSE 'PREVIEW ONLY - WILL ROLLBACK' END AS Mode,@NewCount AS Added,(SELECT COUNT(*) FROM #Plan WHERE Id<>KeepId) AS DuplicatesMerged;
 SELECT OldName,FinalName,Id AS OldId,KeepId AS RetainedId FROM #Plan WHERE Id<>KeepId ORDER BY FinalName;
 SELECT l.Id,l.Name,l.Active FROM dbo.Lookups l JOIN #Wanted w ON w.Name=l.Name WHERE l.Kind='branch' ORDER BY l.Name;
 IF @ApplyChanges=1 COMMIT TRANSACTION; ELSE ROLLBACK TRANSACTION;
 DROP TABLE IF EXISTS #Plan; DROP TABLE IF EXISTS #Branches; DROP TABLE IF EXISTS #Wanted;
END TRY
BEGIN CATCH
 IF CURSOR_STATUS('local','BranchReferences')>=0 CLOSE BranchReferences;
 IF CURSOR_STATUS('local','BranchReferences')>=-1 DEALLOCATE BranchReferences;
 IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
 THROW;
END CATCH;
GO
