USE CBC_UIDMS;
GO
SET XACT_ABORT ON;
IF NOT EXISTS (SELECT 1 FROM dbo.SchemaVersions WHERE Version=6)
 THROW 51013,'Apply migration 009 first.',1;
BEGIN TRANSACTION;
IF NOT EXISTS (SELECT 1 FROM dbo.SchemaVersions WITH (UPDLOCK,HOLDLOCK) WHERE Version=7)
BEGIN
 CREATE TABLE dbo.DirectoryIdentities (
  SystemId nvarchar(160) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,
  UserId uniqueidentifier NOT NULL UNIQUE REFERENCES dbo.Users(Id),
  LinkedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
 );
 INSERT dbo.SchemaVersions(Version) VALUES(7);
END;
COMMIT;
GO
