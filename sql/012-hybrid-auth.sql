/* Authentication provenance for hybrid local and Active Directory sign-in. */
USE CBC_UIDMS;
GO
SET XACT_ABORT ON;
IF NOT EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=8)
 THROW 51015,'Apply migration 011 before hybrid authentication.',1;
BEGIN TRANSACTION;
IF COL_LENGTH('dbo.Sessions','AuthProvider') IS NULL
 ALTER TABLE dbo.Sessions ADD AuthProvider varchar(10) NOT NULL CONSTRAINT DF_Sessions_AuthProvider DEFAULT 'local' CHECK(AuthProvider IN ('local','ad'));
IF COL_LENGTH('dbo.AuthChallenges','AuthProvider') IS NULL
 ALTER TABLE dbo.AuthChallenges ADD AuthProvider varchar(10) NOT NULL CONSTRAINT DF_AuthChallenges_AuthProvider DEFAULT 'local' CHECK(AuthProvider IN ('local','ad'));
IF NOT EXISTS(SELECT 1 FROM dbo.SchemaVersions WHERE Version=9)
 INSERT dbo.SchemaVersions(Version) VALUES(9);
COMMIT;
GO
