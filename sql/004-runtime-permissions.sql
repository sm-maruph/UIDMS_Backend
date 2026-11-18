/* DBA: replace this example password before execution. Do not commit your edited copy.
   Mixed Mode SQL authentication must be enabled for this SQL-login deployment.
   Prefer a managed service identity/Windows-integrated deployment where supported.
   Replace only the @Password value below in your private SSMS execution copy.
   Run the entire script as a DBA. It does not reset an existing login password.
   Login creation and database permissions share one batch so a failure cannot
   continue into user creation after a GO separator. */
USE master;
GO
DECLARE @Password nvarchar(128)=N'REPLACE_WITH_A_STRONG_UNIQUE_DATABASE_PASSWORD';
IF @Password LIKE N'REPLACE%' OR LEN(@Password)<24
  THROW 51002,'Set a unique runtime login password of at least 24 characters before executing this script.',1;
IF DB_ID(N'CBC_UIDMS') IS NULL
  THROW 51003,'Install database scripts 001, 002 and 003 before running runtime permissions.',1;
BEGIN TRY
IF SUSER_ID(N'uidms_api') IS NULL
BEGIN
 DECLARE @Create nvarchar(max)=N'CREATE LOGIN [uidms_api] WITH PASSWORD='+QUOTENAME(@Password,'''')+N', CHECK_POLICY=ON, CHECK_EXPIRATION=ON, DEFAULT_DATABASE=[CBC_UIDMS];';
 EXEC(@Create); /* DBA-only, quoted password. Never run dynamic SQL from HTTP data. */
END;
IF SUSER_ID(N'uidms_api') IS NULL
  THROW 51004,'Runtime login is unavailable. Run this script with a DBA account that can create logins.',1;
USE CBC_UIDMS;
IF DATABASE_PRINCIPAL_ID(N'uidms_runtime') IS NULL CREATE ROLE uidms_runtime;
IF DATABASE_PRINCIPAL_ID(N'uidms_api') IS NULL CREATE USER uidms_api FOR LOGIN uidms_api;
ALTER ROLE uidms_runtime ADD MEMBER uidms_api;
GRANT SELECT ON SCHEMA::dbo TO uidms_runtime;
GRANT INSERT,UPDATE ON SCHEMA::dbo TO uidms_runtime;
GRANT UPDATE ON OBJECT::dbo.TicketSequence TO uidms_runtime;
GRANT DELETE ON dbo.Sessions TO uidms_runtime;
GRANT DELETE ON dbo.AuthChallenges TO uidms_runtime;
GRANT DELETE ON dbo.RequestItems TO uidms_runtime;
GRANT DELETE ON dbo.RequestPeople TO uidms_runtime;
GRANT DELETE ON dbo.RequestSteps TO uidms_runtime;
GRANT DELETE ON dbo.MailingGroupMembers TO uidms_runtime;
GRANT DELETE ON dbo.WorkflowSteps TO uidms_runtime;
GRANT DELETE ON dbo.RateLimitBuckets TO uidms_runtime;
DENY UPDATE,DELETE ON dbo.AuditEvents TO uidms_runtime;
DENY INSERT,UPDATE,DELETE ON dbo.SchemaVersions TO uidms_runtime;
DENY INSERT,UPDATE,DELETE ON dbo.PortalRoles TO uidms_runtime;
DENY ALTER ON SCHEMA::dbo TO uidms_runtime;
END TRY
BEGIN CATCH
  THROW;
END CATCH;
GO
