/* Existing installations: run as DBA after 001-004.
   New reset/unlock requests use User -> CITO -> IT processing -> Completed.
   Previously submitted tickets retain their historical approval snapshots. */
USE CBC_UIDMS;
GO
SET XACT_ABORT ON;
IF OBJECT_ID(N'dbo.SchemaVersions') IS NULL
 THROW 51005,'Install the base schema before applying this migration.',1;
IF NOT EXISTS(SELECT 1 FROM dbo.RequestTypes WHERE Code='reset')
 THROW 51006,'Install reference data before applying this migration.',1;
BEGIN TRANSACTION;
DELETE dbo.WorkflowSteps WHERE TypeCode='reset';
INSERT dbo.WorkflowSteps(TypeCode,Position,Role) VALUES('reset',1,N'CITO');
UPDATE dbo.RequestTypes SET IncludesHr=0 WHERE Code='reset';
IF NOT EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=2)
 INSERT dbo.SchemaVersions(Version) VALUES(2);
COMMIT;
GO
