/* Development fixture provenance. Does not seed or overwrite any user/request.
   Password 1234 is usable only through the separately gated local mock-login mode. */
USE CBC_UIDMS;
GO
SET XACT_ABORT ON;
IF NOT EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=7)
 THROW 51014,'Apply migration 010 before mock-data support.',1;
BEGIN TRANSACTION;
IF COL_LENGTH('dbo.Users','IsDemo') IS NULL
 ALTER TABLE dbo.Users ADD IsDemo bit NOT NULL CONSTRAINT DF_Users_IsDemo DEFAULT 0;
IF OBJECT_ID(N'dbo.DemoImports') IS NULL
 CREATE TABLE dbo.DemoImports(
  EntityType varchar(30) NOT NULL, SourceKey nvarchar(100) NOT NULL,
  EntityId uniqueidentifier NOT NULL, SourceHash char(64) NOT NULL,
  OriginalJson nvarchar(max) NOT NULL CHECK(ISJSON(OriginalJson)=1),
  ImportedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
  PRIMARY KEY(EntityType,SourceKey)
 );
IF NOT EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=8)
 INSERT dbo.SchemaVersions(Version) VALUES(8);
COMMIT;
GO
