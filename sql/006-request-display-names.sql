/* Display names only. Stable type codes, submitted form snapshots, approvals
   and audit history are preserved. Run as DBA after the preceding scripts. */
USE CBC_UIDMS;
GO
SET XACT_ABORT ON;
IF OBJECT_ID(N'dbo.SchemaVersions') IS NULL
 THROW 51007,'Install the base schema before applying request display names.',1;
IF (SELECT COUNT(*) FROM dbo.RequestTypes WHERE Code IN ('reset','movement'))<>2
 THROW 51008,'Install reference data before applying request display names.',1;
BEGIN TRANSACTION;
UPDATE dbo.RequestTypes SET Name=N'Unlock / Reset' WHERE Code='reset';
UPDATE dbo.RequestTypes SET Name=N'Branch / Department Transfer' WHERE Code='movement';
IF NOT EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=3)
 INSERT dbo.SchemaVersions(Version) VALUES(3);
COMMIT;
GO
