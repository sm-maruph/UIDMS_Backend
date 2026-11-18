USE CBC_UIDMS;
GO
SET XACT_ABORT ON;
IF OBJECT_ID(N'dbo.SchemaVersions') IS NULL
 THROW 51011,'Install the base schema before applying system email templates.',1;
BEGIN TRANSACTION;
IF NOT EXISTS (SELECT 1 FROM dbo.SchemaVersions WITH (UPDLOCK,HOLDLOCK) WHERE Version=5)
BEGIN
 CREATE TABLE dbo.SystemEmailTemplates (
  Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
  Name nvarchar(160) NOT NULL UNIQUE,
  Recipients nvarchar(max) NOT NULL CHECK (ISJSON(Recipients)=1),
  Subject nvarchar(300) NOT NULL,
  Body nvarchar(max) NOT NULL,
  Version rowversion NOT NULL
 );
 CREATE TABLE dbo.SystemEmailTemplateSystems (
  SystemId uniqueidentifier NOT NULL PRIMARY KEY REFERENCES dbo.Systems(Id),
  TemplateId uniqueidentifier NOT NULL REFERENCES dbo.SystemEmailTemplates(Id) ON DELETE CASCADE
 );
 CREATE INDEX IX_SystemEmailTemplateSystems_Template ON dbo.SystemEmailTemplateSystems(TemplateId);
 CREATE TABLE dbo.SystemApprovalOverrides (
  TemplateId uniqueidentifier NOT NULL REFERENCES dbo.SystemEmailTemplates(Id),
  TypeCode varchar(50) NOT NULL REFERENCES dbo.RequestTypes(Code),
  Steps nvarchar(300) NOT NULL CHECK (ISJSON(Steps)=1),
  PRIMARY KEY (TypeCode,TemplateId)
 );
 CREATE INDEX IX_SystemApprovalOverrides_Template ON dbo.SystemApprovalOverrides(TemplateId);
 CREATE TABLE dbo.RequestEmailDrafts (
  Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
  RequestId uniqueidentifier NOT NULL REFERENCES dbo.Requests(Id),
  TemplateId uniqueidentifier NULL,
  Position int NOT NULL,
  Content nvarchar(max) NOT NULL CHECK (ISJSON(Content)=1),
  SentBy uniqueidentifier NULL REFERENCES dbo.Users(Id),
  SentAt datetime2(3) NULL,
  UNIQUE (RequestId,Position)
 );
 INSERT dbo.SchemaVersions(Version) VALUES(5);
END;
IF DATABASE_PRINCIPAL_ID(N'uidms_runtime') IS NOT NULL
BEGIN
 GRANT DELETE ON dbo.SystemEmailTemplates TO uidms_runtime;
 GRANT DELETE ON dbo.SystemEmailTemplateSystems TO uidms_runtime;
 GRANT DELETE ON dbo.SystemApprovalOverrides TO uidms_runtime;
END;
COMMIT;
GO
