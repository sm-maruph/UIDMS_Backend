/* Keep I/S Drive and N Drive as separate request types. Existing IDs/history
   and workflow snapshots remain unchanged. Run as DBA after scripts 001-006. */
USE CBC_UIDMS;
GO
SET XACT_ABORT ON;
IF OBJECT_ID(N'dbo.SchemaVersions') IS NULL
 THROW 51009,'Install the base schema before applying drive request names.',1;
IF (SELECT COUNT(*) FROM dbo.RequestTypes WHERE Code IN ('idrive','n-drive'))<>2
 THROW 51010,'Install reference data before applying drive request names.',1;
BEGIN TRANSACTION;
UPDATE dbo.RequestTypes SET Name=N'I Drive / S Drive Access' WHERE Code='idrive';
UPDATE dbo.RequestTypes SET Name=N'N Drive Access' WHERE Code='n-drive';
IF NOT EXISTS(SELECT 1 FROM dbo.Systems WHERE Name=N'S Drive')
 INSERT dbo.Systems(Name,TransferManaged) VALUES(N'S Drive',0);
IF NOT EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=4)
 INSERT dbo.SchemaVersions(Version) VALUES(4);
COMMIT;
GO
