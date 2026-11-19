/* Verified AD employees may create a basic User profile before MFA enrollment. */
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
IF NOT EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=9)
 THROW 51016,'Apply migration 012 before AD self-enrollment.',1;
IF EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=10) RETURN;
BEGIN TRANSACTION;
/* SQL Server's ordinary unique constraint permits only one NULL. Keep uniqueness
   for supplied addresses while allowing multiple employees without work email. */
DECLARE @EmailConstraint sysname;
SELECT @EmailConstraint=kc.name FROM sys.key_constraints kc
WHERE kc.parent_object_id=OBJECT_ID(N'dbo.Users') AND kc.type='UQ'
 AND (SELECT COUNT(*) FROM sys.index_columns ic WHERE ic.object_id=kc.parent_object_id AND ic.index_id=kc.unique_index_id)=1
 AND EXISTS(SELECT 1 FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
  WHERE ic.object_id=kc.parent_object_id AND ic.index_id=kc.unique_index_id AND c.name=N'Email');
IF @EmailConstraint IS NOT NULL
BEGIN
 DECLARE @DropEmailConstraint nvarchar(max)=N'ALTER TABLE dbo.Users DROP CONSTRAINT '+QUOTENAME(@EmailConstraint)+N';';
 EXEC sys.sp_executesql @DropEmailConstraint;
END;
ALTER TABLE dbo.Users ALTER COLUMN Email nvarchar(254) NULL;
CREATE UNIQUE INDEX UX_Users_Email ON dbo.Users(Email) WHERE Email IS NOT NULL;
CREATE TABLE dbo.AdEnrollmentChallenges(
 TokenHash char(64) NOT NULL PRIMARY KEY,
 SystemId nvarchar(160) NOT NULL UNIQUE,
 EmployeeId nvarchar(40) NOT NULL UNIQUE,
 Name nvarchar(160) NOT NULL,
 Email nvarchar(254) NULL,
 ExpiresAt datetime2(3) NOT NULL,
 CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_AdEnrollment_Expiry ON dbo.AdEnrollmentChallenges(ExpiresAt);
IF DATABASE_PRINCIPAL_ID(N'uidms_runtime') IS NOT NULL
 GRANT DELETE ON dbo.AdEnrollmentChallenges TO uidms_runtime;
INSERT dbo.SchemaVersions(Version) VALUES(10);
COMMIT;
GO
