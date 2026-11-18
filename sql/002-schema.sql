USE CBC_UIDMS;
GO
SET XACT_ABORT ON;
GO
IF OBJECT_ID(N'dbo.SchemaVersions') IS NOT NULL
  THROW 51000, 'Schema already installed. Do not rerun 002; use a versioned migration.', 1;
BEGIN TRANSACTION;
CREATE TABLE dbo.SchemaVersions(Version int NOT NULL PRIMARY KEY, AppliedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME());
CREATE TABLE dbo.PortalRoles(Name nvarchar(40) NOT NULL PRIMARY KEY);
CREATE TABLE dbo.Lookups(
 Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
 Kind varchar(20) NOT NULL CHECK(Kind IN ('branch','department','designation')),
 Name nvarchar(150) NOT NULL, Active bit NOT NULL DEFAULT 1,
 CONSTRAINT UQ_Lookup UNIQUE(Kind,Name)
);
CREATE TABLE dbo.Users(
 Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
 EmployeeId nvarchar(40) NOT NULL UNIQUE, Name nvarchar(160) NOT NULL,
 Email nvarchar(254) NOT NULL UNIQUE, Role nvarchar(40) NOT NULL REFERENCES dbo.PortalRoles(Name),
 BranchId uniqueidentifier NULL REFERENCES dbo.Lookups(Id),
 DepartmentId uniqueidentifier NULL REFERENCES dbo.Lookups(Id),
 DesignationId uniqueidentifier NULL REFERENCES dbo.Lookups(Id),
 PasswordHash varchar(300) NULL, Active bit NOT NULL DEFAULT 1,
 MfaSecret varchar(500) NULL, MfaLastCounter bigint NULL,
 FailedAttempts int NOT NULL DEFAULT 0, MfaFailedAttempts int NOT NULL DEFAULT 0, LockedUntil datetime2(3) NULL,
 Signature varbinary(max) NULL, SignatureContentType varchar(30) NULL,
 CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), UpdatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 Version rowversion NOT NULL,
 CONSTRAINT CK_Signature CHECK(Signature IS NULL OR (DATALENGTH(Signature)<=262144 AND SignatureContentType IS NOT NULL AND SignatureContentType='image/png'))
);
CREATE TABLE dbo.Sessions(
 TokenHash char(64) NOT NULL PRIMARY KEY, UserId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id),
 CsrfHash char(64) NOT NULL, CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 LastSeenAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), ExpiresAt datetime2(3) NOT NULL,
 RevokedAt datetime2(3) NULL, Ip varchar(64) NOT NULL, UserAgent nvarchar(300) NULL
);
CREATE INDEX IX_Sessions_User ON dbo.Sessions(UserId,RevokedAt,ExpiresAt);
CREATE TABLE dbo.AuthChallenges(
 TokenHash char(64) NOT NULL PRIMARY KEY, UserId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id),
 Purpose varchar(20) NOT NULL CHECK(Purpose IN ('mfa','activation')),
 PendingMfaSecret varchar(500) NULL, Attempts int NOT NULL DEFAULT 0,
 ExpiresAt datetime2(3) NOT NULL, CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_Challenges_User ON dbo.AuthChallenges(UserId,Purpose);
CREATE TABLE dbo.RateLimitBuckets(Namespace varchar(30) NOT NULL, KeyHash char(64) NOT NULL, TotalHits int NOT NULL, ResetAt datetime2(3) NOT NULL, PRIMARY KEY(Namespace,KeyHash));
CREATE INDEX IX_RateLimit_Expiry ON dbo.RateLimitBuckets(ResetAt);
CREATE TABLE dbo.Systems(Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, Name nvarchar(150) NOT NULL UNIQUE, Active bit NOT NULL DEFAULT 1, TransferManaged bit NOT NULL DEFAULT 0);
CREATE TABLE dbo.SystemRoles(Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, SystemId uniqueidentifier NOT NULL REFERENCES dbo.Systems(Id), Name nvarchar(150) NOT NULL, Active bit NOT NULL DEFAULT 1, UNIQUE(SystemId,Name));
CREATE TABLE dbo.AccessGrants(
 Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, UserId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id),
 SystemId uniqueidentifier NOT NULL REFERENCES dbo.Systems(Id), SystemRoleId uniqueidentifier NULL REFERENCES dbo.SystemRoles(Id),
 Username nvarchar(150) NULL, GrantedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), RevokedAt datetime2(3) NULL,
 SourceRequestId uniqueidentifier NULL
);
CREATE UNIQUE INDEX UX_ActiveGrant ON dbo.AccessGrants(UserId,SystemId,SystemRoleId) WHERE RevokedAt IS NULL;
CREATE TABLE dbo.RequestTypes(
 Code varchar(50) NOT NULL PRIMARY KEY, Name nvarchar(100) NOT NULL UNIQUE,
 Active bit NOT NULL DEFAULT 1, IncludesHr bit NOT NULL DEFAULT 0,
 InitiatorRoles nvarchar(1000) NOT NULL CHECK(ISJSON(InitiatorRoles)=1)
);
CREATE TABLE dbo.WorkflowSteps(
 TypeCode varchar(50) NOT NULL REFERENCES dbo.RequestTypes(Code), Position int NOT NULL CHECK(Position>0),
 Role nvarchar(40) NOT NULL, CONSTRAINT PK_Workflow PRIMARY KEY(TypeCode,Position),
 CONSTRAINT CK_WorkflowRole CHECK(Role IN ('Manager','HR','IT','CITO','COO'))
);
CREATE SEQUENCE dbo.TicketSequence AS bigint START WITH 1 INCREMENT BY 1;
CREATE TABLE dbo.Requests(
 Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
 TicketNumber nvarchar(40) NOT NULL UNIQUE,
 TypeCode varchar(50) NOT NULL REFERENCES dbo.RequestTypes(Code), RequesterId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id),
 SubjectUserId uniqueidentifier NULL REFERENCES dbo.Users(Id),
 BranchId uniqueidentifier NOT NULL REFERENCES dbo.Lookups(Id), DepartmentId uniqueidentifier NOT NULL REFERENCES dbo.Lookups(Id),
 DestinationBranchId uniqueidentifier NULL REFERENCES dbo.Lookups(Id), DestinationDepartmentId uniqueidentifier NULL REFERENCES dbo.Lookups(Id),
 Status varchar(30) NOT NULL DEFAULT 'Pending' CHECK(Status IN ('Employee review','Pending','In review','Query','Approved','IT processing','HO processing','Completed','Rejected','Cancelled')),
 CurrentPosition int NOT NULL DEFAULT 1,
 Justification nvarchar(4000) NOT NULL,
 Details nvarchar(max) NOT NULL CHECK(ISJSON(Details)=1),
 SignatureSnapshot varbinary(max) NULL CHECK(SignatureSnapshot IS NULL OR DATALENGTH(SignatureSnapshot)<=262144),
 RequesterSnapshot nvarchar(max) NOT NULL CHECK(ISJSON(RequesterSnapshot)=1),
 ConsentAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), UpdatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 SubmittedIp varchar(64) NOT NULL, CompletedAt datetime2(3) NULL, DeletedAt datetime2(3) NULL,
 Version rowversion NOT NULL
);
ALTER TABLE dbo.AccessGrants ADD CONSTRAINT FK_Grant_Request FOREIGN KEY(SourceRequestId) REFERENCES dbo.Requests(Id);
CREATE INDEX IX_Requests_Requester ON dbo.Requests(RequesterId,CreatedAt DESC) INCLUDE(Status,TypeCode,TicketNumber);
CREATE INDEX IX_Requests_Queue ON dbo.Requests(Status,BranchId,DepartmentId,CreatedAt DESC);
CREATE TABLE dbo.RequestPeople(
 Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, RequestId uniqueidentifier NOT NULL REFERENCES dbo.Requests(Id),
 EmployeeId nvarchar(40) NOT NULL, Name nvarchar(160) NOT NULL, UserId uniqueidentifier NULL REFERENCES dbo.Users(Id),
 BranchId uniqueidentifier NOT NULL REFERENCES dbo.Lookups(Id), DepartmentId uniqueidentifier NOT NULL REFERENCES dbo.Lookups(Id),
 Details nvarchar(max) NOT NULL CHECK(ISJSON(Details)=1), UNIQUE(RequestId,EmployeeId)
);
CREATE TABLE dbo.RequestItems(
 Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, RequestId uniqueidentifier NOT NULL REFERENCES dbo.Requests(Id),
 PersonId uniqueidentifier NOT NULL REFERENCES dbo.RequestPeople(Id), SystemId uniqueidentifier NOT NULL REFERENCES dbo.Systems(Id),
 SystemRoleId uniqueidentifier NULL REFERENCES dbo.SystemRoles(Id), Operation varchar(20) NOT NULL CHECK(Operation IN ('grant','revoke','reset','update')),
 Reason nvarchar(2000) NULL, UNIQUE(RequestId,PersonId,SystemId,SystemRoleId)
);
CREATE TABLE dbo.RequestSteps(
 RequestId uniqueidentifier NOT NULL REFERENCES dbo.Requests(Id), Position int NOT NULL, Role nvarchar(40) NOT NULL REFERENCES dbo.PortalRoles(Name),
 BranchId uniqueidentifier NULL REFERENCES dbo.Lookups(Id), DepartmentId uniqueidentifier NULL REFERENCES dbo.Lookups(Id),
 Status varchar(15) NOT NULL DEFAULT 'Waiting' CHECK(Status IN ('Waiting','Approved','Rejected')),
 ActorId uniqueidentifier NULL REFERENCES dbo.Users(Id), Remark nvarchar(2000) NULL, DecidedAt datetime2(3) NULL,
 PRIMARY KEY(RequestId,Position)
);
CREATE INDEX IX_Steps_Queue ON dbo.RequestSteps(Role,Status) INCLUDE(RequestId,Position,BranchId,DepartmentId);
CREATE TABLE dbo.RequestRevisions(
 Id bigint IDENTITY PRIMARY KEY, RequestId uniqueidentifier NOT NULL REFERENCES dbo.Requests(Id), ActorId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id),
 Snapshot nvarchar(max) NOT NULL CHECK(ISJSON(Snapshot)=1), CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE TABLE dbo.Queries(
 Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, RequestId uniqueidentifier NOT NULL REFERENCES dbo.Requests(Id),
 AuthorId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id), RecipientId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id),
 Message nvarchar(350) NOT NULL, ReturnStatus varchar(30) NOT NULL, CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 ResolvedAt datetime2(3) NULL, CONSTRAINT CK_QueryRecipient CHECK(AuthorId<>RecipientId)
);
CREATE UNIQUE INDEX UX_Query_Open ON dbo.Queries(RequestId) WHERE ResolvedAt IS NULL;
CREATE INDEX IX_Query_Recipient ON dbo.Queries(RecipientId,ResolvedAt,CreatedAt DESC);
CREATE INDEX IX_Query_Author ON dbo.Queries(AuthorId,CreatedAt DESC);
CREATE TABLE dbo.QueryResponses(
 Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, QueryId uniqueidentifier NOT NULL UNIQUE REFERENCES dbo.Queries(Id),
 AuthorId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id), Message nvarchar(4000) NOT NULL,
 CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE TABLE dbo.HrClearances(
 PersonId uniqueidentifier NOT NULL PRIMARY KEY REFERENCES dbo.RequestPeople(Id), ActorId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id),
 Police varchar(30) NOT NULL CHECK(Police IN ('Completed','Pending','Special recommendation')),
 ReferenceCheck varchar(20) NOT NULL CHECK(ReferenceCheck IN ('Both checked','One checked','Pending')),
 Recommendation nvarchar(2000) NULL, UpdatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 CONSTRAINT CK_Hr_Recommendation CHECK(Police<>'Special recommendation' OR LEN(COALESCE(Recommendation,N''))>0)
);
CREATE TABLE dbo.Fulfilments(
 RequestId uniqueidentifier NOT NULL PRIMARY KEY REFERENCES dbo.Requests(Id), ActorId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id),
 ProcessingReference nvarchar(250) NULL, Notes nvarchar(2000) NULL,
 ProcessingAt datetime2(3) NULL, CompletedAt datetime2(3) NULL
);
CREATE TABLE dbo.CredentialDeliveries(
 Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, RequestId uniqueidentifier NOT NULL REFERENCES dbo.Requests(Id),
 RecipientId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id), Ciphertext nvarchar(max) NULL,
 ExpiresAt datetime2(3) NOT NULL, ReadAt datetime2(3) NULL, CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE TABLE dbo.MailingGroups(Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, Email nvarchar(254) NOT NULL UNIQUE, Name nvarchar(160) NOT NULL, Active bit NOT NULL DEFAULT 1);
CREATE TABLE dbo.MailingGroupMembers(GroupId uniqueidentifier NOT NULL REFERENCES dbo.MailingGroups(Id), UserId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id), PRIMARY KEY(GroupId,UserId));
CREATE TABLE dbo.Notifications(Id bigint IDENTITY PRIMARY KEY, UserId uniqueidentifier NOT NULL REFERENCES dbo.Users(Id), RequestId uniqueidentifier NULL REFERENCES dbo.Requests(Id), Message nvarchar(300) NOT NULL, CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), ReadAt datetime2(3) NULL);
CREATE INDEX IX_Notifications_User ON dbo.Notifications(UserId,ReadAt,CreatedAt DESC);
CREATE TABLE dbo.EmailOutbox(
 Id bigint IDENTITY PRIMARY KEY, Recipient nvarchar(254) NOT NULL, Subject nvarchar(200) NOT NULL, Body nvarchar(4000) NOT NULL,
 CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), SentAt datetime2(3) NULL, Attempts int NOT NULL DEFAULT 0,
 ClaimedUntil datetime2(3) NULL, LastError varchar(100) NULL
);
CREATE TABLE dbo.Attachments(
 Id uniqueidentifier NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, RequestId uniqueidentifier NOT NULL REFERENCES dbo.Requests(Id),
 UploadedBy uniqueidentifier NOT NULL REFERENCES dbo.Users(Id), OriginalName nvarchar(150) NOT NULL,
 ContentType varchar(50) NOT NULL, Bytes varbinary(max) NOT NULL, Sha256 char(64) NOT NULL,
 ScanStatus varchar(15) NOT NULL DEFAULT 'Quarantined' CHECK(ScanStatus IN ('Quarantined','Clean','Rejected')),
 ScanReference nvarchar(300) NULL, CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 CONSTRAINT CK_Attachment_Size CHECK(DATALENGTH(Bytes) BETWEEN 1 AND 5242880)
);
CREATE TABLE dbo.AuditEvents(
 Id bigint IDENTITY PRIMARY KEY, ActorId uniqueidentifier NULL REFERENCES dbo.Users(Id),
 Event varchar(100) NOT NULL, EntityId nvarchar(80) NULL, Ip varchar(64) NOT NULL,
 CorrelationId uniqueidentifier NOT NULL, Metadata nvarchar(max) NOT NULL DEFAULT N'{}' CHECK(ISJSON(Metadata)=1),
 CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_Audit_Date ON dbo.AuditEvents(CreatedAt DESC) INCLUDE(Event,ActorId,EntityId);
/* Static DDL in its own execution batch, still inside the installation transaction. */
EXEC(N'CREATE TRIGGER dbo.TR_AuditEvents_AppendOnly ON dbo.AuditEvents INSTEAD OF UPDATE,DELETE AS
BEGIN
 THROW 51001,''Audit events are append-only.'',1;
END;');
INSERT dbo.SchemaVersions(Version) VALUES(1);
COMMIT;
GO
