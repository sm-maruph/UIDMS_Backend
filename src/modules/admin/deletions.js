import {createHash} from 'node:crypto';
import {Router} from 'express';
import {p} from '../../core/db.js';
import {z,id,parse,uuidParam} from '../../core/validation.js';
import {requireCondition} from '../../core/errors.js';
import {roles} from '../auth/service.js';
import {audit} from '../audit/service.js';
import {mergePendingOrganization} from './organization-merge.js';

const kindSchema=z.enum(['user','request','branch','department','designation']);
const choicesSchema=z.object({reviewToken:z.string().regex(/^[a-f0-9]{64}$/),employees:z.enum(['move','delete']).default('move'),replacementId:id.nullable().default(null),requests:z.enum(['keep','delete']).default('keep'),deleteOtherRequests:z.boolean().default(false),mergePending:z.boolean().default(false),confirmName:z.string().min(1).max(160)}).strict();
const terminal="('Completed','Rejected','Cancelled')";
const maxReview=5000;
const clean=row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Buffer.isBuffer(value)?value.toString('hex'):value]));
const isUserSet="SELECT CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@users)";
async function auditRows(query,req,event,rows){
 if(!rows.length)return;
 await query(`INSERT dbo.AuditEvents(ActorId,Event,EntityId,Ip,CorrelationId,Metadata,AuditSessionId,ActorRole)
 SELECT @actor,@event,CONVERT(nvarchar(80),entity),@ip,@correlation,metadata,@session,@role
 FROM OPENJSON(@rows) WITH(entity uniqueidentifier '$.id',metadata nvarchar(max) '$.metadata' AS JSON)`,{actor:p.id(req.user.Id),event:p.str(event,100),ip:p.str(req.ip||'local',64),correlation:p.id(req.id),session:p.id(req.auditSessionId),role:p.text(req.user.Role,40),rows:p.json(rows)});
}

export async function deletionPlan(query,kind,targetId){
 const target=(await query(kind==='user'?'SELECT Id,Name,EmployeeId,Role,Active,Version FROM dbo.Users WHERE Id=@id AND DeletedAt IS NULL':kind==='request'?'SELECT Id,TicketNumber AS Name,Status,Version FROM dbo.Requests WHERE Id=@id AND DeletedAt IS NULL':'SELECT Id,Name,Kind,Active FROM dbo.Lookups WHERE Id=@id AND Kind=@kind AND DeletedAt IS NULL',{id:p.id(targetId),kind:p.str(kind,20)})).recordset[0];
 requireCondition(target,404,'DELETE_TARGET_NOT_FOUND','This record was already removed or is no longer available.');
 const users=kind==='user'?[target]:kind==='request'?[]:(await query(`SELECT TOP(${maxReview+1}) Id,Name,EmployeeId,Role,Active,Version FROM dbo.Users WHERE DeletedAt IS NULL AND ${ {branch:'BranchId',department:'DepartmentId',designation:'DesignationId'}[kind]}=@id ORDER BY Id`,{id:p.id(targetId)})).recordset;
 requireCondition(users.length<=maxReview,409,'DELETE_REVIEW_TOO_LARGE','More than 5,000 employees are linked. Remove or move them in smaller groups first.');
 const params={id:p.id(targetId),scope:p.id(['user','request'].includes(kind)?null:targetId),kind:p.str(kind,20),users:p.json(users.map(row=>row.Id))};
 const related=`(r.RequesterId IN (${isUserSet}) OR r.SubjectUserId IN (${isUserSet}) OR EXISTS(SELECT 1 FROM dbo.RequestPeople rp WHERE rp.RequestId=r.Id AND rp.UserId IN (${isUserSet})) OR EXISTS(SELECT 1 FROM dbo.RequestSteps s WHERE s.RequestId=r.Id AND (s.AssignedUserId IN (${isUserSet}) OR s.ActorId IN (${isUserSet}) OR EXISTS(SELECT 1 FROM dbo.uidms_StepReviewers(s.RequestId,s.Position) eligible WHERE eligible.UserId IN (${isUserSet})))) OR EXISTS(SELECT 1 FROM dbo.Queries q WHERE q.RequestId=r.Id AND (q.AuthorId IN (${isUserSet}) OR q.RecipientId IN (${isUserSet}))))`;
 const scope=kind==='request'?'r.Id=@id':kind==='user'?related:`(${related} OR r.BranchId=@id OR r.DepartmentId=@id OR r.DestinationBranchId=@id OR r.DestinationDepartmentId=@id OR EXISTS(SELECT 1 FROM dbo.RequestPeople rp WHERE rp.RequestId=r.Id AND (rp.BranchId=@id OR rp.DepartmentId=@id)) OR EXISTS(SELECT 1 FROM dbo.RequestSteps s WHERE s.RequestId=r.Id AND (s.BranchId=@id OR s.DepartmentId=@id)))`;
 const requests=(await query(`SELECT TOP(${maxReview+1}) r.Id,r.TicketNumber,r.TypeCode,r.Status,r.Version,u.Name AS RequesterName,u.EmployeeId AS RequesterEmployeeId,
 CAST(CASE WHEN r.RequesterId IN (${isUserSet}) THEN 1 ELSE 0 END AS bit) AS CreatedByUser,
 CAST(CASE WHEN r.Status NOT IN ${terminal} AND (
 (r.Status='Employee review' AND r.SubjectUserId IN (${isUserSet})) OR EXISTS(SELECT 1 FROM dbo.Queries q WHERE q.RequestId=r.Id AND q.ResolvedAt IS NULL AND q.RecipientId IN (${isUserSet})) OR
 EXISTS(SELECT 1 FROM dbo.RequestSteps s WHERE s.RequestId=r.Id AND s.Status='Waiting' AND (s.AssignedUserId IN (${isUserSet}) OR EXISTS(SELECT 1 FROM dbo.uidms_StepReviewers(s.RequestId,s.Position) eligible WHERE eligible.UserId IN (${isUserSet}))))) THEN 1 ELSE 0 END AS bit) AS UserDependency,
 CAST(CASE WHEN @kind IN ('branch','department') AND r.Status NOT IN ${terminal} AND EXISTS(SELECT 1 FROM dbo.RequestSteps s WHERE s.RequestId=r.Id AND s.Status='Waiting' AND (s.BranchId=@id OR s.DepartmentId=@id)) THEN 1 ELSE 0 END AS bit) AS ScopeDependency
 FROM dbo.Requests r JOIN dbo.Users u ON u.Id=r.RequesterId WHERE r.DeletedAt IS NULL AND ${scope} ORDER BY r.Id`,params)).recordset.map(clean);
 requireCondition(requests.length<=maxReview,409,'DELETE_REVIEW_TOO_LARGE','More than 5,000 requests are linked. Review and remove them in smaller groups first.');
 const requestIds=requests.map(row=>row.Id);
 const assignments=(await query(`SELECT a.ScopeId,l.Name,l.Kind,a.UserId,u.EmployeeId,a.Version FROM dbo.OrganizationApprovers a JOIN dbo.Lookups l ON l.Id=a.ScopeId JOIN dbo.Users u ON u.Id=a.UserId WHERE a.ScopeId=@scope OR a.UserId IN (${isUserSet}) ORDER BY a.ScopeId`,params)).recordset.map(clean);
 const acting=(await query(`SELECT Id,PrincipalId,ActingUserId,Role,ScopeId,StartsAt,EndsAt,Version FROM dbo.RoleDelegations WHERE RevokedAt IS NULL AND EndsAt>SYSUTCDATETIME() AND (ScopeId=@scope OR PrincipalId IN (${isUserSet}) OR ActingUserId IN (${isUserSet})) ORDER BY Id`,params)).recordset.map(clean);
 const counts=(await query(`SELECT
 (SELECT COUNT(*) FROM dbo.AccessGrants WHERE UserId IN (${isUserSet}) AND RevokedAt IS NULL) AS activeAccess,
 (SELECT COUNT(*) FROM dbo.MailingGroupMembers WHERE UserId IN (${isUserSet})) AS mailingMemberships,
 (SELECT COUNT(*) FROM dbo.RequestPeople WHERE RequestId IN (SELECT CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@requests))) AS beneficiaries,
 (SELECT COUNT(*) FROM dbo.RequestItems WHERE RequestId IN (SELECT CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@requests))) AS systemItems,
 (SELECT COUNT(*) FROM dbo.Queries WHERE RequestId IN (SELECT CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@requests))) AS queries,
 (SELECT COUNT(*) FROM dbo.Attachments WHERE RequestId IN (SELECT CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@requests))) AS attachments,
 (SELECT COUNT(*) FROM dbo.CredentialDeliveries WHERE (RecipientId IN (${isUserSet}) OR RequestId IN (SELECT CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@requests))) AND Ciphertext IS NOT NULL) AS credentialDeliveries`,{...params,requests:p.json(requestIds)})).recordset[0];
 const plan={kind,target:clean(target),users:users.map(clean),requests,assignments,acting,counts};
 return {...plan,reviewToken:createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
}

export async function performDeletion(db,req,kind,targetId,body){return db.transaction(async query=>{
 const plan=await deletionPlan(query,kind,targetId);
 requireCondition(plan.reviewToken===body.reviewToken,409,'DELETE_DEPENDENCIES_CHANGED','Dependencies changed. Reload the review before deleting.');
 requireCondition(body.confirmName===plan.target.Name,400,'DELETE_NAME_MISMATCH','Enter the exact record name to confirm.');
 const removeUsers=kind==='user'||kind!=='request'&&body.employees==='delete';
 const users=removeUsers?plan.users:[];
 const merging=Boolean(body.mergePending);
 requireCondition(!merging||['branch','department'].includes(kind)&&body.employees==='move'&&body.requests==='keep'&&!body.deleteOtherRequests,400,'INVALID_ORGANIZATION_MERGE','Merging requires keeping all employees and requests and selecting another branch or department of the same type.');
 requireCondition(!users.some(row=>row.Id===req.user.Id),403,'SELF_DELETION_FORBIDDEN','You cannot delete your own account, including through an organization. Move your account to another entry first.');
 const superAdmins=(await query("SELECT Id FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE Role='Super Admin' AND Active=1 AND DeletedAt IS NULL")).recordset;
 requireCondition(!users.some(row=>row.Active&&row.Role==='Super Admin')||superAdmins.some(row=>!users.some(user=>user.Id===row.Id)),409,'LAST_SUPER_ADMIN','At least one active Super Admin must remain.');
 const requestIds=plan.requests.filter(row=>kind==='request'||body.requests==='delete'&&(kind!=='user'||row.CreatedByUser)||body.deleteOtherRequests&&row.UserDependency&&removeUsers).map(row=>row.Id);
 const blockers=plan.requests.filter(row=>!requestIds.includes(row.Id)&&(!merging&&row.ScopeDependency||removeUsers&&row.UserDependency));
 requireCondition(blockers.length===0,409,'DELETE_LIVE_DEPENDENCIES','Some kept requests still need this employee or organization. Reassign their pending responsibilities or choose to remove the affected requests.');
 const params={id:p.id(targetId),scope:p.id(['user','request'].includes(kind)?null:targetId),actor:p.id(req.user.Id),users:p.json(users.map(row=>row.Id)),requests:p.json(requestIds)};
 if(kind!=='user'&&kind!=='request'&&(plan.users.length||merging)&&!removeUsers){
  requireCondition(body.replacementId&&body.replacementId!==targetId,400,'DELETE_REPLACEMENT_REQUIRED','Select another active entry of the same type for the linked employees.');
  const replacement=(await query('SELECT Id FROM dbo.Lookups WHERE Id=@replacement AND Kind=@kind AND Active=1 AND DeletedAt IS NULL',{replacement:p.id(body.replacementId),kind:p.str(kind,20)})).recordset[0];
  requireCondition(replacement,400,'DELETE_REPLACEMENT_INVALID','Select an active replacement of the same type.');
  const column={branch:'BranchId',department:'DepartmentId',designation:'DesignationId'}[kind];
  await query(`UPDATE dbo.Users SET ${column}=@replacement,UpdatedAt=SYSUTCDATETIME() WHERE ${column}=@id AND DeletedAt IS NULL`,{id:p.id(targetId),replacement:p.id(body.replacementId)});
  await auditRows(query,req,'user.organization_moved',plan.users.map(user=>({id:user.Id,metadata:{kind,previousId:targetId,replacementId:body.replacementId,reason:'organization_deleted'}})));
 }
 const updatedRequests=merging?await mergePendingOrganization(query,req,kind,targetId,body.replacementId):0;
 if(users.length){
  await query(`DECLARE @closed TABLE(Id uniqueidentifier,UserId uniqueidentifier,LastIp varchar(64),Role nvarchar(40),EndedAt datetime2(3));
   UPDATE dbo.AuditSessions SET EndedAt=SYSUTCDATETIME(),EndReason='account_deleted'
   OUTPUT inserted.Id,inserted.UserId,inserted.LastIp,inserted.Role,inserted.EndedAt INTO @closed
   WHERE EndedAt IS NULL AND UserId IN (${isUserSet});
   INSERT dbo.AuditEvents(ActorId,Event,EntityId,Ip,CreatedAt,Metadata,AuditSessionId,ActorRole,CorrelationId)
   SELECT UserId,'auth.session_ended',CONVERT(nvarchar(80),Id),LastIp,EndedAt,N'{"reason":"account_deleted","serverGenerated":true}',Id,Role,NEWID() FROM @closed;
   UPDATE dbo.Users SET Active=0,DeletedAt=SYSUTCDATETIME(),PasswordHash=NULL,MfaSecret=NULL,MfaLastCounter=NULL,UpdatedAt=SYSUTCDATETIME() WHERE Id IN (${isUserSet});
   UPDATE dbo.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE UserId IN (${isUserSet});
   DELETE dbo.AuthChallenges WHERE UserId IN (${isUserSet});
   DELETE dbo.MailingGroupMembers WHERE UserId IN (${isUserSet});`,params);
  await auditRows(query,req,'user.deleted',users.map(user=>({id:user.Id,metadata:{employeeId:user.EmployeeId,name:user.Name,requests:body.requests,sourceKind:kind}})));
 }
 if(users.length||kind!=='user'&&kind!=='request'){
  await query(`UPDATE dbo.RoleDelegations SET RevokedAt=SYSUTCDATETIME(),RevokedBy=@actor WHERE RevokedAt IS NULL AND (PrincipalId IN (${isUserSet}) OR ActingUserId IN (${isUserSet}) OR ScopeId=@scope);
   DELETE dbo.OrganizationApprovers WHERE UserId IN (${isUserSet}) OR ScopeId=@scope;`,params);
 }
 if(requestIds.length){
  await query(`UPDATE dbo.Requests SET DeletedAt=SYSUTCDATETIME(),UpdatedAt=SYSUTCDATETIME(),Status=CASE WHEN Status IN ${terminal} THEN Status ELSE 'Cancelled' END WHERE Id IN (SELECT CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@requests));`,params);
  const removed=new Set(requestIds);await auditRows(query,req,'request.deleted',plan.requests.filter(row=>removed.has(row.Id)).map(row=>({id:row.Id,metadata:{sourceKind:kind,sourceId:targetId,ticketNumber:row.TicketNumber}})));
 }
 await query(`UPDATE dbo.CredentialDeliveries SET Ciphertext=NULL,ExpiresAt=SYSUTCDATETIME() WHERE RecipientId IN (${isUserSet}) OR RequestId IN (SELECT CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@requests));
 UPDATE dbo.Notifications SET ReadAt=COALESCE(ReadAt,SYSUTCDATETIME()) WHERE UserId IN (${isUserSet}) OR RequestId IN (SELECT CONVERT(uniqueidentifier,[value]) FROM OPENJSON(@requests));`,params);
 if(!['user','request'].includes(kind)){
  await query('UPDATE dbo.Lookups SET Active=0,DeletedAt=SYSUTCDATETIME() WHERE Id=@id',{id:p.id(targetId)});
  await audit(query,req,'lookup.deleted',targetId,{kind,name:plan.target.Name,employees:body.employees,replacementId:body.replacementId,removedUsers:users.length,removedRequests:requestIds.length});
 }
 return {deleted:true,users:users.length,requests:requestIds.length,retainedRequests:plan.requests.length-requestIds.length,mergedRequests:updatedRequests};
});}

export function deletionSession(req,res,next){
 const remaining=Date.parse(req.sessionWindow?.expiresAt)-Date.now();
 requireCondition(Number.isFinite(remaining)&&remaining>=10*60000,403,'REAUTHENTICATION_REQUIRED','Sign in again. Deletion requires at least 10 minutes remaining in your session.');next();
}
export function deletionRoutes(db){const router=Router();router.use('/admin/deletions',roles('Admin','Super Admin'),deletionSession);
 router.get('/admin/deletions/:kind/:id',async(req,res)=>{const kind=parse(kindSchema,req.params.kind),target=uuidParam(req);res.json(await db.transaction(query=>deletionPlan(query,kind,target)));});
 router.delete('/admin/deletions/:kind/:id',async(req,res)=>res.json(await performDeletion(db,req,parse(kindSchema,req.params.kind),uuidParam(req),parse(choicesSchema,req.body))));
 return router;
}
