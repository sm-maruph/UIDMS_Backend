/* Reviewed administrative removal. Historical rows and audit links are retained. */
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
IF NOT EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=13)
 THROW 51020,'Apply migration 016 before reviewed deletion.',1;
IF EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=14) RETURN;
BEGIN TRANSACTION;
ALTER TABLE dbo.Users ADD DeletedAt datetime2(3) NULL;
ALTER TABLE dbo.Lookups ADD DeletedAt datetime2(3) NULL;
EXEC(N'ALTER TABLE dbo.Users ADD CONSTRAINT CK_DeletedUser_Inactive CHECK(DeletedAt IS NULL OR Active=0)');
EXEC(N'ALTER TABLE dbo.Lookups ADD CONSTRAINT CK_DeletedLookup_Inactive CHECK(DeletedAt IS NULL OR Active=0)');
IF DATABASE_PRINCIPAL_ID(N'uidms_runtime') IS NOT NULL
 GRANT DELETE ON dbo.OrganizationApprovers TO uidms_runtime;
INSERT dbo.SchemaVersions(Version) VALUES(14);
COMMIT;
GO
