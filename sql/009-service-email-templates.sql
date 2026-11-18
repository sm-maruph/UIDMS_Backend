USE CBC_UIDMS;
GO
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET ARITHABORT ON;
SET NUMERIC_ROUNDABORT OFF;
IF NOT EXISTS (SELECT 1 FROM dbo.SchemaVersions WHERE Version=5)
 THROW 51012,'Apply migration 008 first.',1;
BEGIN TRANSACTION;
IF NOT EXISTS (SELECT 1 FROM dbo.SchemaVersions WITH (UPDLOCK,HOLDLOCK) WHERE Version=6)
BEGIN
 DECLARE @nameConstraint sysname=(SELECT Name FROM sys.key_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.SystemEmailTemplates') AND type='UQ');
 DECLARE @memberKey sysname=(SELECT Name FROM sys.key_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.SystemEmailTemplateSystems') AND type='PK');
 DECLARE @dropConstraints nvarchar(max)=N'ALTER TABLE dbo.SystemEmailTemplates DROP CONSTRAINT '+QUOTENAME(@nameConstraint)
  +N'; ALTER TABLE dbo.SystemEmailTemplateSystems DROP CONSTRAINT '+QUOTENAME(@memberKey)+N';';
 EXEC(@dropConstraints);
 ALTER TABLE dbo.SystemEmailTemplates ADD Category varchar(32) NOT NULL CONSTRAINT DF_EmailTemplate_Category DEFAULT '', IsServiceDefault bit NOT NULL CONSTRAINT DF_EmailTemplate_ServiceDefault DEFAULT 0;
 ALTER TABLE dbo.SystemEmailTemplateSystems ADD Category varchar(32) NOT NULL CONSTRAINT DF_EmailTemplateSystem_Category DEFAULT '';
 EXEC(N'ALTER TABLE dbo.SystemEmailTemplates ADD CONSTRAINT UQ_EmailTemplate_CategoryName UNIQUE(Category,Name), CONSTRAINT UQ_EmailTemplate_CategoryId UNIQUE(Category,Id), CONSTRAINT CK_EmailTemplate_ServiceDefault CHECK(IsServiceDefault=0 OR Category<>'''');
 ALTER TABLE dbo.SystemEmailTemplateSystems ADD CONSTRAINT PK_EmailTemplateSystem_CategorySystem PRIMARY KEY(Category,SystemId), CONSTRAINT FK_EmailTemplateSystem_CategoryTemplate FOREIGN KEY(Category,TemplateId) REFERENCES dbo.SystemEmailTemplates(Category,Id);
 CREATE UNIQUE INDEX UX_EmailTemplate_ServiceDefault ON dbo.SystemEmailTemplates(Category) WHERE IsServiceDefault=1;');
 IF NOT EXISTS (SELECT 1 FROM dbo.Systems WHERE Name=N'Other software')
  INSERT dbo.Systems(Name) VALUES(N'Other software');
 INSERT dbo.SchemaVersions(Version) VALUES(6);
END;
COMMIT;
GO
